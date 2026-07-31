const { test } = require('node:test');
const assert = require('node:assert');

// Fresh module per test — _email.js reads env at call time, but we also want
// to reset the fetch stub between cases.
function loadEmail() {
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/_email.js');
}

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: response.ok !== false,
      json: async () => response.json ?? { id: 'test-id-123' }
    };
  };
  return calls;
}

test('allowlist blocks a non-listed recipient', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('troy@example.com', 'Gig tomorrow', '<p>hi</p>');

  assert.strictEqual(calls.length, 0, 'must not call Resend for a blocked address');
});

test('allowlist permits a listed recipient', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('joe.coover@gmail.com', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'must call Resend for an allowed address');
});

test('allowlist is case-insensitive and tolerates spaces', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = ' joe.coover@gmail.com , other@x.com ';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('JOE.COOVER@GMAIL.COM', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'matching must ignore case and padding');
});

test('unset allowlist permits everyone (production behavior)', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('anyone@example.com', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'no allowlist means no filtering');
});

test('throws when Resend returns its error shape', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: false, json: { statusCode: 403, message: 'Domain not verified', name: 'validation_error' } });
  const { sendEmail } = loadEmail();

  await assert.rejects(
    () => sendEmail('anyone@example.com', 'Test', '<p>hi</p>'),
    /Domain not verified/,
    'a Resend rejection must throw, not return quietly'
  );
});

test('throws when the API key is missing', async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await assert.rejects(
    () => sendEmail('anyone@example.com', 'Test', '<p>hi</p>'),
    /RESEND_API_KEY/,
    'a missing key is a configuration failure, not a silent no-op'
  );
});

test('returns the Resend id on success', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: true, json: { id: 'resend-abc-123' } });
  const { sendEmail } = loadEmail();

  const result = await sendEmail('anyone@example.com', 'Test', '<p>hi</p>');

  assert.strictEqual(result.id, 'resend-abc-123');
});

// Task 5: client.js, auth.js and test-email.js used to hand-roll their own
// Resend fetch, bypassing EMAIL_ALLOWLIST and the corrected error detection.
// _email.js must stay the only place that talks to Resend.
test('_email.js is the only module that calls the Resend API', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'netlify', 'functions');

  const offenders = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && f !== '_email.js')
    .filter(f => fs.readFileSync(path.join(dir, f), 'utf8').includes('api.resend.com'));

  assert.deepStrictEqual(offenders, [], 'these bypass the guarded sender');
});

test('client.js sends through the shared sendEmail', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'client.js'), 'utf8');

  assert.match(src, /require\('\.\/_email'\)/);
  assert.match(src, /sendEmail[^=]*\}\s*=\s*require\('\.\/_email'\)/, 'sendEmail must be imported, not shadowed');
  assert.doesNotMatch(src, /const sendEmail\s*=/, 'a local sendEmail would shadow the guarded one');
});

test('suppressed sends return {suppressed:true} rather than a Resend id', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  const result = await sendEmail('someone@example.com', 'Test', '<p>hi</p>');

  assert.strictEqual(result.suppressed, true);
  assert.strictEqual(result.id, undefined, 'callers must not read an id off a suppressed send');
});

// A pg client that answers the automation_rules SELECT with one rule and
// records every other query (the email_log INSERT is what we assert on).
const ONE_RULE = [{ id: 7, name: 'Deposit Paid', recipient: 'client',
                    subject: 'Hi {{client_first_name}}', body_html: '<p>hi</p>' }];

function fakeRuleClient(rules = ONE_RULE) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: /FROM automation_rules/.test(sql) ? rules : [] };
    }
  };
}

const BOOKING = { id: 42, client_email: 'client@example.com', client_name: 'Ada Lovelace' };
const logRow = (client) => client.queries.find(q => /INSERT INTO email_log/.test(q.sql));
const logRows = (client) => client.queries.filter(q => /INSERT INTO email_log/.test(q.sql));

// Fix round 1: a suppressed send never left the building. Logging it as 'sent'
// makes automations.js's `status='sent'` de-dupe skip that client forever once
// the allowlist is lifted — silent mail loss.
test('a suppressed send is logged as "suppressed", not "sent"', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  const calls = stubFetch({ ok: true });
  const { fireStatusAutomations } = loadEmail();
  const client = fakeRuleClient();

  await fireStatusAutomations(client, BOOKING, 'confirmed');

  assert.strictEqual(calls.length, 0, 'the allowlist must have blocked the send');
  const row = logRow(client);
  assert.ok(row, 'a suppressed send must still be recorded');
  assert.strictEqual(row.params[6], 'suppressed');
  assert.notStrictEqual(row.params[6], 'sent', 'this is what would cause silent mail loss');
});

test('a real send is still logged as "sent"', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  const calls = stubFetch({ ok: true, json: { id: 'resend-abc-123' } });
  const { fireStatusAutomations } = loadEmail();
  const client = fakeRuleClient();

  await fireStatusAutomations(client, BOOKING, 'confirmed');

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(logRow(client).params[6], 'sent');
});

test('logStatus maps only a suppressed result, leaving logEmail to default', () => {
  const { logStatus } = loadEmail();

  assert.strictEqual(logStatus({ suppressed: true }), 'suppressed');
  assert.strictEqual(logStatus({ id: 'resend-abc-123' }), undefined);
  assert.strictEqual(logStatus(undefined), undefined);
});

// A booking imported with no email address still runs through senders (e.g.
// stripe-webhook on deposit paid). sendEmail returns {skipped:'no recipient'};
// logging that as 'sent' makes /api/health's last_successful_email report a
// send that never happened.
test('logStatus maps a skipped send to "skipped", never "sent"', () => {
  const { logStatus } = loadEmail();

  assert.strictEqual(logStatus({ skipped: 'no recipient' }), 'skipped');
});

// The central claim of this branch: sendEmail now throws, and no caller may
// break because of it. A status change must still complete and still leave an
// honest email_log row.
test('a throwing sendEmail is caught, logged "failed", and does not propagate', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: false, json: { statusCode: 403, message: 'x' } });
  const { fireStatusAutomations } = loadEmail();
  const client = fakeRuleClient();

  // Returning rules.length (not 0) proves the throw was handled per-rule
  // rather than escaping into fireStatusAutomations' outer catch.
  const fired = await fireStatusAutomations(client, BOOKING, 'confirmed');

  assert.strictEqual(fired, 1, 'the function must return normally, not via its outer catch');
  const row = logRow(client);
  assert.ok(row, 'a failed send must still be recorded');
  assert.strictEqual(row.params[6], 'failed');
  assert.match(row.params[7], /x/, 'the failure reason must be recorded');
});

test('a second rule still fires after the first rule\'s send throws', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  // First send fails, second succeeds.
  let n = 0;
  globalThis.fetch = async () => (++n === 1)
    ? { ok: false, json: async () => ({ statusCode: 403, message: 'bad address' }) }
    : { ok: true,  json: async () => ({ id: 'resend-ok' }) };
  const { fireStatusAutomations } = loadEmail();
  const client = fakeRuleClient([
    { id: 1, name: 'First',  recipient: 'client', subject: 'A', body_html: '<p>a</p>' },
    { id: 2, name: 'Second', recipient: 'client', subject: 'B', body_html: '<p>b</p>' }
  ]);

  const fired = await fireStatusAutomations(client, BOOKING, 'confirmed');

  assert.strictEqual(fired, 2);
  assert.strictEqual(n, 2, 'the second rule must still have attempted its send');
  const rows = logRows(client);
  assert.strictEqual(rows.length, 2, 'both rules must be logged');
  assert.strictEqual(rows[0].params[6], 'failed');
  assert.strictEqual(rows[1].params[6], 'sent');
});

function fakeClient() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

test('logEmail defaults to status "sent" with no error detail', async () => {
  const { logEmail } = loadEmail();
  const client = fakeClient();

  await logEmail(client, 1, 2, 'Deposit Paid', 'Subject', 'a@example.com', 'client');

  assert.strictEqual(client.calls.length, 1);
  assert.match(client.calls[0].sql, /INSERT INTO email_log/);
  assert.match(client.calls[0].sql, /status/);
  assert.match(client.calls[0].sql, /error_detail/);
  assert.deepStrictEqual(
    client.calls[0].params,
    [1, 2, 'Deposit Paid', 'Subject', 'a@example.com', 'client', 'sent', '']
  );
});

test('logEmail records a failure status and error message', async () => {
  const { logEmail } = loadEmail();
  const client = fakeClient();

  await logEmail(client, 1, null, 'Deposit Paid', 'Subject', 'a@example.com', 'admin', 'failed', 'Resend send failed: Domain not verified');

  assert.strictEqual(client.calls.length, 1);
  assert.deepStrictEqual(
    client.calls[0].params,
    [1, null, 'Deposit Paid', 'Subject', 'a@example.com', 'admin', 'failed', 'Resend send failed: Domain not verified']
  );
});
