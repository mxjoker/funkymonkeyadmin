/**
 * _email.js — shared email helper for all Funky Monkey functions
 *
 * Single source of truth for:
 *  - Sending via Resend
 *  - Template variable rendering
 *  - Email wrapping (branded HTML shell)
 *  - Logging to email_log table
 *  - Firing automation rules on status change
 */

const FROM = 'Funky Monkey Events <bookings@funkymonkeyevents.com>';

// ── HTML escape for user-supplied values in email templates ──────────────────
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── HTML wrapper ──────────────────────────────────────────────────────────────
function wrap(body) {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px">
    <div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div>
  </div>
  <div style="padding:24px">${body}</div>
  <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,.1);font-size:11px;color:#A78BCA;text-align:center">
    Funky Monkey Events · OKC · (405) 431-6625
  </div>
</div>`;
}

// ── Template renderer ─────────────────────────────────────────────────────────
function render(template, booking, stripeLink) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  const dateStr = booking.event_date
    ? new Date(String(booking.event_date).split('T')[0] + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
    : 'TBD';
  const depositBtn = stripeLink
    ? `<div style="text-align:center;margin:20px 0">
        <a href="${stripeLink}" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px">
          💳 Pay Deposit — $${Number(booking.deposit_amount||100).toFixed(2)}
        </a>
        <p style="color:#A78BCA;font-size:11px;margin-top:8px">Secure payment via Stripe · Cards, Apple Pay & Google Pay accepted</p>
      </div>`
    : '';

  return template
    .replace(/{{client_first_name}}/g, esc(firstName))
    .replace(/{{client_name}}/g,       esc(booking.client_name   || ''))
    .replace(/{{service_name}}/g,      esc(booking.service_name  || ''))
    .replace(/{{event_date}}/g,        dateStr)
    .replace(/{{event_time}}/g,        esc(booking.event_time    || ''))
    .replace(/{{event_zip}}/g,         esc(booking.event_zip     || ''))
    .replace(/{{total_price}}/g,       Number(booking.total_price   ||0).toFixed(2))
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount||100).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due   ||0).toFixed(2))
    .replace(/{{reference}}/g,         booking.reference     || '')
    .replace(/{{deposit_link}}/g,      depositBtn);
}

// ── Core send function ────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    const data = await res.json();
    if (data.error) console.error('Resend error:', JSON.stringify(data.error));
    else console.log('Email sent to:', to, '| id:', data.id, '| subject:', subject);
    return data;
  } catch(e) {
    console.error('sendEmail error:', e.message);
  }
}

// ── Log to email_log table ────────────────────────────────────────────────────
async function logEmail(client, bookingId, ruleId, triggerLabel, subject, recipientEmail, recipientLabel) {
  try {
    await client.query(
      `INSERT INTO email_log (booking_id, rule_id, trigger_label, subject, recipient_email, recipient_label)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bookingId, ruleId||null, triggerLabel, subject, recipientEmail, recipientLabel||'client']
    );
  } catch(e) {
    console.error('logEmail error:', e.message);
  }
}

// ── Fire automation rules for a status change ─────────────────────────────────
async function fireStatusAutomations(client, booking, newStatus, stripeLink) {
  try {
    const { rows: rules } = await client.query(
      `SELECT * FROM automation_rules
       WHERE active=TRUE AND trigger_event='status_change' AND trigger_status=$1
       ORDER BY sort_order`,
      [newStatus]
    );

    const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';

    for (const rule of rules) {
      const toEmail = rule.recipient === 'admin' ? NOTIFY : booking.client_email;
      if (!toEmail) continue;
      const subject = render(rule.subject, booking, stripeLink);
      const html    = wrap(render(rule.body_html, booking, stripeLink));
      await sendEmail(toEmail, subject, html);
      await logEmail(client, booking.id, rule.id, rule.name, subject, toEmail, rule.recipient);
    }

    return rules.length;
  } catch(e) {
    console.error('fireStatusAutomations error:', e.message);
    return 0;
  }
}

// ── Ensure email_log table exists ─────────────────────────────────────────────
async function ensureEmailLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      rule_id INTEGER,
      trigger_label VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      recipient_label VARCHAR(32) DEFAULT 'client',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(32) DEFAULT 'sent'
    )
  `);
}

// ── Ensure booking_changes table exists (superset schema) ────────────────────
// Owned by booking-changelog.js; this mirrors the exact same DDL so both
// writers converge to the same shape regardless of creation order.
async function ensureBookingChanges(client) {
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
  // Converge pre-existing tables of either legacy shape
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
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_changes_booking_id
    ON booking_changes(booking_id)
  `);
}

// ── Log a booking change ───────────────────────────────────────────────────────
async function logChange(client, bookingId, action, detail) {
  try {
    await client.query(
      `INSERT INTO booking_changes (booking_id, action, detail) VALUES ($1, $2, $3)`,
      [bookingId, action, detail || '']
    );
  } catch(e) {
    console.error('logChange error:', e.message);
  }
}

module.exports = { wrap, render, esc, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog, ensureBookingChanges, logChange };
