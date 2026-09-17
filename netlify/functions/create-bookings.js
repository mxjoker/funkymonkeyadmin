/**
 * Create bookings WITHOUT sending any email — the backfill/import seam.
 *
 * POST /api/bookings emails the client ("Booking Request Received") and is the
 * public new-request path. This endpoint is its admin-only, no-email sibling:
 * it inserts already-known bookings (e.g. historical PPM gigs, CRM backfills)
 * with their real reference and status, and NEVER calls sendEmail. It does not
 * even require _email, so a client can never be mailed from here.
 *
 * Auth: admin only (the Booked Solid AGENT_API_TOKEN resolves to admin).
 * Body: { "bookings": [ {...}, ... ] }  OR a single {...} object.
 * Query: ?dryrun=true  -> validate + report, write nothing.
 *
 * Idempotent: a reference already in the table is skipped, never duplicated.
 * Each row provides CRM-native fields (status/brand already mapped by the caller).
 */

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const ALLOWED_STATUS = new Set(['draft', 'review', 'quoted', 'accepted', 'confirmed', 'completed', 'cancelled']);
// Shared with bookings.js so the admin direct-entry path and the public form
// cannot disagree about which brands exist. This file used to keep its own
// two-value set, which would have rejected 'fmms' while the public path
// silently swallowed it.
const { normaliseBrand } = require('./_brand');
// Who collected the money. Admin-only endpoint, so the caller is trusted here —
// unlike bookings.js, which is also the public form and gates this on the token.
const { sourceOf, platformBooked } = require('./_source');
// Same decider as import-bookings.js and _items.js. One mapping, three intakes.
const { resolveServiceId, norm, catalogueServiceIds } = require('./_service-map');


// Clamp a numeric to [0, 100000]; blank/invalid -> 0.
function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 100000);
}
const str = (v, max = 255) => String(v ?? '').trim().slice(0, max);
// An explicit id always wins; a name is only resolved when the caller sent no
// id at all. Never the reverse — a caller that names a catalogue service knows
// more than a string match does.
//
// Then the legacy PPM map, then the live catalogue. Both, in that order,
// because they answer different questions: the map knows retired names the
// catalogue has dropped ("Story Doodles"), the catalogue knows services the map
// was written too early to contain ("Game Show Champions"). Either alone leaves
// a hole, and this endpoint had neither.
const serviceIdFor = (b, catalogue) =>
  str(b.service_id, 64)
  || resolveServiceId(b.service_name)
  || catalogue.get(norm(b.service_name))
  || '';

function validate(b) {
  const errors = [];
  if (!str(b.reference, 20)) errors.push('reference required');
  if (!str(b.client_name, 120)) errors.push('client_name required');
  if (!b.event_date || isNaN(Date.parse(String(b.event_date)))) errors.push('event_date must be a parseable date');
  if (!ALLOWED_STATUS.has(String(b.status || '').trim())) errors.push(`status must be one of ${[...ALLOWED_STATUS].join('/')}`);
  try { normaliseBrand(b.brand); } catch (e) { errors.push(e.message); }
  return errors;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload.bookings) ? payload.bookings
    : [payload];
  if (!rows.length) return json(400, { error: 'no bookings in body' });
  if (rows.length > 200) return json(400, { error: 'max 200 bookings per call' });

  const dryRun = event.queryStringParameters?.dryrun === 'true';
  const result = { dryRun, total: rows.length, imported: 0, skipped: 0, errors: 0, unlinked: 0, details: [] };

  return withClient(async (client) => {
    // Once per request, not once per row: an import of 700 rows must not run
    // 700 catalogue queries.
    const catalogue = await catalogueServiceIds(client);

    for (const b of rows) {
      const ref = str(b.reference, 20);
      const errs = validate(b);
      if (errs.length) {
        result.errors++; result.details.push({ reference: ref || null, error: errs.join('; ') });
        continue;
      }
      // idempotent: never duplicate an existing reference
      const { rows: existing } = await client.query('SELECT id FROM bookings WHERE reference=$1', [ref]);
      if (existing.length) { result.skipped++; result.details.push({ reference: ref, skipped: 'already exists' }); continue; }

      // Computed before the dry-run exit so a preview reports exactly what a
      // real import would link — a preview that cannot show the gap is the
      // reason an unstaffable booking gets created in the first place.
      const serviceId = serviceIdFor(b, catalogue);
      if (!serviceId) { result.unlinked++; result.details.push({ reference: ref, unlinked_service: str(b.service_name) }); }
      if (dryRun) { result.imported++; result.details.push({ reference: ref, would_import: true, service_id: serviceId || null }); continue; }

      const total = num(b.total_price);
      const deposit = num(b.deposit_amount);
      const source = sourceOf(b);
      // A platform collected from the client, so nothing is owed to us. An
      // explicit balance_due still wins — a caller correcting a figure by hand
      // outranks a derivation, as everywhere else in this file.
      const balance = b.balance_due !== undefined ? num(b.balance_due)
        : (platformBooked({ source }) || String(b.status) === 'completed'
            ? 0
            : Math.max(0, total - deposit));

      const { rows: ins } = await client.query(`
        INSERT INTO bookings (
          reference, status, brand, service_id, service_name, service_price,
          addon_total, mileage_cost, total_price, deposit_amount, balance_due,
          deposit_paid, event_date, event_time, event_zip, event_location,
          event_type, guest_count, notes, client_name, client_phone,
          client_email, child_name, customer_type, referral_source, admin_notes,
          source
        ) VALUES (
          $1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20, $21,$22,$23,$24,$25,$26, $27
        ) RETURNING id, reference
      `, [
        ref, String(b.status).trim(), normaliseBrand(b.brand),
        // The only link to staffing: staff_slots and the time templates are
        // keyed on service_id, so a booking created without one can never match
        // a role, notify anyone, or compute a real shift window.
        //
        // Callers that know the catalogue id should still send it. When one
        // does not, the service NAME is resolved against the same decider
        // import-bookings.js uses at intake — this endpoint is the other intake
        // and had no resolution at all, which is why every unlinked upcoming
        // booking measured on 2026-09-15 came through here or the admin modal.
        // resolveServiceId returns '' for an ambiguous name rather than
        // guessing, and the daily digest reports what stays unlinked.
        serviceId,
        str(b.service_name), num(b.service_price),
        num(b.addon_total), num(b.mileage_cost), total, deposit, balance,
        b.deposit_paid === true, b.event_date, str(b.event_time, 32), str(b.event_zip, 20), str(b.event_location, 5000),
        str(b.event_type), Math.floor(num(b.guest_count)), str(b.notes, 5000), str(b.client_name, 120), str(b.client_phone, 64),
        str(b.client_email, 200), str(b.child_name, 120), str(b.customer_type, 64), str(b.referral_source), str(b.admin_notes, 5000),
        // This column was missing entirely, so every booking this seam created
        // stored NULL and read as 'direct'. All three GigSalad bookings in
        // production arrived that way, and one carried a $465 balance we could
        // never collect. referral_source beside it is marketing free text and
        // answers a different question — see the header of _source.js.
        source,
      ]);
      result.imported++;
      result.details.push({ reference: ins[0].reference, id: ins[0].id, imported: true });
    }
    // No email. No staff notify. That is the entire point of this endpoint.
    return json(200, { success: true, ...result });
  });
};
