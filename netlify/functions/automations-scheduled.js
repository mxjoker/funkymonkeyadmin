// netlify/functions/automations-scheduled.js
//
// Runs the date-driven automation rules once a day, plus three SMS jobs.
//
// Why this exists: `runScheduledAutomations` in automations.js was only
// reachable two ways — a manual POST of action:'run_scheduled', or a button in
// the admin UI. Its own comment said "call daily via cron" and nothing ever
// did. So rules whose trigger is date-relative never fired on their own.
//
// The rules select on a single calendar day (event_date = today ± trigger_days),
// so a missed run is a permanently missed send — there is no catch-up. That is
// what makes a real schedule, rather than a button, the correct fix.
//
// The three SMS jobs live here rather than in the rules engine because they
// send to STAFF. Every rule in automation_rules resolves its recipient as
// 'client' or 'admin' off the booking row; "everyone assigned to this booking"
// is a different query and a different address, and teaching the engine a third
// recipient type — plus its UI — for two messages is not worth it.
//
// Schedule lives in netlify.toml. Idempotency is each job's own concern.

const { withClient } = require('./_db');
const { runScheduledAutomations, ensureTables, sendDueScheduledEmails } = require('./automations');
const { ensureSmsTables, sendSms, flushHeldSms } = require('./_sms');
const { wantsSms } = require('./staff-assignments');

// ── Day-of reminder: call time and address, to everyone working today ────────
async function staffDayOfReminders(client, now) {
  const { rows } = await client.query(`
    SELECT sa.id AS assignment_id, sa.schedule_start, sa.tag_filled,
           s.id AS staff_id, s.phone, s.comms_preference, s.preferred_name, s.name,
           b.id AS booking_id, b.service_name, b.event_time, b.event_zip, b.event_location
    FROM staff_assignments sa
    JOIN staff s    ON s.id = sa.staff_id AND s.active = TRUE
    JOIN bookings b ON b.id = sa.booking_id
    WHERE sa.status = 'assigned'
      AND b.event_date::date = CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM sms_log l
        WHERE l.staff_id = s.id AND l.booking_id = b.id
          AND l.trigger_label = 'Day-of reminder'
      )
  `);
  let sent = 0;
  for (const r of rows) {
    if (!wantsSms(r) || !r.phone) continue;
    // schedule_start is a TIME column; pg does not parse it (no type-1083
    // registration), so it arrives as the raw Postgres text "HH:MM:SS" —
    // confirmed by test/staff-portal-times.test.js's "Postgres time values
    // with seconds are accepted", which already relies on this shape. Slicing
    // the first 5 characters gives "HH:MM".
    const when = r.schedule_start ? String(r.schedule_start).slice(0, 5) : (r.event_time || 'TBD');
    const where = r.event_location || r.event_zip || 'OKC';
    const res = await sendSms(client, r.phone,
      `Today: ${r.service_name}, ${r.tag_filled}. Load up ${when}. ${where}. Questions: (405) 431-6625`,
      { booking_id: r.booking_id, staff_id: r.staff_id, trigger_label: 'Day-of reminder', now });
    if (res.status === 'queued') sent++;
  }
  return sent;
}

// ── Unstaffed alert: to Joe, not to the crew ─────────────────────────────────
// The gap this closes: a gig three days out with nobody assigned is currently
// only visible if someone looks.
async function unstaffedAlerts(client, now) {
  const notify = process.env.NOTIFY_SMS;
  if (!notify) {
    console.error('unstaffedAlerts: NOTIFY_SMS unset — no alert sent');
    return 0;
  }
  const { rows } = await client.query(`
    SELECT b.id, b.service_name, b.event_date, b.event_zip
    FROM bookings b
    WHERE b.status IN ('accepted','confirmed')
      AND b.event_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + 3)
      AND NOT EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.booking_id = b.id AND sa.status = 'assigned')
      -- Dedupe is per DAY, not per booking. A lifetime-once guard means a gig
      -- alerts on day 1, stays unstaffed, and goes silent for the rest of the
      -- window — quiet exactly as the risk peaks. The staff_assignments
      -- NOT EXISTS above is what actually stops the noise: once someone is
      -- assigned the booking drops out of this result set entirely.
      AND NOT EXISTS (
        SELECT 1 FROM sms_log l
        WHERE l.booking_id = b.id
          AND l.trigger_label = 'Unstaffed alert'
          AND l.created_at::date = CURRENT_DATE
      )
    ORDER BY b.event_date
  `);
  let sent = 0;
  for (const b of rows) {
    const d = new Date(String(b.event_date).slice(0, 10) + 'T00:00:00Z')
      .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
    const res = await sendSms(client, notify,
      `UNSTAFFED: ${b.service_name} on ${d} (${b.event_zip || 'OKC'}) has nobody assigned.`,
      { booking_id: b.id, trigger_label: 'Unstaffed alert', now });
    if (res.status === 'queued') sent++;
  }
  return sent;
}

exports.handler = async () => {
  const startedAt = new Date().toISOString();
  const now = new Date();
  console.log(`Scheduled automations starting (${startedAt})`);

  try {
    const result = await withClient(async (client) => {
      await ensureTables(client);
      await ensureSmsTables(client);

      // Held first: these were due last night and are the most time-sensitive
      // thing in the run.
      //
      // Each of the three jobs is guarded independently — one failing query
      // must not cost the others their run, and a scheduled function that
      // fails quietly is how the original problem stayed invisible for months.
      const held = await flushHeldSms(client, now).catch(e => { console.error('flushHeldSms FAILED:', e.message); return { sent: 0, expired: 0, optedOut: 0, blocked: 0 }; });
      const sent = await runScheduledAutomations(client).catch(e => { console.error('runScheduledAutomations FAILED:', e.message); return 0; });
      const dayOf = await staffDayOfReminders(client, now).catch(e => { console.error('staffDayOfReminders FAILED:', e.message); return 0; });
      const alerts = await unstaffedAlerts(client, now).catch(e => { console.error('unstaffedAlerts FAILED:', e.message); return 0; });
      const followUps = await sendDueScheduledEmails(client, now).catch(e => { console.error('sendDueScheduledEmails FAILED:', e.message); return 0; });
      return { held, sent, dayOf, alerts, followUps };
    });

    console.log(`Scheduled automations complete — ${result.sent} rule message(s), ${result.held.sent} held SMS flushed, ${result.held.expired} expired, ${result.held.optedOut} opted out, ${result.held.blocked} blocked (no Twilio creds), ${result.dayOf} day-of reminder(s), ${result.alerts} unstaffed alert(s), ${result.followUps} scheduled follow-up(s)`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result, startedAt }) };
  } catch (e) {
    console.error('Scheduled automations FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message, startedAt }) };
  }
};

module.exports.staffDayOfReminders = staffDayOfReminders;
module.exports.unstaffedAlerts = unstaffedAlerts;
