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
const { sanitiseClientEdit, CLIENT_EDITABLE, zipChanged, describeFieldChange } = require('./_finalise');
const { emailMatches } = require('./finalise');
const { sendTemplate } = require('./automations');
const { logChange, esc, fmtEventDate } = require('./_email');

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

// `id` is here for Phase 4's anchor (see campAsBooking) — buildCampView
// ignores it.
async function daysFor(c, campId) {
  const { rows } = await c.query(
    'SELECT id, event_date, contract_signed FROM bookings WHERE camp_id = $1 ORDER BY event_date',
    [campId]
  );
  return rows;
}

// ── Phase 4: telling people what happened ─────────────────────────────────
//
// Until this, a client could fill in the whole camp form and hear nothing
// back, and a camp could be moved to a different town without anyone being
// told. A single booking's finalise has sent both since August; the camp path
// sent neither. Everything here mirrors finalise.js rather than inventing a
// second scheme, and reuses three of its four templates unchanged.

// A camp shaped like a booking, so render() and sendTemplate() work on it
// untouched — the same trick generate-invoice.js uses for the camp invoice.
//
// `id` is the camp's FIRST DAY, not the camp. email_log.booking_id and
// booking_changes.booking_id are both INTEGER NOT NULL pointing at bookings,
// and the first day is the anchor row groupBookingsByCamp already uses for
// every sortable column. Without it these emails would send and appear in no
// log at all. A camp with no days has no anchor and logs nothing —
// sendTemplate already handles a booking with no id.
function campAsBooking(camp, days) {
  const dated = (days || []).filter(d => d.event_date)
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const anchor = dated[0] || (days || [])[0];
  return {
    ...camp,
    id: anchor ? anchor.id : undefined,
    event_date: dated.length ? dated[0].event_date : null,
    // What the admin alert prints as the camp's name.
    service_name: camp.label || '',
    // Explicit, so render() and sendTemplate's SMS branch cannot read a stray
    // truthy value off a camp row: a camp takes no deposit, and SMS consent is
    // a question asked of a booking, never of a camp.
    deposit_amount: 0,
    sms_consent: false,
  };
}

function campDatesLabel(days) {
  const dates = (days || []).map(d => d.event_date).filter(Boolean)
    .map(d => String(d)).sort();
  if (!dates.length) return 'no dates yet';
  const fmt = (d) => fmtEventDate(d, { weekday: undefined, month: 'short', day: 'numeric' });
  return dates[0] === dates[dates.length - 1]
    ? fmt(dates[0])
    : `${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}`;
}

// Runs AFTER the commit. The save is what matters; no failure here may undo a
// client's edit or 500 their page, so every send is caught on its own — but
// loudly, because a silent one means a camp moved and nobody knows.
async function notifyCampSaved(c, { camp, updatedCamp, days, keys, emailChanged, addrConflict }) {
  const forEmail = campAsBooking(updatedCamp, days);

  // Reused for the client's receipt below. client_email is left out: a change
  // to it is already the subject of the two emails the email-change flow
  // sends, and a third mention would be noise. Same rule as finalise.js.
  const changesForEmail = [];
  for (const k of keys) {
    if (String(camp[k] ?? '') === String(updatedCamp[k] ?? '')) continue;
    if (forEmail.id) {
      await logChange(c, forEmail.id, 'Client finalised camp details',
        `${camp.reference}: ${k}: "${camp[k] ?? ''}" → "${updatedCamp[k] ?? ''}"`);
    }
    if (k !== 'client_email') changesForEmail.push(describeFieldChange(k, camp[k], updatedCamp[k]));
  }

  // ── The camp moved ────────────────────────────────────────────────────
  // Two ways it can happen, same as a booking: the client edited event_zip
  // directly, or edited only the address to one whose embedded ZIP disagrees
  // with the stored ZIP. Either one moved the camp; only watching the first
  // left the address-only path silent.
  const zip = zipChanged(camp, updatedCamp);
  if (zip.changed || addrConflict) {
    const detailParts = [];
    if (zip.changed) detailParts.push(`${zip.from} → ${zip.to}`);
    if (addrConflict) detailParts.push(`event_zip ${zip.changed ? `now ${updatedCamp.event_zip}` : `unchanged (${updatedCamp.event_zip})`} but ${addrConflict}`);
    if (forEmail.id) {
      await logChange(c, forEmail.id, 'Camp moved by client — every day affected',
        `${camp.reference}: ${detailParts.join('; ')}`);
    }

    const caseParts = [];
    if (zip.changed) caseParts.push(`<p><strong>Quoted from:</strong> ${esc(zip.from)}<br/><strong>Now:</strong> ${esc(zip.to)}</p>`);
    if (addrConflict) caseParts.push(zip.changed
      ? `<p>The address they entered also names a different ZIP than the one just saved: <strong>${esc(addrConflict)}</strong>.</p>`
      : `<p>The ZIP on file (<strong>${esc(updatedCamp.event_zip)}</strong>) was not changed, but the address they entered now names a different ZIP: <strong>${esc(addrConflict)}</strong>.</p>`);

    const changedWhat = zip.changed && addrConflict ? 'the ZIP and address' : zip.changed ? 'the ZIP' : 'the address';
    try {
      const r = await sendTemplate(c, forEmail, 'camp_moved_alert', null, {
        extra: {
          changed_what: changedWhat,
          zip_case: caseParts.join(''),
          camp_dates: campDatesLabel(days),
          day_count: `${days.length} day${days.length === 1 ? '' : 's'}`,
        },
      });
      if (!r.sent) console.error('finalise-camp: move alert not sent —', r.error);
    } catch (e) {
      console.error('finalise-camp: move alert FAILED for', camp.reference, '|', e.message);
    }
  }

  // ── Their email changed, so the link they hold is dead ────────────────
  // Auth is a reference plus an email, so anyone forwarded a camp link could
  // change the contact address and quietly take over a whole WEEK of
  // bookings. The notice to the previous address is the only control this
  // flow has, so it is sent first and never skipped by a later failure.
  if (emailChanged) {
    if (camp.client_email) {
      try {
        const r = await sendTemplate(c, forEmail, 'contact_email_changed', null, { to: camp.client_email });
        if (!r.sent) console.error('finalise-camp: old-address notice not sent —', r.error);
      } catch (e) {
        console.error('finalise-camp: old-address notice FAILED for', camp.reference, '|', e.message);
      }
    }
    // finaliseLinkFor() builds my-booking.html?ref=…&email=…, and that page
    // already routes a CAMP- reference to /api/finalise-camp itself — so
    // {{finalise_link}} resolves correctly here with no camp-specific code.
    const changesHtml = changesForEmail.length
      ? `<p style="margin-top:16px">They also updated:</p><ul>${changesForEmail.map(l => `<li>${l}</li>`).join('')}</ul>`
      : '';
    try {
      const r = await sendTemplate(c, forEmail, 'finalise_link_reissued', null,
        { extra: { change_block: changesHtml } });
      if (!r.sent) console.error('finalise-camp: link re-issue not sent —', r.error);
    } catch (e) {
      console.error('finalise-camp: link re-issue FAILED for', camp.reference, '|', e.message);
    }
    return;
  }

  // ── Per-save receipt ──────────────────────────────────────────────────
  // Reuses the booking template as-is: its wording is about a reference and a
  // list of changes, and {{reference}} reading CAMP-… makes it plain enough
  // what was updated. Only the move alert needed camp-specific copy, because
  // that one talks about price and mileage.
  if (changesForEmail.length) {
    try {
      const r = await sendTemplate(c, forEmail, 'booking_updated_receipt', null,
        { extra: { change_list: changesForEmail.map(l => `<li>${l}</li>`).join('') } });
      if (!r.sent) console.error('finalise-camp: change receipt not sent —', r.error);
    } catch (e) {
      console.error('finalise-camp: change receipt FAILED for', camp.reference, '|', e.message);
    }
  }
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
      let addrConflict = null;
      if (fields.event_location !== undefined || fields.event_zip !== undefined) {
        const addr = normaliseAddress(
          fields.event_location !== undefined ? fields.event_location : camp.event_location,
          fields.event_zip !== undefined ? fields.event_zip : camp.event_zip
        );
        // Same second signal finalise.js watches: the client can move the camp
        // by editing only the address, to one whose embedded ZIP disagrees
        // with the stored event_zip. normaliseAddress keeps the stored ZIP in
        // that case, so zipChanged() stays false and the camp has still moved.
        if (addr.conflict) {
          addrConflict = addr.conflict;
          console.error('finalise-camp: address/ZIP disagree on', camp.reference, '|', addr.conflict);
        }
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

        // Everything below is after the COMMIT on purpose, exactly as
        // finalise.js does it: the save is what matters, and no email failure
        // may undo a client's edit or 500 their page. Each send is caught
        // individually and reported loudly — a silent one means a camp moved
        // and nobody knows.
        await notifyCampSaved(c, { camp, updatedCamp, days, keys, emailChanged, addrConflict });

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
