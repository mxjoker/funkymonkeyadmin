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
const { ensureSmsTables, sendSms, flushHeldSms, renderSms } = require('./_sms');
// fmtEventDate, not a sixth private date formatter: event_date arrives as
// "…T00:00:00.000Z" and any renderer that parses that whole string shows the
// previous evening in Central. See test/my-booking-date.test.js.
const { fmtEventDate } = require('./_email');
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

  // Window, statuses and wording all come from the rule now. Editable in
  // Automations; previously all three were literals in this file.
  const { rows: ruleRows } = await client.query(
    "SELECT * FROM automation_rules WHERE trigger_event='unstaffed' ORDER BY id LIMIT 1");
  const rule = ruleRows[0];
  if (!rule) {
    console.error('unstaffedAlerts: no unstaffed rule found — no alert sent');
    return 0;
  }
  if (!rule.active) return 0;

  // Blank trigger_status means "both", which is the historical behaviour and
  // the default. A single status narrows it — the useful case being confirmed
  // only, so an accepted-but-unpaid booking stops nagging.
  const statuses = rule.trigger_status ? [rule.trigger_status] : ['accepted', 'confirmed'];
  // A rule saved with no day count must not silently become "today only".
  const days = Number.isFinite(Number(rule.trigger_days)) && Number(rule.trigger_days) >= 0
    ? Number(rule.trigger_days) : 3;

  const { rows } = await client.query(`
    SELECT b.*
    FROM bookings b
    WHERE b.status = ANY($1)
      AND b.event_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $2::int)
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
  `, [statuses, days]);

  let sent = 0;
  for (const b of rows) {
    const body = renderSms(rule.body_sms || '', b);
    if (!body.trim()) {
      console.error('unstaffedAlerts: the rule has an empty message — nothing sent for booking', b.id);
      continue;
    }
    const res = await sendSms(client, notify, body,
      { booking_id: b.id, trigger_label: 'Unstaffed alert', now });
    if (res.status === 'queued') sent++;
  }
  return sent;
}


// ── Incomplete-gig alert: the fields staffing is built on ────────────────────
// The gap this closes, measured 2026-09-15: booking 18 was confirmed, 11 days
// out, with Joe himself assigned — and had no event_time and no ZIP. spanFor()
// cannot compute a shift window without a time, so the assignment carried
// schedule_start = NULL and the staff portal showed "Load up — not calculated
// yet". Nothing said so. Two more upcoming gigs were in the same state, and
// nine of thirty-three upcoming bookings had no service_id.
//
// admin.html's incompleteReasons() already paints exactly this list in the
// dashboard panel — the detection was never the problem. Nobody was told. This
// sends the same finding rather than re-deriving it, so the two agree on what
// "incomplete" means; the reason strings below are deliberately the same words.
//
// Alert fatigue is the real risk: an incomplete gig stays incomplete until
// someone edits it, so this must not text every day forever. The window is the
// rule's trigger_days (default 14) and the dedupe is per booking per DAY, the
// same shape as the unstaffed alert — but the gig drops out of the result the
// moment the missing field is filled in, which is what actually ends the noise.
async function incompleteAlerts(client, now) {
  const notify = process.env.NOTIFY_SMS;
  if (!notify) {
    console.error('incompleteAlerts: NOTIFY_SMS unset — no alert sent');
    return 0;
  }

  const { rows: ruleRows } = await client.query(
    "SELECT * FROM automation_rules WHERE trigger_event='incomplete' ORDER BY id LIMIT 1");
  const rule = ruleRows[0];
  if (!rule) {
    console.error('incompleteAlerts: no incomplete rule found — no alert sent');
    return 0;
  }
  if (!rule.active) return 0;

  const statuses = rule.trigger_status ? [rule.trigger_status] : ['accepted', 'confirmed'];
  const days = Number.isFinite(Number(rule.trigger_days)) && Number(rule.trigger_days) >= 0
    ? Number(rule.trigger_days) : 14;

  // coalesce(col,'') <> '' rather than IS NOT NULL: every text column in this
  // schema is DEFAULT '', so IS NOT NULL is a dead test that is always true.
  // That exact mistake shipped a migration guard that could never fire.
  const { rows } = await client.query(`
    SELECT b.*,
           CASE WHEN coalesce(b.service_id,'') = '' THEN 'no service' END AS r_service,
           CASE WHEN coalesce(b.event_time::text,'') = '' THEN 'no time' END AS r_time,
           CASE WHEN coalesce(b.event_zip,'') = '' THEN 'no ZIP' END AS r_zip
    FROM bookings b
    WHERE b.status = ANY($1)
      AND b.event_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $2::int)
      AND (coalesce(b.service_id,'') = ''
        OR coalesce(b.event_time::text,'') = ''
        OR coalesce(b.event_zip,'') = '')
      AND NOT EXISTS (
        SELECT 1 FROM sms_log l
        WHERE l.trigger_label = 'Incomplete gig'
          AND l.created_at::date = CURRENT_DATE
      )
    ORDER BY b.event_date
  `, [statuses, days]);

  if (!rows.length) return 0;

  // ONE message for all of them, not one each. The unstaffed alert sends per
  // booking because a gig three days out with no crew is a separate emergency
  // each time; this is a list of paperwork, it runs on a 14-day window, and a
  // gig stays incomplete until someone edits it. Measured against production
  // 2026-09-15 the per-booking shape would have sent SIX texts on the first
  // run and six more every day after — which is how an alert gets ignored, and
  // an ignored alert is worse than none because it still looks like cover.
  //
  // The per-day dedupe therefore carries no booking_id: the digest is one
  // message about the whole window, so "already sent today" is one question,
  // not one per booking.
  const lines = rows.map((b) => {
    const reasons = [b.r_service, b.r_time, b.r_zip].filter(Boolean).join(', ');
    // Slice to YYYY-MM-DD before parsing: event_date is a DATE column and pg
    // hands it over as "…T00:00:00.000Z", which formats as the previous evening
    // in Central. fmtEventDate does this correctly, so use it rather than a
    // sixth private copy of the same formatter.
    // Short form: the full "Thursday, September 17, 2026" made a six-gig digest
    // 461 characters, which Twilio bills as four segments every day. Six gigs
    // now fit in two. fmtEventDate takes Intl options, so this is still the
    // one formatter rather than a private one that could drift a day.
    return `${b.client_name || 'Unnamed'} ${fmtEventDate(b.event_date, { weekday: undefined, month: 'short', year: undefined })} (${reasons})`;
  });

  const body = (rule.body_sms || '')
    .replace(/{{count}}/g, String(rows.length))
    .replace(/{{list}}/g, lines.join('; '));
  if (!body.trim()) {
    console.error('incompleteAlerts: the rule has an empty message — nothing sent');
    return 0;
  }

  const res = await sendSms(client, notify, body, { trigger_label: 'Incomplete gig', now });
  return res.status === 'queued' ? 1 : 0;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
// The stamp that proves this run happened. Until it existed the only trace a
// run left was the mail it sent, so a run that died was indistinguishable from
// a quiet day with nothing due — which is how 2026-09-02 cost a client her
// reminder and stayed invisible until someone audited the database by hand.
//
// Deliberately NOT an alert of its own: whoever reads this stamp is a different
// job, because a dead run cannot notice that it is dead. calendar-sync runs
// hourly and does the reading.
// Created here too: this function reaches admin_settings without going through
// _auth or calendar.js, so on a cold database the table need not exist yet.
async function recordRun(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS admin_settings (
    key VARCHAR(64) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await client.query(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES ('last_automation_run', NOW()::text, NOW())
     ON CONFLICT (key) DO UPDATE SET value=NOW()::text, updated_at=NOW()`
  );
}

// A dead man's switch for the case the heartbeat cannot cover: Netlify never
// invoking anything at all, which takes the hourly reader down with this job.
// Inert until HEALTHCHECK_URL is set, so it costs nothing until it is wanted.
async function pingHealthcheck() {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch (e) {
    // A monitoring ping must never be the reason a run reports failure.
    console.error('healthcheck ping failed:', e.message);
  }
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
      //
      // Each guard also names itself in `failures`. Swallowing an exception is
      // right for the other jobs' sake and wrong for anyone's knowledge of it:
      // a run that limped is not a run that worked, and only a clean one earns
      // the heartbeat below.
      const failures = [];
      const guard = (name, fallback) => (e) => { console.error(`${name} FAILED:`, e.message); failures.push(name); return fallback; };

      const held = await flushHeldSms(client, now).catch(guard('flushHeldSms', { sent: 0, expired: 0, optedOut: 0, blocked: 0 }));
      const sent = await runScheduledAutomations(client).catch(guard('runScheduledAutomations', 0));
      const dayOf = await staffDayOfReminders(client, now).catch(guard('staffDayOfReminders', 0));
      const alerts = await unstaffedAlerts(client, now).catch(guard('unstaffedAlerts', 0));
      const gaps = await incompleteAlerts(client, now).catch(guard('incompleteAlerts', 0));
      const followUps = await sendDueScheduledEmails(client, now).catch(guard('sendDueScheduledEmails', 0));

      // Only a clean run stamps the heartbeat, so the hourly reader alerts on a
      // run that blew up as well as on one that never happened.
      if (!failures.length) await recordRun(client);
      return { held, sent, dayOf, alerts, gaps, followUps, failures };
    });

    if (!result.failures.length) await pingHealthcheck();

    console.log(`Scheduled automations complete — ${result.sent} rule message(s), ${result.held.sent} held SMS flushed, ${result.held.expired} expired, ${result.held.optedOut} opted out, ${result.held.blocked} blocked (no Twilio creds), ${result.dayOf} day-of reminder(s), ${result.alerts} unstaffed alert(s), ${result.gaps} incomplete-gig alert(s), ${result.followUps} scheduled follow-up(s)${result.failures.length ? ` — ${result.failures.length} job(s) FAILED: ${result.failures.join(', ')}` : ''}`);
    return { statusCode: 200, body: JSON.stringify({ ok: !result.failures.length, ...result, startedAt }) };
  } catch (e) {
    console.error('Scheduled automations FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message, startedAt }) };
  }
};

module.exports.staffDayOfReminders = staffDayOfReminders;
module.exports.unstaffedAlerts = unstaffedAlerts;
module.exports.incompleteAlerts = incompleteAlerts;
module.exports.recordRun = recordRun;
