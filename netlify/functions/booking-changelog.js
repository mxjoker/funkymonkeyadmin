// netlify/functions/booking-changelog.js
// Tracks all changes made to booking records for audit trail

const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Superset schema: unifies _email.js shape (action, detail, created_at)
// and booking-changelog.js shape (field_name, old_value, new_value, changed_by, changed_at).
// Pre-existing tables of either shape converge via ALTER TABLE ADD COLUMN IF NOT EXISTS.
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS booking_changes (
      id          SERIAL PRIMARY KEY,
      booking_id  INTEGER NOT NULL,
      action      VARCHAR(100),
      detail      TEXT,
      field_name  VARCHAR(100),
      old_value   TEXT,
      new_value   TEXT,
      changed_by  VARCHAR(100),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Converge pre-existing tables of either shape
  const alters = [
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS action     VARCHAR(100)`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS detail     TEXT`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS field_name VARCHAR(100)`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS old_value  TEXT`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS new_value  TEXT`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS changed_by VARCHAR(100)`,
    `ALTER TABLE booking_changes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
  ];
  for (const sql of alters) {
    try { await client.query(sql); } catch(e) { /* ignore if already exists */ }
  }

  // Index for faster queries by booking_id
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_changes_booking_id
    ON booking_changes(booking_id)
  `);
}

// Helper to log a single field change
async function logChange(client, bookingId, fieldName, oldValue, newValue, changedBy = 'admin') {
  // Skip if values are the same
  if (oldValue === newValue) return;

  // Convert to strings for comparison
  const oldStr = oldValue !== null && oldValue !== undefined ? String(oldValue) : null;
  const newStr = newValue !== null && newValue !== undefined ? String(newValue) : null;

  if (oldStr === newStr) return;

  await client.query(
    `INSERT INTO booking_changes (booking_id, field_name, old_value, new_value, changed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [bookingId, fieldName, oldStr, newStr, changedBy]
  );
}

// Compare two booking objects and log all differences
async function logBookingChanges(client, bookingId, oldBooking, newBooking, changedBy = 'admin') {
  const fieldsToTrack = [
    'status',
    'service_name',
    'service_price',
    'total_price',
    'deposit_amount',
    'balance_due',
    'deposit_paid',
    'event_date',
    'event_time',
    'event_location',
    'event_zip',
    'event_type',
    'guest_count',
    'client_name',
    'client_email',
    'client_phone',
    'child_name',
    'guests_of_honour',
    'notes',
    'admin_notes',
    'contract_signed',
    'payment_method',
    'payment_amount',
    'confirmation_deadline',
    'mileage_miles',
    'mileage_cost',
  ];

  for (const field of fieldsToTrack) {
    await logChange(client, bookingId, field, oldBooking[field], newBooking[field], changedBy);
  }

  // Handle JSONB addons field specially
  const oldAddons = JSON.stringify(oldBooking.addons || []);
  const newAddons = JSON.stringify(newBooking.addons || []);
  if (oldAddons !== newAddons) {
    await client.query(
      `INSERT INTO booking_changes (booking_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [bookingId, 'addons', oldAddons, newAddons, changedBy]
    );
  }
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // All booking-changelog routes are admin-only
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    try {
      await ensureTable(client);

      // GET /api/booking-changelog?booking_id=X
      if (event.httpMethod === 'GET') {
        const bookingId = event.queryStringParameters?.booking_id;

        if (!bookingId) {
          return json(400, { error: 'booking_id required' });
        }

        const result = await client.query(
          `SELECT * FROM booking_changes
           WHERE booking_id = $1
           ORDER BY created_at DESC`,
          [bookingId]
        );

        return json(200, { changes: result.rows });
      }

      // POST /api/booking-changelog
      // Manual logging (for special events or external integrations)
      if (event.httpMethod === 'POST') {
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          return json(400, { error: 'Invalid JSON' });
        }
        const { booking_id, field_name, old_value, new_value, changed_by } = body;

        if (!booking_id || !field_name) {
          return json(400, { error: 'booking_id and field_name required' });
        }

        await client.query(
          `INSERT INTO booking_changes (booking_id, field_name, old_value, new_value, changed_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [booking_id, field_name, old_value || null, new_value || null, changed_by || 'system']
        );

        return json(200, { success: true });
      }

      return json(405, { error: 'Method not allowed' });

    } catch (err) {
      console.error('Booking changelog error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

// Export helper function for use in booking.js
exports.logBookingChanges = logBookingChanges;
