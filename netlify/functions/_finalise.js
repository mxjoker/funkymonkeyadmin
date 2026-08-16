// netlify/functions/_finalise.js — what a client is allowed to change about
// their own booking, and how we notice when that changes the price.
//
// The whitelist is the security boundary for a page authenticated by nothing
// stronger than a booking reference and an email address. Everything absent
// from it is REJECTED and reported, never quietly dropped: a client who edits
// a field and is told "saved" while it was discarded is the silent-failure
// shape this codebase has eighteen documented instances of.

// Deliberately excludes every field that carries money (total_price,
// deposit_amount, balance_due, service_price, mileage_cost, items), workflow
// state (status, deposit_paid), anything internal (admin_notes), and the
// identifiers the auth check itself relies on (id, reference, client_email is
// editable but see the note in finalise.js about re-authentication).
const CLIENT_EDITABLE = Object.freeze([
  'client_name', 'client_phone', 'client_email',
  'event_time', 'event_location', 'event_zip', 'venue', 'surface_type',
  'guest_count', 'child_name', 'guests_of_honour', 'notes',
]);

// Two editable fields have types that matter.
//
// guest_count feeds per-guest add-on pricing, so "lots" must be a rejection
// rather than a NaN that silently zeroes a line.
//
// client_email is half the authentication key. A malformed one does not just
// store bad data — it locks the client out of their own booking AND sends the
// re-issued link into the void, so it is rejected here rather than discovered
// later. Deliberately a shape check, not a validity check: we cannot know if an
// address exists, and rejecting unusual-but-legal addresses would be worse than
// accepting a typo the re-issue notice will surface anyway.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitiseClientEdit(body) {
  const fields = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!CLIENT_EDITABLE.includes(k)) { rejected.push(k); continue; }
    if (k === 'guest_count') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { rejected.push(k); continue; }
      fields[k] = Math.trunc(n);
      continue;
    }
    if (k === 'client_email') {
      const e = String(v || '').trim().toLowerCase();
      if (!EMAIL_SHAPE.test(e)) { rejected.push(k); continue; }
      fields[k] = e;
      continue;
    }
    fields[k] = v;
  }
  return { fields, rejected };
}

// Mileage and travel cost are calculated from event_zip, so a client moving the
// event to a different ZIP after being quoted has changed what the job costs.
// We do not re-price (Joe's ruling 2026-08-15) — we tell a human. Filling in a
// ZIP that was previously empty is the page doing its job, not a re-quote.
function zipChanged(prev, next) {
  const from = String((prev && prev.event_zip) || '').trim().slice(0, 5);
  const to   = String((next && next.event_zip) || '').trim().slice(0, 5);
  if (!from || !to || from === to) return { changed: false, from, to };
  return { changed: true, from, to };
}

module.exports = { CLIENT_EDITABLE, sanitiseClientEdit, zipChanged };
