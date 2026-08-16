const { test } = require('node:test');
const assert = require('node:assert');

function loadAutomations() {
  for (const m of ['../netlify/functions/automations.js', '../netlify/functions/_sms.js', '../netlify/functions/_email.js']) {
    delete require.cache[require.resolve(m)];
  }
  return require('../netlify/functions/automations.js');
}

function fakeClient({ smsRows = [], emailRows = [] } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM sms_log/i.test(sql))   return { rows: smsRows };
      if (/FROM email_log/i.test(sql)) return { rows: emailRows };
      if (/FROM sms_optout/i.test(sql)) return { rows: [] };
      return { rows: [{ id: 1 }] };
    }
  };
}

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return { ok: true, status: 201, json: async () => ({ id: 'em_1', sid: 'SM_1', status: 'queued' }) };
  };
  return calls;
}

// sms_consent: true — these tests exercise channel routing, which only happens
// for a client who ticked the consent box. The tests that cover the consent gate
// itself override this field explicitly.
const BOOKING = { id: 5, client_name: 'Dana Ruiz', client_email: 'dana@example.com', client_phone: '405-541-7953', service_name: 'Foam Party', event_date: '2026-08-23', sms_consent: true };
const DAYTIME = new Date('2026-08-15T15:00:00Z');

function creds() {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_PHONE_NUMBER = '+14055550100';
  delete process.env.EMAIL_ALLOWLIST;
}

test("a channel='sms' rule sends no email", async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(), { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi {{client_first_name}}' }, BOOKING, null, DAYTIME);

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /twilio/, 'the only call must be to Twilio');
});

// automations.js:110 bailed on `if (!toEmail) return false`, which would have
// made an SMS-only rule silently send nothing for a booking with no email —
// no throw, just a smaller `sent` count.
test('an SMS-only rule still sends when the booking has no email address', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  const ok = await sendAutomationMessage(fakeClient(), { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' }, { ...BOOKING, client_email: null }, null, DAYTIME);

  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 1);
});

test("a channel='both' rule sends one of each", async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(), { id: 1, name: 'R', channel: 'both', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' }, BOOKING, null, DAYTIME);

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls.filter(c => /twilio/.test(c.url)).length, 1);
  assert.strictEqual(calls.filter(c => /resend/.test(c.url)).length, 1);
});

test("a channel='email' rule is unchanged and never touches Twilio", async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(), { id: 1, name: 'R', channel: 'email', recipient: 'client', subject: 'S', body_html: '<p>x</p>' }, BOOKING, null, DAYTIME);

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /resend/);
});

// The email guard is `status='sent'`. An SMS row sits at 'queued' until the
// delivery callback lands — and stays there forever if the carrier drops it.
// Reusing `status='sent'` would therefore never suppress anything, and a rule
// whose window reopens would re-send.
test('the SMS de-dupe guard matches a queued row, not only a delivered one', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  const c = fakeClient({ smsRows: [{ id: 99 }] });
  await sendAutomationMessage(c, { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' }, BOOKING, null, DAYTIME);

  assert.strictEqual(calls.length, 0, 'an existing sms_log row in any status must suppress a resend');
});

test('the SMS body is rendered plain, never as escaped HTML', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(), { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi {{client_name}}' }, { ...BOOKING, client_name: "Siobhan O'Brien" }, null, DAYTIME);

  const body = new URLSearchParams(calls[0].body).get('Body');
  assert.strictEqual(body, "Hi Siobhan O'Brien");
});

// ── save_rule partial-update bug ──────────────────────────────────────────────
// toggleRule() posts only {id, active}. The UPDATE used to set name/
// trigger_event/subject/body_html unconditionally from those absent fields,
// violating their NOT NULL constraints — a 500 that toggleRule's fetch call
// never even checked, so the active switch was silently dead. Exercised at the
// HTTP handler with _db/_auth stubbed out, since neither talks to a real
// database or an admin session; the assertion is on the SQL/params the handler
// hands to `client.query`, not on a live UPDATE.
function loadAutomationsHandler(fakeClient) {
  for (const m of ['../netlify/functions/automations.js', '../netlify/functions/_sms.js', '../netlify/functions/_email.js', '../netlify/functions/_db.js', '../netlify/functions/_auth.js']) {
    delete require.cache[require.resolve(m)];
  }
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => ({ role: 'admin' });
  authMod.preflight = () => null;
  return require('../netlify/functions/automations.js');
}

test('a partial {id, active} save_rule update does not blank the other columns', async () => {
  const queries = [];
  const fakeClient = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      // Satisfies ensureTables' seed-check (`existing[0].count`) without
      // triggering the "no rules yet, seed defaults" branch.
      return { rows: [{ count: '1' }] };
    }
  };
  const { handler } = loadAutomationsHandler(fakeClient);

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'save_rule', rule: { id: 42, active: false } })
  });

  assert.strictEqual(res.statusCode, 200, 'a partial update must not 500');
  const update = queries.find(q => /UPDATE automation_rules/i.test(q.sql));
  assert.ok(update, 'the handler must have issued the UPDATE');

  // active is positional (never coalesced) and must carry the real `false`.
  assert.strictEqual(update.params[1], false);

  // Every other column is COALESCE'd or CASE-guarded against the *stored*
  // value, so an absent field must arrive as a null parameter (COALESCE
  // falls through) — never the literal string 'undefined' or the column
  // getting blanked.
  assert.strictEqual(update.params[0], null, 'name must fall through, not blank');
  assert.match(update.sql, /name=COALESCE/i);
  assert.match(update.sql, /body_html=COALESCE/i);
  assert.match(update.sql, /channel=COALESCE/i);
  assert.match(update.sql, /body_sms=COALESCE/i);

  // trigger_status/trigger_days are legitimately nullable, so they can't be
  // COALESCE'd the same way — a full save must still be able to clear them.
  // Absent here (toggleRule never sends them), so their "present" flags must
  // be false and the SQL must gate on that flag rather than coalescing.
  assert.match(update.sql, /trigger_status=CASE WHEN \$\d+ THEN \$\d+ ELSE trigger_status END/i);
  assert.match(update.sql, /trigger_days=CASE WHEN \$\d+ THEN \$\d+ ELSE trigger_days END/i);
  const hasIdx = update.sql.match(/trigger_status=CASE WHEN \$(\d+)/i)[1] - 1;
  assert.strictEqual(update.params[hasIdx], false, 'trigger_status must be flagged absent, not cleared');
});

// ── Client SMS consent ───────────────────────────────────────────────────────
// Carrier vetting rejected a passive "we'll text you" notice on the booking
// form. Consent is now an unchecked box the customer ticks, and a booking
// without it must never be texted — having a phone number is not consent.
test('a client who did not tick the consent box is never texted', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(),
    { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' },
    { ...BOOKING, sms_consent: false }, null, DAYTIME);

  assert.strictEqual(calls.length, 0, 'no consent means no call to Twilio at all');
});

// The column defaults to FALSE, but every booking taken before the checkbox
// existed has no opinion recorded. Absent is not consent.
test('a booking predating the consent checkbox is never texted', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(),
    { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' },
    { ...BOOKING, sms_consent: undefined }, null, DAYTIME);

  assert.strictEqual(calls.length, 0, 'an absent consent record must not be read as consent');
});

test('a client who ticked the box is texted', async () => {
  creds();
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(),
    { id: 1, name: 'R', channel: 'sms', recipient: 'client', subject: 'S', body_html: '<p>x</p>', body_sms: 'Hi' },
    { ...BOOKING, sms_consent: true }, null, DAYTIME);

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /twilio/);
});

// Admin alerts go to Joe's own number, which needs no consent record.
test('an admin-recipient rule still sends without a booking consent record', async () => {
  creds();
  process.env.NOTIFY_SMS = '+14055550111';
  const calls = stubFetch();
  const { sendAutomationMessage } = loadAutomations();

  await sendAutomationMessage(fakeClient(),
    { id: 1, name: 'R', channel: 'sms', recipient: 'admin', subject: 'S', body_html: '<p>x</p>', body_sms: 'Unstaffed' },
    { ...BOOKING, sms_consent: false }, null, DAYTIME);

  assert.strictEqual(calls.length, 1, 'admin messages are not gated on client consent');
});

// ── Opt-in confirmation message ──────────────────────────────────────────────
// The campaign registration declares this exact string, so the registered text
// and the sent text must stay the same by construction. Carrier rules require
// all four elements; this pins them so a later reword cannot quietly drop one.
test('the declared opt-in confirmation carries every required element', () => {
  const src = require('node:fs').readFileSync(require.resolve('../netlify/functions/bookings.js'), 'utf8');
  const m = src.match(/const SMS_OPT_IN_MESSAGE = "(.*)";/);
  assert.ok(m, 'SMS_OPT_IN_MESSAGE must exist — it is what the campaign registration declares');
  const msg = m[1];

  assert.match(msg, /Funky Monkey Events/,        'must name the brand');
  assert.match(msg, /msgs? per booking/i,         'must state message frequency');
  assert.match(msg, /Msg & data rates may apply/, 'must carry the rates disclaimer verbatim');
  assert.match(msg, /Reply STOP to cancel/,       'must tell them how to opt out');
  assert.match(msg, /HELP for help/,              'must tell them how to get help');

  const { smsSegments, toGsm7 } = require('../netlify/functions/_sms.js');
  const segs = smsSegments(toGsm7(msg));
  assert.ok(segs <= 2, `opt-in confirmation must fit two segments, was ${segs}`);
});
