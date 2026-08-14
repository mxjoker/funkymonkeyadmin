# Two-Way SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send and receive SMS through Twilio on a new 405 number, so staff can be offered gigs and reply to express interest, and clients get booking messages — all through one sender, one log, and the automation rules engine that already exists.

**Architecture:** `_sms.js` is the single door to Twilio, mirroring `_email.js`: every send goes through `sendSms()`, which enforces opt-out and quiet hours and writes an `sms_log` row for every outcome. Delivery status comes only from Twilio's status callback, never from the send call. Client SMS is a `channel` column on `automation_rules`, driven by the existing 9am-Central cron. Staff replies arrive at `sms-webhook.js`, are letter-parsed against the `offer_map` stored on their most recent outbound offer, and land in the same `staff_assignments` insert the portal already uses.

**Tech Stack:** Node 18+ CommonJS Netlify Functions, `pg`, `node --test`, native `fetch`, native `crypto` (HMAC-SHA1 for Twilio signature). No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** No `twilio` SDK — the REST API is one `fetch` with Basic auth, exactly as `refund.js` does Stripe.
- **`sendSms()` is the only function that calls the Twilio Messages API.** Nothing else. This is what makes opt-out, quiet hours, and the log complete.
- **`sendSms()` never throws.** It returns a status object and always writes an `sms_log` row. This is a deliberate divergence from `sendEmail()` (which throws): `sendSms` owns its own logging, so a throw would add nothing but a way to break the caller. Every state is a logged row, none of which resembles success.
- **Delivery status only ever comes from the status callback.** A `201` from the send API means `queued` and is logged as `queued`. Never write `delivered` in `sendSms()`.
- **`sms_log.status` vocabulary** (exact strings): `queued`, `delivered`, `failed`, `undelivered`, `invalid_number`, `opted_out`, `held`, `expired`, `received`.
- **All templates plain text, target ≤ 320 characters** (two SMS segments). Never pass HTML or `render()` output to `sendSms()`.
- **Quiet hours are 8am–9pm America/Chicago.** Outside that window a message is held, not dropped, not sent.
- **Every SMS call site wraps in `.catch()`** so a Twilio outage cannot fail a booking save or an assignment.
- **Timezone string is `America/Chicago`** everywhere. Do not use a fixed UTC offset — CDT/CST differ.
- **Test command is `npm test`** (`node --test 'test/**/*.test.js'`). No frameworks, no fixtures, no DB in tests.
- **No test sends a real message.** Stub `globalThis.fetch`.

---

## Task 0: Prerequisite — 10DLC registration (Joe, not code)

This blocks production traffic and has a multi-day lead time. Nothing below reaches a real handset until it is approved. Start it before Task 1.

- [ ] **Step 1: Create the Twilio account and buy a local 405 number**

Twilio Console → Phone Numbers → Buy a number → Oklahoma City (405), SMS capability required.

- [ ] **Step 2: Submit A2P 10DLC brand registration**

Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC. Use the LLC legal name, EIN, and business address. Standard (not Sole Proprietor) brand.

- [ ] **Step 3: Submit the campaign**

Use case: **Mixed / Customer Care**. Sample messages must match what this plan actually sends — copy two of them verbatim from Task 4 and Task 8. Opt-in description: *"Customers provide their phone number on the booking form at funkymonkeyevents.com, where a notice states 'We'll text you about your booking. Reply STOP to opt out.' Staff provide their number in their staff portal profile and select SMS as their communication preference."*

- [ ] **Step 4: Record the three env vars in Netlify**

Netlify dashboard → Site settings → Environment variables. **Set these in the dashboard by hand** — the Netlify MCP connector reports success on env writes without persisting them.

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1405xxxxxxx
NOTIFY_SMS=+1405xxxxxxx        # Joe's own mobile, for forwarded client replies
```

- [ ] **Step 5: Confirm campaign approval before running the Task 4 smoke test**

Twilio Console → Messaging → Campaigns shows `VERIFIED`. Until then messages will be accepted (`queued`) and silently filtered by carriers — which is precisely the failure mode the status callback exists to expose.

---

## Task 1: Pure SMS helpers

No network, no database. These four functions are where quiet breakage lives, so they land first with tests.

**Files:**
- Create: `netlify/functions/_sms.js`
- Modify: `netlify/functions/_email.js:256` (export `reviewLinkFor`)
- Test: `test/sms-helpers.test.js`

**Interfaces:**
- Consumes: `fmtEventDate`, `reviewLinkFor` from `./_email`
- Produces:
  - `normalisePhone(raw) -> string|null` — E.164 or null
  - `isQuietHours(date = new Date()) -> boolean`
  - `renderSms(template, booking, link) -> string`
  - `parseLetters(reply, offerMap) -> { picked: string[], unknown: string[], freeform: boolean }`

- [ ] **Step 1: Export `reviewLinkFor` from `_email.js`**

`netlify/functions/_email.js:256` — add `reviewLinkFor` to the export list so `_sms.js` reuses the magic-vs-Funky-Monkey Google profile logic instead of copying it.

```js
module.exports = { wrap, render, esc, fmtEventDate, reviewLinkFor, sendEmail, logStatus, logEmail, fireStatusAutomations, ensureEmailLog, ensureBookingChanges, logChange };
```

- [ ] **Step 2: Write the failing tests**

Create `test/sms-helpers.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalisePhone, isQuietHours, renderSms, parseLetters } = require('../netlify/functions/_sms.js');

// ── normalisePhone ──────────────────────────────────────────────────────────
// These four formats are all present in the live client_phone column today.
test('every live phone format resolves to one E.164 value', () => {
  for (const raw of ['4055417953', '405-541-7953', '1-405-541-7953', '405.541.7953', '(405) 541-7953', '+14055417953']) {
    assert.strictEqual(normalisePhone(raw), '+14055417953', `failed on ${raw}`);
  }
});

// The deleted _sms.js did `if (digits.length >= 11) return '+' + digits`, which
// turns junk into a plausible-but-wrong number. A wrong number is worse than
// no number: it sends a stranger a client's event details.
test('unusable input returns null, never a plausible number', () => {
  for (const raw of ['', null, undefined, 'TBD', 'none', '405', '5417953', '12345678901234']) {
    assert.strictEqual(normalisePhone(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

// ── isQuietHours (America/Chicago, 8am–9pm allowed) ─────────────────────────
// August is CDT (UTC-5). Boundaries are exact, not approximate.
test('quiet hours boundaries are exact', () => {
  assert.strictEqual(isQuietHours(new Date('2026-08-15T12:59:00Z')), true,  '07:59 CDT is quiet');
  assert.strictEqual(isQuietHours(new Date('2026-08-15T13:00:00Z')), false, '08:00 CDT sends');
  assert.strictEqual(isQuietHours(new Date('2026-08-16T01:59:00Z')), false, '20:59 CDT sends');
  assert.strictEqual(isQuietHours(new Date('2026-08-16T02:00:00Z')), true,  '21:00 CDT is quiet');
});

// January is CST (UTC-6). A fixed offset would be an hour wrong for four months.
test('quiet hours follow the DST change', () => {
  assert.strictEqual(isQuietHours(new Date('2026-01-15T13:59:00Z')), true,  '07:59 CST is quiet');
  assert.strictEqual(isQuietHours(new Date('2026-01-15T14:00:00Z')), false, '08:00 CST sends');
});

// ── renderSms ───────────────────────────────────────────────────────────────
// render() in _email.js HTML-escapes every token. Reusing it would text
// O'Brien as "O&#39;Brien".
test('an apostrophe survives as an apostrophe', () => {
  const out = renderSms("Hi {{client_first_name}}!", { client_name: "Siobhan O'Brien" });
  assert.strictEqual(out, "Hi Siobhan!");
  assert.strictEqual(renderSms('{{client_name}}', { client_name: "Siobhan O'Brien" }), "Siobhan O'Brien");
});

test('renderSms fills money, date and review tokens', () => {
  const booking = { client_name: 'Dana Ruiz', service_name: 'Foam Party', event_date: '2026-08-23', balance_due: 250, service_id: 'foam_party' };
  const out = renderSms('{{client_first_name}} owes ${{balance_due}} for {{service_name}} on {{event_date}}', booking);
  assert.strictEqual(out, 'Dana owes $250.00 for Foam Party on Sat, 8/23/2026');
});

test('a deposit of zero is never rendered as a default amount', () => {
  assert.strictEqual(renderSms('${{deposit_amount}}', { deposit_amount: 0 }), '$0.00');
});

// ── parseLetters ────────────────────────────────────────────────────────────
const OFFER = { a: { booking_id: 1, tag_filled: 'Foam Operator' }, b: { booking_id: 1, tag_filled: 'Setup' }, c: { booking_id: 1, tag_filled: 'Driver' } };

test('letter replies parse in every shape people actually type', () => {
  assert.deepStrictEqual(parseLetters('a', OFFER).picked,     ['a']);
  assert.deepStrictEqual(parseLetters('ab', OFFER).picked,    ['a', 'b']);
  assert.deepStrictEqual(parseLetters('AC', OFFER).picked,    ['a', 'c']);
  assert.deepStrictEqual(parseLetters(' a c ', OFFER).picked, ['a', 'c']);
  assert.deepStrictEqual(parseLetters('a, b', OFFER).picked,  ['a', 'b']);
  assert.deepStrictEqual(parseLetters('abc', OFFER).picked,   ['a', 'b', 'c']);
});

test('a repeated letter registers once', () => {
  assert.deepStrictEqual(parseLetters('aa', OFFER).picked, ['a']);
});

test('an unrecognised letter is reported, not silently dropped', () => {
  const r = parseLetters('ad', OFFER);
  assert.deepStrictEqual(r.picked, ['a']);
  assert.deepStrictEqual(r.unknown, ['d']);
  assert.strictEqual(r.freeform, false);
});

test('a sentence is freeform, not a pile of unknown letters', () => {
  const r = parseLetters("sorry can't make it that weekend", OFFER);
  assert.strictEqual(r.freeform, true, 'must be forwarded to Joe, not letter-parsed');
  assert.deepStrictEqual(r.picked, []);
});

test('an empty reply is freeform', () => {
  assert.strictEqual(parseLetters('', OFFER).freeform, true);
  assert.strictEqual(parseLetters('   ', OFFER).freeform, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../netlify/functions/_sms.js'`

- [ ] **Step 4: Write `_sms.js` with the four pure helpers**

Create `netlify/functions/_sms.js`:

```js
// netlify/functions/_sms.js — the one door to Twilio.
//
// Mirrors _email.js on purpose: a single sender means opt-out and quiet hours
// are enforced in one place rather than at nine call sites, and the log is
// complete because nothing else can send.
//
// A previous _sms.js was deleted in 90e3dc7 as an unused sender. It is not
// being resurrected — it returned null on every error path, so a caller could
// not tell a delivered message from a missing API key. This one returns a
// status for every outcome and writes a row for every one of them.

const { fmtEventDate, reviewLinkFor } = require('./_email');

const TZ = 'America/Chicago';

// ── Phone normalisation ──────────────────────────────────────────────────────
// Load-bearing: applied on send AND on inbound lookup. If the two ever disagree
// a reply stops matching the person who sent it, and nothing errors.
//
// Deliberately strict. The old version did `if (digits.length >= 11) return
// '+' + digits`, which turned a mistyped 14-digit string into a valid-looking
// E.164 number — texting a stranger a client's address rather than failing.
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// ── Quiet hours ──────────────────────────────────────────────────────────────
// 8am–9pm Central. Intl rather than a fixed offset: Oklahoma is UTC-5 in summer
// and UTC-6 in winter, so a hardcoded offset is an hour wrong for four months
// of the year — in the direction of texting people at 7am.
// hourCycle 'h23' rather than hour12:false, which yields "24" for midnight on
// some ICU builds.
function centralHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hourCycle: 'h23'
  }).format(date));
}

function isQuietHours(date = new Date()) {
  const h = centralHour(date);
  return h < 8 || h >= 21;
}

// ── Plain-text template renderer ─────────────────────────────────────────────
// Same token names as _email.js render(), but NOT the same function: render()
// runs every value through esc(), so "O'Brien" would arrive as "O&#39;Brien",
// and its {{deposit_link}} is a whole <div>. Same vocabulary, different medium.
function renderSms(template, booking = {}, link) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  return String(template || '')
    .replace(/{{client_first_name}}/g, firstName)
    .replace(/{{client_name}}/g,       booking.client_name || '')
    .replace(/{{guests_of_honour}}/g,  booking.guests_of_honour || booking.child_name || 'everyone')
    .replace(/{{child_name}}/g,        booking.child_name || '')
    .replace(/{{review_link}}/g,       reviewLinkFor(booking))
    .replace(/{{service_name}}/g,      booking.service_name || '')
    .replace(/{{event_date}}/g,        fmtEventDate(booking.event_date, { weekday: 'short', month: 'numeric', day: 'numeric' }) || 'TBD')
    .replace(/{{event_time}}/g,        booking.event_time || '')
    .replace(/{{event_zip}}/g,         booking.event_zip  || '')
    .replace(/{{total_price}}/g,       Number(booking.total_price   || 0).toFixed(2))
    // NOT `|| 100`. Schools and libraries book with deposit_amount = 0 and must
    // never be texted a demand for money the booking does not want.
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount || 0).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due    || 0).toFixed(2))
    .replace(/{{reference}}/g,         booking.reference || '')
    .replace(/{{payment_link}}/g,      link || '');
}

// ── Letter reply parsing ─────────────────────────────────────────────────────
// An offer lists roles as lettered options; a reply may combine them ("ac").
// Resolved against the offer_map stored on THAT outbound message, never against
// the live open-gig list — otherwise "b" means something different two hours
// later, because slots change.
//
// ponytail: a reply of more than MAX_PICK letters is treated as prose and
// forwarded to Joe rather than parsed. Offers never carry more than a handful
// of roles, and "sorry can't make it" must not come back as
// "Didn't recognise 's','o','r','y'". Raise MAX_PICK if offers ever get longer.
const MAX_PICK = 6;

function parseLetters(reply, offerMap) {
  const valid = Object.keys(offerMap || {});
  const letters = String(reply || '').toLowerCase().replace(/[^a-z]/g, '');
  const picked = [], unknown = [], seen = new Set();

  if (!letters || letters.length > MAX_PICK) return { picked, unknown, freeform: true };

  for (const ch of letters) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    (valid.includes(ch) ? picked : unknown).push(ch);
  }
  // Nothing recognised at all — this is prose, not a mistyped selection.
  if (!picked.length) return { picked: [], unknown: [], freeform: true };
  return { picked, unknown, freeform: false };
}

module.exports = { normalisePhone, isQuietHours, renderSms, parseLetters };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all suites green (previous count was 199 tests; expect ~213)

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_sms.js netlify/functions/_email.js test/sms-helpers.test.js
git commit -m "feat(sms): phone normalisation, quiet hours, plain-text render, letter parsing"
```

---

## Task 2: The sender, the tables, and the four skip states

**Files:**
- Modify: `netlify/functions/_sms.js` (add `ensureSmsTables`, `sendSms`, `isOptedOut`)
- Modify: `INSTRUCTIONS.md:584` (the stale claim that `_sms.js` already exists and is complete)
- Test: `test/sms-send.test.js`

**Interfaces:**
- Consumes: `normalisePhone`, `isQuietHours` from Task 1
- Produces:
  - `ensureSmsTables(client) -> Promise<void>`
  - `sendSms(client, to, body, meta = {}) -> Promise<{ status, sid?, reason? }>` where `meta` is `{ booking_id, staff_id, rule_id, trigger_label, offer_map }` and `status` is one of `queued` | `invalid_number` | `opted_out` | `held` | `failed` | `no_credentials`
  - `isOptedOut(client, e164) -> Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `test/sms-send.test.js`:

```js
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

// 8am CDT — inside the send window, so these cases test the thing they name.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `sendSms is not a function`

- [ ] **Step 3: Add the tables, the opt-out check and the sender to `_sms.js`**

Append to `netlify/functions/_sms.js`, above `module.exports`:

```js
// ── Tables ───────────────────────────────────────────────────────────────────
// Both mirror email_log. provider_sid is UNIQUE, which is what makes a replayed
// webhook idempotent; it is nullable because held / skipped rows never got one,
// and Postgres permits many NULLs under a UNIQUE constraint.
let smsSchemaReady;
async function ensureSmsTables(client) {
  if (!smsSchemaReady) {
    smsSchemaReady = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS sms_log (
          id SERIAL PRIMARY KEY,
          direction VARCHAR(8) NOT NULL DEFAULT 'out',
          phone VARCHAR(32) NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          booking_id INTEGER,
          staff_id INTEGER,
          rule_id INTEGER,
          trigger_label VARCHAR(255) DEFAULT '',
          provider_sid VARCHAR(64) UNIQUE,
          status VARCHAR(32) NOT NULL DEFAULT 'queued',
          error_detail TEXT DEFAULT '',
          offer_map JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS sms_log_phone_idx ON sms_log (phone, created_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS sms_log_rule_idx  ON sms_log (rule_id, booking_id)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS sms_optout (
          phone VARCHAR(32) PRIMARY KEY,
          reason VARCHAR(64) DEFAULT 'STOP',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    })().catch(e => { smsSchemaReady = null; throw e; });
  }
  return smsSchemaReady;
}

async function isOptedOut(client, e164) {
  const { rows } = await client.query('SELECT phone FROM sms_optout WHERE phone=$1', [e164]);
  return rows.length > 0;
}

async function logSms(client, row) {
  try {
    const { rows } = await client.query(
      `INSERT INTO sms_log (direction, phone, body, booking_id, staff_id, rule_id, trigger_label, provider_sid, status, error_detail, offer_map)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider_sid) DO NOTHING
       RETURNING id`,
      [row.direction || 'out', row.phone, row.body || '', row.booking_id || null, row.staff_id || null,
       row.rule_id || null, row.trigger_label || '', row.provider_sid || null, row.status,
       row.error_detail || '', row.offer_map ? JSON.stringify(row.offer_map) : null]
    );
    return rows[0] ? rows[0].id : null;
  } catch (e) {
    console.error('logSms error:', e.message);
    return null;
  }
}

// ── The one sender ───────────────────────────────────────────────────────────
// Never throws. Every outcome is a status AND a logged row, so there is no path
// where a message quietly did not happen. Callers read `.status`; none of the
// five non-send outcomes resembles success.
//
// `meta.now` exists only so quiet hours are testable without faking the clock.
async function sendSms(client, to, body, meta = {}) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  const site  = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const base  = { direction: 'out', body, booking_id: meta.booking_id, staff_id: meta.staff_id,
                  rule_id: meta.rule_id, trigger_label: meta.trigger_label, offer_map: meta.offer_map };

  if (!sid || !token || !from) {
    console.error('sendSms: Twilio credentials are not configured');
    await logSms(client, { ...base, phone: String(to || ''), status: 'failed', error_detail: 'no_credentials' });
    return { status: 'no_credentials' };
  }

  const e164 = normalisePhone(to);
  if (!e164) {
    // The raw value goes in the phone column deliberately: "which record has a
    // broken number" is the question this row exists to answer.
    console.error('sendSms: unparseable number:', JSON.stringify(to));
    await logSms(client, { ...base, phone: String(to || ''), status: 'invalid_number', error_detail: `raw: ${JSON.stringify(to)}` });
    return { status: 'invalid_number' };
  }

  if (await isOptedOut(client, e164)) {
    await logSms(client, { ...base, phone: e164, status: 'opted_out' });
    return { status: 'opted_out' };
  }

  // Held, not dropped. flushHeldSms() in Task 8 sends these at 9am Central.
  if (isQuietHours(meta.now || new Date())) {
    await logSms(client, { ...base, phone: e164, status: 'held' });
    return { status: 'held' };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: e164, From: from, Body: body,
        // Delivery truth arrives here, seconds later. The response below only
        // ever means "Twilio accepted it".
        StatusCallback: `${site}/api/sms-status`
      }).toString()
    });
    const data = await res.json();

    if (!res.ok || data.code) {
      const reason = `${data.code || res.status}: ${data.message || 'Twilio send failed'}`;
      console.error('Twilio error:', e164, '|', reason);
      await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: reason });
      return { status: 'failed', reason };
    }

    // 'queued', not 'sent'. See the module header.
    await logSms(client, { ...base, phone: e164, status: 'queued', provider_sid: data.sid });
    console.log('SMS queued to:', e164, '| SID:', data.sid);
    return { status: 'queued', sid: data.sid };
  } catch (e) {
    console.error('sendSms error:', e164, '|', e.message);
    await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: e.message });
    return { status: 'failed', reason: e.message };
  }
}
```

Update the export line at the bottom of `_sms.js`:

```js
module.exports = { normalisePhone, isQuietHours, renderSms, parseLetters, ensureSmsTables, isOptedOut, logSms, sendSms };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Correct the stale claim in `INSTRUCTIONS.md`**

`INSTRUCTIONS.md:584` currently says `_sms.js` (Twilio) is complete but nothing calls it — written before commit `90e3dc7` deleted that file. Replace that bullet with:

```markdown
**2. SMS notifications** — `_sms.js` is the single Twilio sender: `sendSms(client, to, body, meta)` enforces opt-out and 8am–9pm Central quiet hours and writes an `sms_log` row for every outcome. Delivery status comes from the `sms-status.js` callback, never from the send call. Requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `NOTIFY_SMS` in Netlify, and an approved A2P 10DLC campaign — without one, carriers filter messages that Twilio still reports as accepted.
```

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_sms.js test/sms-send.test.js INSTRUCTIONS.md
git commit -m "feat(sms): one sender with opt-out, quiet hours, and a row for every outcome"
```

---

## Task 3: Delivery status callback

Without this, the log's word for "delivered" is Twilio's word for "accepted" — the exact silent failure that lets a crew member miss a gig while the system reports a send.

**Files:**
- Create: `netlify/functions/sms-status.js`
- Create: `netlify/functions/_twilio-sig.js`
- Modify: `netlify.toml` (redirect)
- Test: `test/sms-webhook.test.js`

**Interfaces:**
- Consumes: `ensureSmsTables` from Task 2
- Produces:
  - `verifyTwilio(event, path) -> boolean` (from `_twilio-sig.js`)
  - `parseForm(body) -> object` (from `_twilio-sig.js`)
  - `twilioSignature(authToken, url, params) -> string` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `test/sms-webhook.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

function loadSig() {
  delete require.cache[require.resolve('../netlify/functions/_twilio-sig.js')];
  return require('../netlify/functions/_twilio-sig.js');
}

// Build the header Twilio would send, using Twilio's documented algorithm:
// HMAC-SHA1 over the full URL followed by every POST param sorted by key,
// concatenated as key+value, base64-encoded.
function signed(token, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function twilioEvent(params, { token = 'tok_test', path = '/api/sms-status', tamper = false } = {}) {
  const url = 'https://funkymonkeyadmin.netlify.app' + path;
  const sig = signed(token, url, params);
  return {
    httpMethod: 'POST',
    headers: { 'x-twilio-signature': tamper ? 'Zm9yZ2VkCg==' : sig },
    body: new URLSearchParams(params).toString()
  };
}

test('a correctly signed request verifies', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
  assert.strictEqual(verifyTwilio(twilioEvent(params), '/api/sms-status'), true);
});

// Without this check anyone with the URL can forge replies — registering
// interest as another staff member, or opting a client out.
test('a forged signature is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
  assert.strictEqual(verifyTwilio(twilioEvent(params, { tamper: true }), '/api/sms-status'), false);
});

test('a request signed with the wrong token is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1' };
  assert.strictEqual(verifyTwilio(twilioEvent(params, { token: 'wrong_token' }), '/api/sms-status'), false);
});

test('a request with a tampered body is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const ev = twilioEvent({ MessageSid: 'SM1', MessageStatus: 'delivered' });
  ev.body = new URLSearchParams({ MessageSid: 'SM1', MessageStatus: 'failed' }).toString();
  assert.strictEqual(verifyTwilio(ev, '/api/sms-status'), false);
});

test('a missing signature header is rejected, not waved through', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  const { verifyTwilio } = loadSig();
  assert.strictEqual(verifyTwilio({ headers: {}, body: 'MessageSid=SM1' }, '/api/sms-status'), false);
});

test('a missing auth token rejects rather than skipping verification', () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1' };
  assert.strictEqual(verifyTwilio(twilioEvent(params), '/api/sms-status'), false);
});

test('parseForm decodes a urlencoded body including + and %', () => {
  const { parseForm } = loadSig();
  const out = parseForm('Body=a+c&From=%2B14055417953');
  assert.strictEqual(out.Body, 'a c');
  assert.strictEqual(out.From, '+14055417953');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../netlify/functions/_twilio-sig.js'`

- [ ] **Step 3: Write `_twilio-sig.js`**

Create `netlify/functions/_twilio-sig.js`:

```js
// netlify/functions/_twilio-sig.js — Twilio webhook signature verification.
//
// Shared by sms-status.js and sms-webhook.js. Not optional on either: without
// it, anyone who learns the URL can forge a delivery receipt, register gig
// interest as somebody else, or opt a client out of their own booking texts.
//
// The URL is rebuilt from SITE_URL and a fixed path rather than from request
// headers. Netlify sits behind a proxy, so Host/X-Forwarded-Proto are not
// reliably the values Twilio signed — deriving the URL from them is the classic
// way this check "works in testing and rejects everything in production".
// Consequence: Twilio must be pointed at exactly `${SITE_URL}/api/sms-status`
// and `${SITE_URL}/api/sms-webhook`, with no query string.

const crypto = require('node:crypto');

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body || '')) out[k] = v;
  return out;
}

function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function verifyTwilio(event, path) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const header = event.headers && (event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature']);
  // No token configured is a rejection, not a bypass. A misconfigured
  // deployment must fail closed.
  if (!token || !header) return false;

  const site = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const expected = twilioSignature(token, site + path, parseForm(event.body));

  const a = Buffer.from(header, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyTwilio, twilioSignature, parseForm };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Write the status callback function**

Create `netlify/functions/sms-status.js`:

```js
// netlify/functions/sms-status.js — Twilio delivery status callback.
//
// This is the only writer of 'delivered'. sendSms() logs 'queued' because that
// is all a 201 from Twilio means: the carrier can still drop the message, and
// with incomplete 10DLC registration it routinely does. Without this endpoint
// the log would read "sent" for messages nobody ever received, and the first
// symptom would be a crew member not turning up.

const { withClient } = require('./_db');
const { ensureSmsTables } = require('./_sms');
const { verifyTwilio, parseForm } = require('./_twilio-sig');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!verifyTwilio(event, '/api/sms-status')) {
    console.error('sms-status: signature verification FAILED — request rejected');
    return { statusCode: 403, body: 'Forbidden' };
  }

  const p = parseForm(event.body);
  const sid = p.MessageSid || p.SmsSid;
  const status = p.MessageStatus || p.SmsStatus;
  if (!sid || !status) return { statusCode: 200, body: 'ignored' };

  // Twilio sends the whole lifecycle (accepted → queued → sent → delivered).
  // Only terminal states are worth recording; 'sent' from Twilio means "handed
  // to the carrier", which is exactly the claim this endpoint exists to avoid
  // believing.
  if (!['delivered', 'failed', 'undelivered'].includes(status)) {
    return { statusCode: 200, body: 'ok' };
  }

  try {
    await withClient(async (client) => {
      await ensureSmsTables(client);
      const { rowCount } = await client.query(
        `UPDATE sms_log SET status=$1, error_detail=$2, updated_at=NOW() WHERE provider_sid=$3`,
        [status, p.ErrorCode ? `Twilio error ${p.ErrorCode}` : '', sid]
      );
      if (!rowCount) console.error('sms-status: no sms_log row for SID', sid);
      else if (status !== 'delivered') console.error('SMS NOT DELIVERED:', sid, '|', status, '| code:', p.ErrorCode || 'none');
    });
  } catch (e) {
    // Returning 500 makes Twilio retry, which is what we want for a transient
    // DB blip: the update is idempotent (keyed on a unique SID).
    console.error('sms-status error:', e.message);
    return { statusCode: 500, body: 'error' };
  }

  return { statusCode: 200, body: 'ok' };
};
```

- [ ] **Step 6: Add the redirects to `netlify.toml`**

Append to `netlify.toml` (both paths are needed now; `sms-webhook` is used from Task 6):

```toml
# Twilio webhooks. The signature check rebuilds the signed URL from SITE_URL +
# these exact paths, so Twilio must be configured with these URLs and no query
# string — see _twilio-sig.js.
[[redirects]]
  from = "/api/sms-status"
  to = "/.netlify/functions/sms-status"
  status = 200

[[redirects]]
  from = "/api/sms-webhook"
  to = "/.netlify/functions/sms-webhook"
  status = 200
```

- [ ] **Step 7: Run the full suite**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/_twilio-sig.js netlify/functions/sms-status.js netlify.toml test/sms-webhook.test.js
git commit -m "feat(sms): Twilio signature verification and delivery status callback"
```

---

## Task 4: First real message — "you're booked" — and the smoke-test gate

The smallest thing that proves 10DLC actually delivers. **Nothing after this task is worth building until a message provably lands on a handset.**

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (add `notifySms`, hook the assign path at `:743`)
- Modify: `admin.html:3360`, `admin.html:3929`, `staff-portal.html:700` (comms preference options)
- Test: `test/sms-staff.test.js`

**Interfaces:**
- Consumes: `sendSms`, `ensureSmsTables`, `renderSms` from Tasks 1–2
- Produces: `wantsSms(staff) -> boolean`, `notifySms(client, staff, body, meta) -> Promise<void>` (both exported from `staff-assignments.js` for tests)

- [ ] **Step 1: Write the failing test**

Create `test/sms-staff.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { wantsSms } = require('../netlify/functions/staff-assignments.js');

// comms_preference already existed on the staff table with an 'sms' option in
// both the admin and portal UIs, labelled "coming soon". This is that switch
// finally meaning something — not a second opt-in mechanism.
test('only staff who asked for SMS get SMS', () => {
  assert.strictEqual(wantsSms({ comms_preference: 'sms' }),   true);
  assert.strictEqual(wantsSms({ comms_preference: 'both' }),  true);
  assert.strictEqual(wantsSms({ comms_preference: 'email' }), false);
  assert.strictEqual(wantsSms({ comms_preference: 'call' }),  false);
});

// The column defaults to 'email' but old rows may hold NULL or ''. Neither is
// consent.
test('an unset preference is not consent', () => {
  assert.strictEqual(wantsSms({}), false);
  assert.strictEqual(wantsSms({ comms_preference: null }), false);
  assert.strictEqual(wantsSms({ comms_preference: '' }), false);
  assert.strictEqual(wantsSms(null), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `wantsSms is not a function`

- [ ] **Step 3: Add `wantsSms` and `notifySms` to `staff-assignments.js`**

At the top of `netlify/functions/staff-assignments.js`, alongside the existing `_email` import (line 5):

```js
const { sendEmail, wrap } = require('./_email');
const { sendSms, ensureSmsTables } = require('./_sms');
```

Immediately after the existing `notify` helper (which ends at line 15), add:

```js
// Staff SMS rides on comms_preference, the column that has been on the staff
// table — with an "SMS (coming soon)" option in both UIs — since before this
// feature existed. A second opt-in mechanism would mean two places to check and
// one of them eventually being missed.
const wantsSms = (s) => ['sms', 'both'].includes(s && s.comms_preference);

// Fire-and-forget, same contract as notify() above: a Twilio outage must never
// fail the assignment it accompanies. sendSms does not throw, but ensureSmsTables
// can, so the whole thing is guarded.
async function notifySms(client, staff, body, meta = {}) {
  if (!wantsSms(staff) || !staff.phone) return;
  try {
    await ensureSmsTables(client);
    await sendSms(client, staff.phone, body, { ...meta, staff_id: staff.id });
  } catch (e) {
    console.error('staff notifySms failed:', staff.staff_id, '|', e.message);
  }
}
```

- [ ] **Step 4: Hook the assign path**

In `netlify/functions/staff-assignments.js`, immediately **after** the existing `await notify({ ... })` call in the `action === 'assign'` branch (the block starting at line 743 with subject `✅ You're booked!`), add:

```js
            // Shift start, not just the event time: the whole point of the text
            // is the number the crew member has to set an alarm for.
            const smsTime = fa.schedule_start
              ? toStr(toMins(fa.schedule_start))
              : (b.event_time || 'TBD');
            await notifySms(client, s,
              `You're booked: ${b.service_name}, ${dateStr}. Load up ${smsTime}, ${b.event_zip || 'OKC'}. Details in the portal: ${PORTAL}`,
              { booking_id: b.id, trigger_label: "You're booked" });
```

- [ ] **Step 5: Export `wantsSms` for the test**

At the bottom of `netlify/functions/staff-assignments.js`, alongside the existing test exports (line 931–935):

```js
exports.wantsSms = wantsSms;
```

- [ ] **Step 6: Make the SMS option real in both UIs**

`admin.html:3360` — replace the single "SMS (future)" option with two live options:

```html
          <option value="sms"   ${s?.comms_preference==='sms'  ?'selected':''}>SMS</option>
          <option value="both"  ${s?.comms_preference==='both' ?'selected':''}>Email + SMS</option>
```

`admin.html:3929` — same replacement for the "(coming soon)" variant:

```html
          <option value="sms"   ${s.comms_preference==='sms'  ?'selected':''}>SMS</option>
          <option value="both"  ${s.comms_preference==='both' ?'selected':''}>Email + SMS</option>
```

`staff-portal.html:700` — replace `<option value="sms" ...>SMS (coming soon)</option>` with:

```
'<option value="sms" '+(s.comms_preference==='sms'?'selected':'')+'>SMS</option><option value="both" '+(s.comms_preference==='both'?'selected':'')+'>Email + SMS</option>'
```

`both` is offered because picking `sms` alone silently turns a crew member's email off. Most people want the text *and* the email with the schedule table in it.

- [ ] **Step 7: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 8: Commit and deploy**

```bash
git add netlify/functions/staff-assignments.js admin.html staff-portal.html test/sms-staff.test.js
git commit -m "feat(sms): text staff their call time when assigned; comms_preference goes live"
git push
```

Then **Netlify → Trigger deploy**. Auto-publishing is off; a push alone deploys nothing.

- [ ] **Step 9: SMOKE TEST — the gate everything else waits on**

Requires Task 0 step 5 (campaign `VERIFIED`).

1. In admin, set Joe's own staff record to `comms_preference = 'both'` and confirm the phone number is his mobile.
2. Assign Joe to any upcoming booking.
3. Confirm the text arrives on the handset.
4. Query the log and confirm the callback, not the send call, wrote the status:

```sql
SELECT phone, status, provider_sid, error_detail, created_at, updated_at
FROM sms_log ORDER BY id DESC LIMIT 5;
```

Expected: one row, `status = 'delivered'`, `updated_at` a few seconds later than `created_at`.

**If `status` is still `queued` a minute later, stop.** Either the callback URL is wrong or the carrier dropped it — both are exactly what this gate exists to catch, and no further layer should be built on a channel that does not deliver.

---

## Task 5: Gig-available offer with a stored letter map

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (`notifyStaffForBooking`, ~line 889)
- Test: `test/sms-staff.test.js` (extend)

**Interfaces:**
- Consumes: `notifySms` from Task 4
- Produces: `buildOfferMap(matched, bookingId) -> { [letter]: { booking_id, tag_filled } }` and `offerText(booking, dateStr, offerMap) -> string`, both exported from `staff-assignments.js`

**Deviation from the spec, deliberate:** the spec illustrates an offer spanning several bookings (`a) Foam Party Sat 8/23 … b) Magic Show Sun 8/24`). The trigger that exists — `notifyStaffForBooking` — fires per booking, so letters here map to the **roles on the one gig that just opened**, which is also exactly the `tag_filled` value the interest insert requires. A cross-booking digest is a second sender, not different parsing; it can reuse all of this later.

- [ ] **Step 1: Write the failing tests**

Append to `test/sms-staff.test.js`:

```js
const { buildOfferMap, offerText } = require('../netlify/functions/staff-assignments.js');

// The letter→role map is stored on the outbound sms_log row so a reply resolves
// against what was actually offered, not against the open-gig list at reply
// time. Slots change; "b" must not mean something different two hours later.
test('an offer map keys each letter to a booking and a role', () => {
  const map = buildOfferMap(['Foam Operator', 'Setup'], 42);
  assert.deepStrictEqual(map, {
    a: { booking_id: 42, tag_filled: 'Foam Operator' },
    b: { booking_id: 42, tag_filled: 'Setup' }
  });
});

test('a single matching role still gets a letter', () => {
  assert.deepStrictEqual(buildOfferMap(['Driver'], 7), { a: { booking_id: 7, tag_filled: 'Driver' } });
});

test('the offer text lists every letter and the STOP notice', () => {
  const map = buildOfferMap(['Foam Operator', 'Setup'], 42);
  const txt = offerText({ service_name: 'Foam Party', event_zip: '73013', event_time: '6:00 PM' }, 'Sat, 8/23/2026', map);
  assert.match(txt, /a\) Foam Operator/);
  assert.match(txt, /b\) Setup/);
  assert.match(txt, /Reply STOP to opt out/);
  assert.ok(txt.length <= 320, `offer must fit two segments, was ${txt.length}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `buildOfferMap is not a function`

- [ ] **Step 3: Implement both helpers**

In `netlify/functions/staff-assignments.js`, add above `notifyStaffForBooking` (line 857):

```js
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// One letter per role this staff member matched on this booking. The value is
// {booking_id, tag_filled} rather than a bare booking id because the interest
// insert is keyed on (booking_id, staff_id, tag_filled) — someone who matches
// two roles on one gig is two distinct rows, not one.
function buildOfferMap(matchedTags, bookingId) {
  const map = {};
  matchedTags.forEach((tag, i) => { map[LETTERS[i]] = { booking_id: bookingId, tag_filled: tag }; });
  return map;
}

// Written for the medium: two segments (320 chars) is the budget, and a
// reformatted email blows it four times over.
function offerText(booking, dateStr, offerMap) {
  const lines = Object.entries(offerMap).map(([ltr, v]) => `${ltr}) ${v.tag_filled}`).join('\n');
  const when = `${dateStr}${booking.event_time ? ' ' + booking.event_time : ''}`;
  return `Gig available: ${booking.service_name}\n${when} · ${booking.event_zip || 'OKC'}\n${lines}\nReply with any combination (a, ab) if you're interested. Reply STOP to opt out.`;
}
```

- [ ] **Step 4: Send the offer alongside the existing email**

In `notifyStaffForBooking`, inside the `for (const { staff, matched } of eligible)` loop (line 889), immediately after the existing `await notify({ ... })` call that ends at line 908:

```js
    const offerMap = buildOfferMap(matched, booking.id);
    await notifySms(client, staff, offerText(booking, dateStr, offerMap), {
      booking_id: booking.id, trigger_label: 'Gig available', offer_map: offerMap
    });
```

- [ ] **Step 5: Export the helpers for tests**

At the bottom of `netlify/functions/staff-assignments.js`:

```js
exports.buildOfferMap = buildOfferMap;
exports.offerText = offerText;
```

- [ ] **Step 6: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/staff-assignments.js test/sms-staff.test.js
git commit -m "feat(sms): text matching crew a lettered gig offer, with the map stored on the send"
```

---

## Task 6: Inbound webhook — staff express interest by reply

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (extract `expressInterest`)
- Create: `netlify/functions/sms-webhook.js`
- Test: `test/sms-inbound.test.js`

**Interfaces:**
- Consumes: `parseLetters`, `sendSms`, `ensureSmsTables`, `normalisePhone`; `verifyTwilio`, `parseForm`
- Produces:
  - `expressInterest(client, { booking_id, staff_id, tag_filled, status }) -> Promise<row>` (exported from `staff-assignments.js`)
  - `classifyInbound(bodyText) -> 'stop' | 'start' | 'help' | 'message'` (exported from `sms-webhook.js`)
  - `replyForLetters(picked, unknown, offerMap) -> string` (exported from `sms-webhook.js`)

**Correction to the spec:** the spec says SMS is "another route into `expressInterest`". There is no such function — `staff-assignments.js:439-462` is an inline block inside the POST handler, behind `requireAuth`, and it requires `tag_filled`. Step 1 extracts it so the portal and the webhook share one insert rather than drifting apart.

- [ ] **Step 1: Extract `expressInterest` from the HTTP handler**

In `netlify/functions/staff-assignments.js`, add this function near `notifyStaffForBooking` (above line 857):

```js
// The one interest insert. Was inline inside the POST handler; the SMS webhook
// is a second caller, and two copies of an upsert is how they drift.
//
// Staff express interest, Joe assigns — so there is no race and no atomic claim
// here on purpose. Interest is not exclusive: two people wanting a one-slot role
// is normal and harmless. The ON CONFLICT is what makes a Twilio webhook retry
// idempotent: a replayed "ab" updates two rows rather than creating four.
async function expressInterest(client, { booking_id, staff_id, tag_filled, status }) {
  const { rows } = await client.query(
    `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE SET status=$4, updated_at=NOW()
     RETURNING *`,
    [parseInt(booking_id), parseInt(staff_id), tag_filled, status || 'interested']
  );
  return rows[0];
}
```

Then replace the inline query in the `action === 'express_interest'` branch (`staff-assignments.js:454-461`) with a call to it:

```js
          const row = await expressInterest(client, { booking_id, staff_id, tag_filled, status });
          return json(200, row);
```

Add to the exports at the bottom of the file:

```js
exports.expressInterest = expressInterest;
```

- [ ] **Step 2: Run the existing suite to prove the extraction changed nothing**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — `test/staff-assignments.test.js` still green.

- [ ] **Step 3: Write the failing inbound tests**

Create `test/sms-inbound.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInbound, replyForLetters } = require('../netlify/functions/sms-webhook.js');

// STOP/START/HELP are carrier-level obligations and must never reach gig logic.
test('opt-out keywords are recognised in the shapes people send them', () => {
  for (const s of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'CANCEL', 'QUIT', 'END']) {
    assert.strictEqual(classifyInbound(s), 'stop', `failed on ${JSON.stringify(s)}`);
  }
});

test('start and help are their own routes', () => {
  assert.strictEqual(classifyInbound('START'), 'start');
  assert.strictEqual(classifyInbound('unstop'), 'start');
  assert.strictEqual(classifyInbound('HELP'), 'help');
  assert.strictEqual(classifyInbound('info'), 'help');
});

// "I can't stop thinking about the foam party" is not an opt-out. Only a
// keyword-only message is.
test('a keyword inside a sentence is not an opt-out', () => {
  assert.strictEqual(classifyInbound("can't stop thinking about it"), 'message');
  assert.strictEqual(classifyInbound('a'), 'message');
  assert.strictEqual(classifyInbound(''), 'message');
});

// Unrecognised letters get an answer, not silence.
test('an unrecognised letter is named back to the sender', () => {
  const out = replyForLetters(['a'], ['d'], { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' }, c: { tag_filled: 'Driver' } });
  assert.match(out, /Didn't recognise 'd'/);
  assert.match(out, /a, b, c/);
});

test('a clean selection confirms the roles by name', () => {
  const out = replyForLetters(['a', 'b'], [], { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' } });
  assert.match(out, /Foam Operator/);
  assert.match(out, /Setup/);
  assert.doesNotMatch(out, /Didn't recognise/);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../netlify/functions/sms-webhook.js'`

- [ ] **Step 5: Write `sms-webhook.js`**

Create `netlify/functions/sms-webhook.js`:

```js
// netlify/functions/sms-webhook.js — inbound SMS from Twilio.
//
// Routing, in order:
//   1. Signature check. Reject anything that fails — without it anyone with the
//      URL can register interest as somebody else or opt a client out.
//   2. STOP / START / HELP, before any gig logic touches the message.
//   3. A staff member with a recent offer → letter parsing → expressInterest.
//   4. Everything else → logged and forwarded to Joe.
//
// Always returns 200 on anything it handled. Twilio retries non-200s, and the
// unique provider SID plus the ON CONFLICT in expressInterest make a replay
// harmless — but a retry storm is still noise.

const { withClient } = require('./_db');
const { ensureSmsTables, sendSms, logSms, normalisePhone, parseLetters } = require('./_sms');
const { verifyTwilio, parseForm } = require('./_twilio-sig');
const { expressInterest, ensureTables: ensureStaffTables } = require('./staff-assignments');

// Twilio handles these at carrier level too, but a message that arrives here
// must never reach gig logic. Keyword-only, so "can't stop thinking about it"
// is a message, not an opt-out.
const STOP_WORDS  = ['stop', 'stopall', 'unsubscribe', 'cancel', 'quit', 'end', 'revoke', 'optout'];
const START_WORDS = ['start', 'yes', 'unstop'];
const HELP_WORDS  = ['help', 'info'];

function classifyInbound(text) {
  const w = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP_WORDS.includes(w))  return 'stop';
  if (START_WORDS.includes(w)) return 'start';
  if (HELP_WORDS.includes(w))  return 'help';
  return 'message';
}

function replyForLetters(picked, unknown, offerMap) {
  const parts = [];
  if (picked.length) {
    parts.push(`Got it — you're down as interested in ${picked.map(l => offerMap[l].tag_filled).join(' and ')}. Joe will confirm.`);
  }
  if (unknown.length) {
    parts.push(`Didn't recognise ${unknown.map(l => `'${l}'`).join(', ')} — that offer had ${Object.keys(offerMap).join(', ')}.`);
  }
  return parts.join(' ');
}

// The most recent offer this number was sent. Resolving against this rather
// than the live open-gig list is the whole point: slots change, so "b" would
// otherwise mean something different two hours after the offer went out.
async function latestOffer(client, e164) {
  const { rows } = await client.query(
    `SELECT staff_id, booking_id, offer_map FROM sms_log
     WHERE phone=$1 AND direction='out' AND offer_map IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [e164]
  );
  return rows[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!verifyTwilio(event, '/api/sms-webhook')) {
    console.error('sms-webhook: signature verification FAILED — request rejected');
    return { statusCode: 403, body: 'Forbidden' };
  }

  const p = parseForm(event.body);
  const from = normalisePhone(p.From);
  const text = p.Body || '';
  const sid  = p.MessageSid || p.SmsSid || null;

  if (!from) {
    console.error('sms-webhook: unparseable sender', JSON.stringify(p.From));
    return { statusCode: 200, body: 'ok' };
  }

  try {
    const reply = await withClient(async (client) => {
      await ensureSmsTables(client);

      // Log the inbound message first, whatever it turns out to be. ON CONFLICT
      // on the unique SID means a Twilio retry does not double-log.
      const logged = await logSms(client, { direction: 'in', phone: from, body: text, provider_sid: sid, status: 'received' });
      if (!logged && sid) {
        console.log('sms-webhook: replayed SID', sid, '— already handled');
        return null;
      }

      const kind = classifyInbound(text);

      if (kind === 'stop') {
        await client.query(
          `INSERT INTO sms_optout (phone, reason) VALUES ($1,'STOP') ON CONFLICT (phone) DO NOTHING`, [from]
        );
        console.log('sms-webhook: opted out', from);
        return null; // Twilio sends its own STOP confirmation. A second one is spam.
      }

      if (kind === 'start') {
        await client.query('DELETE FROM sms_optout WHERE phone=$1', [from]);
        return "You're back on the list. Reply STOP any time to opt out.";
      }

      if (kind === 'help') {
        return 'Funky Monkey Events. Reply with the letters from a gig offer to register interest, or STOP to opt out. Questions: (405) 431-6625.';
      }

      const offer = await latestOffer(client, from);
      if (offer && offer.offer_map) {
        const map = typeof offer.offer_map === 'string' ? JSON.parse(offer.offer_map) : offer.offer_map;
        const { picked, unknown, freeform } = parseLetters(text, map);
        if (!freeform) {
          await ensureStaffTables(client);
          for (const letter of picked) {
            await expressInterest(client, {
              booking_id: map[letter].booking_id,
              staff_id: offer.staff_id,
              tag_filled: map[letter].tag_filled
            });
          }
          return replyForLetters(picked, unknown, map);
        }
      }

      // Freeform, or from someone with no open offer. Forwarded, because a text
      // that lands somewhere nobody watches is worse than no texting at all —
      // the sender reasonably assumes it was received.
      const notify = process.env.NOTIFY_SMS;
      if (notify) {
        await sendSms(client, notify, `SMS from ${from}: ${text}`.slice(0, 300), { trigger_label: 'Forwarded reply' });
      } else {
        console.error('sms-webhook: NOTIFY_SMS unset — inbound message NOT forwarded:', from, '|', text);
      }
      return null;
    });

    if (reply) {
      await withClient(c => sendSms(c, from, reply, { trigger_label: 'Reply' }));
    }
  } catch (e) {
    console.error('sms-webhook error:', e.message);
    return { statusCode: 500, body: 'error' };
  }

  return { statusCode: 200, body: 'ok' };
};

module.exports.classifyInbound = classifyInbound;
module.exports.replyForLetters = replyForLetters;
```

- [ ] **Step 6: Confirm `ensureTables` is exported from `staff-assignments.js`**

Run: `grep -n "exports.ensureTables\|ensureTables" netlify/functions/staff-assignments.js | tail -5`

If `ensureTables` is not on `exports`, add at the bottom of the file:

```js
exports.ensureTables = ensureTables;
```

- [ ] **Step 7: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 8: Commit and deploy**

```bash
git add netlify/functions/sms-webhook.js netlify/functions/staff-assignments.js test/sms-inbound.test.js
git commit -m "feat(sms): inbound webhook — letter replies register gig interest"
git push
```

Netlify → Trigger deploy. Then in the Twilio Console, set the number's **A MESSAGE COMES IN** webhook to `https://funkymonkeyadmin.netlify.app/api/sms-webhook`, HTTP POST, no query string.

- [ ] **Step 9: Verify inbound end to end**

Text `a` from Joe's phone in reply to a real offer, then:

```sql
SELECT direction, phone, body, status FROM sms_log ORDER BY id DESC LIMIT 4;
SELECT booking_id, staff_id, tag_filled, status FROM staff_assignments ORDER BY id DESC LIMIT 3;
```

Expected: an inbound `received` row, an outbound confirmation, and one `interested` assignment row. Then text `d` and confirm the "Didn't recognise" reply arrives.

---

## Task 7: One rule loop, two channels

`automations.js` has `sendAutomationEmail` + `triggerStatusChange`; `_email.js` has `fireStatusAutomations`, a near-duplicate of the same loop. The live status-change path is `fireStatusAutomations` (called from `booking.js:355` and `accept-quote.js:125`); `triggerStatusChange` is only reachable through an HTTP action nothing calls. Adding a channel branch to one of them ships half the client messages, which is the same shape of bug `_brand.js` was created to end.

**Files:**
- Modify: `netlify/functions/automations.js` (schema, `sendAutomationMessage`, `triggerStatusChange`)
- Modify: `netlify/functions/_email.js` (delete `fireStatusAutomations`)
- Modify: `netlify/functions/booking.js:3,355` and `netlify/functions/accept-quote.js:10,125`
- Modify: `admin.html` (rule editor: channel + SMS body)
- Modify: `booking-form.html` (disclosure at collection)
- Test: `test/sms-automations.test.js`

**Interfaces:**
- Consumes: `sendSms`, `renderSms`, `ensureSmsTables`
- Produces:
  - `sendAutomationMessage(client, rule, booking, stripeLink, now) -> Promise<boolean>` — `now` is optional and exists only so quiet hours are testable; the four internal call sites omit it
  - `triggerStatusChange(client, booking, newStatus, stripeLink) -> Promise<number>` (returns the rule count, matching what `fireStatusAutomations` returned)
  - `alreadySmsSent(client, ruleId, bookingId) -> Promise<boolean>`

**Import direction matters:** `_sms.js` requires `_email.js`. So the combined sender goes in `automations.js` (which may require both), never in `_email.js` — that would be a cycle.

- [ ] **Step 1: Write the failing tests**

Create `test/sms-automations.test.js`:

```js
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

const BOOKING = { id: 5, client_name: 'Dana Ruiz', client_email: 'dana@example.com', client_phone: '405-541-7953', service_name: 'Foam Party', event_date: '2026-08-23' };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `sendAutomationMessage is not a function`

- [ ] **Step 3: Add the two columns to the rules schema**

In `netlify/functions/automations.js`, inside `ensureTables` immediately after the `CREATE TABLE IF NOT EXISTS automation_rules` block (after line 34):

```js
  // SMS is a channel on this engine, not a parallel system: same triggers, same
  // rule editor, so "when do we contact people" stays defined in one place.
  // body_sms is its own column rather than a stripped body_html — SMS bills per
  // 160 characters, and a reformatted email is four segments of nobody's idea
  // of a text message.
  await client.query("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS channel VARCHAR(8) DEFAULT 'email'");
  await client.query("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS body_sms TEXT DEFAULT ''");
  await ensureSmsTables(client);
```

Add the import at the top of `automations.js` (after line 3):

```js
const { sendSms, renderSms, ensureSmsTables, normalisePhone } = require('./_sms');
```

- [ ] **Step 4: Replace `sendAutomationEmail` with `sendAutomationMessage`**

In `netlify/functions/automations.js`, replace the whole `sendAutomationEmail` function (lines 106–125) with:

```js
// ── SMS de-dupe guard ────────────────────────────────────────────────────────
// Deliberately NOT `status='sent'`, which is what the email guard uses. An SMS
// row is 'queued' until the delivery callback lands, and stays 'queued' forever
// if the carrier drops it — so a status filter would never suppress anything.
// The question here is "did we already try", and any row answers it.
async function alreadySmsSent(client, ruleId, bookingId) {
  const { rows } = await client.query(
    'SELECT id FROM sms_log WHERE rule_id=$1 AND booking_id=$2 LIMIT 1', [ruleId, bookingId]
  );
  return rows.length > 0;
}

// ── Send one rule, on whichever channels it asks for ─────────────────────────
// The single choke point for triggerStatusChange and all three scheduled loops.
// Returns true if anything went out on any channel.
//
// ponytail: a channel='both' rule whose email succeeds is excluded by the outer
// email_log guard on the next run, so a failed SMS half is not retried. Neither
// is a failed email today. Add a per-channel outer guard if that ever bites.
async function sendAutomationMessage(client, rule, booking, stripeLink, now) {
  const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
  const channel = rule.channel || 'email';
  let sentAnything = false;

  // SMS first, and above the email recipient check — an SMS-only rule must not
  // be skipped because the booking happens to have no email address.
  if (channel === 'sms' || channel === 'both') {
    const toPhone = rule.recipient === 'admin' ? process.env.NOTIFY_SMS : booking.client_phone;
    const smsBody = renderSms(rule.body_sms || '', booking, stripeLink);
    if (!toPhone) {
      console.error('automation SMS skipped — no phone | rule:', rule.name, '| booking:', booking.id);
    } else if (!smsBody.trim()) {
      console.error('automation SMS skipped — rule has an empty body_sms | rule:', rule.name);
    } else if (await alreadySmsSent(client, rule.id, booking.id)) {
      console.log('automation SMS skipped — already sent | rule:', rule.name, '| booking:', booking.id);
    } else {
      const res = await sendSms(client, toPhone, smsBody, {
        booking_id: booking.id, rule_id: rule.id, trigger_label: rule.name, now
      });
      if (res.status === 'queued' || res.status === 'held') sentAnything = true;
    }
  }

  if (channel === 'email' || channel === 'both') {
    const toEmail = rule.recipient === 'admin' ? NOTIFY : booking.client_email;
    if (toEmail) {
      const subject = render(rule.subject, booking, stripeLink);
      const html    = wrap(render(rule.body_html, booking, stripeLink));
      // Guarded here rather than at each loop: one bad recipient must never
      // abort the rest of the batch.
      try {
        const res = await sendEmail(toEmail, subject, html);
        await logEmail(client, booking.id, rule.id, rule.name, subject, toEmail, rule.recipient, logStatus(res));
        sentAnything = true;
      } catch (e) {
        console.error('automation email failed:', toEmail, '| rule:', rule.name, '|', e.message);
        await logEmail(client, booking.id, rule.id, rule.name, subject, toEmail, rule.recipient, 'failed', e.message);
      }
    }
  }

  return sentAnything;
}
```

Then replace all four call sites of `sendAutomationEmail` in `automations.js` (lines 137, 169, 194, 217) with `sendAutomationMessage`, keeping their arguments:

```js
    if (await sendAutomationMessage(client, rule, booking, null)) sent++;
```

and in `triggerStatusChange`:

```js
    await sendAutomationMessage(client, rule, booking, stripeLink);
```

- [ ] **Step 5: Make `triggerStatusChange` the single status-change path**

Replace `triggerStatusChange` in `automations.js` (lines 127–139) with a version that returns a count and ensures its own tables, matching the contract `fireStatusAutomations` had:

```js
// ── Trigger: status_change ────────────────────────────────────────────────────
// The one status-change loop. _email.js used to carry a near-identical
// fireStatusAutomations — the live path, while this one was reachable only via
// an HTTP action nothing called. Two copies of a rule loop is how a channel gets
// added to one of them and half the messages quietly stop.
async function triggerStatusChange(client, booking, newStatus, stripeLink) {
  try {
    await ensureTables(client);
    const { rows: rules } = await client.query(
      `SELECT * FROM automation_rules
       WHERE active=TRUE AND trigger_event='status_change' AND trigger_status=$1
       ORDER BY sort_order`,
      [newStatus]
    );
    for (const rule of rules) {
      await sendAutomationMessage(client, rule, booking, stripeLink);
    }
    return rules.length;
  } catch (e) {
    console.error('triggerStatusChange error:', e.message);
    return 0;
  }
}
```

Add to the exports at the bottom of `automations.js`:

```js
module.exports.triggerStatusChange = triggerStatusChange;
module.exports.sendAutomationMessage = sendAutomationMessage;
module.exports.alreadySmsSent = alreadySmsSent;
```

- [ ] **Step 6: Delete `fireStatusAutomations` and repoint its two callers**

In `netlify/functions/_email.js`, delete the whole `fireStatusAutomations` function (lines 187–221) and remove it from the export list on line 256.

In `netlify/functions/booking.js` line 3, drop `fireStatusAutomations` from the `_email` destructure and add the import:

```js
const { triggerStatusChange } = require('./automations');
```

At `booking.js:355`, replace:

```js
          const sent = await triggerStatusChange(c, updated, u.status, stripeLink);
```

In `netlify/functions/accept-quote.js` line 10, drop `fireStatusAutomations` from the `_email` destructure and add:

```js
const { triggerStatusChange } = require('./automations');
```

At `accept-quote.js:125`, replace:

```js
      await triggerStatusChange(c, updated, 'accepted', updated.stripe_payment_link || null);
```

- [ ] **Step 7: Run the full suite**

Run: `npm test 2>&1 | tail -20`
Expected: PASS. If `test/accept-quote.test.js` fails on the rename, update its expectation — the behaviour is identical, only the function name moved.

- [ ] **Step 8: Add channel and SMS body to the rule editor**

In `admin.html`, find the automation rule editor form (search for `sf-comms` is the wrong form — search for `trigger_event` in the rule-editing modal). Add a channel select and an SMS body textarea beside the existing subject/body fields, and include both in the `save_rule` payload:

```html
<label>Channel</label>
<select id="rule-channel">
  <option value="email">Email only</option>
  <option value="sms">SMS only</option>
  <option value="both">Email + SMS</option>
</select>
<label>SMS text <span style="color:#9ca3af;font-size:.72rem">plain text, aim for under 320 characters</span></label>
<textarea id="rule-body-sms" rows="3" maxlength="320"></textarea>
```

In the object posted by `save_rule`, add:

```js
  channel:  document.getElementById('rule-channel').value,
  body_sms: document.getElementById('rule-body-sms').value,
```

And in the `save_rule` handler in `automations.js` (lines 330–349), add both columns to the UPDATE and the INSERT:

```js
        if (r.id) {
          await client.query(
            `UPDATE automation_rules SET name=$1,active=$2,trigger_event=$3,trigger_status=$4,
             trigger_days=$5,recipient=$6,subject=$7,body_html=$8,sort_order=$9,channel=$10,body_sms=$11,updated_at=NOW()
             WHERE id=$12`,
            [r.name,r.active!==false,r.trigger_event,r.trigger_status||null,
             r.trigger_days||null,r.recipient||'client',r.subject,r.body_html,r.sort_order||0,
             r.channel||'email',r.body_sms||'',r.id]
          );
        } else {
          await client.query(
            `INSERT INTO automation_rules (name,active,trigger_event,trigger_status,trigger_days,recipient,subject,body_html,sort_order,channel,body_sms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [r.name,r.active!==false,r.trigger_event,r.trigger_status||null,
             r.trigger_days||null,r.recipient||'client',r.subject,r.body_html,r.sort_order||0,
             r.channel||'email',r.body_sms||'']
          );
        }
```

- [ ] **Step 9: Add the disclosure at collection**

In `booking-form.html`, find the client phone input and add directly beneath it:

```html
<p style="font-size:.78rem;color:#A78BCA;margin-top:4px">We'll text you about your booking. Reply STOP to opt out. Message and data rates may apply.</p>
```

This wording is what Task 0 step 3 submits to Twilio as the opt-in description; keep the two identical.

- [ ] **Step 10: Run the suite and commit**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

```bash
git add netlify/functions/automations.js netlify/functions/_email.js netlify/functions/booking.js netlify/functions/accept-quote.js admin.html booking-form.html test/sms-automations.test.js
git commit -m "feat(sms): channel column on automation rules; one status-change loop instead of two"
```

---

## Task 8: The morning flush, and the two staff messages with no trigger yet

Three additions to the daily 9am-Central run. The spec's staff "day-of reminder" and "gig still unstaffed" have no trigger in the engine today — every date-driven rule selects from `bookings` and resolves the recipient as `client` or `admin` (`automations.js:26`). Sending to *staff assigned to a booking* is a different query and a different recipient, so these two are bespoke code in the scheduled function rather than a new `recipient` type in the rules engine, its resolution logic, and its admin UI, for two messages.

**Files:**
- Modify: `netlify/functions/_sms.js` (add `flushHeldSms`)
- Modify: `netlify/functions/automations-scheduled.js`
- Test: `test/sms-scheduled.test.js`

**Interfaces:**
- Consumes: `sendSms`, `isQuietHours`
- Produces:
  - `flushHeldSms(client, now) -> Promise<{ sent, expired }>`
  - `staffDayOfReminders(client, now) -> Promise<number>` (in `automations-scheduled.js`)
  - `unstaffedAlerts(client, now) -> Promise<number>` (in `automations-scheduled.js`)

- [ ] **Step 1: Write the failing tests**

Create `test/sms-scheduled.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

function loadSms() {
  delete require.cache[require.resolve('../netlify/functions/_sms.js')];
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/_sms.js');
}

function fakeClient(heldRows) {
  const queries = [];
  return {
    queries,
    updates: () => queries.filter(q => /UPDATE sms_log/i.test(q.sql)),
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM sms_log/i.test(sql) && /held/.test(sql)) return { rows: heldRows };
      if (/FROM sms_optout/i.test(sql)) return { rows: [] };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `flushHeldSms is not a function`

- [ ] **Step 3: Implement `flushHeldSms` in `_sms.js`**

Add to `netlify/functions/_sms.js` above `module.exports`, and add `flushHeldSms` to the export list:

```js
// ── The morning flush ────────────────────────────────────────────────────────
// Quiet hours hold a message rather than dropping it, and this is where held
// messages go out. There is no queue and no per-message scheduler in this
// system — the 9am Central cron is the only recurring thing — so "held" is a
// status on the row and this is the flush.
//
// Sends directly rather than via sendSms() so the held row is updated in place:
// routing it back through sendSms would write a second log row for the same
// message and leave the first stuck at 'held' forever.
const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function flushHeldSms(client, now = new Date()) {
  // Never flush inside quiet hours: it would re-hold everything it just picked
  // up and make no progress.
  if (isQuietHours(now)) return { sent: 0, expired: 0 };

  const { rows } = await client.query(
    `SELECT * FROM sms_log WHERE status='held' ORDER BY created_at LIMIT 200`
  );
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const site = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  let sent = 0, expired = 0;

  for (const row of rows) {
    // A day-before reminder that surfaces three days late is misinformation.
    if (now - new Date(row.created_at) > HELD_MAX_AGE_MS) {
      await client.query("UPDATE sms_log SET status=$1, error_detail=$2, updated_at=NOW() WHERE id=$3",
        ['expired', 'held longer than 24h', row.id]);
      console.error('flushHeldSms: expired held message', row.id, '→', row.phone);
      expired++;
      continue;
    }
    if (!sid || !token || !from) continue;
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: row.phone, From: from, Body: row.body, StatusCallback: `${site}/api/sms-status` }).toString()
      });
      const data = await res.json();
      if (!res.ok || data.code) {
        const reason = `${data.code || res.status}: ${data.message || 'Twilio send failed'}`;
        await client.query("UPDATE sms_log SET status='failed', error_detail=$1, updated_at=NOW() WHERE id=$2", [reason, row.id]);
        console.error('flushHeldSms failed:', row.phone, '|', reason);
        continue;
      }
      await client.query("UPDATE sms_log SET status=$1, provider_sid=$2, updated_at=NOW() WHERE id=$3",
        ['queued', data.sid, row.id]);
      sent++;
    } catch (e) {
      await client.query("UPDATE sms_log SET status='failed', error_detail=$1, updated_at=NOW() WHERE id=$2", [e.message, row.id]);
      console.error('flushHeldSms error:', row.phone, '|', e.message);
    }
  }
  return { sent, expired };
}
```

- [ ] **Step 4: Run the flush tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Add the flush and the two staff messages to the scheduled function**

Replace `netlify/functions/automations-scheduled.js` with:

```js
// netlify/functions/automations-scheduled.js
//
// Runs the date-driven automation rules once a day, plus three SMS jobs.
//
// Why this exists: `runScheduledAutomations` in automations.js was only
// reachable two ways — a manual POST of action:'run_scheduled', or a button in
// the admin UI. Its own comment said "call daily via cron" and nothing ever
// did. So rules whose trigger is date-relative never fired on their own.
//
// The rules select on a single calendar day (event_date = today ± trigger_days),
// so a missed run is a permanently missed send — there is no catch-up. That is
// what makes a real schedule, rather than a button, the correct fix.
//
// The three SMS jobs live here rather than in the rules engine because they
// send to STAFF. Every rule in automation_rules resolves its recipient as
// 'client' or 'admin' off the booking row; "everyone assigned to this booking"
// is a different query and a different address, and teaching the engine a third
// recipient type — plus its UI — for two messages is not worth it.
//
// Schedule lives in netlify.toml. Idempotency is each job's own concern.

const { withClient } = require('./_db');
const { runScheduledAutomations, ensureTables } = require('./automations');
const { ensureSmsTables, sendSms, flushHeldSms } = require('./_sms');
const { wantsSms } = require('./staff-assignments');

// ── Day-of reminder: call time and address, to everyone working today ────────
async function staffDayOfReminders(client, now) {
  const { rows } = await client.query(`
    SELECT sa.id AS assignment_id, sa.schedule_start, sa.tag_filled,
           s.id AS staff_id, s.phone, s.comms_preference, s.preferred_name, s.name,
           b.id AS booking_id, b.service_name, b.event_time, b.event_zip, b.event_location
    FROM staff_assignments sa
    JOIN staff s    ON s.id = sa.staff_id AND s.active = TRUE
    JOIN bookings b ON b.id = sa.booking_id
    WHERE sa.status = 'assigned'
      AND b.event_date::date = CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM sms_log l
        WHERE l.staff_id = s.id AND l.booking_id = b.id
          AND l.trigger_label = 'Day-of reminder'
      )
  `);
  let sent = 0;
  for (const r of rows) {
    if (!wantsSms(r) || !r.phone) continue;
    const when = r.schedule_start ? String(r.schedule_start).slice(0, 5) : (r.event_time || 'TBD');
    const where = r.event_location || r.event_zip || 'OKC';
    const res = await sendSms(client, r.phone,
      `Today: ${r.service_name}, ${r.tag_filled}. Load up ${when}. ${where}. Questions: (405) 431-6625`,
      { booking_id: r.booking_id, staff_id: r.staff_id, trigger_label: 'Day-of reminder', now });
    if (res.status === 'queued') sent++;
  }
  return sent;
}

// ── Unstaffed alert: to Joe, not to the crew ─────────────────────────────────
// The gap this closes: a gig three days out with nobody assigned is currently
// only visible if someone looks.
async function unstaffedAlerts(client, now) {
  const notify = process.env.NOTIFY_SMS;
  if (!notify) {
    console.error('unstaffedAlerts: NOTIFY_SMS unset — no alert sent');
    return 0;
  }
  const { rows } = await client.query(`
    SELECT b.id, b.service_name, b.event_date, b.event_zip
    FROM bookings b
    WHERE b.status IN ('accepted','confirmed')
      AND b.event_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + 3)
      AND NOT EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.booking_id = b.id AND sa.status = 'assigned')
      AND NOT EXISTS (
        SELECT 1 FROM sms_log l WHERE l.booking_id = b.id AND l.trigger_label = 'Unstaffed alert'
      )
    ORDER BY b.event_date
  `);
  let sent = 0;
  for (const b of rows) {
    const d = new Date(String(b.event_date).slice(0, 10) + 'T00:00:00Z')
      .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
    const res = await sendSms(client, notify,
      `UNSTAFFED: ${b.service_name} on ${d} (${b.event_zip || 'OKC'}) has nobody assigned.`,
      { booking_id: b.id, trigger_label: 'Unstaffed alert', now });
    if (res.status === 'queued') sent++;
  }
  return sent;
}

exports.handler = async () => {
  const startedAt = new Date().toISOString();
  const now = new Date();
  console.log(`Scheduled automations starting (${startedAt})`);

  try {
    const result = await withClient(async (client) => {
      await ensureTables(client);
      await ensureSmsTables(client);

      // Held first: these were due last night and are the most time-sensitive
      // thing in the run.
      const held = await flushHeldSms(client, now);
      const sent = await runScheduledAutomations(client);
      // Each SMS job is guarded independently — one failing query must not cost
      // the others their run, and a scheduled function that fails quietly is
      // how the original problem stayed invisible for months.
      const dayOf = await staffDayOfReminders(client, now).catch(e => { console.error('staffDayOfReminders FAILED:', e.message); return 0; });
      const alerts = await unstaffedAlerts(client, now).catch(e => { console.error('unstaffedAlerts FAILED:', e.message); return 0; });
      return { held, sent, dayOf, alerts };
    });

    console.log(`Scheduled automations complete — ${result.sent} rule message(s), ${result.held.sent} held SMS flushed, ${result.held.expired} expired, ${result.dayOf} day-of reminder(s), ${result.alerts} unstaffed alert(s)`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result, startedAt }) };
  } catch (e) {
    console.error('Scheduled automations FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message, startedAt }) };
  }
};

module.exports.staffDayOfReminders = staffDayOfReminders;
module.exports.unstaffedAlerts = unstaffedAlerts;
```

- [ ] **Step 6: Run the suite**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_sms.js netlify/functions/automations-scheduled.js test/sms-scheduled.test.js
git commit -m "feat(sms): morning flush for held messages, staff day-of reminders, unstaffed alerts"
```

---

## Task 9: Client inbound and go-live

Client inbound is the only layer carrying an operational commitment rather than just code — the forwarding built in Task 6 already covers it, so this task is the configuration, the rules, and the manual verification that everything actually reaches a handset.

**Files:**
- Modify: none (code complete) — this task creates the five client rules and runs the go-live checks

- [ ] **Step 1: Confirm forwarding is live**

From a phone that is neither Joe's nor a staff member's, text the Twilio number "hi is this funky monkey". Confirm Joe's phone receives `SMS from +1405…: hi is this funky monkey`, and:

```sql
SELECT direction, phone, body, status FROM sms_log WHERE direction='in' ORDER BY id DESC LIMIT 3;
```

- [ ] **Step 2: Create the five client rules in the admin UI**

Admin → Automations → new rule, for each. Exact day counts for the last two are Joe's call at configuration time.

| Name | Trigger | Channel | `body_sms` |
|---|---|---|---|
| Booking confirmed | `status_change` → `confirmed` | both | `Hi {{client_first_name}}! Your {{service_name}} on {{event_date}} is confirmed. Questions? Call (405) 431-6625. Reply STOP to opt out.` |
| Deposit request | `status_change` → `accepted` | both | `Hi {{client_first_name}}! To lock in {{event_date}} we need your ${{deposit_amount}} deposit. Check your email for the payment link. Reply STOP to opt out.` |
| Day-before reminder | `days_before_event` = 1 | sms | `Hi {{client_first_name}}! We're all set for {{service_name}} tomorrow at {{event_time}}. See you then! Reply STOP to opt out.` |
| Balance due | `days_before_event` = N | both | `Hi {{client_first_name}}! Your remaining balance of ${{balance_due}} is due before {{event_date}}. Reply STOP to opt out.` |
| Review link | `days_after_event` = N | sms | `Thanks for having us, {{client_first_name}}! A quick review would mean a lot: {{review_link}} Reply STOP to opt out.` |

- [ ] **Step 3: Smoke test every template against Joe's own phone**

This is what tests cannot cover: whether a message reaches a handset. 10DLC filtering only appears in production.

Create one throwaway booking with Joe's own phone and email as the client, then walk it through each trigger — set it to `accepted`, then `confirmed`, then run the scheduled function by hand from the admin "run scheduled" button with the event date set to tomorrow.

- [ ] **Step 4: Confirm the carrier, not Twilio, says delivered**

```sql
SELECT trigger_label, phone, status, error_detail, created_at, updated_at
FROM sms_log WHERE created_at > NOW() - INTERVAL '2 hours' ORDER BY id;
```

Every row must read `delivered`. **A row still at `queued` several minutes later means the carrier dropped it** — check the 10DLC campaign status before pointing anything at a real client or crew member.

- [ ] **Step 5: Verify opt-out end to end**

Text `STOP` from Joe's phone, confirm `sms_optout` gains the row, then trigger any rule for that booking and confirm the new `sms_log` row reads `opted_out` and no message arrives. Then text `START` and confirm the row is deleted and sending resumes.

- [ ] **Step 6: Resolve the two open contact records**

- Noah Drews has the placeholder email `Filler@filler.com` and is currently unreachable by the system. Give him a real email or set `comms_preference = 'sms'` with a verified phone.
- His staff access code (`crisp-rocket-comet-76`) was exposed in a screenshot. Regenerate it.

- [ ] **Step 7: Commit any rule seed changes and deploy**

```bash
git add -A
git commit -m "feat(sms): client message rules and go-live verification"
git push
```

Netlify → Trigger deploy, then confirm the deploy actually published before relying on it.

---

## Self-review notes

**Spec coverage.** All nine messages are implemented: staff gig-available (Task 5), you're-booked (Task 4), day-of reminder and unstaffed alert (Task 8), and the five client messages (Task 9 step 2 on the Task 7 engine). Provider and number, 10DLC, both tables, normalisation, the staff reply loop, letter multi-select with a stored map, inbound routing, the automations `channel` column, all three compliance items, all four failure-mode states, idempotency on both directions, and the full test list are each carried by a task.

**Three deliberate deviations from the spec, each with its reasoning inline in the task that makes it:**

1. **Task 6** — the spec says SMS is "another route into `expressInterest`". No such function exists; it is an inline block behind `requireAuth` requiring `tag_filled`. Task 6 step 1 extracts it so both callers share one insert.
2. **Task 5** — the spec's illustrated offer spans several bookings. The trigger that exists fires per booking, so letters map to the roles on one gig. A cross-booking digest reuses every piece of this and is a later, separate sender.
3. **Task 8** — staff day-of and unstaffed messages are bespoke code in the scheduled function, not a `recipient='staff'` type in the rules engine, because the engine resolves recipients off the booking row and two messages do not justify a third recipient type plus its UI.

**Two corrections to invariants the spec asserted:**

- The email de-dupe guard is `status='sent'`; reusing it for SMS would never suppress anything, because an SMS row sits at `queued` until the callback lands and stays there if the carrier drops it. `alreadySmsSent` matches any row (Task 7).
- `sendAutomationEmail` bails at `if (!toEmail) return false`, which would silently send nothing for an SMS-only rule on a booking with no email. The SMS branch sits above that check (Task 7).

**One structural change the spec did not anticipate:** `_email.js:fireStatusAutomations` and `automations.js:triggerStatusChange` are two implementations of the same rule loop, and the live path is the one in `_email.js`. Adding a channel branch to one would ship half the client messages. Task 7 collapses them into one, which is a net deletion.
