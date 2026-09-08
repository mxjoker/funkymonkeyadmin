const { test } = require('node:test');
const assert = require('node:assert');

// The watchdog's value is entirely in what it does NOT alert on. Alerting on a
// day with no mail would have fired 12 times in 30 days for one real fault, so
// these tests pin the quiet cases as hard as the noisy one.

function load() {
  delete require.cache[require.resolve('../netlify/functions/calendar-sync.js')];
  delete require.cache[require.resolve('../netlify/functions/_sms.js')];
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/calendar-sync.js');
}

const NOW = new Date('2026-09-07T15:17:00Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 3600000);

// Stands in for the database: one heartbeat row, and whether an alert already
// went out today.
function fakeClient({ heartbeat, alertedToday = false }) {
  const sent = [];
  return {
    sent,
    query: async (sql) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/FROM admin_settings/i.test(sql)) {
        return { rows: heartbeat === null ? [] : [{ updated_at: heartbeat }] };
      }
      if (/FROM sms_log/i.test(sql) && /Automations stalled/.test(sql)) {
        return { rows: alertedToday ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO sms_log/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/FROM sms_optout/i.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };
}

function twilio() {
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_PHONE_NUMBER = '+14055550100';
  process.env.NOTIFY_SMS = '+14055417953';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(new URLSearchParams(opts.body));
    return { ok: true, status: 201, json: async () => ({ sid: 'SM_hb', status: 'queued' }) };
  };
  return calls;
}

test('a run that happened an hour ago is not alerted on', async () => {
  twilio();
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: hoursAgo(1) }), NOW);
  assert.strictEqual(res.alerted, false);
});

test('a quiet day — a run that sent no mail at all — is not a fault', async () => {
  const calls = twilio();
  const { checkAutomationsHeartbeat } = load();
  // The heartbeat is written by a clean run whether or not it sent anything,
  // so "nothing was due" looks exactly like a healthy run. That is the point.
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: hoursAgo(23) }), NOW);
  assert.strictEqual(res.alerted, false);
  assert.strictEqual(calls.length, 0, 'no text on a quiet day');
});

test('24 hours is still fine — a daily job drifts minute to minute', async () => {
  twilio();
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: hoursAgo(24.5) }), NOW);
  assert.strictEqual(res.alerted, false, '24h exactly would trip on ordinary drift');
});

test('a run that never happened is alerted on', async () => {
  const calls = twilio();
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: hoursAgo(26) }), NOW);
  assert.strictEqual(res.alerted, true);
  assert.strictEqual(calls.length, 1, 'exactly one text');
  assert.match(calls[0].get('Body'), /have not run/i);
  assert.strictEqual(calls[0].get('To'), '+14055417953', 'goes to Joe, not a client');
});

test('a stall alerts once a day, not once an hour', async () => {
  const calls = twilio();
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(
    fakeClient({ heartbeat: hoursAgo(50), alertedToday: true }), NOW);
  assert.strictEqual(res.alerted, false);
  assert.strictEqual(calls.length, 0, '24 texts a day is its own kind of broken');
});

test('the first deploy, before any run has stamped, stays quiet', async () => {
  const calls = twilio();
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: null }), NOW);
  assert.strictEqual(res.alerted, false, 'no heartbeat yet is not a stall');
  assert.strictEqual(calls.length, 0, 'release day must not alert');
});

test('with no number configured it reports that rather than pretending to watch', async () => {
  twilio();
  delete process.env.NOTIFY_SMS;
  const { checkAutomationsHeartbeat } = load();
  const res = await checkAutomationsHeartbeat(fakeClient({ heartbeat: hoursAgo(99) }), NOW);
  assert.strictEqual(res.alerted, false);
  assert.match(res.reason, /NOTIFY_SMS/);
});

// ── the writer ──────────────────────────────────────────────────────────────

test('only a clean run stamps the heartbeat', async () => {
  const { recordRun } = require('../netlify/functions/automations-scheduled.js');
  const seen = [];
  await recordRun({ query: async (sql) => { seen.push(sql); return { rows: [] }; } });
  assert.ok(seen.some(s => /INSERT INTO admin_settings/i.test(s)), 'writes the stamp');
  assert.ok(seen.some(s => /last_automation_run/.test(s)), 'under the key the watchdog reads');
  assert.ok(seen.some(s => /CREATE TABLE IF NOT EXISTS admin_settings/i.test(s)),
    'this function reaches admin_settings without _auth, so it must ensure the table');
});
