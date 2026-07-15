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

const ALLOWED_STATUS = new Set(['confirmed', 'completed', 'pending', 'review', 'cancelled']);
const BRANDS = new Set(['jcm', 'fme']);

// Clamp a numeric to [0, 100000]; blank/invalid -> 0.
function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 100000);
}
const str = (v, max = 255) => String(v ?? '').trim().slice(0, max);

function validate(b) {
  const errors = [];
  if (!str(b.reference, 20)) errors.push('reference required');
  if (!str(b.client_name, 120)) errors.push('client_name required');
  if (!b.event_date || isNaN(Date.parse(String(b.event_date)))) errors.push('event_date must be a parseable date');
  if (!ALLOWED_STATUS.has(String(b.status || '').trim())) errors.push(`status must be one of ${[...ALLOWED_STATUS].join('/')}`);
  if (b.brand !== undefined && !BRANDS.has(String(b.brand))) errors.push('brand must be jcm or fme');
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
  const result = { dryRun, total: rows.length, imported: 0, skipped: 0, errors: 0, details: [] };

  return withClient(async (client) => {
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

      if (dryRun) { result.imported++; result.details.push({ reference: ref, would_import: true }); continue; }

      const total = num(b.total_price);
      const deposit = num(b.deposit_amount);
      const balance = b.balance_due !== undefined ? num(b.balance_due)
        : (String(b.status) === 'completed' ? 0 : Math.max(0, total - deposit));

      const { rows: ins } = await client.query(`
        INSERT INTO bookings (
          reference, status, brand, service_name, service_price,
          addon_total, mileage_cost, total_price, deposit_amount, balance_due,
          deposit_paid, event_date, event_time, event_zip, event_location,
          event_type, guest_count, notes, client_name, client_phone,
          client_email, child_name, customer_type, referral_source, admin_notes
        ) VALUES (
          $1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20, $21,$22,$23,$24,$25
        ) RETURNING id, reference
      `, [
        ref, String(b.status).trim(), BRANDS.has(String(b.brand)) ? b.brand : 'fme',
        str(b.service_name), num(b.service_price),
        num(b.addon_total), num(b.mileage_cost), total, deposit, balance,
        b.deposit_paid === true, b.event_date, str(b.event_time, 32), str(b.event_zip, 20), str(b.event_location, 5000),
        str(b.event_type), Math.floor(num(b.guest_count)), str(b.notes, 5000), str(b.client_name, 120), str(b.client_phone, 64),
        str(b.client_email, 200), str(b.child_name, 120), str(b.customer_type, 64), str(b.referral_source), str(b.admin_notes, 5000),
      ]);
      result.imported++;
      result.details.push({ reference: ins[0].reference, id: ins[0].id, imported: true });
    }
    // No email. No staff notify. That is the entire point of this endpoint.
    return json(200, { success: true, ...result });
  });
};
