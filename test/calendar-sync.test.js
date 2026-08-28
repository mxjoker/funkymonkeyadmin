const { test } = require('node:test');
const assert = require('node:assert');
const { windowFor, syncFeed } = require('../netlify/functions/calendar-sync.js');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:x@test', 'SUMMARY:Dentist',
  'DTSTART;TZID=America/Chicago:20260912T140000',
  'DTEND;TZID=America/Chicago:20260912T150000',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const okFetch = async () => ({ ok: true, status: 200, text: async () => ICS });

function recordingClient() {
  const sqls = [];
  return { sqls, query: async (sql, params) => { sqls.push({ sql, params }); return { rows: [] }; } };
}

test('the window runs from a week back to eighteen months out', () => {
  const { windowStart, windowEnd } = windowFor(new Date('2026-08-27T12:00:00Z'));
  assert.strictEqual(windowStart.toISOString().slice(0, 10), '2026-08-20');
  assert.strictEqual(windowEnd.toISOString().slice(0, 10), '2028-02-27');
});

test('a good sync replaces the feed rows inside a transaction', async () => {
  const c = recordingClient();
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date('2026-08-27T12:00:00Z'), okFetch);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);

  const text = c.sqls.map(s => s.sql).join('\n');
  assert.match(text, /BEGIN/);
  assert.match(text, /DELETE FROM external_busy WHERE feed_id/i);
  assert.match(text, /INSERT INTO external_busy/i);
  assert.match(text, /COMMIT/);
  assert.ok(c.sqls.findIndex(s => /DELETE FROM external_busy/i.test(s.sql)) >
            c.sqls.findIndex(s => /BEGIN/.test(s.sql)), 'the delete must be inside the transaction');
});

test('a failing fetch records the error and DELETES NOTHING', async () => {
  const c = recordingClient();
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), boom);

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);

  const text = c.sqls.map(s => s.sql).join('\n');
  assert.ok(!/DELETE FROM external_busy/i.test(text),
    'stale busy rows must survive a failed sync — an empty calendar reporting you free is the failure this design exists to prevent');
  assert.match(text, /UPDATE calendar_feeds SET[\s\S]*last_status/i);
  const upd = c.sqls.find(s => /UPDATE calendar_feeds/i.test(s.sql));
  assert.ok(upd.params.includes('error'));
});

test('a non-200 response is an error, not an empty calendar', async () => {
  const c = recordingClient();
  const notFound = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), notFound);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /404/);
  assert.ok(!c.sqls.some(s => /DELETE FROM external_busy/i.test(s.sql)));
});

test('an oversized feed is refused rather than parsed', async () => {
  const c = recordingClient();
  const huge = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(5 * 1024 * 1024 + 1) });
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), huge);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /too large/i);
});

test('parser warnings are persisted so they can reach the conflict panel', async () => {
  const c = recordingClient();
  const withRule = async () => ({ ok: true, status: 200, text: async () => [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:y@test', 'SUMMARY:Third Thursday',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;BYSETPOS=3;BYDAY=TH',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n') });

  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date('2026-01-01T00:00:00Z'), withRule);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  const upd = c.sqls.find(s => /UPDATE calendar_feeds/i.test(s.sql));
  assert.match(JSON.stringify(upd.params), /Third Thursday/);
});

// --- URL-leak audit: the feed URL is a credential (a Google secret-ICS
// address grants standing read access to a personal calendar). Confirmed by
// hand against the real global fetch that a malformed URL produces a
// TypeError whose message embeds the exact input string
// ("Failed to parse URL from <url>") — this reproduces that failure with an
// injected fetchImpl and asserts the URL never survives into last_error.
test('a URL-embedding fetch failure never leaks the feed URL into the error', async () => {
  const c = recordingClient();
  const secretUrl = 'https://calendar.google.com/private-SECRETTOKEN123/basic.ics';
  const leaky = async () => { throw new TypeError(`Failed to parse URL from ${secretUrl}`); };
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: secretUrl }, new Date(), leaky);

  assert.strictEqual(r.ok, false);
  assert.ok(!r.error.includes(secretUrl), 'the raw feed URL must not appear in the returned error');
  assert.ok(!r.error.includes('SECRETTOKEN123'), 'the secret token must not appear in the returned error');

  const text = JSON.stringify(c.sqls);
  assert.ok(!text.includes(secretUrl), 'the raw feed URL must not appear in any SQL params written to the DB');
  assert.ok(!text.includes('SECRETTOKEN123'), 'the secret token must not appear in any SQL params written to the DB');
});
