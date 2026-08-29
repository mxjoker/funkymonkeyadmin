const crypto = require("crypto");
const { withClient } = require('./_db');
const { logChange, ensureEmailLog, ensureBookingChanges } = require('./_email');
// _items.js is the single definition of the rate. The receipt states the
// percentage the client was charged, so it must read it from there rather than
// restate it — a literal here would print 5% beside a page charging something
// else the day the rate moves.
const { SERVICE_FEE_RATE } = require('./_items');
const { sendTemplate } = require('./automations');


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

// Promote a pre-payment status once nothing is owed: accounting-export.js counts
// revenue only for confirmed/completed and staff-assignments.js staffs only
// accepted/confirmed, so a booking that paid in full by balance link would
// otherwise be invisible to both. Never move a booking backwards, and never
// promote while a shortfall remains. These are exactly the statuses that sort
// before 'confirmed' in create-bookings.js's ALLOWED_STATUS, so promotion can
// only ever move a booking forwards — 'completed' and 'cancelled' are absent
// on purpose.
const PRE_PAYMENT = ['draft', 'review', 'quoted', 'accepted'];

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
      // What this payment contributed to bookings.service_fee_collected. Always
      // a number so the UPDATE needs no branching — 0 in the fallback below,
      // where the split is genuinely unknown and a guess would be worse than
      // nothing.
      fee: 0,
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
    // Reference the balance this branch just computed, not b.balance_due — they
    // differ precisely in the shortfall cases, which are the ones that must not
    // promote. deposit_paid is deliberately left alone: there was no deposit,
    // and claiming one was paid would be a second untruth.
    if (result.balance_due === 0 && PRE_PAYMENT.includes(b.status)) {
      result.status = 'confirmed';
    }
    return result;
  }
  const totalCents   = Math.round((parseFloat(b.total_price)  || 0) * 100);
  const mileageCents = Math.round((parseFloat(b.mileage_cost) || 0) * 100);
  const paidCents    = Math.round((Number(amountPaid) || 0) * 100);
  const recomputed = round2(Math.max(0, totalCents + mileageCents - paidCents) / 100);

  // THE INVARIANT: a payment can never increase what is owed. This branch
  // recomputes balance_due from scratch (total + mileage - amountPaid),
  // which is only correct when amountPaid is the one and only payment ever
  // made against the booking. It is not, whenever a deposit link is paid
  // after the balance was already settled elsewhere — Stripe links live 24h
  // (create-stripe-link.js), so a stale one being paid late is a real,
  // reachable window, not a hypothetical. Clamp to whichever is lower: the
  // recompute can only ever reduce what was owed, never raise it. Mirrors
  // the balance branch above, which computes relatively for the same reason.
  //
  // The clamp needs a trustworthy ceiling to clamp TO. bookings.js defaults
  // balance_due to 0 and create-bookings.js always computes it, so a
  // present-but-non-numeric value is an already-corrupt row, not a normal
  // case — `Number(b.balance_due) || 0` would silently read that as "$0
  // owed", wiping whatever was actually owed AND (paired with the flag
  // below) telling a human to refund a customer who may still owe the full
  // recomputed amount. Missing entirely (undefined/null/'') is the ordinary
  // "never priced yet" case and is fine to read as 0, same as before.
  const balanceDueRaw = b.balance_due;
  const balanceDueMissing = balanceDueRaw === undefined || balanceDueRaw === null || balanceDueRaw === '';
  const balanceDueUnparseable = !balanceDueMissing && !Number.isFinite(Number(balanceDueRaw));

  let balance_due, wouldRaise;
  if (balanceDueUnparseable) {
    // Can't apply an invariant against a number we don't have. Don't clamp
    // in either direction — keep the recomputed figure so nothing is
    // silently zeroed, and let the distinct log message below say why.
    balance_due = recomputed;
    wouldRaise = false;
  } else {
    const owed = Math.max(0, round2(Number(balanceDueRaw) || 0));
    wouldRaise = recomputed > owed + 0.005;
    balance_due = wouldRaise ? owed : recomputed;
  }

  // Status may only move FORWARD out of PRE_PAYMENT, same rule as the
  // balance branch's promotion above. It must never overwrite 'completed' or
  // 'cancelled' — that is exactly how a settled booking got un-settled: the
  // old code forced status to 'confirmed' unconditionally. Independent of
  // balance_due's parseability — a corrupt NUMERIC column says nothing
  // about whether status should regress.
  const wasPrePayment = PRE_PAYMENT.includes(b.status);
  const status = wasPrePayment ? 'confirmed' : (b.status || 'confirmed');
  // Would the old, unconditional 'confirmed' have demoted a real status?
  const wouldRegress = !wasPrePayment && b.status != null && b.status !== 'confirmed';

  const result = {
    kind: 'deposit',
    deposit_paid: true,
    deposit_amount: Number(amountPaid) || 0,
    payment_method: 'stripe',
    status,
    balance_due,
    // A deposit carries no service fee. Present so the UPDATE can accumulate
    // effect.fee unconditionally.
    fee: 0,
    logAction: 'Deposit paid via Stripe',
  };

  // Flag, never auto-refund (owner's call): a webhook that issues refunds on
  // an edge case nobody modelled is worse than the bug it fixes. wouldRaise
  // and wouldRegress are a genuine overpayment — the fix worked, and a human
  // should look at refunding it. balanceDueUnparseable is a DIFFERENT
  // problem — a corrupt row, not a confirmed overpayment — and must never
  // be reported as one; the two need different actions from whoever reads
  // the log (refund vs. fix the data), so they stay separate messages.
  if (wouldRaise || wouldRegress) {
    result.overpaymentFlagged = true;
    result.overpaymentAmount = Number(amountPaid) || 0;
  }
  if (balanceDueUnparseable) {
    result.balanceDueUnparseable = true;
  }

  return result;
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
// Which of the two balance receipts goes out. The wording itself lives in
// _templates.js and is editable in the Automations tab; the DECISION cannot be,
// because it is about what is true, not about how it reads.
function balanceReceiptCopy(effect) {
  return effect.balance_due === 0
    ? { template_key: 'balance_paid_receipt_full', outstanding: '0.00' }
    : { template_key: 'balance_paid_receipt_partial', outstanding: effect.balance_due.toFixed(2) };
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
      // The service fee is charged and shown to the client but was stored
      // nowhere queryable, so Stripe payouts could not be reconciled against
      // the books — they differ by exactly the fee on every balance payment.
      // bookings.js also adds it, but the UPDATE below writes it and a webhook
      // can fire before any bookings request has ever run.
      //
      // A record, never an input: it must not appear in any balance, total or
      // derivability calculation.
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_fee_collected NUMERIC(10,2) DEFAULT 0");
      // Set by paymentEffect's deposit branch when a payment would have
      // raised balance_due or regressed status — a stale deposit link paid
      // after the booking was already settled. Never cleared automatically:
      // this is a "look at me" flag for a manual refund (see the owner's
      // decision in paymentEffect's comment), not a state machine, so it
      // stays set until whoever resolves the refund clears it by hand.
      // Nullable: null/0 means "nothing unexplained here", non-null is both
      // the flag and the amount in one column — no separate boolean to drift
      // out of sync with it.
      await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overpayment_amount NUMERIC(10,2)");

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
                 balance_due=$8,
                 service_fee_collected = COALESCE(service_fee_collected, 0) + $9,
                 overpayment_amount = CASE WHEN $11::boolean THEN $12 ELSE overpayment_amount END
             WHERE id=$10
             RETURNING *`,
            [effect.deposit_paid, isDeposit, effect.deposit_amount,
             effect.payment_method, effect.status, sessionId, paymentIntentId,
             balanceDue, effect.fee, booking.id,
             effect.overpaymentFlagged === true, effect.overpaymentAmount ?? null]
          );
          const b = updated.rows[0];
          await logChange(c, b.id, effect.logAction,
            effect.kind === 'balance'
              ? (effect.itemised
                  ? `$${amountPaid.toFixed(2)} (balance $${effect.balance.toFixed(2)} + service fee $${effect.fee.toFixed(2)})`
                  : `$${amountPaid.toFixed(2)} (not itemised: ${effect.warning})`)
              : `$${amountPaid.toFixed(2)}`);

          // Flag, never auto-refund: see paymentEffect's comment for why.
          // This is a second, distinct changelog line from the one above —
          // that one is "a deposit was paid"; this one is "and it shouldn't
          // have been, because nothing was owed."
          if (effect.overpaymentFlagged) {
            await logChange(c, b.id, 'Unexpected deposit payment on a settled booking',
              `$${effect.overpaymentAmount.toFixed(2)} — the balance was NOT reopened; this likely needs refunding.`);
          }
          // A DIFFERENT problem from the one above — a corrupt balance_due,
          // not a confirmed overpayment. Keep it a separate message: this
          // one needs someone to fix the row's data, not issue a refund.
          if (effect.balanceDueUnparseable) {
            await logChange(c, b.id, 'balance_due could not be verified',
              `balance_due on this booking is not a number; the payment was applied ` +
              `but the balance could not be verified — check the row.`);
          }


          // Client email — a balance receipt is not a deposit confirmation.
          // Sending the existing "You're CONFIRMED!" copy to someone settling
          // up after their event reads as if we had lost track of them.
          //
          // Both bodies are rows in automation_rules now (see _templates.js).
          // What stays here is everything that is a FACT rather than wording:
          // which receipt is true, and what the money actually was.
          if (effect.kind === 'balance') {
            const { template_key, outstanding } = balanceReceiptCopy(effect);
            // Only print a Balance / Service-fee breakdown when it came from
            // Stripe-signed metadata. Otherwise state just the amount
            // received — a fabricated split is worse than none.
            const payment_breakdown = effect.itemised
              ? `<tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${effect.balance.toFixed(2)}</td></tr>
                 <tr><td style="padding:4px 0;color:#A78BCA">Service fee (${Math.round(SERVICE_FEE_RATE * 100)}%)</td><td style="padding:4px 0;text-align:right">$${effect.fee.toFixed(2)}</td></tr>
                 <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total paid</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>`
              : `<tr><td style="padding:4px 0;font-weight:900">Amount received</td><td style="padding:4px 0;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>`;
            const r = await sendTemplate(c, b, template_key, null,
              { extra: { payment_breakdown, outstanding } });
            if (!r.sent) console.error('Webhook: balance receipt not sent —', r.error);
          } else {
            const r = await sendTemplate(c, b, 'deposit_paid_receipt', null,
              { extra: { amount_paid: amountPaid.toFixed(2) } });
            if (!r.sent) console.error('Webhook: deposit receipt not sent —', r.error);
          }

          // Admin notification
          {
            const isBalance = effect.kind === 'balance';
            const r = await sendTemplate(c, b, 'payment_received_alert', null, {
              extra: {
                amount_paid: amountPaid.toFixed(2),
                payment_kind_label: isBalance ? 'Balance' : 'Deposit',
                payment_headline: isBalance
                  ? 'Stripe balance payment received!'
                  : 'Stripe deposit received — booking auto-confirmed!',
              }
            });
            if (!r.sent) console.error('Webhook: admin payment alert not sent —', r.error);
          }

          // Names what it actually moved. This log is the first thing read when
          // a payment goes missing, and calling every payment a deposit is how
          // a balance bug hides in it.
          console.log(`Webhook: confirmed booking ${b.reference} (id:${b.id}) — ${effect.kind} $${amountPaid} balance_due $${balanceDue}`);

        } else {
          console.warn(`Webhook: no booking matched — dbId:${bookingDbId} ref:${bookingRef} email:${customerEmail}`);
        }
      }

      // ── Payment failed ─────────────────────────
      if (ev.type === "payment_intent.payment_failed") {
        const pi = ev.data.object;
        const email = pi.last_payment_error?.payment_method?.billing_details?.email;
        if (email) {
          // No booking is looked up here — a failed intent often matches none —
          // so the row is empty and the address comes from Stripe. sendTemplate
          // skips the email_log write when there is no booking to attach it to.
          try {
            await withClient(async (c) => {
              const r = await sendTemplate(c, {}, 'payment_failed', null, { to: email });
              if (!r.sent) console.error('Webhook: payment-failed email not sent —', r.error);
            });
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
