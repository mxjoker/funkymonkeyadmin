const { Client } = require("pg");
const crypto = require("crypto");

const db = () => new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const FROM = "Funky Monkey Events <bookings@funkymonkeyevents.com>";
const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";

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

const verifySig = (payload, sigHeader, secret) => {
  try {
    const parts = sigHeader.split(",").reduce((a, p) => { const [k,v]=p.split("="); a[k]=v; return a; }, {});
    if (!parts.t || !parts.v1) return false;
    if (Math.abs(Date.now()/1000 - parseInt(parts.t)) > 300) return false;
    const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(parts.v1,"hex"), Buffer.from(expected,"hex"));
  } catch(e) { return false; }
};

exports.handler = async (event) => {
  const h = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sigHeader = event.headers["stripe-signature"];
  if (webhookSecret && sigHeader && !verifySig(event.body, sigHeader, webhookSecret)) {
    console.error("Invalid Stripe signature");
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let ev;
  try { ev = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const c = db();
  try {
    await c.connect();

    // ── Checkout completed (deposit paid) ──────
    if (ev.type === "checkout.session.completed") {
      const session = ev.data.object;
      const amountPaid = (session.amount_total || 0) / 100;
      const customerEmail = session.customer_details?.email || session.customer_email;

      // create-stripe-link.js stores the numeric DB id in metadata.booking_db_id
      // and the reference (FM-XXXXXX) in metadata.booking_id / client_reference_id
      const bookingDbId  = session.metadata?.booking_db_id;
      const bookingRef   = session.metadata?.booking_id || session.client_reference_id;

      let booking = null;

      // 1. Try numeric DB id first (most reliable)
      if (bookingDbId) {
        const r = await c.query("SELECT * FROM bookings WHERE id=$1 LIMIT 1", [parseInt(bookingDbId)]);
        booking = r.rows[0] || null;
      }

      // 2. Fall back to reference string (FM-XXXXXX)
      if (!booking && bookingRef) {
        const r = await c.query("SELECT * FROM bookings WHERE reference=$1 LIMIT 1", [bookingRef]);
        booking = r.rows[0] || null;
      }

      // 3. Last resort: match by client email + open status
      if (!booking && customerEmail) {
        const r = await c.query(
          "SELECT * FROM bookings WHERE LOWER(client_email)=LOWER($1) AND status IN ('review','pending','confirmed') ORDER BY created_at DESC LIMIT 1",
          [customerEmail]
        );
        booking = r.rows[0] || null;
      }

      if (booking) {
        // Mark deposit paid, set status confirmed, record payment method
        const updated = await c.query(
          `UPDATE bookings
           SET deposit_paid=TRUE,
               deposit_paid_at=NOW(),
               deposit_amount=$1,
               payment_method='stripe',
               status='confirmed'
           WHERE id=$2
           RETURNING *`,
          [amountPaid, booking.id]
        );
        const b = updated.rows[0];

        // Calculate balance due
        const total    = parseFloat(b.total_price)   || 0;
        const mileage  = parseFloat(b.mileage_cost)  || 0;
        const deposit  = parseFloat(b.deposit_amount)|| 0;
        const balance  = Math.max(0, (total + mileage) - deposit).toFixed(2);

        const dateStr  = b.event_date
          ? new Date(b.event_date + "T00:00:00").toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" })
          : "";
        const timeStr  = b.event_time     || "";
        const locStr   = b.event_location || b.event_zip || "OKC";

        // Client confirmation email
        await sendEmail(
          b.client_email,
          "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events",
          wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${b.client_name}</strong>! 🎉</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We got your deposit and your event is officially <strong style="color:#10B981">CONFIRMED!</strong></p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${b.service_name}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date &amp; Time</span><br><span style="font-weight:600">${dateStr}${timeStr ? " at " + timeStr : ""}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Location</span><br><span style="font-weight:600">${locStr}</span></div>
              <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #3D246044">
                <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Paid ✓</span><br><span style="color:#10B981;font-size:20px;font-weight:900">$${amountPaid.toFixed(2)}</span></div>
                <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due Day-Of</span><br><span style="color:#FFD600;font-size:20px;font-weight:900">$${balance}</span></div>
              </div>
            </div>
            <p style="color:#A78BCA;font-size:13px;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`)
        );

        // Admin notification email
        await sendEmail(
          NOTIFY,
          `💰 Deposit In: ${b.client_name} — $${amountPaid.toFixed(2)}`,
          wrap(`<p style="font-size:15px;font-weight:700;color:#10B981;margin-bottom:16px">💰 Stripe deposit received — booking auto-confirmed!</p>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:130px">Ref</td><td style="padding:7px 0;color:#FFD600;font-weight:700">${b.reference}</td></tr>
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Client</td><td style="padding:7px 0;font-weight:700">${b.client_name}</td></tr>
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</td><td style="padding:7px 0">${b.service_name}</td></tr>
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date</td><td style="padding:7px 0">${dateStr}${timeStr ? " at " + timeStr : ""}</td></tr>
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Paid</td><td style="padding:7px 0;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>
              <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due</td><td style="padding:7px 0;color:#FFD600;font-weight:700">$${balance}</td></tr>
            </table>
            <div style="margin-top:20px;text-align:center">
              <a href="https://funkymonkeyadmin.netlify.app/admin.html" style="background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">View in Dashboard →</a>
            </div>`)
        );

        console.log(`Webhook: confirmed booking ${b.reference} (id:${b.id}) — deposit $${amountPaid}`);

      } else {
        console.warn(`Webhook: no booking matched — dbId:${bookingDbId} ref:${bookingRef} email:${customerEmail}`);
      }
    }

    // ── Payment failed ─────────────────────────
    if (ev.type === "payment_intent.payment_failed") {
      const pi = ev.data.object;
      const email = pi.last_payment_error?.payment_method?.billing_details?.email;
      if (email) {
        await sendEmail(email, "Payment didn't go through — Funky Monkey Events",
          wrap(`<p style="font-size:16px;margin-bottom:16px">Hi there! 👋</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your deposit payment didn't go through — no worries, it happens!</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Try again with a different card, or give us a call and we'll figure it out.</p>
            <p style="font-size:13px;color:#A78BCA;text-align:center"><a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
      }
    }

    return { statusCode: 200, headers: h, body: JSON.stringify({ received: true }) };
  } catch(e) {
    console.error("Webhook error:", e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  } finally { await c.end(); }
};
