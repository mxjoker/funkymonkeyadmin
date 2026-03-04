const { Client } = require("pg");

const client = () => new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Ensure table exists
const ensureTable = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      booking_id TEXT,
      client TEXT,
      phone TEXT,
      email TEXT,
      event_type TEXT,
      guests INTEGER,
      referral TEXT,
      service_id TEXT,
      service TEXT,
      date TEXT,
      time TEXT,
      zip TEXT,
      location TEXT,
      notes TEXT,
      addons JSONB DEFAULT '[]',
      mileage_fee NUMERIC DEFAULT 0,
      miles NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      deposit_due NUMERIC DEFAULT 0,
      deposit NUMERIC DEFAULT 0,
      payment_method TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'review',
      staff_id INTEGER,
      contract_signed BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const db = client();
  try {
    await db.connect();
    await ensureTable(db);

    // GET — return all bookings newest first
    if (event.httpMethod === "GET") {
      const result = await db.query(
        "SELECT * FROM bookings ORDER BY created_at DESC"
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result.rows)
      };
    }

    // POST — create new booking from form submission
    if (event.httpMethod === "POST") {
      const d = JSON.parse(event.body);
      const bookingId = "FM-" + Date.now().toString().slice(-6);
      const result = await db.query(`
        INSERT INTO bookings (
          booking_id, client, phone, email, event_type, guests, referral,
          service_id, service, date, time, zip, location, notes, addons,
          mileage_fee, miles, total, deposit_due, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'review')
        RETURNING *
      `, [
        bookingId, d.client, d.phone, d.email, d.eventType,
        d.guests || 0, d.referral, d.serviceId, d.service,
        d.date, d.time, d.zip, d.location, d.notes,
        JSON.stringify(d.addons || []),
        d.mileageFee || 0, d.miles || 0, d.total || 0, d.depositDue || 0
      ]);
      return {
        statusCode: 201,
        headers,
        body: JSON.stringify(result.rows[0])
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    console.error("DB error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    await db.end();
  }
};
