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

exports.handler = async () => {
  try {
    const result = await withClient((client) => syncAllFeeds(client, new Date()));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('calendar-sync FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.windowFor = windowFor;
module.exports.syncFeed = syncFeed;
module.exports.syncAllFeeds = syncAllFeeds;
