// netlify/functions/booking-changelog.js
// Tracks all changes made to booking records for audit trail

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS booking_changes (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      field_name VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(100),
      changed_at TIMESTAMPTZ DEFAULT NOW(),
      change_type VARCHAR(50) DEFAULT 'update'
    )
  `);

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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const client = await pool.connect();
  try {
    await ensureTable(client);

    // GET /api/booking-changelog?booking_id=X
    if (event.httpMethod === 'GET') {
      const bookingId = event.queryStringParameters?.booking_id;
      
      if (!bookingId) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'booking_id required' })
        };
      }

      const result = await client.query(
        `SELECT * FROM booking_changes 
         WHERE booking_id = $1 
         ORDER BY changed_at DESC`,
        [bookingId]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ changes: result.rows })
      };
    }

    // POST /api/booking-changelog
    // Manual logging (for special events or external integrations)
    if (event.httpMethod === 'POST') {
      const { booking_id, field_name, old_value, new_value, changed_by } = JSON.parse(event.body || '{}');

      if (!booking_id || !field_name) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'booking_id and field_name required' })
        };
      }

      await client.query(
        `INSERT INTO booking_changes (booking_id, field_name, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [booking_id, field_name, old_value || null, new_value || null, changed_by || 'system']
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true })
      };
    }

    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' })
    };

  } catch (err) {
    console.error('Booking changelog error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    client.release();
  }
};

// Export helper function for use in booking.js
exports.logBookingChanges = logBookingChanges;
