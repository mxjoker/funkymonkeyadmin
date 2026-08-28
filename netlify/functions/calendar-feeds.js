// netlify/functions/calendar-feeds.js
//
// Admin CRUD for subscribed calendars, plus the "refresh now" action.
//
// The feed URL IS the credential — anyone holding a Google secret-ICS address
// can read that calendar indefinitely. So it is write-only from the API's point
// of view: it goes in, it never comes back out, and the only edit is replace.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function ensureCalendarTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id               SERIAL PRIMARY KEY,
      label            TEXT NOT NULL,
      url              TEXT NOT NULL,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_at   TIMESTAMPTZ,
      last_status      TEXT,
      last_error       TEXT,
      last_event_count INTEGER,
      last_warnings    JSONB NOT NULL DEFAULT '[]',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS external_busy (
      id         SERIAL PRIMARY KEY,
      feed_id    INTEGER NOT NULL REFERENCES calendar_feeds(id) ON DELETE CASCADE,
      starts_at  TIMESTAMPTZ NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      all_day    BOOLEAN NOT NULL DEFAULT FALSE,
      summary    TEXT,
      uid        TEXT,
      synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_busy_range ON external_busy (starts_at, ends_at)');
}

// Host and filename only. Everything between them is secret in every provider's
// scheme, so none of it survives.
//
// Only http(s) gets this treatment. Other schemes (data:, mailto:, javascript:,
// ...) carry their payload in places `new URL()` happily parses as "pathname" —
// which would walk the whole secret straight through. `save` only ever lets
// http(s) into the table today, but this function does not get to assume that:
// it must not depend on validation performed by a caller it doesn't control.
function maskUrl(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return s ? '…' : '';
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.protocol}//${u.host}/…/${last}`;
  } catch {
    return s ? '…' : '';
  }
}

const FEED_COLUMNS = 'id, label, url, active, last_synced_at, last_status, last_error, last_event_count, last_warnings';

async function listFeeds(client) {
  const { rows } = await client.query(`SELECT ${FEED_COLUMNS} FROM calendar_feeds ORDER BY id`);
  // Destructure the url away rather than deleting it, so a future column
  // addition cannot reintroduce it by accident.
  return rows.map(({ url, ...rest }) => ({ ...rest, url_masked: maskUrl(url) }));
}

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  const auth = await requireAuth(event, ['admin']); if (!auth) return unauthorized();

  try {
    return await withClient(async (client) => {
      await ensureCalendarTables(client);

      if (event.httpMethod === 'GET') {
        return json(200, { feeds: await listFeeds(client) });
      }

      if (event.httpMethod === 'POST') {
        let body; try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON' }); }

        if (body.action === 'save') {
          const label = String(body.label || '').trim();
          const url = String(body.url || '').trim();
          if (!label) return json(400, { error: 'A label is required.' });
          if (!/^https?:\/\//i.test(url)) return json(400, { error: 'The calendar address must be a http(s) URL.' });
          if (body.id) {
            const r = await client.query('UPDATE calendar_feeds SET label=$1, url=$2 WHERE id=$3', [label, url, body.id]);
            if (r.rowCount === 0) return json(404, { error: `No feed with id ${body.id}.` });
          } else {
            await client.query('INSERT INTO calendar_feeds (label, url) VALUES ($1,$2)', [label, url]);
          }
          return json(200, { feeds: await listFeeds(client) });
        }

        if (body.action === 'delete') {
          if (!body.id) return json(400, { error: 'Which feed?' });
          const r = await client.query('DELETE FROM calendar_feeds WHERE id=$1', [body.id]);
          if (r.rowCount === 0) return json(404, { error: `No feed with id ${body.id}.` });
          return json(200, { feeds: await listFeeds(client) });
        }

        if (body.action === 'refresh') {
          const { syncAllFeeds } = require('./calendar-sync');
          const result = await syncAllFeeds(client, new Date());
          return json(200, { feeds: await listFeeds(client), result });
        }

        return json(400, { error: `Unknown action "${body.action}".` });
      }

      return json(405, { error: 'Method not allowed' });
    });
  } catch (e) {
    console.error('calendar-feeds error:', e.message);
    return json(500, { error: 'Calendar feeds are unavailable right now.' });
  }
};

module.exports.ensureCalendarTables = ensureCalendarTables;
module.exports.maskUrl = maskUrl;
module.exports.listFeeds = listFeeds;
