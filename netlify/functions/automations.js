const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json'
};

const FROM = 'Funky Monkey Events <bookings@funkymonkeyevents.com>';
const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

// ── Ensure tables ─────────────────────────────────────────────────────────────
async function ensureTables(client) {
  // automation_rules: defines when/what to send
  await client.query(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      trigger_event VARCHAR(64) NOT NULL,
      -- trigger_event: 'status_change', 'days_before_event', 'days_after_event',
      --                'days_after_enquiry', 'deposit_paid'
      trigger_status VARCHAR(64) DEFAULT NULL,
      -- for status_change: which status triggers it (confirmed/cancelled/completed)
      trigger_days INTEGER DEFAULT NULL,
      -- for days_before/after: how many days
      recipient VARCHAR(32) DEFAULT 'client',
      -- 'client' or 'admin'
      subject VARCHAR(500) NOT NULL,
      body_html TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // email_log: every email sent, linked to a booking
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      rule_id INTEGER REFERENCES automation_rules(id) ON DELETE SET NULL,
      trigger_label VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      recipient_label VARCHAR(32) DEFAULT 'client',
      -- 'client' or 'admin' or 'manual'
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(32) DEFAULT 'sent'
    )
  `);

  // booking_tasks: per-booking admin checklist
  await client.query(`
    CREATE TABLE IF NOT EXISTS booking_tasks (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      task TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed default automation rules if none exist
  const { rows: existing } = await client.query('SELECT COUNT(*) FROM automation_rules');
  if (parseInt(existing[0].count) === 0) {
    const defaults = [
      {
        name: 'Booking Confirmation + Deposit Request',
        trigger_event: 'status_change', trigger_status: 'confirmed',
        recipient: 'client', sort_order: 1,
        subject: 'Your booking is CONFIRMED! 🎊 — Funky Monkey Events',
        body_html: '<p>Hi {{client_first_name}}! Your event is confirmed. Please pay your deposit to lock in your date.</p><p><strong>Service:</strong> {{service_name}}<br><strong>Date:</strong> {{event_date}}<br><strong>Deposit:</strong> ${{deposit_amount}}</p>{{deposit_link}}'
      },
      {
        name: 'Pre-Event Reminder (3 days before)',
        trigger_event: 'days_before_event', trigger_days: 3,
        recipient: 'client', sort_order: 2,
        subject: 'See you in 3 days! 🎉 — Funky Monkey Events',
        body_html: '<p>Hi {{client_first_name}}! Just a reminder that your {{service_name}} is coming up on {{event_date}}. We\'re so excited!</p><p>If you have any last-minute questions, give us a call at (405) 431-6625.</p>'
      },
      {
        name: 'Post-Event Follow-up (1 day after)',
        trigger_event: 'days_after_event', trigger_days: 1,
        recipient: 'client', sort_order: 3,
        subject: 'How did we do? ⭐ — Funky Monkey Events',
        body_html: '<p>Hi {{client_first_name}}! Thank you so much for having us at your event! We hope everyone had an amazing time.</p><p>We\'d love it if you could leave us a quick review — it means the world to us!</p><p>As a thank you, returning clients get <strong>10% off</strong> their next booking.</p>'
      },
      {
        name: 'Cancellation Notice',
        trigger_event: 'status_change', trigger_status: 'cancelled',
        recipient: 'client', sort_order: 4,
        subject: 'Booking update — Funky Monkey Events',
        body_html: '<p>Hi {{client_first_name}}, unfortunately we weren\'t able to confirm your booking for {{service_name}} on {{event_date}}. We\'re sorry for any inconvenience!</p><p>We\'d love to find a date that works — please give us a call or submit a new request.</p>'
      },
    ];
    for (const r of defaults) {
      await client.query(
        `INSERT INTO automation_rules (name, trigger_event, trigger_status, trigger_days, recipient, subject, body_html, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.name, r.trigger_event, r.trigger_status||null, r.trigger_days||null, r.recipient, r.subject, r.body_html, r.sort_order]
      );
    }
  }
}

// ── Template engine ───────────────────────────────────────────────────────────
function renderTemplate(html, booking, stripeLink) {
  const dateStr = booking.event_date
    ? new Date(String(booking.event_date).split('T')[0] + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
    : 'TBD';
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  const depositLink = stripeLink
    ? `<div style="text-align:center;margin:20px 0"><a href="${stripeLink}" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px">💳 Pay Deposit — $${Number(booking.deposit_amount||100).toFixed(2)}</a></div>`
    : '';

  return html
    .replace(/{{client_first_name}}/g, firstName)
    .replace(/{{client_name}}/g, booking.client_name || '')
    .replace(/{{service_name}}/g, booking.service_name || '')
    .replace(/{{event_date}}/g, dateStr)
    .replace(/{{event_time}}/g, booking.event_time || '')
    .replace(/{{event_zip}}/g, booking.event_zip || '')
    .replace(/{{total_price}}/g, Number(booking.total_price||0).toFixed(2))
    .replace(/{{deposit_amount}}/g, Number(booking.deposit_amount||100).toFixed(2))
    .replace(/{{balance_due}}/g, Number(booking.balance_due||0).toFixed(2))
    .replace(/{{reference}}/g, booking.reference || '')
    .replace(/{{deposit_link}}/g, depositLink);
}

const emailWrap = (body) => `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px">
      <div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div>
    </div>
    <div style="padding:24px">${body}</div>
    <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,.1);font-size:11px;color:#A78BCA;text-align:center">
      Funky Monkey Events · OKC · (405) 431-6625
    </div>
  </div>`;

// ── Send one automation email ─────────────────────────────────────────────────
async function sendAutomationEmail(client, rule, booking, stripeLink) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
  const toEmail = rule.recipient === 'admin' ? NOTIFY : booking.client_email;
  if (!toEmail) return;

  const subject = renderTemplate(rule.subject, booking, stripeLink);
  const html    = emailWrap(renderTemplate(rule.body_html, booking, stripeLink));

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: toEmail, subject, html })
    });
    const data = await res.json();
    if (data.error) console.error('Resend error:', JSON.stringify(data.error));

    // Log it
    await client.query(
      `INSERT INTO email_log (booking_id, rule_id, trigger_label, subject, recipient_email, recipient_label)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [booking.id, rule.id, rule.name, subject, toEmail, rule.recipient]
    );
  } catch(e) { console.error('sendAutomationEmail error:', e.message); }
}

// ── Trigger: status_change ────────────────────────────────────────────────────
// Called from booking.js when status changes
async function triggerStatusChange(client, booking, newStatus, stripeLink) {
  const { rows: rules } = await client.query(
    `SELECT * FROM automation_rules
     WHERE active=TRUE AND trigger_event='status_change' AND trigger_status=$1
     ORDER BY sort_order`,
    [newStatus]
  );
  for (const rule of rules) {
    await sendAutomationEmail(client, rule, booking, stripeLink);
  }
}

// ── Trigger: scheduled (days_before/after) ───────────────────────────────────
// Called by a scheduled function or manually via POST action:'run_scheduled'
async function runScheduledAutomations(client) {
  const today = new Date();
  today.setHours(0,0,0,0);
  let sent = 0;

  // days_before_event
  const { rows: beforeRules } = await client.query(
    `SELECT * FROM automation_rules
     WHERE active=TRUE AND trigger_event='days_before_event' AND trigger_days IS NOT NULL
     ORDER BY sort_order`
  );
  for (const rule of beforeRules) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + rule.trigger_days);
    const dateStr = targetDate.toISOString().split('T')[0];

    const { rows: bookings } = await client.query(
      `SELECT * FROM bookings
       WHERE status IN ('confirmed','pending')
         AND event_date::date = $1::date
         AND id NOT IN (
           SELECT booking_id FROM email_log WHERE rule_id=$2
         )`,
      [dateStr, rule.id]
    );
    for (const booking of bookings) {
      await sendAutomationEmail(client, rule, booking, null);
      sent++;
    }
  }

  // days_after_event
  const { rows: afterRules } = await client.query(
    `SELECT * FROM automation_rules
     WHERE active=TRUE AND trigger_event='days_after_event' AND trigger_days IS NOT NULL
     ORDER BY sort_order`
  );
  for (const rule of afterRules) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() - rule.trigger_days);
    const dateStr = targetDate.toISOString().split('T')[0];

    const { rows: bookings } = await client.query(
      `SELECT * FROM bookings
       WHERE status IN ('confirmed','completed')
         AND event_date::date = $1::date
         AND id NOT IN (
           SELECT booking_id FROM email_log WHERE rule_id=$2
         )`,
      [dateStr, rule.id]
    );
    for (const booking of bookings) {
      await sendAutomationEmail(client, rule, booking, null);
      sent++;
    }
  }

  return sent;
}

// ── HTTP handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTables(client);

    // GET /api/automations — list rules + recent email log
    if (event.httpMethod === 'GET') {
      const type = event.queryStringParameters?.type;

      if (type === 'log') {
        const bookingId = event.queryStringParameters?.booking_id;
        if (bookingId) {
          const { rows } = await client.query(
            `SELECT * FROM email_log WHERE booking_id=$1 ORDER BY sent_at DESC`,
            [parseInt(bookingId)]
          );
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
        }
        // Global log
        const { rows } = await client.query(
          `SELECT el.*, b.reference, b.client_name FROM email_log el
           JOIN bookings b ON b.id = el.booking_id
           ORDER BY el.sent_at DESC LIMIT 100`
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
      }

      if (type === 'tasks') {
        const bookingId = event.queryStringParameters?.booking_id;
        if (!bookingId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'booking_id required' }) };
        const { rows } = await client.query(
          'SELECT * FROM booking_tasks WHERE booking_id=$1 ORDER BY sort_order, id',
          [parseInt(bookingId)]
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
      }

      // Default: list automation rules
      const { rows } = await client.query('SELECT * FROM automation_rules ORDER BY sort_order, id');
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const action = body.action;

    // POST action:'run_scheduled' — trigger all scheduled automations (call daily via cron)
    if (action === 'run_scheduled') {
      const sent = await runScheduledAutomations(client);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, sent }) };
    }

    // POST action:'trigger_status' — called internally when booking status changes
    if (action === 'trigger_status') {
      const { booking_id, status, stripe_link } = body;
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
      if (!rows[0]) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Booking not found' }) };
      await triggerStatusChange(client, rows[0], status, stripe_link || null);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'send_manual' — manually send an email to a client
    if (action === 'send_manual') {
      const { booking_id, subject, html } = body;
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
      const booking = rows[0];
      if (!booking) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Booking not found' }) };

      const RESEND_API_KEY = process.env.RESEND_API_KEY;
      if (RESEND_API_KEY && booking.client_email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM, to: booking.client_email, subject, html: emailWrap(html) })
        });
        await client.query(
          `INSERT INTO email_log (booking_id, trigger_label, subject, recipient_email, recipient_label)
           VALUES ($1,'Manual',$2,$3,'client')`,
          [booking.id, subject, booking.client_email]
        );
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'save_rule' — create or update an automation rule
    if (action === 'save_rule') {
      const r = body.rule;
      if (r.id) {
        await client.query(
          `UPDATE automation_rules SET name=$1,active=$2,trigger_event=$3,trigger_status=$4,
           trigger_days=$5,recipient=$6,subject=$7,body_html=$8,sort_order=$9,updated_at=NOW()
           WHERE id=$10`,
          [r.name,r.active!==false,r.trigger_event,r.trigger_status||null,
           r.trigger_days||null,r.recipient||'client',r.subject,r.body_html,r.sort_order||0,r.id]
        );
      } else {
        await client.query(
          `INSERT INTO automation_rules (name,active,trigger_event,trigger_status,trigger_days,recipient,subject,body_html,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [r.name,r.active!==false,r.trigger_event,r.trigger_status||null,
           r.trigger_days||null,r.recipient||'client',r.subject,r.body_html,r.sort_order||0]
        );
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'delete_rule'
    if (action === 'delete_rule') {
      await client.query('UPDATE automation_rules SET active=FALSE WHERE id=$1', [body.rule_id]);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'save_task' — add/update a booking task
    if (action === 'save_task') {
      const { booking_id, task, task_id } = body;
      if (task_id) {
        await client.query('UPDATE booking_tasks SET task=$1 WHERE id=$2', [task, task_id]);
      } else {
        await client.query(
          'INSERT INTO booking_tasks (booking_id, task, sort_order) VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM booking_tasks WHERE booking_id=$1))',
          [parseInt(booking_id), task]
        );
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'complete_task'
    if (action === 'complete_task') {
      const { task_id, completed } = body;
      await client.query(
        'UPDATE booking_tasks SET completed=$1, completed_at=$2 WHERE id=$3',
        [completed, completed ? new Date() : null, task_id]
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // POST action:'delete_task'
    if (action === 'delete_task') {
      await client.query('DELETE FROM booking_tasks WHERE id=$1', [body.task_id]);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch(err) {
    console.error('automations.js error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};

// Export helpers for use in booking.js
module.exports.triggerStatusChange = triggerStatusChange;
module.exports.handler = exports.handler;
