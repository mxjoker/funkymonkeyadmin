// netlify/functions/finalise-camp.js — Phase 2 of "camps": one finalise form
// for a whole camp, instead of one per day.
//
// Authenticated exactly like finalise.js: camp reference plus the client
// email stored on that camp, 404 on any mismatch without revealing whether
// the reference exists. Same bar, same failure mode — see finalise.js's
// header for why that is an acceptable one.
//
// A camp's shared fields (contact details, address, venue, surface, one
// event time, notes) are written to the camp row AND every one of its days
// in a single transaction — all days or none. A half-updated camp is worse
// than an un-updated one, because nothing looks wrong until a day's
// client_email no longer matches the camp's and it 404s.
//
// Deliberately excluded from what a camp form can touch: guest_count (the
// per-kid headcount — Phase 3, collected after the camp ends, not a camp-wide
// field), child_name and guests_of_honour (birthday-party fields that mean
// nothing for a week of different families). CLIENT_EDITABLE and
// sanitiseClientEdit are reused, not re-implemented, so a field added there
// for bookings is filtered down here rather than needing a second allowlist
// to remember.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const { normaliseAddress } = require('./_address');
const { sanitiseClientEdit, CLIENT_EDITABLE } = require('./_finalise');
const { emailMatches } = require('./finalise');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const CAMP_EXCLUDED = new Set(['guest_count', 'child_name', 'guests_of_honour']);
const CAMP_EDITABLE = Object.freeze(CLIENT_EDITABLE.filter(f => !CAMP_EXCLUDED.has(f)));

// Shared auth, same shape as finalise.js's. Returns the camp row or null;
// the caller 404s either way so a wrong reference and a wrong email are
// indistinguishable from outside.
async function authenticateCamp(c, reference, email) {
  const ref = String(reference || '').trim().toUpperCase();
  if (!ref || !String(email || '').trim()) return null;
  const { rows } = await c.query('SELECT * FROM camps WHERE reference = $1', [ref]);
  if (!rows.length) return null;
  if (!emailMatches(rows[0].client_email, email)) return null;
  return rows[0];
}

const CAMP_VIEW_FIELDS = [
  'reference', 'label', 'client_name', 'client_phone', 'client_email',
  'event_location', 'event_zip', 'venue', 'surface_type', 'event_time', 'notes',
];

// `days` is every booking for this camp (event_date + contract_signed only —
// nothing money-shaped belongs on this page; that stays per-day until a
// later phase). contract_signed is reported as one state for the whole camp:
// booking.js keeps every day's value in lockstep the moment any one of them
// is toggled, so reading any single day (or requiring all, as here) agrees.
function buildCampView(camp, days) {
  const out = {};
  for (const f of CAMP_VIEW_FIELDS) out[f] = camp[f] ?? '';
  out.day_count = days.length;
  out.dates = days.map(d => d.event_date).filter(Boolean).sort();
  out.contract_signed = days.length > 0 && days.every(d => d.contract_signed === true);
  return out;
}

async function daysFor(c, campId) {
  const { rows } = await c.query(
    'SELECT event_date, contract_signed FROM bookings WHERE camp_id = $1 ORDER BY event_date',
    [campId]
  );
  return rows;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    return withClient(async (c) => {
      const camp = await authenticateCamp(c, qs.reference, qs.email);
      if (!camp) return json(404, { error: 'Camp not found' });
      const days = await daysFor(c, camp.id);
      return json(200, { camp: buildCampView(camp, days) });
    });
  }

  if (event.httpMethod === 'PATCH' || event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const { reference, email, updates } = body;

    return withClient(async (c) => {
      const camp = await authenticateCamp(c, reference, email);
      if (!camp) return json(404, { error: 'Camp not found' });

      const { fields, rejected } = sanitiseClientEdit(updates);
      // A camp does not share every field a single booking's finalise form
      // does — drop what's excluded even though CLIENT_EDITABLE allowed it,
      // and report it rather than silently discarding it (same rule as any
      // other rejection here).
      for (const k of Object.keys(fields)) {
        if (CAMP_EXCLUDED.has(k)) { delete fields[k]; rejected.push(k); }
      }
      if (rejected.length) console.error('finalise-camp: rejected fields for', camp.reference, '|', rejected.join(', '));
      if (!Object.keys(fields).length) return json(400, { error: 'Nothing to save', rejected });

      // Keep the ZIP out of the address line, same as finalise.js and every
      // other writer.
      if (fields.event_location !== undefined || fields.event_zip !== undefined) {
        const addr = normaliseAddress(
          fields.event_location !== undefined ? fields.event_location : camp.event_location,
          fields.event_zip !== undefined ? fields.event_zip : camp.event_zip
        );
        if (fields.event_location !== undefined) fields.event_location = addr.location;
        if (fields.event_zip !== undefined) fields.event_zip = addr.zip;
      }

      const keys = Object.keys(fields);
      const emailChanged = keys.includes('client_email') &&
        (camp.client_email || '').toLowerCase() !== fields.client_email.toLowerCase();

      // All days or none. The camp row and every day sharing its camp_id are
      // written inside one transaction — if the days' UPDATE fails, the
      // camp row's own change (client_email above all) must not survive
      // either, or the client's link (reference + email) would authenticate
      // against a camp whose days still expect the old address. See
      // calendar-sync.js:85 for the same client/BEGIN/COMMIT/ROLLBACK idiom.
      await c.query('BEGIN');
      try {
        const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
        const { rows: campRows } = await c.query(
          `UPDATE camps SET ${sets} WHERE id=$${keys.length + 1} RETURNING *`,
          [...keys.map(k => fields[k]), camp.id]
        );
        const updatedCamp = campRows[0];

        await c.query(
          `UPDATE bookings SET ${sets}, updated_at=NOW() WHERE camp_id=$${keys.length + 1}`,
          [...keys.map(k => fields[k]), camp.id]
        );

        await c.query('COMMIT');

        const days = await daysFor(c, camp.id);
        return json(200, { success: true, camp: buildCampView(updatedCamp, days), rejected, emailChanged });
      } catch (e) {
        await c.query('ROLLBACK');
        console.error('finalise-camp: save failed for', camp.reference, '|', e.message);
        return json(500, { error: 'Could not save — please try again or call us on (405) 431-6625.' });
      }
    });
  }

  return json(405, { error: 'Method not allowed' });
};

module.exports.handler = exports.handler;
module.exports.buildCampView = buildCampView;
module.exports.CAMP_EDITABLE = CAMP_EDITABLE;
module.exports.authenticateCamp = authenticateCamp;
