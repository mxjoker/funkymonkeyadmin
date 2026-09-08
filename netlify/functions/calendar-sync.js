// netlify/functions/calendar-sync.js
//
// Pulls every active feed once an hour into external_busy.
//
// One rule governs the error handling here: a feed that fails keeps the rows it
// already had. Deleting first and refetching second would turn a transient 500
// at Google into an empty calendar, and an empty calendar says "you are free"
// with total confidence. Stale data is wrong by hours; an empty table is wrong
// by an entire booked Saturday.

const { withClient } = require('./_db');
const { parseIcs } = require('./_ics');
const { ensureCalendarTables } = require('./calendar-feeds');
const { ensureSmsTables, sendSms } = require('./_sms');

const TZ = 'America/Chicago';
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

function windowFor(now) {
  const windowStart = new Date(now.getTime() - 7 * 86400000);
  const windowEnd = new Date(now.getTime());
  windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 18);
  return { windowStart, windowEnd };
}

// The feed URL is a credential (a Google secret-ICS address grants standing
// read access to a personal calendar). Node's fetch embeds the exact URL it
// was given, verbatim, in TypeError messages for a malformed address (e.g.
// "Failed to parse URL from https://...token=SECRET") — confirmed by hand
// against the real global fetch, not assumed. Exact-string removal only
// catches that one spelling, though — a lowercased host, a stripped default
// port, a percent-encoded space, or a redirect target that came back
// normalised all survive it. There is no diagnostic case where a raw URL in
// an error is worth that risk: a human fixes a broken feed by its label, not
// its address. So strip the known URL first, then blanket-redact anything
// URL-shaped, closing the class rather than the one instance.
function redactUrl(message, url) {
  let s = String(message == null ? '' : message);
  if (url) s = s.split(url).join('[feed url redacted]');
  return s.replace(/https?:\/\/\S+/gi, '[feed url redacted]');
}

async function syncFeed(client, feed, now, fetchImpl = fetch) {
  const { windowStart, windowEnd } = windowFor(now);
  let events = [], warnings = [], error = null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let text;
    try {
      const res = await fetchImpl(feed.url, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
      text = await res.text();
    } finally { clearTimeout(timer); }

    if (text.length > MAX_BYTES) throw new Error(`feed is too large (${text.length} bytes)`);

    // With redirect: 'follow', a revoked or rotated secret URL commonly answers
    // 200 with an HTML sign-in page rather than an HTTP error. parseIcs would
    // find zero events in that body — indistinguishable from a genuinely empty
    // calendar — and the feed would be stamped healthy with last_event_count=0.
    // A rotated Google URL must read as a broken feed, never as an empty
    // calendar that reports Joe free.
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('feed did not return a calendar (is the address still valid?)');

    const parsed = parseIcs(text, { windowStart, windowEnd, tz: TZ });
    events = parsed.events;
    warnings = parsed.warnings;
  } catch (e) {
    error = e.name === 'AbortError'
      ? `feed timed out after ${FETCH_TIMEOUT_MS}ms`
      : redactUrl(e.message, feed.url);
  }

  if (error) {
    // Deliberately no DELETE. See the header.
    await client.query(
      `UPDATE calendar_feeds SET last_status=$1, last_error=$2, last_synced_at=NOW() WHERE id=$3`,
      ['error', error, feed.id]
    );
    return { ok: false, count: 0, warnings: [], error };
  }

  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM external_busy WHERE feed_id=$1', [feed.id]);
    for (const e of events) {
      await client.query(
        `INSERT INTO external_busy (feed_id, starts_at, ends_at, all_day, summary, uid)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [feed.id, e.startsAt.toISOString(), e.endsAt.toISOString(), e.allDay, e.summary, e.uid]
      );
    }
    await client.query(
      `UPDATE calendar_feeds
          SET last_status=$1, last_error=NULL, last_event_count=$2, last_warnings=$3::jsonb, last_synced_at=NOW()
        WHERE id=$4`,
      ['ok', events.length, JSON.stringify(warnings), feed.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    const writeError = `write failed: ${redactUrl(e.message, feed.url)}`;
    await client.query(
      `UPDATE calendar_feeds SET last_status=$1, last_error=$2, last_synced_at=NOW() WHERE id=$3`,
      ['error', writeError, feed.id]
    );
    return { ok: false, count: 0, warnings: [], error: writeError };
  }

  return { ok: true, count: events.length, warnings, error: null };
}

async function syncAllFeeds(client, now = new Date(), fetchImpl = fetch) {
  await ensureCalendarTables(client);
  const { rows: feeds } = await client.query(
    'SELECT id, label, url FROM calendar_feeds WHERE active = TRUE ORDER BY id');
  let synced = 0, failed = 0;
  for (const feed of feeds) {
    // Feeds are independent: one bad URL — or any other per-feed exception,
    // including one syncFeed itself failed to catch — must not stop the rest.
    let r;
    try {
      r = await syncFeed(client, feed, now, fetchImpl);
    } catch (e) {
      r = { ok: false, error: redactUrl(e.message, feed.url) };
    }
    if (r.ok) synced++;
    else { failed++; console.error(`calendar-sync: feed ${feed.id} (${feed.label}) failed — ${r.error}`); }
  }
  console.log(`calendar-sync: ${synced} feed(s) synced, ${failed} failed`);
  return { synced, failed };
}

// ── Watching the daily automations run ───────────────────────────────────────
// This job is here only because it is the one that runs hourly. A dead run
// cannot report itself, so something else has to notice the silence, and the
// alternative — a second scheduled function whose only purpose is to look —
// is a whole cron to maintain for one query.
//
// The signal is the heartbeat's age, NOT whether any mail went out. Over the
// 30 days to 2026-09-06 the automations sent nothing at all on 12 of them and
// only one was a fault, so alerting on a quiet day would have cried wolf
// eleven times and taught everyone to ignore it.
//
// 25 hours, not 24: the run is daily, so a 24h threshold would trip on ordinary
// minute-to-minute drift between one run and the next.
const STALE_AFTER_HOURS = 25;

async function checkAutomationsHeartbeat(client, now = new Date()) {
  const notify = process.env.NOTIFY_SMS;
  if (!notify) return { alerted: false, reason: 'NOTIFY_SMS unset' };

  await ensureSmsTables(client);
  const { rows } = await client.query(
    "SELECT updated_at FROM admin_settings WHERE key='last_automation_run'");

  // No stamp at all means the heartbeat has never been written — true on the
  // first deploy, before the next 14:00 run. Staying quiet until there is
  // something to compare against beats a guaranteed alert on release day.
  if (!rows.length || !rows[0].updated_at) return { alerted: false, reason: 'no heartbeat yet' };

  const ageHours = (now - new Date(rows[0].updated_at)) / 3600000;
  if (ageHours < STALE_AFTER_HOURS) return { alerted: false, ageHours };

  // Once a day while it stays broken, not once an hour. Same per-day dedupe the
  // unstaffed alert uses, for the same reason.
  const { rows: already } = await client.query(
    `SELECT 1 FROM sms_log
     WHERE trigger_label='Automations stalled' AND created_at::date = CURRENT_DATE LIMIT 1`);
  if (already.length) return { alerted: false, reason: 'already alerted today', ageHours };

  await sendSms(client, notify,
    `Automations have not run for ${Math.floor(ageHours)}h. Client reminders are not going out. Check the Netlify function log.`,
    { trigger_label: 'Automations stalled', now });
  return { alerted: true, ageHours };
}

exports.handler = async () => {
  try {
    const result = await withClient(async (client) => {
      const synced = await syncAllFeeds(client, new Date());
      // Guarded: the watchdog must never be the reason the sync reports failure.
      const heartbeat = await checkAutomationsHeartbeat(client, new Date())
        .catch(e => { console.error('checkAutomationsHeartbeat FAILED:', e.message); return { alerted: false }; });
      if (heartbeat.alerted) console.error(`calendar-sync: automations stalled ${Math.floor(heartbeat.ageHours)}h — alert sent`);
      return { ...synced, heartbeat };
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    // Every per-feed path redacts before returning, so nothing here should
    // carry a URL today — but this is the one checkpoint explicitly named as
    // needing it, and "no path reaches it today" is what every leak is until
    // someone adds a path. Redact anyway.
    const message = redactUrl(e.message);
    console.error('calendar-sync FAILED:', message);
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
};

module.exports.windowFor = windowFor;
module.exports.syncFeed = syncFeed;
module.exports.syncAllFeeds = syncAllFeeds;
module.exports.checkAutomationsHeartbeat = checkAutomationsHeartbeat;
module.exports.STALE_AFTER_HOURS = STALE_AFTER_HOURS;
