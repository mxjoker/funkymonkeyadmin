const FROM = "Funky Monkey Events <bookings@funkymonkeyevents.com>";

const sendEmail = async (to, subject, html) => {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    const data = await res.json();
    if (data.error) console.error("Resend error:", JSON.stringify(data));
    else console.log("Email sent to:", to, "id:", data.id);
  } catch(e) { console.error("Email error:", e.message); }
};

const wrap = (body) => `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px"><div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div></div>
  <div style="padding:24px">${body}</div></div>`;

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "STRIPE_SECRET_KEY not configured in Netlify environment variables" }) };

  try {
    const { bookingId, bookingRef, client, email, service, amount } = JSON.parse(event.body);
    if (!amount || amount <= 0) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid amount" }) };

    // Create Stripe Checkout Session
    const params = new URLSearchParams({
      "mode": "payment",
      "success_url": `https://funkymonkeyadmin.netlify.app/booking-form.html?paid=1`,
      "cancel_url": `https://funkymonkeyadmin.netlify.app/booking-form.html?cancelled=1`,
      "customer_email": email || "",
      "client_reference_id": bookingRef || String(bookingId),
      "metadata[booking_id]": bookingRef || String(bookingId),
      "metadata[booking_db_id]": String(bookingId),
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
      "line_items[0][price_data][product_data][name]": `Deposit — ${service}`,
      "line_items[0][price_data][product_data][description]": `50% deposit for ${client}'s event. Balance due day-of.`,
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
    if (!res.ok) throw new Error(session.error?.message || "Stripe API error");

    const url = session.url;

    // Email the client with the payment link
    await sendEmail(email, `Your deposit link is ready! 💳 — Funky Monkey Events`,
      wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${client}</strong>! 🎉</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your booking for <strong style="color:#F3E8FF">${service}</strong> is approved! Pay your deposit to lock in your date.</p>
        <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px;text-align:center">
          <div style="font-size:11px;color:#A78BCA;text-transform:uppercase;font-weight:700;margin-bottom:6px">Deposit Amount</div>
          <div style="font-size:36px;font-weight:900;color:#10B981;font-family:'Fredoka One',sans-serif">$${amount.toFixed(2)}</div>
          <div style="font-size:12px;color:#A78BCA;margin-top:4px">Secure your date — balance due day of event</div>
        </div>
        <div style="text-align:center;margin-bottom:24px">
          <a href="${url}" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Deposit Now →</a>
        </div>
        <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
          🔒 Secure payment powered by Stripe · Accepts all major cards, Apple Pay & Google Pay<br>
          Link expires in 24 hours · Booking ref: ${bookingRef||bookingId}
        </div>
        <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));

    return { statusCode: 200, headers: h, body: JSON.stringify({ url, sessionId: session.id }) };
  } catch(e) {
    console.error("Stripe link error:", e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
