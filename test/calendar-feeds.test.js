const { test } = require('node:test');
const assert = require('node:assert');
const { maskUrl, listFeeds, ensureCalendarTables } = require('../netlify/functions/calendar-feeds.js');

test('maskUrl keeps enough to recognise a feed and hides the secret', () => {
  const u = 'https://calendar.google.com/calendar/ical/abc123secrettoken/private-9f8e7d6c/basic.ics';
  const m = maskUrl(u);
  assert.match(m, /^https:\/\/calendar\.google\.com\//);
  assert.match(m, /basic\.ics$/);
  assert.ok(!m.includes('abc123secrettoken'), 'the token must not survive masking');
  assert.ok(!m.includes('private-9f8e7d6c'), 'the private path must not survive masking');
});

test('maskUrl does not throw on junk', () => {
  assert.strictEqual(typeof maskUrl('not a url'), 'string');
  assert.strictEqual(typeof maskUrl(''), 'string');
  assert.strictEqual(typeof maskUrl(null), 'string');
});

test('listFeeds never returns the raw url — the URL is the credential', async () => {
  const c = { query: async () => ({ rows: [{
    id: 1, label: 'Personal',
    url: 'https://calendar.google.com/calendar/ical/SECRET/private-TOKEN/basic.ics',
    active: true, last_synced_at: null, last_status: null, last_error: null,
    last_event_count: null, last_warnings: [],
  }] }) };

  const feeds = await listFeeds(c);
  const blob = JSON.stringify(feeds);
  assert.ok(!blob.includes('SECRET'), 'raw url leaked out of listFeeds');
  assert.ok(!blob.includes('private-TOKEN'), 'raw url leaked out of listFeeds');
  assert.strictEqual(feeds[0].url, undefined, 'there must be no url property at all');
  assert.ok(feeds[0].url_masked, 'a masked form must be provided for display');
});

test('maskUrl rejects non-http(s) schemes, even though save enforces http(s) upstream', () => {
  const dataUrl = maskUrl('data:text/plain;base64,SECRETTOKEN==');
  assert.ok(!dataUrl.includes('SECRETTOKEN'), 'a data: URL must not leak its payload');

  const mailto = maskUrl('mailto:someone@example.com?body=SECRET');
  assert.ok(!mailto.includes('SECRET'), 'a mailto: URL must not leak its query');
  assert.ok(!mailto.includes('someone@example.com'), 'a mailto: URL must not leak its address');

  const js = maskUrl('javascript:alert(document.cookie)SECRET');
  assert.ok(!js.includes('SECRET'), 'a javascript: URL must not leak its body');
});

// HTTP handler with _db/_auth stubbed out, matching the pattern in
// sms-automations.test.js — neither talks to a real database or session.
function loadHandler(fakeClient) {
  for (const m of ['../netlify/functions/calendar-feeds.js', '../netlify/functions/_db.js', '../netlify/functions/_auth.js']) {
    delete require.cache[require.resolve(m)];
  }
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => ({ role: 'admin' });
  authMod.preflight = () => null;
  return require('../netlify/functions/calendar-feeds.js');
}

test('saving with an id that does not exist returns 404, not a silent no-op 200', async () => {
  const fakeClient = { query: async (sql) => {
    if (/^UPDATE calendar_feeds/i.test(sql)) return { rowCount: 0, rows: [] };
    return { rows: [] };
  } };
  const { handler } = loadHandler(fakeClient);

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'save', id: 999, label: 'Ghost', url: 'https://example.com/x.ics' }),
  });

  assert.strictEqual(res.statusCode, 404, 'updating a nonexistent feed must not report success');
});

test('deleting an id that does not exist returns 404, not a silent no-op 200', async () => {
  const fakeClient = { query: async (sql) => {
    if (/^DELETE FROM calendar_feeds/i.test(sql)) return { rowCount: 0, rows: [] };
    return { rows: [] };
  } };
  const { handler } = loadHandler(fakeClient);

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'delete', id: 999 }),
  });

  assert.strictEqual(res.statusCode, 404, 'deleting a nonexistent feed must not report success');
});

test('a webcal:// address is accepted and stored as https:// — Apple\'s share hands out webcal://', async () => {
  let savedUrl = null;
  const fakeClient = { query: async (sql, params) => {
    if (/^INSERT INTO calendar_feeds/i.test(sql)) { savedUrl = params[1]; return { rows: [] }; }
    return { rows: [] };
  } };
  const { handler } = loadHandler(fakeClient);

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'save', label: 'iCloud', url: 'webcal://p01-caldav.icloud.com/published/2/abc123' }),
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(savedUrl, 'https://p01-caldav.icloud.com/published/2/abc123', 'webcal:// must be normalised to https:// before it is stored');
});

test('ensureCalendarTables creates both tables and the range index', async () => {
  const sqls = [];
  const c = { query: async (sql) => { sqls.push(sql); return { rows: [] }; } };
  await ensureCalendarTables(c);
  const all = sqls.join('\n');
  assert.match(all, /CREATE TABLE IF NOT EXISTS calendar_feeds/i);
  assert.match(all, /CREATE TABLE IF NOT EXISTS external_busy/i);
  assert.match(all, /idx_busy_range/i);
  assert.match(all, /ON DELETE CASCADE/i, 'deleting a feed must take its busy rows with it');
});
