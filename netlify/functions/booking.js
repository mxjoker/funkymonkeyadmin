const { Client } = require("pg");
const { wrap, render, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog, ensureBookingChanges, logChange } = require('./_email');
const { notifyMatchingStaff } = require('./staff-assignments');

const db = () => new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PATCH,DELETE,OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const id = event.path.split("/").pop();
  if (!id || isNaN(parseInt(id))) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid ID" }) };

  const c = db();
  try {
    await c.connect();
    await ensureEmailLog(c);
    await ensureBookingChanges(c);

    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.activity !== 'true') {
        return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };
      }
      const { rows: changes } = await c.query(
        `SELECT id, action, detail, created_at FROM booking_changes
         WHERE booking_id=$1 ORDER BY created_at DESC`,
        [parseInt(id)]
      );
      return { statusCode: 200, headers: h, body: JSON.stringify({ changes }) };
    }

    if (event.httpMethod === "PATCH") {
      const u = JSON.parse(event.body || "{}");

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
      };

      // Fetch old status for change log (only when a status change is incoming)
      let prevStatus = null;
      if (u.status) {
        const prev = await c.query('SELECT status FROM bookings WHERE id=$1', [parseInt(id)]);
        prevStatus = prev.rows[0]?.status || '?';
      }

      const sets = [], vals = [];
      let idx = 1;
      for (const [k, col] of Object.entries(colMap)) {
        if (u[k] !== undefined) { sets.push(`${col}=$${idx}`); vals.push(u[k]); idx++; }
      }

      if (!sets.length) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "No fields to update" }) };

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

      vals.push(parseInt(id));
      const r = await c.query(
        `UPDATE bookings SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
        vals
      );
      if (!r.rows.length) return { statusCode: 404, headers: h, body: JSON.stringify({ error: "Not found" }) };

      let updated = r.rows[0];
      let stripeLink = null;

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
        const sent = await fireStatusAutomations(c, updated, u.status, stripeLink);
        console.log(`Fired ${sent} automation(s) for status=${u.status} booking=${updated.reference}`);
      }

      // Log high-signal changes to booking_changes
      if (u.status && prevStatus !== u.status) {
        await logChange(c, parseInt(id), 'Status changed', `${prevStatus} → ${u.status}`);
      }
      if (u.payment_amount !== undefined && u.payment_method !== undefined) {
        const amt = `$${Number(u.payment_amount).toFixed(2)} ${u.payment_method}`;
        const ref = u.payment_ref ? ` — Ref: ${u.payment_ref}` : '';
        await logChange(c, parseInt(id), 'Payment recorded', amt + ref);
      }
      if (u.contract_signed !== undefined || u.contractSigned !== undefined) {
        const signed = u.contract_signed ?? u.contractSigned;
        await logChange(c, parseInt(id), signed ? 'Contract signed' : 'Contract unsigned', '');
      }
      if (u.admin_notes !== undefined) {
        await logChange(c, parseInt(id), 'Admin notes updated', '');
      }

      return { statusCode: 200, headers: h, body: JSON.stringify(updated) };
    }

    if (event.httpMethod === "DELETE") {
      await c.query("DELETE FROM bookings WHERE id=$1", [parseInt(id)]);
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch(e) {
    console.error("booking.js error:", e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  } finally {
    await c.end();
  }
};
