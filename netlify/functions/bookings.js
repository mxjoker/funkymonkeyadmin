const crypto = require('crypto');
const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized, forbidden } = require('./_auth');
const { esc, wrap, sendEmail } = require('./_email');
const { notifyMatchingStaff } = require('./staff-assignments');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Public field subset per API contract
const PUBLIC_FIELDS = [
  'reference', 'status', 'service_id', 'service_name', 'event_type',
  'event_date', 'event_time', 'event_zip', 'event_location',
  'start_time', 'end_time', 'guest_count', 'venue_name',
  'event_address', 'client_name', 'client_email', 'addons', 'total_price', 'mileage_cost',
  'deposit_amount', 'deposit_paid', 'balance_due', 'payment_amount', 'created_at',
];

function pickPublicFields(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = row[f] ?? null;
  return out;
}

let schemaReady;
async function ensureTable(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
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
      stripe_payment_intent_id VARCHAR(255),
      stripe_payment_link TEXT DEFAULT '',

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

      event_type_id VARCHAR(64) DEFAULT '',
      is_custom_quote BOOLEAN DEFAULT FALSE,
      extra_hours INTEGER DEFAULT 0,
      extra_hours_cost NUMERIC(10,2) DEFAULT 0,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add any missing columns for backwards compat
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
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_link TEXT DEFAULT ''",
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
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_note TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type_id VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_custom_quote BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_hours INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_hours_cost NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS child_name VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests_of_honour VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_type VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS venue VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmation_deadline DATE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_ref VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS brand VARCHAR(8) DEFAULT 'fme'"
  ];
  for (const sql of cols) {
    try { await client.query(sql); } catch (_) {}
  }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// Generates FM- + 8 chars of crypto-random base32 (no ambiguous chars I/O/1/0)
// ~40 bits of randomness. Caller retries on UNIQUE violation.
function generateReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I/O/1/0
  let r = 'FM-';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) r += chars[bytes[i] % 32];
  return r;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};

    // GET single booking by reference — public requires ?email matching
    if (qs.reference) {
      const ref = qs.reference.toUpperCase();

      // Check for admin token first (bypasses email requirement)
      const auth = await requireAuth(event, ['admin']);
      if (auth) {
        // Admin: full row
        return withClient(async (client) => {
          await ensureTable(client);
          const { rows } = await client.query(
            'SELECT * FROM bookings WHERE reference = $1',
            [ref]
          );
          if (!rows.length) return json(404, { error: 'Not found' });
          return json(200, { bookings: rows });
        });
      }

      // Public: require email param, case-insensitive match — 404 on any mismatch
      const emailParam = (qs.email || '').trim().toLowerCase();
      if (!emailParam) return json(404, { error: 'Not found' });

      return withClient(async (client) => {
        await ensureTable(client);
        const { rows } = await client.query(
          'SELECT * FROM bookings WHERE reference = $1',
          [ref]
        );
        // Return 404 on not-found OR email mismatch (don't reveal existence)
        if (!rows.length) return json(404, { error: 'Not found' });
        if ((rows[0].client_email || '').toLowerCase() !== emailParam) {
          return json(404, { error: 'Not found' });
        }
        return json(200, { bookings: [pickPublicFields(rows[0])] });
      });
    }

    // GET availability by service_id+date — admin or staff
    if (qs.service_id && qs.date) {
      const auth = await requireAuth(event, ['admin', 'staff']);
      if (!auth) return unauthorized();
      return withClient(async (client) => {
        await ensureTable(client);
        const { rows } = await client.query(
          `SELECT * FROM bookings WHERE service_id=$1 AND event_date=$2`,
          [qs.service_id, qs.date]
        );
        return json(200, rows);
      });
    }

    // GET all/filtered — admin only
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();

    return withClient(async (client) => {
      await ensureTable(client);
      // Optional filters for agent delta-sync: ?brand=jcm|fme, ?since=ISO-date
      const conditions = [];
      const params = [];
      if (qs.brand) {
        params.push(qs.brand);
        conditions.push(`brand = $${params.length}`);
      }
      if (qs.since && !isNaN(Date.parse(qs.since))) {
        params.push(qs.since);
        conditions.push(`updated_at >= $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await client.query(
        `SELECT * FROM bookings ${where} ORDER BY created_at DESC`,
        params
      );
      return json(200, rows);
    });
  }

  // ── POST new booking (public) ────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let b;
    try {
      b = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }

    // ── Validation (contract §POST /api/bookings) ────────────────────────────
    const clientName = String(b.client_name || '').trim();
    if (!clientName) return json(400, { error: 'client_name is required' });
    if (clientName.length > 120) return json(400, { error: 'client_name too long (max 120)' });

    const clientEmail = String(b.client_email || '').trim();
    if (!clientEmail) return json(400, { error: 'client_email is required' });
    if (clientEmail.length > 200) return json(400, { error: 'client_email too long (max 200)' });
    // Plausible email check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return json(400, { error: 'client_email is not valid' });
    }

    if (!b.event_date || isNaN(Date.parse(String(b.event_date)))) {
      return json(400, { error: 'event_date must be a parseable date' });
    }

    if (!b.service_id && !b.service_name) {
      return json(400, { error: 'service_id or service_name is required' });
    }

    // Clamp / sanitize numerics — reject NaN
    const rawGuestCount = b.guest_count !== undefined ? Number(b.guest_count) : 0;
    if (isNaN(rawGuestCount)) return json(400, { error: 'guest_count must be a number' });
    const guestCount = Math.min(Math.max(Math.floor(rawGuestCount), 0), 10000);

    const clampPrice = (v, label) => {
      const n = Number(v);
      if (v !== undefined && v !== null && v !== '' && isNaN(n)) {
        throw Object.assign(new Error(`${label} must be a number`), { statusCode: 400 });
      }
      return Math.min(Math.max(n || 0, 0), 100000);
    };

    let servicePrice, addonTotal, mileageCost, totalPrice, extraHoursCost;
    try {
      servicePrice    = clampPrice(b.service_price,    'service_price');
      addonTotal      = clampPrice(b.addon_total,       'addon_total');
      mileageCost     = clampPrice(b.mileage_cost,      'mileage_cost');
      totalPrice      = clampPrice(b.total_price,       'total_price');
      extraHoursCost  = clampPrice(b.extra_hours_cost,  'extra_hours_cost');
    } catch (e) {
      return json(400, { error: e.message });
    }

    const rawExtraHours = b.extra_hours !== undefined ? Number(b.extra_hours) : 0;
    if (isNaN(rawExtraHours)) return json(400, { error: 'extra_hours must be a number' });
    const extraHours = Math.max(0, Math.floor(rawExtraHours));

    const rawMileageMiles = b.mileage_miles !== undefined ? Number(b.mileage_miles) : 0;
    const mileageMiles = Math.max(0, Math.floor(isNaN(rawMileageMiles) ? 0 : rawMileageMiles));

    // Trim strings, cap free text at 5000
    const cap5k = (v) => String(v || '').trim().slice(0, 5000);
    const cap255 = (v) => String(v || '').trim().slice(0, 255);

    // Get deposit_amount from request or default to 100
    const depositAmount = Math.min(Math.max(Number(b.deposit_amount) || 100, 0), 100000);

    // Balance calc: total_price + mileage_cost - deposit_amount
    const balanceDue = Math.max(0, totalPrice + mileageCost - depositAmount);

    return withClient(async (client) => {
      await ensureTable(client);

      // Retry loop for unique reference
      let reference;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateReference();
        const { rows: existing } = await client.query(
          'SELECT 1 FROM bookings WHERE reference=$1', [candidate]
        );
        if (!existing.length) { reference = candidate; break; }
      }
      if (!reference) return json(500, { error: 'Could not generate unique reference' });

      const { rows } = await client.query(`
        INSERT INTO bookings (
          reference, status,
          service_id, service_name, service_price,
          addons, addon_total, mileage_cost, mileage_miles,
          total_price, deposit_amount, balance_due,
          event_date, event_time, event_zip, event_location,
          event_type, event_type_id, guest_count, notes,
          is_custom_quote, extra_hours, extra_hours_cost,
          client_name, client_phone, client_email, referral_source,
          child_name, brand
        ) VALUES (
          $1, 'review',
          $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18, $19,
          $20, $21, $22,
          $23, $24, $25, $26,
          $27, $28
        ) RETURNING *
      `, [
        reference,
        cap255(b.service_id),
        cap255(b.service_name),
        servicePrice,
        JSON.stringify(b.addons || []),
        addonTotal,
        mileageCost,
        mileageMiles,
        totalPrice,
        depositAmount,
        balanceDue,
        b.event_date,
        cap255(b.event_time),
        cap255(b.event_zip),
        cap5k(b.event_location),
        cap255(b.event_type),
        cap255(b.event_type_id),
        guestCount,
        cap5k(b.notes),
        b.is_custom_quote === true,
        extraHours,
        extraHoursCost,
        clientName,
        cap255(b.client_phone),
        clientEmail,
        cap255(b.referral_source),
        cap255(b.child_name),
        b.brand === 'jcm' ? 'jcm' : 'fme',
      ]);

      const booking = rows[0];

      // Await both — in a serverless function the container may terminate as soon
      // as the handler returns, dropping any unawaited fetch calls to Resend.
      await sendBookingEmails(booking);
      await notifyMatchingStaff(booking).catch(e => console.error('Staff notify error:', e.message));

      return json(201, { success: true, reference: booking.reference, id: booking.id });
    });
  }

  return json(405, { error: 'Method not allowed' });
};

// Send admin notification then client acknowledgment, both awaited so the
// serverless container doesn't terminate before the Resend calls complete.
// Each is caught independently so admin failure never blocks client email.
async function sendBookingEmails(booking) {
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';

  const dateStr = booking.event_date
    ? new Date(String(booking.event_date).split('T')[0] + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      })
    : 'TBD';

  const addons = Array.isArray(booking.addons) ? booking.addons : [];
  const addonList = addons.map(a =>
    `<li>${esc(a.name)} — $${Number(a.price).toFixed(2)}</li>`
  ).join('');

  // Admin notification — failure logged but does NOT skip client email
  await sendEmail(
    NOTIFY_EMAIL,
    `🐒 New Booking Request — ${esc(booking.reference)} — ${esc(booking.service_name)}`,
    wrap(`
      <h2>New Booking Request</h2>
      <p><strong>Ref:</strong> ${esc(booking.reference)}</p>
      <p><strong>Service:</strong> ${esc(booking.service_name)}</p>
      <p><strong>Date:</strong> ${dateStr} at ${esc(booking.event_time)}</p>
      <p><strong>ZIP:</strong> ${esc(booking.event_zip)}${booking.event_location ? ' — ' + esc(booking.event_location) : ''}</p>
      <p><strong>Event Type:</strong> ${esc(booking.event_type)} · ${booking.guest_count} guests</p>
      <hr/>
      <p><strong>Client:</strong> ${esc(booking.client_name)}</p>
      <p><strong>Phone:</strong> ${esc(booking.client_phone)}</p>
      <p><strong>Email:</strong> ${esc(booking.client_email)}</p>
      ${booking.referral_source ? `<p><strong>Referral:</strong> ${esc(booking.referral_source)}</p>` : ''}
      <hr/>
      <p><strong>Service:</strong> $${Number(booking.service_price).toFixed(2)}</p>
      ${addonList ? `<ul>${addonList}</ul>` : ''}
      ${Number(booking.mileage_cost) > 0 ? `<p><strong>Travel:</strong> $${Number(booking.mileage_cost).toFixed(2)} (${booking.mileage_miles} mi)</p>` : ''}
      <p><strong>Total:</strong> $${Number(booking.total_price).toFixed(2)}</p>
      <p><strong>Deposit:</strong> $${Number(booking.deposit_amount).toFixed(2)}</p>
      <p><strong>Balance Due:</strong> $${Number(booking.balance_due).toFixed(2)}</p>
      ${booking.notes ? `<p><strong>Notes:</strong> ${esc(booking.notes)}</p>` : ''}
      <br/>
      <a href="https://funkymonkeyadmin.netlify.app/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">View in Admin</a>
    `)
  ).catch(e => console.error('Admin email error:', e.message));

  // Client acknowledgment — always attempted regardless of admin email outcome
  const firstName = esc(booking.client_name.split(' ')[0] || 'there');
  await sendEmail(
    booking.client_email,
    `🎉 Booking Request Received — Funky Monkey Events (${booking.reference})`,
    wrap(`
      <h2>Thanks, ${firstName}!</h2>
      <p>We've received your booking request and will get back to you within 24 hours to confirm availability.</p>
      <p><strong>Your reference number:</strong> ${esc(booking.reference)}</p>
      <h3>Booking Summary</h3>
      <p><strong>Service:</strong> ${esc(booking.service_name)}</p>
      <p><strong>Date:</strong> ${dateStr} at ${esc(booking.event_time)}</p>
      ${Number(booking.total_price) > 0 ? `<p><strong>Estimated Total:</strong> $${Number(booking.total_price).toFixed(2)}</p>` : '<p><em>A custom quote will be included in our follow-up.</em></p>'}
      <p><strong>Deposit to Confirm:</strong> $${Number(booking.deposit_amount).toFixed(2)}</p>
      ${Number(booking.total_price) > 0 ? `<p><strong>Balance Due at Event:</strong> $${Number(booking.balance_due).toFixed(2)}</p>` : ''}
      <br/>
      <p>Questions? Call or text us at <strong>(405) 431-6625</strong></p>
      <p>— The Funky Monkey Events Team 🐒</p>
    `)
  ).catch(e => console.error('Client email error:', e.message));
}
