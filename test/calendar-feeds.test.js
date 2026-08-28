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
