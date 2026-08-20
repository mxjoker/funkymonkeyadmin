const { test } = require('node:test');
const assert = require('node:assert');

function loadSms() {
  delete require.cache[require.resolve('../netlify/functions/_sms.js')];
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/_sms.js');
}

function fakeClient(heldRows, optedOutPhones = []) {
  const queries = [];
  return {
    queries,
    updates: () => queries.filter(q => /UPDATE sms_log/i.test(q.sql)),
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM sms_log/i.test(sql) && /held/.test(sql)) return { rows: heldRows };
      if (/FROM sms_optout/i.test(sql)) {
        const phone = params[0];
        return { rows: optedOutPhones.includes(phone) ? [{ phone }] : [] };
      }
      return { rows: [{ id: 1 }] };
    }
  };
}

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, params: new URLSearchParams(opts.body) });
    return { ok: true, status: 201, json: async () => ({ sid: 'SM_flush', status: 'queued' }) };
  };
  return calls;
}

function creds() {
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_PHONE_NUMBER = '+14055550100';
}

const NINE_AM = new Date('2026-08-15T14:00:00Z'); // 09:00 CDT

test('a held message is sent when the flush runs in the morning', async () => {
  creds();
  const calls = stubFetch();
  const c = fakeClient([{ id: 3, phone: '+14055417953', body: 'Your booking is confirmed', booking_id: 5, staff_id: null, rule_id: 1, trigger_label: 'Confirmed', created_at: new Date('2026-08-15T03:00:00Z') }]);
  const { flushHeldSms } = loadSms();

  const res = await flushHeldSms(c, NINE_AM);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].params.get('Body'), 'Your booking is confirmed');
  assert.strictEqual(res.sent, 1);
});

// Otherwise the flush would re-hold what it just picked up, forever.
test('the flush does nothing during quiet hours', async () => {
  creds();
  const calls = stubFetch();
  const c = fakeClient([{ id: 3, phone: '+14055417953', body: 'hi', created_at: new Date() }]);
  const { flushHeldSms } = loadSms();

  const res = await flushHeldSms(c, new Date('2026-08-16T03:00:00Z')); // 22:00 CDT

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.sent, 0);
});

// "Your event is tomorrow" arriving three days late is worse than not arriving.
test('a held message older than 24 hours expires instead of sending', async () => {
  creds();
  const calls = stubFetch();
  const c = fakeClient([{ id: 3, phone: '+14055417953', body: 'Your event is tomorrow', created_at: new Date('2026-08-12T03:00:00Z') }]);
  const { flushHeldSms } = loadSms();

  const res = await flushHeldSms(c, NINE_AM);

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.expired, 1);
  assert.ok(c.updates().some(q => q.params.includes('expired')), 'the expiry is recorded, not silently dropped');
});

// The held row must be resolved, not left to be picked up again tomorrow.
test('a flushed row is updated in place rather than logged twice', async () => {
  creds();
  stubFetch();
  const c = fakeClient([{ id: 3, phone: '+14055417953', body: 'hi', created_at: new Date('2026-08-15T03:00:00Z') }]);
  const { flushHeldSms } = loadSms();

  await flushHeldSms(c, NINE_AM);

  const upd = c.updates()[0];
  assert.ok(upd, 'the held row must be updated');
  assert.ok(upd.params.includes('queued'));
  assert.ok(upd.params.includes('SM_flush'), 'the new SID belongs on the same row');
});

// The whole reason isOptedOut exists is to stop a message reaching someone who
// took the STOP path since it was held. A held-at-11pm message to a number that
// texted STOP at 2am must never reach Twilio at the 9am flush.
test('a held message to a number that opted out in the meantime is never sent', async () => {
  creds();
  const calls = stubFetch();
  const c = fakeClient(
    [{ id: 3, phone: '+14055417953', body: 'hi', created_at: new Date('2026-08-15T03:00:00Z') }],
    ['+14055417953']
  );
  const { flushHeldSms } = loadSms();

  const res = await flushHeldSms(c, NINE_AM);

  assert.strictEqual(calls.length, 0, 'an opted-out number must never be passed to fetch');
  assert.strictEqual(res.optedOut, 1);
  assert.ok(c.updates().some(q => q.params.includes('opted_out')), 'the opt-out is recorded, not silently dropped');
});

// A misconfigured Twilio must not read like "there was nothing to flush" —
// {sent:0, expired:0, optedOut:0} is exactly what a quiet morning also
// returns. `blocked` is what tells the two apart.
test('a misconfigured Twilio blocks the whole flush loudly instead of silently sending nothing', async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  const calls = stubFetch();
  const c = fakeClient([
    { id: 3, phone: '+14055417953', body: 'a', created_at: new Date('2026-08-15T03:00:00Z') },
    { id: 4, phone: '+14055417954', body: 'b', created_at: new Date('2026-08-15T03:00:00Z') },
  ]);
  const { flushHeldSms } = loadSms();

  const res = await flushHeldSms(c, NINE_AM);

  assert.strictEqual(calls.length, 0, 'fetch must never be called when Twilio is not configured');
  assert.strictEqual(res.blocked, 2, 'every held row is reported as blocked, not silently dropped');
  assert.strictEqual(c.updates().length, 0, 'nothing is marked sent, expired or opted-out — it was never actually processed');
});

// No live database in this test suite, so this cannot prove the guard filters
// rows correctly at runtime — that needs Postgres to actually evaluate
// NOT EXISTS. What it can prove, honestly, is that the SQL sent to the driver
// carries a per-day dedupe key rather than a per-booking one: a lifetime-once
// guard alerts on day 1, stays unstaffed, and goes silent for the rest of the
// window — quiet exactly as the risk peaks.
test('the unstaffed-alert dedupe query is scoped to today, not the booking\'s lifetime', async () => {
  process.env.NOTIFY_SMS = '+14055550199';
  const queries = [];
  // The window, statuses and wording now come from a rule, so the fake has to
  // hand one back — without it the function correctly returns before it ever
  // reaches the bookings query.
  const RULE = {
    id: 1, active: true, trigger_event: 'unstaffed', trigger_status: null, trigger_days: 3,
    body_sms: 'UNSTAFFED: {{service_name}} on {{event_date}}.'
  };
  const c = {
    query: async (sql, params) => {
      queries.push(sql);
      if (/FROM automation_rules/i.test(sql)) return { rows: [RULE] };
      return { rows: [] };
    }
  };
  const { unstaffedAlerts } = require('../netlify/functions/automations-scheduled.js');

  await unstaffedAlerts(c, new Date());

  const sql = queries.find(q => /FROM bookings/i.test(q));
  assert.ok(sql, 'unstaffedAlerts must query bookings');
  assert.ok(
    /l\.created_at::date\s*=\s*CURRENT_DATE/i.test(sql),
    'the dedupe must be scoped to today — a bare "trigger_label = \'Unstaffed alert\'" with no date component ' +
    'means the first alert ever sent for a booking suppresses every later one, forever'
  );
});
