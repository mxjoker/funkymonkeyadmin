const { test } = require('node:test');
const assert = require('node:assert');

function loadSms() {
  delete require.cache[require.resolve('../netlify/functions/_sms.js')];
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/_sms.js');
}

// Minimal pg client stand-in. No database in tests — the queries themselves are
// the assertion surface.
function fakeClient({ optedOut = false } = {}) {
  const queries = [];
  return {
    queries,
    inserts: () => queries.filter(q => /INSERT INTO sms_log/i.test(q.sql)),
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM sms_optout/i.test(sql)) return { rows: optedOut ? [{ phone: params[0] }] : [] };
      return { rows: [{ id: 1 }] };
    }
  };
}

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, params: new URLSearchParams(opts.body), headers: opts.headers });
    return {
      ok: response.ok !== false,
      status: response.status || (response.ok === false ? 400 : 201),
      json: async () => response.json ?? { sid: 'SM_test_123', status: 'queued' }
    };
  };
  return calls;
}

function withCreds() {
  process.env.TWILIO_ACCOUNT_SID  = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN   = 'tok_test';
  process.env.TWILIO_PHONE_NUMBER = '+14055550100';
  process.env.SITE_URL            = 'https://funkymonkeyadmin.netlify.app';
}

// 10am CDT — inside the send window, so these cases test the thing they name.
const DAYTIME = new Date('2026-08-15T15:00:00Z');

test('a good number reaches Twilio with the right payload', async () => {
  withCreds();
  const calls = stubFetch({ ok: true });
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, '405-541-7953', 'Gig Saturday?', { staff_id: 7, now: DAYTIME });

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /Accounts\/AC_test\/Messages\.json$/);
  assert.strictEqual(calls[0].params.get('To'), '+14055417953', 'must send E.164, not the raw column value');
  assert.strictEqual(calls[0].params.get('From'), '+14055550100');
  assert.strictEqual(calls[0].params.get('Body'), 'Gig Saturday?');
  assert.ok(calls[0].params.get('StatusCallback'), 'must ask Twilio for delivery status');
  assert.strictEqual(res.status, 'queued');
  assert.strictEqual(res.sid, 'SM_test_123');
});

// The core invariant of the whole feature.
test('a 201 from Twilio is logged as queued, never as delivered or sent', async () => {
  withCreds();
  stubFetch({ ok: true });
  const c = fakeClient();
  const { sendSms } = loadSms();

  await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  const insert = c.inserts()[0];
  assert.ok(insert, 'a row must be written');
  assert.ok(insert.params.includes('queued'), 'accepted-by-Twilio is queued; only the callback may say delivered');
  assert.ok(!insert.params.includes('delivered'), 'sendSms must never write delivered');
});

test('an opted-out number is never passed to fetch', async () => {
  withCreds();
  const calls = stubFetch({ ok: true });
  const c = fakeClient({ optedOut: true });
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  assert.strictEqual(calls.length, 0, 'asserting on the absence of the call, not the return value');
  assert.strictEqual(res.status, 'opted_out');
  assert.ok(c.inserts()[0].params.includes('opted_out'), 'the skip is logged, not silent');
});

test('an unparseable number is logged with its raw value and never sent', async () => {
  withCreds();
  const calls = stubFetch({ ok: true });
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, 'TBD', 'hi', { now: DAYTIME });

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.status, 'invalid_number');
  const insert = c.inserts()[0];
  assert.ok(insert.params.includes('invalid_number'));
  assert.ok(insert.params.includes('TBD'), 'the raw value must be recoverable from the log');
});

test('a message outside quiet hours is held, not dropped and not sent', async () => {
  withCreds();
  const calls = stubFetch({ ok: true });
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: new Date('2026-08-16T03:30:00Z') }); // 22:30 CDT

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.status, 'held');
  assert.ok(c.inserts()[0].params.includes('held'), 'held rows are what the morning flush picks up');
});

test('a Twilio error is logged with the provider code and does not throw', async () => {
  withCreds();
  stubFetch({ ok: false, status: 400, json: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } });
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  assert.strictEqual(res.status, 'failed');
  assert.match(res.reason, /21610/);
  assert.ok(c.inserts()[0].params.includes('failed'));
});

test('a thrown fetch does not escape sendSms', async () => {
  withCreds();
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  assert.strictEqual(res.status, 'failed', 'an outage must never break the booking that triggered it');
  assert.match(res.reason, /ECONNRESET/);
});

test('missing credentials are reported, not treated as a successful send', async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  const calls = stubFetch({ ok: true });
  const c = fakeClient();
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.status, 'no_credentials');
});

test('a message that sends successfully but fails to log returns logged: false', async () => {
  withCreds();
  stubFetch({ ok: true });
  // Fake client that rejects on INSERT — simulates logSms failure
  const c = {
    queries: [],
    inserts: () => [],
    query: async (sql, params) => {
      if (/INSERT INTO sms_log/i.test(sql)) throw new Error('Database offline');
      if (/FROM sms_optout/i.test(sql)) return { rows: [] };
      return { rows: [{ id: 1 }] };
    }
  };
  const { sendSms } = loadSms();

  const res = await sendSms(c, '4055417953', 'hi', { now: DAYTIME });

  assert.strictEqual(res.status, 'queued', 'the message really did send to Twilio');
  assert.strictEqual(res.logged, false, 'but the log write failed, so logged: false');
  assert.ok(res.sid, 'SID is present because Twilio accepted it');
});

// ── Segment counting: encoding cliffs ──────────────────────────────────────
test('100 pure-ASCII characters fit in one GSM-7 segment', () => {
  const { smsSegments } = loadSms();
  const ascii = 'a'.repeat(100);
  assert.strictEqual(smsSegments(ascii), 1, '100 ASCII chars <= 160 GSM-7 limit');
});

test('the same message with a single em dash becomes two segments', () => {
  const { smsSegments } = loadSms();
  const ascii = 'a'.repeat(70);
  assert.strictEqual(smsSegments(ascii), 1, 'baseline: 70 ASCII chars = 1 GSM-7 segment');
  const withDash = ascii + ' — ';
  const segs = smsSegments(withDash);
  assert.strictEqual(segs, 2, '1 em dash (UCS-2) pushes 73 UTF-16 units into 2 segments at 67 units per segment');
});
