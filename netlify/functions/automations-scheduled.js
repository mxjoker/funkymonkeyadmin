// netlify/functions/automations-scheduled.js
//
// Runs the date-driven automation rules once a day.
//
// Why this exists: `runScheduledAutomations` in automations.js was only
// reachable two ways — a manual POST of action:'run_scheduled', or a button in
// the admin UI. Its own comment said "call daily via cron" and nothing ever
// did. So rules whose trigger is date-relative (days_before_event,
// days_after_event, days_after_enquiry, days_after_created) never fired on
// their own: pre-event reminders and post-event follow-ups only went out if
// someone happened to click the button.
//
// The rules select on a single calendar day (event_date = today ± trigger_days),
// so a missed run is a permanently missed send — there is no catch-up. That is
// what makes a real schedule, rather than a button, the correct fix.
//
// Schedule lives in netlify.toml. Idempotency is the rules' own concern:
// each one filters out bookings that already have a 'sent' email_log row for
// that rule, so a double-run in a day cannot double-send.

const { withClient } = require('./_db');
const { runScheduledAutomations, ensureTables } = require('./automations');

exports.handler = async () => {
  const startedAt = new Date().toISOString();
  console.log(`Scheduled automations starting (${startedAt})`);

  try {
    const sent = await withClient(async (client) => {
      await ensureTables(client);
      return runScheduledAutomations(client);
    });

    console.log(`Scheduled automations complete — ${sent} email(s) sent`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent, startedAt }) };
  } catch (e) {
    // Surface the reason. A scheduled function that fails quietly is how the
    // original problem stayed invisible for months.
    console.error('Scheduled automations FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message, startedAt }) };
  }
};
