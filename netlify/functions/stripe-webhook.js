const crypto = require("crypto");
const { withClient } = require('./_db');
const { esc, sendEmail, logStatus, wrap, fmtEventDate, logEmail, logChange, ensureEmailLog, ensureBookingChanges } = require('./_email');

const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";

const verifySig = (payload, sigHeader, secret) => {
  try {
    const parts = sigHeader.split(",").reduce((a, p) => { const [k,v]=p.split("="); a[k]=v; return a; }, {});
    if (!parts.t || !parts.v1) return false;
    if (Math.abs(Date.now()/1000 - parseInt(parts.t)) > 300) return false;
    const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(parts.v1,"hex"), Buffer.from(expected,"hex"));
  } catch(e) { return false; }
};

// What a completed checkout session does to the booking row. Pure, so both
// kinds can be tested without Stripe or a database.
//
// A balance payment is NOT a deposit. Before create-stripe-link.js started
// stamping metadata[payment_kind], this handler treated every session as one:
// it overwrote deposit_amount with whatever was paid, recomputed
// balance_due as total + mileage - <that>, and forced status back to
// 'confirmed'. A client paying a $420 balance link on a $500 booking lost the
// record of their $100 deposit and was still shown $80 owed after paying in
// full — and got a "Deposit received!" email after their event.
//
// The balance branch sets balance_due to 0 rather than subtracting what was
// paid: the payment includes the service fee, so subtracting it would leave a
// negative. Zeroing deliberately makes the balance un-derivable, which is
// correct — it is exactly the "settled out-of-band" state that
// _items.js:151 detects and booking.js:269 protects.
function paymentEffect(booking, amountPaid, kind) {
  const b = booking || {};
  if (kind === 'balance') {
    return {
      kind: 'balance',
      deposit_paid: b.deposit_paid === true,
      deposit_amount: Number(b.deposit_amount) || 0,
      payment_method: b.payment_method || '',
      status: b.status || 'confirmed',
      balance_due: 0,
      logAction: 'Balance paid via Stripe',
    };
  }
  const totalCents   = Math.round((parseFloat(b.total_price)  || 0) * 100);
  const mileageCents = Math.round((parseFloat(b.mileage_cost) || 0) * 100);
  const paidCents    = Math.round((Number(amountPaid) || 0) * 100);
  return {
    kind: 'deposit',
    deposit_paid: true,
    deposit_amount: Number(amountPaid) || 0,
    payment_method: 'stripe',
    status: 'confirmed',
    balance_due: Math.max(0, totalCents + mileageCents - paidCents) / 100,
    logAction: 'Deposit paid via Stripe',
  };
}

exports.handler = async (event) => {
  const h = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  // FAIL-CLOSED: webhook secret must be configured
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set — rejecting webhook");
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Webhook not configured" }) };
  }

  // Signature header must be present and valid
  const sigHeader = event.headers["stripe-signature"];
  if (!sigHeader) {
    console.error("Missing Stripe signature header");
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Missing signature" }) };
  }
  if (!verifySig(event.body, sigHeader, webhookSecret)) {
    console.error("Invalid Stripe signature");
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let ev;
  try { ev = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  try {
    return await withClient(async (c) => {
      await ensureEmailLog(c);
      await ensureBookingChanges(c);

      // Ensure idempotency columns exist
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)");
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255)");

      // ── Checkout completed (deposit paid) ──────
      if (ev.type === "checkout.session.completed") {
        const session = ev.data.object;
        const sessionId = session.id;
        const paymentIntentId = session.payment_intent || null;

        // Integer-cents arithmetic for accuracy
        const amountPaidCents = session.amount_total || 0;
        const amountPaid = amountPaidCents / 100;

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

        // 2. Fall back to reference string (FM-XXXXXXXX)
        if (!booking && bookingRef) {
          const r = await c.query("SELECT * FROM bookings WHERE reference=$1 LIMIT 1", [bookingRef]);
          booking = r.rows[0] || null;
        }

        // 3. Last resort: match by client email + open status
        if (!booking && customerEmail) {
          const r = await c.query(
            "SELECT * FROM bookings WHERE LOWER(client_email)=LOWER($1) AND status IN ('review','confirmed','quoted','accepted') ORDER BY created_at DESC LIMIT 1",
            [customerEmail]
          );
          booking = r.rows[0] || null;
        }

        if (booking) {
          // IDEMPOTENT: if we've already processed this session, skip
          if (booking.stripe_session_id === sessionId) {
            console.log(`Webhook: already processed session ${sessionId} for booking ${booking.reference}`);
            return { statusCode: 200, headers: h, body: JSON.stringify({ received: true, note: "already processed" }) };
          }

          // create-stripe-link.js stamps metadata[payment_kind]. Anything
          // else — including every session minted before that existed — is a
          // deposit, which is what this handler always assumed.
          const kind = session.metadata?.payment_kind === 'balance' ? 'balance' : 'deposit';
          const effect = paymentEffect(booking, amountPaid, kind);
          const balanceDue = effect.balance_due;

          // The balance owed BEFORE this payment, so the receipt can itemise
          // what was actually charged. Read from the row, not from the
          // session, so a tampered session cannot rewrite the arithmetic.
          const balanceBefore = Math.max(0, Number(booking.balance_due) || 0);
          const feePaid = Math.max(0, Math.round((amountPaid - balanceBefore) * 100) / 100);

          const updated = await c.query(
            `UPDATE bookings
             SET deposit_paid=$1,
                 deposit_paid_at = CASE WHEN $2::boolean THEN NOW() ELSE deposit_paid_at END,
                 deposit_amount=$3,
                 payment_method=$4,
                 status=$5,
                 stripe_session_id=$6,
                 stripe_payment_intent_id=$7,
                 balance_due=$8
             WHERE id=$9
             RETURNING *`,
            [effect.deposit_paid, effect.kind === 'deposit', effect.deposit_amount,
             effect.payment_method, effect.status, sessionId, paymentIntentId,
             balanceDue, booking.id]
          );
          const b = updated.rows[0];
          await logChange(c, b.id, effect.logAction,
            effect.kind === 'balance'
              ? `$${amountPaid.toFixed(2)} (balance $${balanceBefore.toFixed(2)} + service fee $${feePaid.toFixed(2)})`
              : `$${amountPaid.toFixed(2)}`);

          const dateStr  = fmtEventDate(b.event_date);
          const timeStr  = b.event_time     || "";
          const locStr   = b.event_location || b.event_zip || "OKC";

          // Client email — a balance receipt is not a deposit confirmation.
          // Sending the existing "You're CONFIRMED!" copy to someone settling
          // up after their event reads as if we had lost track of them.
          if (effect.kind === 'balance') {
            const subject = "Payment received — you're all paid up! 🎉 Funky Monkey Events";
            try {
              const res = await sendEmail(b.client_email, subject,
                wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(b.client_name)}</strong>! 🎉</p>
                  <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you — your balance for <strong style="color:#F3E8FF">${esc(b.service_name)}</strong> is settled in full.</p>
                  <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
                    <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
                      <tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${balanceBefore.toFixed(2)}</td></tr>
                      <tr><td style="padding:4px 0;color:#A78BCA">Service fee (5%)</td><td style="padding:4px 0;text-align:right">$${feePaid.toFixed(2)}</td></tr>
                      <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total paid</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>
                    </table>
                  </div>
                  <p style="color:#A78BCA;font-size:13px;text-align:center">Booking ref: ${esc(b.reference)} · Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
              await logEmail(c, b.id, null, 'Balance Paid', subject, b.client_email, 'client', logStatus(res));
            } catch (emailErr) {
              console.error("Webhook: balance receipt failed:", emailErr.message);
              await logEmail(c, b.id, null, 'Balance Paid', subject, b.client_email, 'client', 'failed', emailErr.message);
            }
          } else {
          // Client confirmation email
          try {
            const res = await sendEmail(
              b.client_email,
              "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events",
              wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(b.client_name)}</strong>! 🎉</p>
                <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We got your deposit and your event is officially <strong style="color:#10B981">CONFIRMED!</strong></p>
                <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${esc(b.service_name)}</span></div>
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date &amp; Time</span><br><span style="font-weight:600">${dateStr}${timeStr ? " at " + esc(timeStr) : ""}</span></div>
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Location</span><br><span style="font-weight:600">${esc(locStr)}</span></div>
                  <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #3D246044">
                    <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Paid ✓</span><br><span style="color:#10B981;font-size:20px;font-weight:900">$${amountPaid.toFixed(2)}</span></div>
                    <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due Day-Of</span><br><span style="color:#FFD600;font-size:20px;font-weight:900">$${balanceDue.toFixed(2)}</span></div>
                  </div>
                </div>
                <p style="color:#A78BCA;font-size:13px;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`)
            );
            await logEmail(c, b.id, null, 'Deposit Paid', "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events", b.client_email, 'client', logStatus(res));
          } catch(emailErr) {
            console.error("Webhook: client email failed:", emailErr.message);
            await logEmail(c, b.id, null, 'Deposit Paid', "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events", b.client_email, 'client', 'failed', emailErr.message);
          }
          }

          // Admin notification email
          const adminSubject = effect.kind === 'balance'
            ? `💰 Balance In: ${b.client_name} — $${amountPaid.toFixed(2)}`
            : `💰 Deposit In: ${b.client_name} — $${amountPaid.toFixed(2)}`;
          const adminTrigger = effect.kind === 'balance' ? 'Balance Paid' : 'Deposit Paid';
          try {
            const res = await sendEmail(
              NOTIFY,
              adminSubject,
              wrap(`<p style="font-size:15px;font-weight:700;color:#10B981;margin-bottom:16px">💰 Stripe deposit received — booking auto-confirmed!</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:130px">Ref</td><td style="padding:7px 0;color:#FFD600;font-weight:700">${esc(b.reference)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Client</td><td style="padding:7px 0;font-weight:700">${esc(b.client_name)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</td><td style="padding:7px 0">${esc(b.service_name)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date</td><td style="padding:7px 0">${dateStr}${timeStr ? " at " + esc(timeStr) : ""}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Paid</td><td style="padding:7px 0;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due</td><td style="padding:7px 0;color:#FFD600;font-weight:700">$${balanceDue.toFixed(2)}</td></tr>
                </table>
                <div style="margin-top:20px;text-align:center">
                  <a href="https://funkymonkeyadmin.netlify.app/admin.html" style="background-color:#FF6B00;color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">View in Dashboard →</a>
                </div>`)
            );
            await logEmail(c, b.id, null, adminTrigger, adminSubject, NOTIFY, 'admin', logStatus(res));
          } catch(emailErr) {
            console.error("Webhook: admin email failed:", emailErr.message);
            await logEmail(c, b.id, null, adminTrigger, adminSubject, NOTIFY, 'admin', 'failed', emailErr.message);
          }

          console.log(`Webhook: confirmed booking ${b.reference} (id:${b.id}) — deposit $${amountPaid} balance_due $${balanceDue}`);

        } else {
          console.warn(`Webhook: no booking matched — dbId:${bookingDbId} ref:${bookingRef} email:${customerEmail}`);
        }
      }

      // ── Payment failed ─────────────────────────
      if (ev.type === "payment_intent.payment_failed") {
        const pi = ev.data.object;
        const email = pi.last_payment_error?.payment_method?.billing_details?.email;
        if (email) {
          try {
            await sendEmail(email, "Payment didn't go through — Funky Monkey Events",
              wrap(`<p style="font-size:16px;margin-bottom:16px">Hi there! 👋</p>
                <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your deposit payment didn't go through — no worries, it happens!</p>
                <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Try again with a different card, or give us a call and we'll figure it out.</p>
                <p style="font-size:13px;color:#A78BCA;text-align:center"><a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
          } catch(emailErr) {
            console.error("Webhook: payment-failed email error:", emailErr.message);
          }
        }
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ received: true }) };
    });
  } catch(e) {
    console.error("Webhook error:", e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Internal server error" }) };
  }
};

// Exported for tests — the handler itself needs Stripe and a database.
module.exports.paymentEffect = paymentEffect;
