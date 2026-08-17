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

// Same rounding idiom used below for totalCents/mileageCents — kept local
// rather than imported since it's one line.
const round2 = (n) => Math.round(n * 100) / 100;

// Parses a Stripe metadata value (always a string, or absent) into a finite
// number, or null if it's missing/blank/not a number.
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
// The balance branch does NOT trust booking.balance_due to reconstruct what
// was fee vs. balance: that's exactly the column a balance payment zeroes,
// so a retried/repeat delivery of the same session would read it back as
// $0, and a quote raised after the link was minted would make it read too
// high. It prefers the balance/fee split create-stripe-link.js stamps into
// session metadata — Stripe signs the whole payload, so that split can't
// have been tampered with — and only falls back to "the whole payment covers
// the balance" when that metadata is absent or doesn't add up to what was
// actually charged. In the fallback case it does NOT itemise a Balance /
// Service-fee breakdown it can't stand behind, and it does not zero the
// balance outright: it subtracts what was paid, so a genuine shortfall stays
// owing instead of being silently written off.
function paymentEffect(booking, amountPaid, kind, meta) {
  const b = booking || {};
  if (kind === 'balance') {
    const owed = Math.max(0, Number(b.balance_due) || 0);
    const metaUsable = !!meta
      && Number.isFinite(meta.balance) && meta.balance >= 0
      && Number.isFinite(meta.fee) && meta.fee >= 0
      && Math.abs(meta.balance + meta.fee - amountPaid) <= 0.005;

    const result = {
      kind: 'balance',
      deposit_paid: b.deposit_paid === true,
      deposit_amount: Number(b.deposit_amount) || 0,
      payment_method: b.payment_method || '',
      status: b.status || 'confirmed',
      logAction: 'Balance paid via Stripe',
    };
    if (metaUsable) {
      result.balance_due = Math.max(0, round2(owed - meta.balance));
      result.itemised = true;
      result.balance = meta.balance;
      result.fee = meta.fee;
    } else {
      result.balance_due = Math.max(0, round2(owed - amountPaid));
      result.itemised = false;
      result.warning = `balance payment metadata unusable — amountPaid=${amountPaid} owed=${owed} ` +
        `meta.balance=${meta?.balance} meta.fee=${meta?.fee}`;
    }
    return result;
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

// Chooses the balance-receipt subject and framing-sentence tail. Pure and
// separate from paymentEffect so the copy DECISION — not the HTML — can be
// tested without a database or SMTP.
//
// A balance payment doesn't always zero balance_due (see paymentEffect's
// comment: a quote raised after the link was minted, or metadata Stripe
// couldn't confirm, can leave a genuine shortfall). Telling the client
// "settled in full" while balance_due still shows money owed misleads them
// into thinking they can stop paying, while the admin email's Balance Due
// row would show the truth — the same booking, two different stories.
function balanceReceiptCopy(effect) {
  if (effect.balance_due === 0) {
    return {
      subject: "Payment received — you're all paid up! 🎉 Funky Monkey Events",
      headline: "is settled in full.",
    };
  }
  return {
    subject: "Payment received — Funky Monkey Events",
    headline: `still has $${effect.balance_due.toFixed(2)} outstanding — we'll follow up about the remaining balance.`,
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
      // Separate pair for balance payments — sharing the deposit's pair meant
      // a balance payment overwrote the deposit's session/intent id, so a
      // retried deposit-webhook delivery (Stripe retries up to ~3 days) would
      // pass the idempotency guard and re-run the deposit branch on an
      // already-paid, already-completed booking. It also destroyed the
      // pointer used to refund the deposit.
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_session_id VARCHAR(255)");
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_payment_intent_id VARCHAR(255)");

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
          // IDEMPOTENT: if we've already processed this session, skip.
          // Checks both pairs — a balance session id lives in its own
          // columns now, not the deposit's.
          if (booking.stripe_session_id === sessionId || booking.stripe_balance_session_id === sessionId) {
            console.log(`Webhook: already processed session ${sessionId} for booking ${booking.reference}`);
            return { statusCode: 200, headers: h, body: JSON.stringify({ received: true, note: "already processed" }) };
          }

          // create-stripe-link.js stamps metadata[payment_kind]. Anything
          // else — including every session minted before that existed — is a
          // deposit, which is what this handler always assumed.
          const kind = session.metadata?.payment_kind === 'balance' ? 'balance' : 'deposit';

          // create-stripe-link.js also stamps the balance/fee split into
          // metadata.balance_amount / metadata.fee_amount for a balance
          // link. Parsed here rather than derived from booking.balance_due,
          // which paymentEffect() cannot trust for this (see its comment).
          const metaBalance = numOrNull(session.metadata?.balance_amount);
          const metaFee     = numOrNull(session.metadata?.fee_amount);
          const meta = (metaBalance !== null && metaFee !== null)
            ? { balance: metaBalance, fee: metaFee } : null;

          const effect = paymentEffect(booking, amountPaid, kind, meta);
          const balanceDue = effect.balance_due;
          const isDeposit = effect.kind === 'deposit';

          if (effect.kind === 'balance' && !effect.itemised) {
            console.error(`Webhook: balance payment ${sessionId} for booking ${booking.reference} (id:${booking.id}) could not be itemised — ${effect.warning}`);
          }

          const updated = await c.query(
            `UPDATE bookings
             SET deposit_paid=$1,
                 deposit_paid_at = CASE WHEN $2::boolean THEN NOW() ELSE deposit_paid_at END,
                 deposit_amount=$3,
                 payment_method=$4,
                 status=$5,
                 stripe_session_id = CASE WHEN $2::boolean THEN $6 ELSE stripe_session_id END,
                 stripe_payment_intent_id = CASE WHEN $2::boolean THEN $7 ELSE stripe_payment_intent_id END,
                 stripe_balance_session_id = CASE WHEN $2::boolean THEN stripe_balance_session_id ELSE $6 END,
                 stripe_balance_payment_intent_id = CASE WHEN $2::boolean THEN stripe_balance_payment_intent_id ELSE $7 END,
                 balance_due=$8
             WHERE id=$9
             RETURNING *`,
            [effect.deposit_paid, isDeposit, effect.deposit_amount,
             effect.payment_method, effect.status, sessionId, paymentIntentId,
             balanceDue, booking.id]
          );
          const b = updated.rows[0];
          await logChange(c, b.id, effect.logAction,
            effect.kind === 'balance'
              ? (effect.itemised
                  ? `$${amountPaid.toFixed(2)} (balance $${effect.balance.toFixed(2)} + service fee $${effect.fee.toFixed(2)})`
                  : `$${amountPaid.toFixed(2)} (not itemised: ${effect.warning})`)
              : `$${amountPaid.toFixed(2)}`);

          const dateStr  = fmtEventDate(b.event_date);
          const timeStr  = b.event_time     || "";
          const locStr   = b.event_location || b.event_zip || "OKC";

          // Client email — a balance receipt is not a deposit confirmation.
          // Sending the existing "You're CONFIRMED!" copy to someone settling
          // up after their event reads as if we had lost track of them.
          if (effect.kind === 'balance') {
            // Which subject/framing sentence: "settled in full" is only true
            // when this payment actually zeroed the balance. See
            // balanceReceiptCopy's comment for why that isn't guaranteed.
            const { subject, headline } = balanceReceiptCopy(effect);
            // Only print a Balance / Service-fee breakdown when it came from
            // Stripe-signed metadata. Otherwise state just the amount
            // received — a fabricated split is worse than none.
            const breakdownRows = effect.itemised
              ? `<tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${effect.balance.toFixed(2)}</td></tr>
                 <tr><td style="padding:4px 0;color:#A78BCA">Service fee (5%)</td><td style="padding:4px 0;text-align:right">$${effect.fee.toFixed(2)}</td></tr>
                 <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total paid</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>`
              : `<tr><td style="padding:4px 0;font-weight:900">Amount received</td><td style="padding:4px 0;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>`;
            try {
              const res = await sendEmail(b.client_email, subject,
                wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(b.client_name)}</strong>! 🎉</p>
                  <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you — your balance for <strong style="color:#F3E8FF">${esc(b.service_name)}</strong> ${headline}</p>
                  <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
                    <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
                      ${breakdownRows}
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
              wrap(`<p style="font-size:15px;font-weight:700;color:#10B981;margin-bottom:16px">💰 Stripe ${effect.kind === 'balance' ? 'balance payment received!' : 'deposit received — booking auto-confirmed!'}</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:130px">Ref</td><td style="padding:7px 0;color:#FFD600;font-weight:700">${esc(b.reference)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Client</td><td style="padding:7px 0;font-weight:700">${esc(b.client_name)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</td><td style="padding:7px 0">${esc(b.service_name)}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date</td><td style="padding:7px 0">${dateStr}${timeStr ? " at " + esc(timeStr) : ""}</td></tr>
                  <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">${effect.kind === 'balance' ? 'Balance Paid' : 'Deposit Paid'}</td><td style="padding:7px 0;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>
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
module.exports.balanceReceiptCopy = balanceReceiptCopy;
