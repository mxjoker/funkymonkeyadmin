const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { wrap, render, esc, sendEmail, logStatus, logEmail, ensureEmailLog } = require('./_email');
const { sendSms, renderSms, ensureSmsTables } = require('./_sms');

const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

let schemaReady;
async function ensureTables(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
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

  // email_log: owned by _email.js (its rule_id column links to automation_rules)
  await ensureEmailLog(client);

  // SMS is a channel on this engine, not a parallel system: same triggers, same
  // rule editor, so "when do we contact people" stays defined in one place.
  // body_sms is its own column rather than a stripped body_html — SMS bills per
  // 160 characters, and a reformatted email is four segments of nobody's idea
  // of a text message.
  await client.query("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS channel VARCHAR(8) DEFAULT 'email'");
  await client.query("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS body_sms TEXT DEFAULT ''");
  await ensureSmsTables(client);

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
        // Deposit-neutral on purpose. Schools and libraries book with
        // deposit_amount = 0, and the old copy ("Please pay your deposit to
        // lock in your date" plus a "Deposit: ${{deposit_amount}}" line) asked
        // them for money the booking does not want. {{deposit_link}} already
        // carries the amount inside the pay button and renders as nothing when
        // there is no deposit, so it is the only place the ask belongs.
        // {{total_price}} is deliberately NOT shown here: it excludes travel,
        // so it would understate the price on any booking with mileage.
        body_html: "<p>Hi {{client_first_name}}! Your event is confirmed.</p><p><strong>Service:</strong> {{service_name}}<br><strong>Date:</strong> {{event_date}}</p>{{deposit_link}}<p>Questions? Just reply to this email and we'll take care of it.</p>"
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
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ── SMS de-dupe guard ────────────────────────────────────────────────────────
// Deliberately NOT `status='sent'`, which is what the email guard uses. An SMS
// row is 'queued' until the delivery callback lands, and stays 'queued' forever
// if the carrier drops it — so a status filter would never suppress anything.
// The question here is "did we already try", and any row answers it.
async function alreadySmsSent(client, ruleId, bookingId) {
  const { rows } = await client.query(
    'SELECT id FROM sms_log WHERE rule_id=$1 AND booking_id=$2 LIMIT 1', [ruleId, bookingId]
  );
  return rows.length > 0;
}

// ── Send one rule, on whichever channels it asks for ─────────────────────────
// The single choke point for triggerStatusChange and all three scheduled loops.
// Returns true if anything went out on any channel.
//
// ponytail: a channel='both' rule whose email succeeds is excluded by the outer
// email_log guard on the next run, so a failed SMS half is not retried. Neither
// is a failed email today. Add a per-channel outer guard if that ever bites.
async function sendAutomationMessage(client, rule, booking, stripeLink, now) {
  const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
  const channel = rule.channel || 'email';
  let sentAnything = false;

  // SMS first, and above the email recipient check — an SMS-only rule must not
  // be skipped because the booking happens to have no email address.
  if (channel === 'sms' || channel === 'both') {
    const toAdmin = rule.recipient === 'admin';
    const toPhone = toAdmin ? process.env.NOTIFY_SMS : booking.client_phone;
    const smsBody = renderSms(rule.body_sms || '', booking, stripeLink);
    // A client is texted only if they ticked the consent box. sms_optout is a
    // global STOP list and answers a different question — "did they ask us to
    // stop" — which is not the same as "did they ever agree to start". Having a
    // phone number is not consent to be texted on it. Admin messages go to Joe's
    // own number and need no such record.
    if (!toAdmin && booking.sms_consent !== true) {
      console.log('automation SMS skipped — no client SMS consent | rule:', rule.name, '| booking:', booking.id);
    } else if (!toPhone) {
      console.error('automation SMS skipped — no phone | rule:', rule.name, '| booking:', booking.id);
    } else if (!smsBody.trim()) {
      console.error('automation SMS skipped — rule has an empty body_sms | rule:', rule.name);
    } else if (await alreadySmsSent(client, rule.id, booking.id)) {
      console.log('automation SMS skipped — already sent | rule:', rule.name, '| booking:', booking.id);
    } else {
      const res = await sendSms(client, toPhone, smsBody, {
        booking_id: booking.id, rule_id: rule.id, trigger_label: rule.name, now
      });
      if (res.status === 'queued' || res.status === 'held') sentAnything = true;
    }
  }

  if (channel === 'email' || channel === 'both') {
    const toEmail = rule.recipient === 'admin' ? NOTIFY : booking.client_email;
    if (toEmail) {
      const subject = render(rule.subject, booking, stripeLink);
      const html    = wrap(render(rule.body_html, booking, stripeLink));
      // Guarded here rather than at each loop: one bad recipient must never
      // abort the rest of the batch.
      try {
        const res = await sendEmail(toEmail, subject, html);
        await logEmail(client, booking.id, rule.id, rule.name, subject, toEmail, rule.recipient, logStatus(res));
        sentAnything = true;
      } catch (e) {
        console.error('automation email failed:', toEmail, '| rule:', rule.name, '|', e.message);
        await logEmail(client, booking.id, rule.id, rule.name, subject, toEmail, rule.recipient, 'failed', e.message);
      }
    }
  }

  return sentAnything;
}

// ── Trigger: status_change ────────────────────────────────────────────────────
// The one status-change loop. _email.js used to carry a near-identical
// fireStatusAutomations — the live path, while this one was reachable only via
// an HTTP action nothing called. Two copies of a rule loop is how a channel gets
// added to one of them and half the messages quietly stop.
async function triggerStatusChange(client, booking, newStatus, stripeLink) {
  try {
    await ensureTables(client);
    const { rows: rules } = await client.query(
      `SELECT * FROM automation_rules
       WHERE active=TRUE AND trigger_event='status_change' AND trigger_status=$1
       ORDER BY sort_order`,
      [newStatus]
    );
    for (const rule of rules) {
      await sendAutomationMessage(client, rule, booking, stripeLink);
    }
    return rules.length;
  } catch (e) {
    console.error('triggerStatusChange error:', e.message);
    return 0;
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
       WHERE status IN ('confirmed','quoted','accepted')
         AND event_date::date = $1::date
         AND id NOT IN (
           SELECT booking_id FROM email_log WHERE rule_id=$2 AND status='sent'
         )`,
      [dateStr, rule.id]
    );
    for (const booking of bookings) {
      if (await sendAutomationMessage(client, rule, booking, null)) sent++;
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
           SELECT booking_id FROM email_log WHERE rule_id=$2 AND status='sent'
         )`,
      [dateStr, rule.id]
    );
    for (const booking of bookings) {
      if (await sendAutomationMessage(client, rule, booking, null)) sent++;
    }
  }

  // days_after_created — fire N days after a booking was created while it is
  // still sitting in a given status (e.g. stale "review" bookings the owner
  // hasn't actioned). Uses created_at rather than event_date.
  const { rows: createdRules } = await client.query(
    `SELECT * FROM automation_rules
     WHERE active=TRUE AND trigger_event='days_after_created' AND trigger_days IS NOT NULL
     ORDER BY sort_order`
  );
  for (const rule of createdRules) {
    const { rows: bookings } = await client.query(
      `SELECT * FROM bookings
       WHERE status = $1
         AND created_at::date = (CURRENT_DATE - $2::int)
         AND id NOT IN (
           SELECT booking_id FROM email_log WHERE rule_id=$3 AND status='sent'
         )`,
      [rule.trigger_status, rule.trigger_days, rule.id]
    );
    for (const booking of bookings) {
      if (await sendAutomationMessage(client, rule, booking, null)) sent++;
    }
  }

  return sent;
}

// ── HTTP handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // All automations routes are admin-only
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
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
            return json(200, rows);
          }
          // Global log
          const { rows } = await client.query(
            `SELECT el.*, b.reference, b.client_name FROM email_log el
             JOIN bookings b ON b.id = el.booking_id
             ORDER BY el.sent_at DESC LIMIT 100`
          );
          return json(200, rows);
        }

        if (type === 'tasks') {
          const bookingId = event.queryStringParameters?.booking_id;
          if (!bookingId) return json(400, { error: 'booking_id required' });
          const { rows } = await client.query(
            'SELECT * FROM booking_tasks WHERE booking_id=$1 ORDER BY sort_order, id',
            [parseInt(bookingId)]
          );
          return json(200, rows);
        }

        // Default: list automation rules
        const { rows } = await client.query('SELECT * FROM automation_rules ORDER BY sort_order, id');
        return json(200, rows);
      }

      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { error: 'Invalid JSON' });
      }
      const action = body.action;

      // POST action:'run_scheduled' — trigger all scheduled automations (call daily via cron)
      if (action === 'run_scheduled') {
        const sent = await runScheduledAutomations(client);
        return json(200, { success: true, sent });
      }

      // POST action:'trigger_status' — called internally when booking status changes
      if (action === 'trigger_status') {
        const { booking_id, status, stripe_link } = body;
        const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
        if (!rows[0]) return json(404, { error: 'Booking not found' });
        await triggerStatusChange(client, rows[0], status, stripe_link || null);
        return json(200, { success: true });
      }

      // POST action:'send_manual' — manually send an email to a client
      if (action === 'send_manual') {
        const { booking_id, subject, html } = body;
        const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
        const booking = rows[0];
        if (!booking) return json(404, { error: 'Booking not found' });

        // No address = nothing to send. Say so instead of returning success.
        if (!booking.client_email) {
          return json(400, { success: false, error: 'This booking has no client email address, so nothing was sent' });
        }

        // A manual send is admin-initiated: report the failure rather than
        // claiming success, but still record it in email_log. No
        // RESEND_API_KEY pre-check — sendEmail throws on a missing key and
        // that must surface here, not be silently skipped.
        let res;
        try {
          res = await sendEmail(booking.client_email, subject, wrap(html));
          await logEmail(client, booking.id, null, 'Manual', subject, booking.client_email, 'client', logStatus(res));
        } catch (e) {
          console.error('manual email failed:', booking.client_email, '|', e.message);
          await logEmail(client, booking.id, null, 'Manual', subject, booking.client_email, 'client', 'failed', e.message);
          return json(502, { success: false, error: e.message });
        }

        if (res && res.suppressed) {
          return json(200, { success: true, suppressed: true, message: `Suppressed by EMAIL_ALLOWLIST — ${booking.client_email} is not on the list, so nothing was sent` });
        }
        return json(200, { success: true });
      }

      // POST action:'save_rule' — create or update an automation rule
      if (action === 'save_rule') {
        const r = body.rule;
        if (r.id) {
          // A partial update (toggleRule sends only {id, active}) must not blank
          // out every other column — this UPDATE used to set name/trigger_event/
          // subject/body_html unconditionally from an object that had none of
          // them, which violated their NOT NULL constraints and 500'd, silently
          // killing the active toggle.
          //
          // COALESCE($n, column) preserves the stored value when a field is
          // absent from the request (its JS value is `undefined`, sent below as
          // SQL NULL). `active` is deliberately NOT coalesced: `false` is a real,
          // meaningful value there, and COALESCE would treat it as "absent" only
          // if it were null — it isn't — so this is just a plain positional set.
          //
          // trigger_status/trigger_days are genuinely nullable and a full save
          // must be able to CLEAR them (e.g. switching a rule off status_change
          // unsets trigger_status). COALESCE alone can't tell "absent, preserve"
          // apart from "explicitly sent as null, clear it" — both arrive as SQL
          // NULL. So each carries its own hasOwnProperty flag ($4/$6) and a CASE:
          // present (even if null) → use the sent value; absent → keep the
          // column untouched. saveRule() always sends both keys on every save
          // (real value or null), so a full save can still clear them; toggleRule
          // never sends either key, so they survive a toggle untouched.
          const has = (k) => Object.prototype.hasOwnProperty.call(r, k);
          const orNull = (k) => has(k) ? r[k] : null;
          await client.query(
            `UPDATE automation_rules SET
               name=COALESCE($1, name), active=$2, trigger_event=COALESCE($3, trigger_event),
               trigger_status=CASE WHEN $4 THEN $5 ELSE trigger_status END,
               trigger_days=CASE WHEN $6 THEN $7 ELSE trigger_days END,
               recipient=COALESCE($8, recipient), subject=COALESCE($9, subject),
               body_html=COALESCE($10, body_html), sort_order=COALESCE($11, sort_order),
               channel=COALESCE($12, channel), body_sms=COALESCE($13, body_sms),
               updated_at=NOW()
             WHERE id=$14`,
            [orNull('name'), r.active !== false, orNull('trigger_event'),
             has('trigger_status'), r.trigger_status || null,
             has('trigger_days'), r.trigger_days || null,
             orNull('recipient'), orNull('subject'), orNull('body_html'), orNull('sort_order'),
             orNull('channel'), orNull('body_sms'), r.id]
          );
        } else {
          await client.query(
            `INSERT INTO automation_rules (name,active,trigger_event,trigger_status,trigger_days,recipient,subject,body_html,sort_order,channel,body_sms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [r.name,r.active!==false,r.trigger_event,r.trigger_status||null,
             r.trigger_days||null,r.recipient||'client',r.subject,r.body_html,r.sort_order||0,
             r.channel||'email',r.body_sms||'']
          );
        }
        return json(200, { success: true });
      }

      // POST action:'delete_rule'
      if (action === 'delete_rule') {
        await client.query('UPDATE automation_rules SET active=FALSE WHERE id=$1', [body.rule_id]);
        return json(200, { success: true });
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
        return json(200, { success: true });
      }

      // POST action:'complete_task'
      if (action === 'complete_task') {
        const { task_id, completed } = body;
        await client.query(
          'UPDATE booking_tasks SET completed=$1, completed_at=$2 WHERE id=$3',
          [completed, completed ? new Date() : null, task_id]
        );
        return json(200, { success: true });
      }

      // POST action:'delete_task'
      if (action === 'delete_task') {
        await client.query('DELETE FROM booking_tasks WHERE id=$1', [body.task_id]);
        return json(200, { success: true });
      }

      return json(400, { error: 'Unknown action' });

    } catch(err) {
      console.error('automations.js error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

module.exports.handler = exports.handler;
// Exported so automations-scheduled.js can run the same batch on a cron.
// Until that function existed, these rules only ever fired when someone
// clicked "run scheduled" in the admin UI.
module.exports.runScheduledAutomations = runScheduledAutomations;
module.exports.ensureTables = ensureTables;
module.exports.triggerStatusChange = triggerStatusChange;
module.exports.sendAutomationMessage = sendAutomationMessage;
module.exports.alreadySmsSent = alreadySmsSent;
