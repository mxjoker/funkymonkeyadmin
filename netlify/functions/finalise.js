// netlify/functions/finalise.js — the client's own booking, theirs to complete.
//
// Authenticated exactly as my-booking.html and accept-quote.js already are:
// booking reference plus the client email stored on that booking, 404 on any
// mismatch without revealing whether the reference exists. That is a modest
// bar, and it is the same bar that already gates accept-quote — which commits
// a client to a quote — so this adds no new exposure. It does mean anyone
// forwarded the email can edit; see the ponytail note at the bottom.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const { wrap, esc, sendEmail, logChange, ensureBookingChanges, ensureEmailLog, finaliseLinkFor } = require('./_email');
const { normaliseAddress } = require('./_address');
const { sanitiseClientEdit, zipChanged } = require('./_finalise');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

// Wider than bookings.js PUBLIC_FIELDS on purpose: a client's own phone number
// is not public data, but it is data they must be able to correct. Kept as its
// own list rather than widening PUBLIC_FIELDS, which is a published contract
// every other public consumer reads.
const FINALISE_FIELDS = [
  'reference', 'status', 'service_name', 'event_date', 'event_type',
  'client_name', 'client_phone', 'client_email',
  'event_time', 'event_location', 'event_zip', 'venue', 'surface_type',
  'guest_count', 'child_name', 'guests_of_honour', 'notes',
  'total_price', 'deposit_amount', 'balance_due', 'deposit_paid',
  'stripe_payment_link',
];

function buildFinaliseResponse(row) {
  const out = {};
  for (const f of FINALISE_FIELDS) out[f] = row[f] ?? (typeof row[f] === 'number' ? 0 : '');
  // An absent link must read as absent so the page can say "we'll send this
  // shortly" rather than rendering a button that goes nowhere.
  out.stripe_payment_link = row.stripe_payment_link || '';
  return out;
}

// Shared auth. Returns the row or null; the caller 404s either way so a
// wrong reference and a wrong email are indistinguishable from outside.
async function authenticate(c, reference, email) {
  const { rows } = await c.query('SELECT * FROM bookings WHERE reference = $1', [String(reference || '').toUpperCase()]);
  if (!rows.length) return null;
  if ((rows[0].client_email || '').toLowerCase() !== String(email || '').trim().toLowerCase()) return null;
  return rows[0];
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    return withClient(async (c) => {
      const booking = await authenticate(c, qs.reference, qs.email);
      if (!booking) return json(404, { error: 'Booking not found' });
      return json(200, { booking: buildFinaliseResponse(booking) });
    });
  }

  if (event.httpMethod === 'PATCH' || event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const { reference, email, updates } = body;

    return withClient(async (c) => {
      await ensureBookingChanges(c);
      await ensureEmailLog(c);

      const booking = await authenticate(c, reference, email);
      if (!booking) return json(404, { error: 'Booking not found' });

      // A booking already paid for is finished being finalised. Editing it here
      // would change details the crew may already be working from.
      if (booking.deposit_paid) {
        return json(409, { error: 'This booking is already confirmed. Call us on (405) 431-6625 to change anything.' });
      }

      const { fields, rejected } = sanitiseClientEdit(updates);
      if (rejected.length) console.error('finalise: rejected fields for', booking.reference, '|', rejected.join(', '));
      if (!Object.keys(fields).length) return json(400, { error: 'Nothing to save', rejected });

      // Keep the ZIP out of the address line, same as every other writer.
      if (fields.event_location !== undefined || fields.event_zip !== undefined) {
        const addr = normaliseAddress(
          fields.event_location !== undefined ? fields.event_location : booking.event_location,
          fields.event_zip      !== undefined ? fields.event_zip      : booking.event_zip
        );
        if (fields.event_location !== undefined) fields.event_location = addr.location;
        if (fields.event_zip !== undefined) fields.event_zip = addr.zip;
      }

      const keys = Object.keys(fields);
      const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
      const { rows } = await c.query(
        `UPDATE bookings SET ${sets}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
        [...keys.map(k => fields[k]), booking.id]
      );
      const updated = rows[0];

      for (const k of keys) {
        if (String(booking[k] ?? '') !== String(updated[k] ?? '')) {
          await logChange(c, booking.id, 'Client finalised details', `${k}: "${booking[k] ?? ''}" → "${updated[k] ?? ''}"`);
        }
      }

      // The ZIP prices the job. Changing it does NOT re-price (Joe's ruling
      // 2026-08-15) — a client watching their total move mid-checkout is the
      // worst moment for it. Tell a human and let them decide.
      const zip = zipChanged(booking, updated);
      if (zip.changed) {
        await logChange(c, booking.id, 'ZIP changed by client — price NOT recalculated', `${zip.from} → ${zip.to}`);
        try {
          await sendEmail(NOTIFY,
            `⚠ ZIP changed after quote — ${updated.reference}`,
            wrap(`<h2>The client moved the event</h2>
              <p><strong>${esc(updated.client_name || 'A client')}</strong> changed the ZIP on <strong>${esc(updated.reference)}</strong> while finalising their details.</p>
              <p><strong>Quoted from:</strong> ${esc(zip.from)}<br/><strong>Now:</strong> ${esc(zip.to)}</p>
              <p><strong>Address:</strong> ${esc(updated.event_location || '')}</p>
              <p>The total is unchanged at $${Number(updated.total_price || 0).toFixed(2)} — mileage was <em>not</em> recalculated. Re-quote if the drive is materially different.</p>
              <a href="${SITE}/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>`));
        } catch (e) {
          // The save has committed and is what matters. A failed alert must not
          // 500 the client or undo their edit — but it must be loud, because a
          // silent one means a price nobody rechecked.
          console.error('finalise: ZIP-change alert FAILED for', updated.reference, '|', e.message);
        }
      }

      // ── The email changed, so the link they are holding is now dead ────────
      // client_email is half the authentication key: the link in their inbox
      // carries the OLD address and will 404 from here on. Re-issue to the new
      // one (Joe's ruling 2026-08-15).
      //
      // The notice to the OLD address is not a courtesy — it is the only
      // control this flow has. Auth is a reference plus an email, so anyone
      // forwarded the original message could change the contact address and
      // quietly take over the booking. Telling the previous address means that
      // cannot happen silently. Send it FIRST: it is the one with a security
      // job, and it must not be skipped if the second send throws.
      const emailChanged = keys.includes('client_email') &&
        (booking.client_email || '').toLowerCase() !== (updated.client_email || '').toLowerCase();

      if (emailChanged) {
        await logChange(c, booking.id, 'Client changed their email — link re-issued',
          `${booking.client_email || '(none)'} → ${updated.client_email}`);

        if (booking.client_email) {
          try {
            await sendEmail(booking.client_email,
              `Contact email changed on your booking — ${updated.reference}`,
              wrap(`<h2>Your contact email was changed</h2>
                <p>The email address on booking <strong>${esc(updated.reference)}</strong> was just changed to <strong>${esc(updated.client_email)}</strong>.</p>
                <p><strong>If this was you, nothing further is needed</strong> — your new link has been sent to that address.</p>
                <p>If it was not you, call us straight away on <a href="tel:+14054316625">(405) 431-6625</a>.</p>`));
          } catch (e) {
            console.error('finalise: old-address change notice FAILED for', updated.reference, '|', e.message);
          }
        }

        try {
          await sendEmail(updated.client_email,
            `Your updated booking link — ${updated.reference}`,
            wrap(`<h2>Here is your new link</h2>
              <p>Your contact email is now <strong>${esc(updated.client_email)}</strong>, so your previous link no longer works. Use this one from now on:</p>
              <p><a href="${finaliseLinkFor(updated)}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open my booking</a></p>`));
        } catch (e) {
          // The change has committed and their page keeps working for this
          // session (Task 4 Step 4 updates it in place). A failed re-issue
          // means only that they have no link for NEXT time — loud, not fatal.
          console.error('finalise: link re-issue FAILED for', updated.reference, '|', e.message);
        }
      }

      // emailChanged tells the page to update the key it authenticates with,
      // so the client can carry on saving without a reload.
      return json(200, { success: true, booking: buildFinaliseResponse(updated), rejected, emailChanged });
    });
  }

  return json(405, { error: 'Method not allowed' });
};

// ponytail: auth is reference + email, matching the two client-facing endpoints
// that already exist. Anyone forwarded the email can therefore edit the booking.
// Acceptable because the same key already gates accept-quote, the editable set
// carries no money, and every change is written to booking_changes. Upgrade to a
// signed expiring token if bookings ever carry anything more sensitive.
module.exports.handler = exports.handler;
module.exports.buildFinaliseResponse = buildFinaliseResponse;
module.exports.FINALISE_FIELDS = FINALISE_FIELDS;
