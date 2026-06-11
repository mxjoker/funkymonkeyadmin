const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { esc, sendEmail, wrap } = require('./_email');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  // Admin token required
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(500, { error: "Stripe not configured" });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { bookingId, bookingRef, client, email, service, amount } = body;

  // Validate amount: must be present and 0 < amount <= 10000
  const amountNum = Number(amount);
  if (!amount || isNaN(amountNum) || amountNum <= 0 || amountNum > 10000) {
    return json(400, { error: "amount must be a number between 0 (exclusive) and 10000" });
  }

  // Validate the referenced booking exists
  const bookingRow = await withClient(async (c) => {
    if (bookingId) {
      const { rows } = await c.query("SELECT id, reference FROM bookings WHERE id=$1 LIMIT 1", [parseInt(bookingId)]);
      return rows[0] || null;
    }
    if (bookingRef) {
      const { rows } = await c.query("SELECT id, reference FROM bookings WHERE reference=$1 LIMIT 1", [bookingRef]);
      return rows[0] || null;
    }
    return null;
  });

  if (!bookingRow) {
    return json(404, { error: "Booking not found" });
  }

  try {
    // Create Stripe Checkout Session
    const params = new URLSearchParams({
      "mode": "payment",
      "success_url": `https://funkymonkeyadmin.netlify.app/confirmation.html?ref=${bookingRef || bookingId}`,
      "cancel_url": `https://funkymonkeyadmin.netlify.app/booking-form.html?cancelled=1`,
      "customer_email": email || "",
      "client_reference_id": bookingRef || String(bookingId),
      "metadata[booking_id]": bookingRef || String(bookingId),
      "metadata[booking_db_id]": String(bookingRow.id),
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(Math.round(amountNum * 100)),
      "line_items[0][price_data][product_data][name]": `Deposit — ${service || 'Event'}`,
      "line_items[0][price_data][product_data][description]": `50% deposit for ${client || ''}'s event. Balance due day-of.`,
      "line_items[0][quantity]": "1",
      "payment_method_types[0]": "card",
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const session = await res.json();
    if (!res.ok) {
      console.error("Stripe error:", JSON.stringify(session.error));
      throw new Error(session.error?.message || "Stripe API error");
    }

    const url = session.url;

    // Email the client with the payment link
    try {
      await sendEmail(email, `Your deposit link is ready! 💳 — Funky Monkey Events`,
        wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(client)}</strong>! 🎉</p>
          <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your booking for <strong style="color:#F3E8FF">${esc(service)}</strong> is approved! Pay your deposit to lock in your date.</p>
          <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px;text-align:center">
            <div style="font-size:11px;color:#A78BCA;text-transform:uppercase;font-weight:700;margin-bottom:6px">Deposit Amount</div>
            <div style="font-size:36px;font-weight:900;color:#10B981;font-family:'Fredoka One',sans-serif">$${amountNum.toFixed(2)}</div>
            <div style="font-size:12px;color:#A78BCA;margin-top:4px">Secure your date — balance due day of event</div>
          </div>
          <div style="text-align:center;margin-bottom:24px">
            <a href="${url}" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Deposit Now →</a>
          </div>
          <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
            🔒 Secure payment powered by Stripe · Accepts all major cards, Apple Pay &amp; Google Pay<br>
            Link expires in 24 hours · Booking ref: ${esc(String(bookingRef || bookingId))}
          </div>
          <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
    } catch(emailErr) {
      console.error("create-stripe-link: email failed:", emailErr.message);
      // Email failure does not fail the link creation
    }

    return json(200, { url, sessionId: session.id });
  } catch(e) {
    console.error("Stripe link error:", e.message);
    return json(500, { error: "Internal server error" });
  }
};
