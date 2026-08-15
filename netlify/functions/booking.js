const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized, forbidden } = require('./_auth');
const { wrap, render, sendEmail, logEmail, ensureEmailLog, ensureBookingChanges, logChange } = require('./_email');
const { triggerStatusChange } = require('./automations');
const { notifyMatchingStaff } = require('./staff-assignments');
const { ensureBookingItems, replaceItems, rollupItems, getItems, balanceIsDerivable, normaliseItems } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const SITE = "https://funkymonkeyadmin.netlify.app";

// ── Stripe Checkout Session ───────────────────────────────────────────────────
const createStripeLink = async (booking) => {
  if (!process.env.STRIPE_SECRET_KEY) return null;

  const amountCents = Math.round(Number(booking.deposit_amount || 100) * 100);
  if (!amountCents || amountCents < 50) {
    console.error("Invalid Stripe amount:", amountCents);
    return null;
  }

  const params = new URLSearchParams({
    "mode": "payment",
    "success_url": `${SITE}/booking-form.html?paid=1`,
    "cancel_url":  `${SITE}/booking-form.html?cancelled=1`,
    "customer_email": booking.client_email || "",
    "client_reference_id": booking.reference || String(booking.id),
    "metadata[booking_id]":    booking.reference || String(booking.id),
    "metadata[booking_db_id]": String(booking.id),
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": `${booking.service_name || 'Event'} — Deposit`,
    "line_items[0][price_data][product_data][description]": `Deposit · ${booking.event_date || ''} · ${booking.event_location || booking.event_zip || 'OKC'}`,
    "line_items[0][quantity]": "1",
    "payment_method_types[0]": "card",
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) { console.error("Stripe error:", JSON.stringify(data.error)); return null; }
    console.log("Stripe session created:", data.url, "booking:", booking.reference);
    return data.url || null;
  } catch(e) { console.error("Stripe error:", e.message); return null; }
};


// ── Handler ───────────────────────────────────────────────────────────────────
// What the activity log should say about a payment edit, or null when this
// PATCH is not one.
//
// Recording a payment and CLEARING a mis-keyed one arrive in the same shape —
// both send payment_amount and payment_method — so they are told apart by the
// values, not by the keys. Without this, clearing logged "Payment recorded
// $0.00", which reads as a real payment of nothing against a booking whose
// deposit just went back to unpaid. The previous amount is carried into the
// detail so the trail records what was undone, not merely that something was.
function paymentLogEntry(u, prev = {}) {
  if (u.payment_amount === undefined || u.payment_method === undefined) return null;

  if (!(Number(u.payment_amount) > 0) && !u.payment_method) {
    const had = Number(prev.payment_amount || 0) > 0
      ? `was $${Number(prev.payment_amount).toFixed(2)}${prev.payment_method ? ' ' + prev.payment_method : ''}`
      : 'no amount was recorded';
    return { action: 'Payment cleared', detail: had };
  }

  const ref = u.payment_ref ? ` — Ref: ${u.payment_ref}` : '';
  return {
    action: 'Payment recorded',
    detail: `$${Number(u.payment_amount).toFixed(2)} ${u.payment_method}${ref}`,
  };
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Validate ID before touching DB
  const id = event.path.split("/").pop();
  if (!id || isNaN(parseInt(id))) return json(400, { error: "Invalid ID" });

  // Auth: GET requires admin or staff; PATCH/DELETE requires admin
  if (event.httpMethod === "GET") {
    const auth = await requireAuth(event, ['admin', 'staff']);
    if (!auth) return unauthorized();
  } else if (event.httpMethod === "PATCH" || event.httpMethod === "DELETE") {
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();
  } else if (event.httpMethod !== "OPTIONS") {
    return json(405, { error: "Method not allowed" });
  }

  return withClient(async (c) => {
    try {
      await ensureEmailLog(c);
      await ensureBookingChanges(c);

      if (event.httpMethod === "GET") {
        if (event.queryStringParameters?.activity !== 'true') {
          return json(405, { error: "Method not allowed" });
        }
        const { rows: changes } = await c.query(
          `SELECT id, action, detail, created_at FROM booking_changes
           WHERE booking_id=$1 ORDER BY created_at DESC`,
          [parseInt(id)]
        );
        return json(200, { changes });
      }

      if (event.httpMethod === "PATCH") {
        const u = JSON.parse(event.body || "{}");

        // Normalise once, gate on this everywhere. normaliseItems drops
        // blank-name rows — an array of them must not pass as "non-empty"
        // just because the raw payload had entries; that is the exact quote
        // wipe the guard below exists to prevent. bookings.js:430 already
        // does it this way; this brings booking.js into agreement.
        const postedItems = Array.isArray(u.items) ? normaliseItems(u.items) : [];

        // A cleared <input> posts '' — Postgres rejects that for non-text
        // columns. Only touch keys actually present, so no null is invented.
        for (const f of ['event_date', 'confirmation_deadline', 'deposit_paid_at']) {
          if (f in u && u[f] === '') u[f] = null;
        }
        for (const f of ['guest_count', 'service_price', 'total_price',
                         'mileage_miles', 'mileage_cost', 'deposit_amount',
                         'balance_due', 'extra_hours', 'extra_hours_cost',
                         'payment_amount']) {
          if (f in u && u[f] === '') u[f] = null;
        }

        const colMap = {
          status:            "status",
          admin_notes:       "admin_notes",
          contract_signed:   "contract_signed",
          notes:             "notes",
          deposit_paid:      "deposit_paid",
          payment_method:    "payment_method",
          payment_amount:    "payment_amount",
          payment_note:      "payment_note",
          paymentMethod:     "payment_method",
          contractSigned:    "contract_signed",
          stripePaymentLink: "stripe_payment_link",
          event_type_id:     "event_type_id",
          is_custom_quote:   "is_custom_quote",
          extra_hours:       "extra_hours",
          extra_hours_cost:  "extra_hours_cost",
          deposit_amount:    "deposit_amount",
          balance_due:       "balance_due",
          confirmation_deadline: "confirmation_deadline",
          payment_ref:       "payment_ref",
          child_name:        "child_name",
          guests_of_honour:  "guests_of_honour",
          customer_type:     "customer_type",
          venue:             "venue",
          // ── Admin direct entry (spec 2026-08-01) ──
          event_date:        "event_date",
          event_time:        "event_time",
          event_location:    "event_location",
          event_zip:         "event_zip",
          event_type:        "event_type",
          guest_count:       "guest_count",
          client_name:       "client_name",
          client_phone:      "client_phone",
          client_email:      "client_email",
          referral_source:   "referral_source",
          service_id:        "service_id",
          service_name:      "service_name",
          service_price:     "service_price",
          total_price:       "total_price",
          mileage_miles:     "mileage_miles",
          mileage_cost:      "mileage_cost",
          surface_type:      "surface_type",
          organisation_name: "organisation_name",
          occasion:          "occasion",
          deposit_paid_at:   "deposit_paid_at",
          deposit_method:    "deposit_method",
          deposit_ref:       "deposit_ref",
        };

        // The whole previous row — field-level change logging below diffs
        // against it. One extra SELECT per PATCH, which is negligible next to
        // the traceability the spec asks for.
        const prevRes = await c.query('SELECT * FROM bookings WHERE id=$1', [parseInt(id)]);
        if (!prevRes.rows.length) return json(404, { error: "Not found" });
        const prev = prevRes.rows[0];
        const prevStatus = prev.status || '?';

        // Decided against the row as it stood BEFORE this request, so a caller
        // cannot make a balance derivable by editing it in the same PATCH.
        const canDeriveBalance = balanceIsDerivable(prev);

        // Captured before the BALANCE_INPUTS block below sets u.balance_due for
        // the benefit of the change-logging loop. Without this, the items block
        // cannot tell a value the caller sent from one this handler injected,
        // and would persist a balance derived from the pre-edit total_price.
        const explicitBalance = u.balance_due !== undefined;

        const sets = [], vals = [];
        let idx = 1;
        for (const [k, col] of Object.entries(colMap)) {
          if (u[k] !== undefined) { sets.push(`${col}=$${idx}`); vals.push(u[k]); idx++; }
        }

        // `items` never appears in colMap — it writes to booking_items, not to
        // a bookings column — so an items-only PATCH would be rejected here as
        // "No fields to update" before the items block below ever ran. The
        // admin quote builder sends exactly that shape, because it deletes the
        // derived money keys and lets rollupItems own them.
        const hasItems = postedItems.length > 0;
        if (!sets.length && !hasItems) return json(400, { error: "No fields to update" });

        // Add missing columns if needed (safe migration)
        const newCols = [
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmation_deadline DATE",
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_ref VARCHAR(255) DEFAULT ''",
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS child_name VARCHAR(255) DEFAULT ''",
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests_of_honour VARCHAR(255) DEFAULT ''",
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_type VARCHAR(64) DEFAULT ''",
          "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS venue VARCHAR(255) DEFAULT ''",
        ];
        for (const sql of newCols) { try { await c.query(sql); } catch(_) {} }

        // An items-only PATCH has no bookings columns to set. Skip the UPDATE
        // entirely rather than emitting `SET , updated_at=NOW()`; the items
        // block below writes the derived columns and bumps updated_at itself.
        let updated = prev;
        if (sets.length) {
          vals.push(parseInt(id));
          const r = await c.query(
            `UPDATE bookings SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
            vals
          );
          if (!r.rows.length) return json(404, { error: "Not found" });
          updated = r.rows[0];
        }
        let stripeLink = null;

        // total_price / mileage_cost / deposit_amount feed balance_due
        // (same formula as bookings.js:329 on create). If one of those
        // changed and the caller didn't send balance_due itself, recompute
        // it here — otherwise invoices and automation emails keep quoting
        // a stale balance. Do this before the field-level logging loop so
        // the recompute is logged like any other change.
        const BALANCE_INPUTS = ['total_price', 'mileage_cost', 'deposit_amount'];
        if (BALANCE_INPUTS.some(f => u[f] !== undefined) && u.balance_due === undefined) {
          if (!canDeriveBalance) {
            // This booking's balance was settled out-of-band. Recomputing would
            // re-bill a customer who has already paid. Leave it and leave a trail.
            await logChange(c, parseInt(id), 'Balance recompute skipped',
              `stored $${Number(prev.balance_due || 0).toFixed(2)} is not explained by ` +
              `total + mileage - deposit; left unchanged`);
          } else {
            const newBalance = Math.max(0,
              Number(updated.total_price || 0) + Number(updated.mileage_cost || 0) - Number(updated.deposit_amount || 0));
            const r3 = await c.query(
              `UPDATE bookings SET balance_due=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
              [newBalance, parseInt(id)]
            );
            updated = r3.rows[0];
            // Mark balance_due as "sent" so the field-level logging loop below
            // (which only inspects keys present in `u`) picks up the change.
            u.balance_due = newBalance;
          }
        }

        // ── Items (Phase 3) ────────────────────────────────────────────────
        // A supplied items array replaces the whole set and re-derives every
        // legacy money column. Runs before the Stripe-link block below so a
        // link generated on this same PATCH quotes the new deposit basis.
        // A non-empty array is required, not merely a present key. An empty
        // array would otherwise delete every item and zero total_price,
        // service_price, addon_total, mileage_cost and balance_due on a real
        // booking — so an admin form that PATCHed before its item rows loaded
        // would silently wipe a customer's quote. A genuine quote always has
        // at least one line, so nothing legitimate is lost by ignoring [].
        // The guard lives here, where every caller routes through, rather than
        // in the UI: trusting the caller is this codebase's documented
        // recurring failure mode.
        let items = null;
        if (postedItems.length > 0) {
          await ensureBookingItems(c);
          const before = await getItems(c, parseInt(id));
          items = await replaceItems(c, parseInt(id), postedItems);
          const roll = rollupItems(items);
          // An explicit balance_due from the caller is a decision, not a
          // derivation — it wins over both the formula and the "leave it"
          // fallback below. It's already been written by the initial UPDATE
          // above (balance_due is a colMap column), so `updated.balance_due`
          // already holds it; no skip log, because nothing was skipped.
          let newBalance;
          if (explicitBalance) {
            newBalance = Number(updated.balance_due || 0);
          } else if (canDeriveBalance) {
            newBalance = Math.max(0, roll.total_price + roll.mileage_cost - Number(updated.deposit_amount || 0));
          } else {
            newBalance = Number(updated.balance_due || 0);
            await logChange(c, parseInt(id), 'Balance recompute skipped',
              `quote edited, but stored $${Number(prev.balance_due || 0).toFixed(2)} is not ` +
              `explained by total + mileage - deposit; left unchanged`);
          }
          const r4 = await c.query(
            `UPDATE bookings SET service_id=$1, service_name=$2, service_price=$3,
                    addons=$4, addon_total=$5, mileage_cost=$6, total_price=$7,
                    balance_due=$8, updated_at=NOW()
             WHERE id=$9 RETURNING *`,
            [roll.service_id, roll.service_name, roll.service_price,
             JSON.stringify(roll.addons), roll.addon_total, roll.mileage_cost,
             roll.total_price, newBalance, parseInt(id)]
          );
          updated = r4.rows[0];

          // Traceability: the spec chose a child table over the addons JSONB
          // precisely so quote edits leave a trail. Log the whole before/after
          // line set, not just a count.
          const fmt = (list) => list.length
            ? list.map(i => `${i.name} x${i.quantity} $${Number(i.price).toFixed(2)}`).join('; ')
            : '—';
          if (fmt(before) !== fmt(items)) {
            await logChange(c, parseInt(id), 'Quote items changed', `${fmt(before)} → ${fmt(items)}`);
          }
        }

        // Auto-generate Stripe link when confirmed
        if (u.status === "confirmed") {
          const depositAmount = Number(updated.deposit_amount || 0);
          if (depositAmount > 0) {
            stripeLink = await createStripeLink(updated);
            if (stripeLink) {
              const r2 = await c.query(
                `UPDATE bookings SET stripe_payment_link=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
                [stripeLink, parseInt(id)]
              );
              updated = r2.rows[0];
            }
          } else {
            console.log(`Skipping Stripe link generation for booking ${updated.id} — deposit_amount is ${depositAmount}`);
          }

          // Auto-notify matching staff when booking is confirmed
          try {
            await notifyMatchingStaff(updated);
            console.log(`Auto-notified matching staff for booking ${updated.reference}`);
          } catch(e) {
            console.error(`Failed to auto-notify staff for booking ${updated.id}:`, e.message);
          }
        }

        // Fire automation rules — single clean path, no fallback duplication
        if (u.status && ["confirmed", "cancelled", "completed"].includes(u.status)) {
          const sent = await triggerStatusChange(c, updated, u.status, stripeLink);
          console.log(`Fired ${sent} automation(s) for status=${u.status} booking=${updated.reference}`);
        }

        // Log high-signal changes to booking_changes
        if (u.status && prevStatus !== u.status) {
          await logChange(c, parseInt(id), 'Status changed', `${prevStatus} → ${u.status}`);
        }
        const payLog = paymentLogEntry(u, prev);
        if (payLog) await logChange(c, parseInt(id), payLog.action, payLog.detail);
        if (u.contract_signed !== undefined || u.contractSigned !== undefined) {
          const signed = u.contract_signed ?? u.contractSigned;
          await logChange(c, parseInt(id), signed ? 'Contract signed' : 'Contract unsigned', '');
        }
        if (u.admin_notes !== undefined) {
          await logChange(c, parseInt(id), 'Admin notes updated', '');
        }

        // Field-level logging for everything the allowlist now accepts.
        // These five already have bespoke log lines above — skip them so a
        // single edit does not produce two rows. payment_ref is NOT here:
        // the bespoke "Payment recorded" block only fires when amount AND
        // method are both present, so a payment_ref-only edit needs this
        // loop to leave any trail at all. When all three are sent together
        // this produces a bespoke summary row plus a payment_ref-changed
        // row — acceptable redundancy against a silent gap.
        const LOGGED_ELSEWHERE = new Set([
          'status', 'admin_notes', 'contract_signed',
          'payment_method', 'payment_amount',
        ]);
        // pg returns DATE/TIMESTAMPTZ as JS Date objects (no type parsers
        // registered in _db.js), so String(Date) is a full GMT string —
        // fine for the equality check below (left untouched), unreadable
        // in the logged detail. Render Dates as their ISO date part for
        // display only; comparison still runs on the full String() value.
        const display = (s, v) => v instanceof Date ? v.toISOString().slice(0, 10) : s;
        for (const [k, col] of Object.entries(colMap)) {
          if (u[k] === undefined || LOGGED_ELSEWHERE.has(col)) continue;
          const before = prev[col], after = updated[col];
          const bs = before === null || before === undefined ? '' : String(before);
          const as = after  === null || after  === undefined ? '' : String(after);
          if (bs !== as) {
            const bd = before == null ? '' : display(bs, before);
            const ad = after  == null ? '' : display(as, after);
            await logChange(c, parseInt(id), `${col} changed`, `${bd || '—'} → ${ad || '—'}`);
          }
        }

        return json(200, items === null ? updated : { ...updated, items });
      }

      if (event.httpMethod === "DELETE") {
        await c.query("DELETE FROM bookings WHERE id=$1", [parseInt(id)]);
        return json(200, { success: true });
      }

      return json(405, { error: "Method not allowed" });

    } catch(e) {
      console.error("booking.js error:", e.message);
      return json(500, { error: "Internal server error" });
    }
  });
};

module.exports.paymentLogEntry = paymentLogEntry;
