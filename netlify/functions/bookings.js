const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      reference VARCHAR(20) UNIQUE,
      status VARCHAR(32) DEFAULT 'review',

      service_id VARCHAR(64),
      service_name VARCHAR(255),
      service_price NUMERIC(10,2),
      addons JSONB DEFAULT '[]',
      addon_total NUMERIC(10,2) DEFAULT 0,
      mileage_cost NUMERIC(10,2) DEFAULT 0,
      mileage_miles INTEGER DEFAULT 0,
      total_price NUMERIC(10,2),
      deposit_amount NUMERIC(10,2) DEFAULT 100,
      balance_due NUMERIC(10,2),
      deposit_paid BOOLEAN DEFAULT FALSE,
      deposit_paid_at TIMESTAMPTZ,
      stripe_session_id VARCHAR(255),

      event_date DATE,
      event_time VARCHAR(10),
      event_zip VARCHAR(10),
      event_location TEXT DEFAULT '',
      event_type VARCHAR(100),
      guest_count INTEGER,
      notes TEXT DEFAULT '',

      client_name VARCHAR(255),
      client_phone VARCHAR(50),
      client_email VARCHAR(255),
      referral_source VARCHAR(100) DEFAULT '',

      admin_notes TEXT DEFAULT '',
      contract_signed BOOLEAN DEFAULT FALSE,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add any missing columns for backwards compat (covers old tables missing Rev 6 cols)
  const cols = [
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference VARCHAR(20)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'review'",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_id VARCHAR(64)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_name VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_price NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons JSONB DEFAULT '[]'",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_total NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mileage_cost NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mileage_miles INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_price NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 100",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_date DATE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_time VARCHAR(10)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_zip VARCHAR(10)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_location TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type VARCHAR(100)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_count INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS referral_source VARCHAR(100) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contract_signed BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"
  ];
  for (const sql of cols) {
    try { await client.query(sql); } catch (_) {}
  }
}

function generateReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'FM-';
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const client = await pool.connect();
  try {
    await ensureTable(client);

    // GET all bookings
    if (event.httpMethod === 'GET') {
      const { rows } = await client.query(
        'SELECT * FROM bookings ORDER BY created_at DESC'
      );
      return { statusCode: 200, headers, body: JSON.stringify(rows) };
    }

    // POST new booking
    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      const reference = generateReference();
      const deposit = 100;
      const balance = (Number(b.total_price) || 0) - deposit;

      const { rows } = await client.query(`
        INSERT INTO bookings (
          reference, status,
          service_id, service_name, service_price,
          addons, addon_total, mileage_cost, mileage_miles,
          total_price, deposit_amount, balance_due,
          event_date, event_time, event_zip, event_location,
          event_type, guest_count, notes,
          client_name, client_phone, client_email, referral_source
        ) VALUES (
          $1, 'review',
          $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18,
          $19, $20, $21, $22
        ) RETURNING *
      `, [
        reference,
        b.service_id || null,
        b.service_name || '',
        Number(b.service_price) || 0,
        JSON.stringify(b.addons || []),
        Number(b.addon_total) || 0,
        Number(b.mileage_cost) || 0,
        Number(b.mileage_miles) || 0,
        Number(b.total_price) || 0,
        deposit,
        balance,
        b.event_date || null,
        b.event_time || '',
        b.event_zip || '',
        b.event_location || '',
        b.event_type || '',
        parseInt(b.guest_count) || 0,
        b.notes || '',
        b.client_name || '',
        b.client_phone || '',
        b.client_email || '',
        b.referral_source || ''
      ]);

      const booking = rows[0];

      // Send emails (fire and forget)
      sendEmails(booking).catch(e => console.error('Email error:', e));

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ success: true, reference: booking.reference, id: booking.id })
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Bookings error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};

async function sendEmails(booking) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
  const FROM = 'Funky Monkey Events <onboarding@resend.dev>';

  const dateStr = booking.event_date
    ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
    : 'TBD';

  const addonList = (booking.addons || []).map(a => `<li>${a.name} — $${Number(a.price).toFixed(2)}</li>`).join('');

  // Admin notification
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: NOTIFY_EMAIL,
      subject: `🐒 New Booking Request — ${booking.reference} — ${booking.service_name}`,
      html: `
        <h2>New Booking Request</h2>
        <p><strong>Ref:</strong> ${booking.reference}</p>
        <p><strong>Service:</strong> ${booking.service_name}</p>
        <p><strong>Date:</strong> ${dateStr} at ${booking.event_time}</p>
        <p><strong>ZIP:</strong> ${booking.event_zip}${booking.event_location ? ' — ' + booking.event_location : ''}</p>
        <p><strong>Event Type:</strong> ${booking.event_type} · ${booking.guest_count} guests</p>
        <hr/>
        <p><strong>Client:</strong> ${booking.client_name}</p>
        <p><strong>Phone:</strong> ${booking.client_phone}</p>
        <p><strong>Email:</strong> ${booking.client_email}</p>
        ${booking.referral_source ? `<p><strong>Referral:</strong> ${booking.referral_source}</p>` : ''}
        <hr/>
        <p><strong>Service:</strong> $${Number(booking.service_price).toFixed(2)}</p>
        ${addonList ? `<ul>${addonList}</ul>` : ''}
        ${Number(booking.mileage_cost) > 0 ? `<p><strong>Travel:</strong> $${Number(booking.mileage_cost).toFixed(2)} (${booking.mileage_miles} mi)</p>` : ''}
        <p><strong>Total:</strong> $${Number(booking.total_price).toFixed(2)}</p>
        <p><strong>Deposit:</strong> $${Number(booking.deposit_amount).toFixed(2)}</p>
        <p><strong>Balance Due:</strong> $${Number(booking.balance_due).toFixed(2)}</p>
        ${booking.notes ? `<p><strong>Notes:</strong> ${booking.notes}</p>` : ''}
        <br/>
        <a href="https://funkymonkeyadmin.netlify.app/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">View in Admin</a>
      `
    })
  });

  // Client confirmation
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: booking.client_email,
      subject: `🎉 Booking Request Received — Funky Monkey Events (${booking.reference})`,
      html: `
        <h2>Thanks, ${booking.client_name.split(' ')[0]}!</h2>
        <p>We've received your booking request. Joe will review it and get back to you within 24 hours.</p>
        <p><strong>Your reference number:</strong> ${booking.reference}</p>
        <h3>Booking Summary</h3>
        <p><strong>Service:</strong> ${booking.service_name}</p>
        <p><strong>Date:</strong> ${dateStr} at ${booking.event_time}</p>
        <p><strong>Total Quote:</strong> $${Number(booking.total_price).toFixed(2)}</p>
        <p><strong>Deposit to Confirm:</strong> $${Number(booking.deposit_amount).toFixed(2)}</p>
        <p><strong>Balance Due at Event:</strong> $${Number(booking.balance_due).toFixed(2)}</p>
        <br/>
        <p>Questions? Call or text Joe at <strong>(405) 431-6625</strong></p>
        <p>— The Funky Monkey Events Team 🐒</p>
      `
    })
  });
}
