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
const EMAIL_SHAPE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Postgres raises 22001 on an over-length value and the whole request 502s
// with nothing to tell the client which field was at fault. Rejecting names
// the field (via `rejected[]`, which the client page already surfaces);
// truncating would silently store something they did not type — the exact
// bug class this file exists to prevent. Widths match the VARCHAR columns in
// bookings.js; event_location and notes are TEXT columns with no DB-enforced
// cap, so 5000 is a sanity limit, not a schema mirror.
const MAX_LEN = {
  client_name: 255, client_phone: 50, client_email: 255,
  event_time: 10, event_zip: 10, event_location: 5000,
  venue: 255, surface_type: 64, child_name: 255,
  guests_of_honour: 255, notes: 5000,
};

// Postgres INTEGER overflows at 2147483647 and raises 22003. A guest count
// above this is a typo, not a party.
const GUEST_COUNT_MAX = 100000;

function sanitiseClientEdit(body) {
  const fields = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!CLIENT_EDITABLE.includes(k)) { rejected.push(k); continue; }
    if (k === 'guest_count') {
      // Number('') and Number(null) are both 0 — finite, non-negative, and
      // silently wrong. Only a genuine integer, as a number or a digit string,
      // is a guest count. Everything else is a rejection, because this figure
      // multiplies per-guest add-on prices.
      if (typeof v !== 'number' && typeof v !== 'string') { rejected.push(k); continue; }
      const t = String(v).trim();
      // An empty box is absence, not a rejected edit — the client simply did
      // not fill it in. Omitted without complaint; anything else non-numeric
      // is reported.
      if (t === '') continue;
      if (!/^\d+$/.test(t)) { rejected.push(k); continue; }
      const n = Number(t);
      if (n > GUEST_COUNT_MAX) { rejected.push(k); continue; }
      fields[k] = n;
      continue;
    }
    if (k === 'client_email') {
      const e = String(v || '').trim().toLowerCase();
      if (!EMAIL_SHAPE.test(e)) { rejected.push(k); continue; }
      if (MAX_LEN[k] && e.length > MAX_LEN[k]) { rejected.push(k); continue; }
      fields[k] = e;
      continue;
    }
    // Everything else is free text. A non-string here is not a user typing
    // something odd, it is a malformed request — and node-postgres would
    // stringify an object into the column rather than refusing it, so the
    // wrong type lands looking plausible.
    if (typeof v !== 'string') { rejected.push(k); continue; }
    if (MAX_LEN[k] && v.length > MAX_LEN[k]) { rejected.push(k); continue; }
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
