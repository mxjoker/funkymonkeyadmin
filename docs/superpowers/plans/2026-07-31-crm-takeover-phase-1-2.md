# CRM Takeover — Phases 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every email and payment path in the CRM either work or report failure loudly, then prove the live money path end-to-end with a real charge.

**Architecture:** All 16 outbound sends route through one function, `sendEmail` in `netlify/functions/_email.js`. Fixing that single function fixes every path, so the work concentrates there: an allowlist guard lands first (so correcting the bug does not wake dormant sends at once), then correct Resend error detection, then truthful logging. A new `/api/health` endpoint makes configuration state observable instead of assumed. Phase 2 then runs one real charge through the whole chain as a go/no-go gate.

**Tech Stack:** Node 25 (CommonJS), Netlify Functions, Neon Postgres via `pg`, Resend for email, Stripe REST API. Tests use the built-in `node:test` runner and `node:assert` — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-crm-takeover-design.md`

## Global Constraints

- **No new npm dependencies.** `package.json` has exactly `pg` and `pdf-lib`. Tests use `node:test`/`node:assert` from stdlib.
- **CommonJS only.** Every file in `netlify/functions/` uses `require`/`module.exports`. Do not introduce ESM there.
- **The staffing subsystem is retained** — `staff.js`, `staff-assignments.js`, `staff-payments.js`, `staff-feedback.js`, `payroll.js`, `payroll-scheduled.js`, `staff-portal.html`. Do not delete them. They are unused but the owner is keeping them.
- **Never bulk-delete or "clean" the `bookings` table.** Its ~632 rows are real imported history. `created_at` is uniformly the 2026-05-07 import date, so it is meaningless as an urgency signal — judge by `event_date`.
- **`EMAIL_ALLOWLIST` must be set in Netlify to the owner's address before Task 3 deploys.** Clearing it is a Phase 4 step, not a Phase 1–2 step.
- **Deploy = `git push` to `main`.** Netlify auto-builds from the GitHub webhook. The Netlify CLI is NOT logged in on this machine, so production environment variables must be set by the owner in the Netlify web dashboard.
- **Tag before each phase:** `git tag pre-phase-1` / `pre-phase-2`, following the existing `pre-hardening` convention.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `netlify/functions/_email.js` | The single send path: allowlist, Resend call, error detection, logging | Modify |
| `netlify/functions/_health.js` | Pure config-inspection logic, no I/O — unit testable | Create |
| `netlify/functions/health.js` | HTTP handler: auth, DB probe, calls `_health.js` | Create |
| `netlify/functions/create-stripe-link.js` | Deposit link generation | Modify (copy bug) |
| `netlify/functions/bookings.js` | Public intake + admin list | Modify (call-site guard) |
| `netlify/functions/coi-request.js`, `refund.js`, `client.js`, `automations.js` | Various senders | Modify (call-site guards as the audit finds) |
| `netlify.toml` | Route table | Modify (add `/api/health`) |
| `test/_email.test.js` | Allowlist + error-detection behavior | Create |
| `test/_health.test.js` | Config inspection | Create |
| `.gitignore` | Secret hygiene | Modify |
| `docs/ROADMAP.md` | Reconcile the deleted SMS sender | Modify |

`_health.js` is split from `health.js` deliberately: the interesting logic is "given this environment, what is true," which is pure and testable. The handler around it only does auth and a DB ping.

---

# Phase 1 — Clear & Trust

## Task 1: Repo hygiene and secret safety

This is first because it is a live risk, and it is independent of every other task.

**Files:**
- Modify: `.gitignore`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: nothing
- Produces: a clean working tree, so later tasks' commits contain only their own changes

- [ ] **Step 1: Move the passcode screenshots out of the repo entirely**

`FME Passcodes/` holds 8 screenshots of staff access codes. It is untracked AND un-ignored — one `git add -A` publishes it. Moving beats ignoring: an ignored secret is still a secret sitting in the working directory.

```bash
cd /Users/joecoover2022/Downloads/FME-Backend
mkdir -p ~/Documents/FME-Secrets
mv "FME Passcodes" ~/Documents/FME-Secrets/
```

- [ ] **Step 2: Belt-and-braces — ignore the path anyway**

Append to `.gitignore` under the existing "Session/workflow artifacts" section:

```gitignore
# Secrets that must never be committed even by accident
FME Passcodes/
*Passcode*
```

- [ ] **Step 3: Verify it is gone and ignored**

```bash
git status --short | grep -i passcode
```

Expected: no output. If anything prints, stop and investigate before continuing.

- [ ] **Step 4: Review the 23 pending working-tree changes**

These predate this plan and must not be swept into its commits.

```bash
git diff --stat
git diff netlify/functions/_email.js netlify/functions/automations.js
```

Read the diffs. The 16 `docs/` changes are almost certainly trailing-whitespace or formatting noise. The 7 `netlify/functions/` changes are real code and need judgment. Commit them as their own change with a message describing what they are, or `git checkout --` them if they are unintended. **Do not proceed until `git status` is clean apart from `deno.lock`.**

- [ ] **Step 5: Reconcile the ROADMAP with reality**

`netlify/functions/_sms.js` is deleted, but `docs/ROADMAP.md` still documents it as built-and-ready under "## SMS (built, not wired)". Replace that section:

```markdown
## SMS (removed)

`netlify/functions/_sms.js` was a complete Twilio sender that nothing ever
called. It was deleted on 2026-07-31 rather than left as dead code. To revive
it, recover the file from git history (`git log --diff-filter=D -- netlify/functions/_sms.js`)
and see `docs/archive/SMS_IMPLEMENTATION_GUIDE.md` for the wiring notes.
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore docs/ROADMAP.md
git commit -m "chore: secure passcode screenshots, reconcile ROADMAP with deleted _sms.js"
```

- [ ] **Step 7: Tag the phase start**

```bash
git tag pre-phase-1
```

---

## Task 2: Test harness and the `EMAIL_ALLOWLIST` guard

The allowlist lands **before** any error-detection change. Correcting the Resend bug without it would wake every dormant send in the system at once — including `staff-assignments.js:576`, which mails real staff, and active automation rules.

**Files:**
- Create: `test/_email.test.js`
- Modify: `netlify/functions/_email.js:92-107` (the `sendEmail` function)
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `sendEmail(to, subject, html)` gains allowlist filtering. Still returns the Resend response object at this stage; Task 3 changes its failure behavior.

- [ ] **Step 1: Add a test script to package.json**

```json
{
  "name": "funky-monkey-events",
  "version": "3.0.0",
  "description": "Funky Monkey Events booking system",
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "pg": "^8.11.3",
    "pdf-lib": "^1.17.1"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/_email.test.js`. It stubs `globalThis.fetch` so no real network call happens — Node 25 has fetch built in, so no mocking library is needed.

```javascript
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
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: the first test FAILS — `calls.length` is 1, not 0, because no allowlist logic exists yet. The last test passes incidentally.

- [ ] **Step 4: Implement the allowlist**

In `netlify/functions/_email.js`, add above `sendEmail` (near the `FROM` constant at line 12):

```javascript
// ── Email allowlist ───────────────────────────────────────────────────────────
// When EMAIL_ALLOWLIST is set, only those addresses actually receive mail;
// everything else is logged and dropped. This exists so that fixing the Resend
// error-detection bug does not wake every dormant send in the system at once.
// Unset (production) = no filtering.
function allowedToSend(to) {
  const list = process.env.EMAIL_ALLOWLIST;
  if (!list) return true;
  const allowed = list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(to).trim().toLowerCase());
}
```

Then, at the top of `sendEmail`, immediately after the existing `if (!key || !to) return;` guard:

```javascript
  if (!allowedToSend(to)) {
    console.log('Email SUPPRESSED by EMAIL_ALLOWLIST:', to, '| subject:', subject);
    return { suppressed: true };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: all 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json test/_email.test.js netlify/functions/_email.js
git commit -m "feat: EMAIL_ALLOWLIST guard in sendEmail

Lands before the Resend error-detection fix so that correcting that bug
does not wake every dormant send at once."
```

- [ ] **Step 7: Set the env var in Netlify before deploying**

**This is a manual step for the owner.** In the Netlify dashboard for `funkymonkeyadmin`, add:

```
EMAIL_ALLOWLIST = joe.coover@gmail.com
```

Do not push Task 3 until this is confirmed set. Task 2 alone is safe to deploy — it only adds filtering.

---

## Task 3: Correct Resend error detection

**Files:**
- Modify: `netlify/functions/_email.js:92-107`
- Modify: `test/_email.test.js`

**Interfaces:**
- Consumes: `allowedToSend(to)` from Task 2
- Produces: `sendEmail` now **throws** on send failure instead of returning silently. Callers must be guarded — that is Task 5.

**Background:** `_email.js:101` checks `if (data.error)`. Resend returns errors as `{statusCode, message, name}` — there is no `error` field. So a rejected send logs `Email sent to: ... | id: undefined` and returns normally. This was already fixed once in June for the `test_email` path in `auth.js`; the core function every automation uses was missed.

- [ ] **Step 1: Write the failing tests**

Append to `test/_email.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: the two `assert.rejects` tests FAIL — nothing throws today.

- [ ] **Step 3: Rewrite sendEmail**

Replace the whole `sendEmail` function in `netlify/functions/_email.js` (currently lines 92–107):

```javascript
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!to) return { skipped: 'no recipient' };
  if (!key) throw new Error('RESEND_API_KEY is not set');

  if (!allowedToSend(to)) {
    console.log('Email SUPPRESSED by EMAIL_ALLOWLIST:', to, '| subject:', subject);
    return { suppressed: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html })
  });
  const data = await res.json();

  // Resend signals failure with {statusCode, message, name} — NOT {error}.
  // The old `if (data.error)` check never matched, so every failure looked
  // like a success. Do not "simplify" this back.
  if (!res.ok || data.statusCode || data.name) {
    const reason = data.message || data.name || `HTTP ${res.status}`;
    console.error('Resend error:', to, '|', reason);
    throw new Error(`Resend send failed: ${reason}`);
  }

  console.log('Email sent to:', to, '| id:', data.id, '| subject:', subject);
  return data;
}
```

Note the `catch` that previously swallowed everything is gone — that was the second half of the silent-failure bug.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_email.js test/_email.test.js
git commit -m "fix: detect Resend failures correctly and throw

Resend returns errors as {statusCode, message, name}, not {error}, so the
old check never matched and every failed send logged as a success. All 16
call sites already guard with .catch or try/catch (verified in Task 5)."
```

- [ ] **Step 6: Do NOT push yet**

Task 5 audits the call sites. Push after Task 5 passes, as one deploy.

---

## Task 4: Record the truth in `email_log`

**Files:**
- Modify: `netlify/functions/_email.js:110-120` (`logEmail`) and `:151-165` (`ensureEmailLog`)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `logEmail(client, bookingId, ruleId, triggerLabel, subject, recipientEmail, recipientLabel, status, errorDetail)` — two new optional trailing parameters. Existing 7-argument calls keep working and default to `'sent'`.

**Background:** the spec said to add a `status` column. It already exists (`_email.js:162`, `status VARCHAR(32) DEFAULT 'sent'`) — but `logEmail`'s INSERT never sets it, so **every row claims success regardless of outcome**. The real work is populating it and adding a reason.

- [ ] **Step 1: Add the error-detail column to the schema helper**

In `ensureEmailLog`, after the `CREATE TABLE` call, add an idempotent migration matching the pattern used in `bookings.js:83`:

```javascript
async function ensureEmailLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      rule_id INTEGER,
      trigger_label VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      recipient_label VARCHAR(32) DEFAULT 'client',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(32) DEFAULT 'sent'
    )
  `);
  await client.query(
    "ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_detail TEXT DEFAULT ''"
  );
}
```

- [ ] **Step 2: Make logEmail accept and store the outcome**

```javascript
async function logEmail(client, bookingId, ruleId, triggerLabel, subject, recipientEmail, recipientLabel, status, errorDetail) {
  try {
    await client.query(
      `INSERT INTO email_log (booking_id, rule_id, trigger_label, subject, recipient_email, recipient_label, status, error_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [bookingId, ruleId||null, triggerLabel, subject, recipientEmail, recipientLabel||'client',
       status||'sent', errorDetail||'']
    );
  } catch(e) {
    console.error('logEmail error:', e.message);
  }
}
```

- [ ] **Step 3: Record failures where sends are already guarded**

In `stripe-webhook.js`, the `logEmail` calls sit *inside* the `try` block after `sendEmail`, so a throw skips them entirely and the failure leaves no trace at all. Move logging into the `catch` as well. For the client confirmation at `stripe-webhook.js:130-150`:

```javascript
          try {
            await sendEmail(
              b.client_email,
              "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events",
              wrap(`...unchanged body...`)
            );
            await logEmail(c, b.id, null, 'Deposit Paid', "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events", b.client_email, 'client');
          } catch(emailErr) {
            console.error("Webhook: client email failed:", emailErr.message);
            await logEmail(c, b.id, null, 'Deposit Paid', "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events", b.client_email, 'client', 'failed', emailErr.message);
          }
```

Apply the same pattern to the admin notification at `stripe-webhook.js:152-172`.

- [ ] **Step 4: Verify the schema migration is safe to run twice**

`ADD COLUMN IF NOT EXISTS` is idempotent, and `ensureEmailLog` is called on every cold start. Confirm no syntax error by reading it back — there is no local database to run it against, so this is a read-check, not an execution check.

```bash
grep -n "error_detail" netlify/functions/_email.js
```

Expected: two hits — the ALTER and the INSERT column list.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_email.js netlify/functions/stripe-webhook.js
git commit -m "feat: email_log records real outcomes, not just attempts

The status column existed but logEmail never set it, so every row read
'sent'. Adds error_detail and logs failures from the webhook's catch
blocks, which previously skipped logging entirely on throw."
```

---

## Task 5: Audit and guard every `sendEmail` call site

Task 3 made `sendEmail` throw. This task proves that every one of the 16 call sites handles it. Two were already verified during planning: `bookings.js:398` and `bookings.js:428` both use `.catch()`, and `stripe-webhook.js` wraps all three of its calls in `try`/`catch`.

**Files:**
- Modify: `netlify/functions/automations.js:105,291`
- Modify: `netlify/functions/coi-request.js:161`
- Modify: `netlify/functions/client.js:215`
- Modify: `netlify/functions/refund.js:205`
- Modify: `netlify/functions/staff-assignments.js:483,575,705,839`
- Modify: `netlify/functions/_email.js:139`

- [ ] **Step 1: List every call site and its current guard**

```bash
cd /Users/joecoover2022/Downloads/FME-Backend
grep -rn "await sendEmail(\|await notify(" netlify/functions/*.js
```

For each hit, read ~10 lines above and below and classify it as: guarded by `.catch()`, guarded by an enclosing `try`/`catch`, or **unguarded**.

- [ ] **Step 2: Guard each unguarded site**

The correct guard depends on what the caller is doing. Two patterns, both already used in this codebase:

For a fire-and-forget notification where failure must not break the response — the `bookings.js:445` pattern:

```javascript
await sendEmail(recipient, subject, body)
  .catch(e => console.error('<context> email error:', e.message));
```

For a send whose failure needs logging to `email_log` — the `stripe-webhook.js` pattern from Task 4:

```javascript
try {
  await sendEmail(recipient, subject, body);
  await logEmail(c, bookingId, ruleId, label, subject, recipient, 'client');
} catch (e) {
  console.error('<context> email failed:', e.message);
  await logEmail(c, bookingId, ruleId, label, subject, recipient, 'client', 'failed', e.message);
}
```

**`_email.js:139` matters most** — it is inside `fireStatusAutomations`, which runs during booking status changes. An unguarded throw there would break the status update itself, not just the email. Guard it with `try`/`catch` and let the status change proceed.

**`automations.js:291`** runs inside the scheduled automation loop. An unguarded throw stops the whole batch, so one bad address would block every other rule. Guard per-iteration.

- [ ] **Step 3: Verify no unguarded call sites remain**

```bash
grep -rn "await sendEmail(\|await notify(" netlify/functions/*.js
```

Re-read each hit. Every one must sit inside a `try`/`catch` or end with `.catch(`. There are 16.

- [ ] **Step 4: Run the test suite**

```bash
npm test
```

Expected: all 7 PASS. These are unit tests of `_email.js` and do not cover call sites — Step 3's read-through is the real check here, which is why it is explicit.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/
git commit -m "fix: guard every sendEmail call site against throws

sendEmail now throws on failure. fireStatusAutomations and the scheduled
automation loop were the risky ones — an unguarded throw there would have
broken a booking status change or stalled the whole rule batch."
```

- [ ] **Step 6: Confirm EMAIL_ALLOWLIST is live, then deploy**

Ask the owner to confirm `EMAIL_ALLOWLIST` is set in the Netlify dashboard. Only then:

```bash
git push origin main
```

Watch the deploy. Once it is live, trigger one send (change a booking's status in the admin UI) and confirm in the function logs that it reads either `Email sent to:` with a real id, or `Email SUPPRESSED by EMAIL_ALLOWLIST:`. Anything else means the deploy did not take.

---

## Task 6: Fix the deposit copy bug

**Files:**
- Modify: `netlify/functions/create-stripe-link.js:69`

**Background:** the Stripe product description hardcodes "50% deposit", but `booking.js:14` and the `bookings` schema default both use a flat `$100`. A client paying $100 on a $3,500 game show currently receives a receipt calling it a 50% deposit.

- [ ] **Step 1: Read the current line**

```bash
grep -n "50% deposit" netlify/functions/create-stripe-link.js
```

- [ ] **Step 2: Replace it with the actual amount**

Change:

```javascript
      "line_items[0][price_data][product_data][description]": `50% deposit for ${client || ''}'s event. Balance due day-of.`,
```

to:

```javascript
      "line_items[0][price_data][product_data][description]": `Deposit for ${client || ''}'s event. Balance due day-of.`,
```

The amount is already shown by Stripe on the checkout page and in the email body at `create-stripe-link.js:94`, so restating it here adds nothing but a chance to be wrong.

- [ ] **Step 3: Check for the same wording elsewhere**

```bash
grep -rn "50%" netlify/functions/ *.html
```

Fix any other occurrence that describes the deposit as a percentage.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/create-stripe-link.js
git commit -m "fix: deposit description said 50% but the deposit is a flat \$100"
```

---

## Task 7: The `/api/health` endpoint

**Files:**
- Create: `netlify/functions/_health.js`
- Create: `netlify/functions/health.js`
- Create: `test/_health.test.js`
- Modify: `netlify.toml`

**Interfaces:**
- Consumes: `requireAuth`, `unauthorized`, `CORS`, `preflight` from `./_auth`; `withClient` from `./_db`
- Produces: `inspectConfig(env)` in `_health.js`, returning `{ checks: [{name, ok, detail}], ok: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/_health.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { inspectConfig } = require('../netlify/functions/_health.js');

function find(result, name) {
  return result.checks.find(c => c.name === name);
}

test('flags a missing Resend key', () => {
  const r = inspectConfig({});
  assert.strictEqual(find(r, 'resend_key').ok, false);
  assert.strictEqual(r.ok, false);
});

test('flags a missing Stripe webhook secret', () => {
  const r = inspectConfig({ STRIPE_SECRET_KEY: 'sk_live_x' });
  assert.strictEqual(find(r, 'stripe_webhook_secret').ok, false);
});

test('reports Stripe test-mode as a distinct state, not a pass', () => {
  const r = inspectConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' });
  const c = find(r, 'stripe_key');
  assert.strictEqual(c.ok, true, 'a test key is present and valid');
  assert.match(c.detail, /test mode/i, 'but it must say so loudly');
});

test('reports the allowlist as active when set', () => {
  const r = inspectConfig({ EMAIL_ALLOWLIST: 'joe.coover@gmail.com' });
  const c = find(r, 'email_allowlist');
  assert.match(c.detail, /joe\.coover@gmail\.com/);
});

test('all green when everything is configured for production', () => {
  const r = inspectConfig({
    RESEND_API_KEY: 're_x',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    DATABASE_URL: 'postgres://x'
  });
  assert.strictEqual(r.ok, true);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../netlify/functions/_health.js'`.

- [ ] **Step 3: Implement `_health.js`**

```javascript
// _health.js — pure configuration inspection. No I/O, so it is unit testable.
// The point of this module is to answer "what is actually true about this
// deployment" instead of assuming. Every check that has ever silently failed
// in production belongs here.

function inspectConfig(env) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('resend_key', !!env.RESEND_API_KEY,
      env.RESEND_API_KEY ? 'present' : 'MISSING — no email can send');

  const sk = env.STRIPE_SECRET_KEY || '';
  add('stripe_key', !!sk,
      !sk ? 'MISSING — no deposit links can be created'
          : sk.startsWith('sk_test') ? 'present (TEST mode — no real money moves)'
          : 'present (live mode)');

  add('stripe_webhook_secret', !!env.STRIPE_WEBHOOK_SECRET,
      env.STRIPE_WEBHOOK_SECRET ? 'present'
        : 'MISSING — the webhook is fail-closed, so deposits will not confirm');

  add('database_url', !!env.DATABASE_URL,
      env.DATABASE_URL ? 'present' : 'MISSING');

  // Not a failure — an active allowlist is correct during phases 1-3. It is
  // reported so nobody wonders why real clients stopped receiving mail.
  add('email_allowlist', true,
      env.EMAIL_ALLOWLIST
        ? `ACTIVE — only these addresses receive mail: ${env.EMAIL_ALLOWLIST}`
        : 'not set — all recipients receive mail (production behavior)');

  return { checks, ok: checks.every(c => c.ok) };
}

module.exports = { inspectConfig };
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: all 12 PASS (7 email + 5 health).

- [ ] **Step 5: Implement the HTTP handler**

Create `netlify/functions/health.js`:

```javascript
// health.js — GET /api/health (admin only)
// Standing answer to "is it actually working". Otto's nightly briefing reads
// this so a broken webhook surfaces in the briefing, not in an angry client email.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { inspectConfig } = require('./_health');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const config = inspectConfig(process.env);
  const checks = [...config.checks];

  // Live probes — things config alone cannot tell us.
  try {
    await withClient(async (c) => {
      await c.query('SELECT 1');

      const { rows: rules } = await c.query(
        'SELECT id, name FROM automation_rules WHERE active = true ORDER BY id'
      );
      checks.push({
        name: 'active_automation_rules',
        ok: true,
        detail: rules.length
          ? rules.map(r => `#${r.id} ${r.name}`).join('; ')
          : 'none active'
      });

      const { rows: lastOk } = await c.query(
        "SELECT sent_at, recipient_email FROM email_log WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1"
      );
      checks.push({
        name: 'last_successful_email',
        ok: lastOk.length > 0,
        detail: lastOk.length
          ? `${lastOk[0].sent_at.toISOString()} to ${lastOk[0].recipient_email}`
          : 'NEVER — no successful send has ever been recorded'
      });

      const { rows: fails } = await c.query(
        "SELECT COUNT(*)::int AS n FROM email_log WHERE status = 'failed' AND sent_at > NOW() - INTERVAL '7 days'"
      );
      checks.push({
        name: 'failed_emails_7d',
        ok: fails[0].n === 0,
        detail: `${fails[0].n} failed send(s) in the last 7 days`
      });
    });
    checks.push({ name: 'database', ok: true, detail: 'reachable' });
  } catch (e) {
    checks.push({ name: 'database', ok: false, detail: `UNREACHABLE — ${e.message}` });
  }

  const ok = checks.every(c => c.ok);
  return json(ok ? 200 : 503, { ok, checked_at: new Date().toISOString(), checks });
};
```

- [ ] **Step 6: Add the route**

In `netlify.toml`, add alongside the other redirects:

```toml
[[redirects]]
  from = "/api/health"
  to = "/.netlify/functions/health"
  status = 200
```

- [ ] **Step 7: Commit and deploy**

```bash
git add netlify/functions/_health.js netlify/functions/health.js test/_health.test.js netlify.toml
git commit -m "feat: /api/health reports real config and send state

Splits pure config inspection into _health.js so it is unit testable;
the handler adds live DB, automation-rule, and email-outcome probes."
git push origin main
```

- [ ] **Step 8: Call it against production**

Log into the admin UI, grab the bearer token from browser devtools (Application → Local Storage), then:

```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
  https://funkymonkeyadmin.netlify.app/api/health | python3 -m json.tool
```

**Record the output — it is the Phase 1 gate.** Expect surprises here; this is the first time the deployment's real state has been visible. The `last_successful_email` check in particular may read `NEVER`.

---

## Task 8: Move Otto's sweep to the evening

Unrelated to the CRM, folded in because it is one line and the owner reads the "morning" briefing as a nightly report.

**Files:**
- Modify: `~/Library/LaunchAgents/com.bookedsolid.autopilot.sweep.plist`

- [ ] **Step 1: Read the current schedule**

```bash
grep -A 6 "StartCalendarInterval" ~/Library/LaunchAgents/com.bookedsolid.autopilot.sweep.plist
```

Expected: `Hour` = 7, `Minute` = 0.

- [ ] **Step 2: Change the hour to 20:00**

Edit the plist so `Hour` reads `20`. Leave `Minute` at `0`.

- [ ] **Step 3: Reload the job**

```bash
launchctl bootout gui/501/com.bookedsolid.autopilot.sweep
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.bookedsolid.autopilot.sweep.plist
launchctl print gui/501/com.bookedsolid.autopilot.sweep | grep -A 3 "run interval\|calendar"
```

- [ ] **Step 4: Verify it still runs**

```bash
launchctl kickstart -k gui/501/com.bookedsolid.autopilot.sweep
```

Wait, then confirm a briefing was written:

```bash
ls -lt ~/BookingHQ/queue/briefing-*.md | head -3
```

Expected: a file dated today. **Known gotcha:** a rate-limited headless run logs `end sweep (exit 0)` while doing nothing, so an empty briefing means "check the usage window," not "the schedule broke."

---

# Phase 2 — Prove the Money Path

**This is the project's go/no-go gate.** If a live charge does not complete the full chain, Option B stops here having cost four days rather than three weeks.

## Task 9: Verify production configuration

**Files:** none — this is verification, performed against the live deployment.

- [ ] **Step 1: Tag the phase**

```bash
git tag pre-phase-2 && git push --tags
```

- [ ] **Step 2: Run the health check and read every line**

```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
  https://funkymonkeyadmin.netlify.app/api/health | python3 -m json.tool
```

Every check must be `ok: true` except `email_allowlist`, which should read `ACTIVE`. Do not proceed past any failure.

- [ ] **Step 3: Resolve whatever it reports**

Likely findings and their owner-side fixes, all in the Netlify dashboard except the first:

- **`resend_key` present but mail still fails** → the `funkymonkeyevents.com` domain is probably unverified in Resend. Check resend.com → Domains for green SPF/DKIM. This has been the suspected blocker since June and needs no code change once fixed.
- **`stripe_key` says TEST mode** → production is running a test key. Replace with the live key.
- **`stripe_webhook_secret` MISSING** → the webhook is fail-closed and deposits will never confirm. Get the signing secret from the Stripe dashboard's webhook endpoint.

- [ ] **Step 4: Prove email works, end to end, to a real inbox**

With `EMAIL_ALLOWLIST` still set to the owner's address:

```bash
curl -s -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action":"test_email"}' \
  https://funkymonkeyadmin.netlify.app/api/auth
```

Expected: a JSON response containing a `resend_id`, **and** an email that actually arrives. A 200 with no `resend_id` is the exact June symptom of a silently rejected send — if that recurs, the domain is still unverified.

- [ ] **Step 5: Confirm the log now records truth**

Re-run `/api/health`. `last_successful_email` must show a timestamp from the last few minutes rather than `NEVER`.

---

## Task 10: The live end-to-end charge

**Files:** none — this exercises the deployed system.

**Interfaces:**
- Consumes: everything built in Phase 1
- Produces: the go/no-go decision for Phases 3–5

- [ ] **Step 1: Temporarily allow the test recipient**

Set `EMAIL_ALLOWLIST` to include whatever address the test booking will use. If that is the owner's own address, it is already covered.

- [ ] **Step 2: Create a test booking through the real public form**

Open `https://funkymonkeyadmin.netlify.app/booking-form.html` and submit a genuine booking with the owner's own email. Use an obviously fake client name — `ZZTEST Phase2` — so it is unmistakable in the admin list later. Pick an event date well in the future.

Expected: the booking appears in the admin UI with status `review`, and two emails arrive (admin notification + client acknowledgment).

- [ ] **Step 3: Set the deposit to $1 and generate the link**

In the admin UI, open the booking, set `deposit_amount` to `1.00`, and change its status to `confirmed`. `booking.js:154` auto-generates a Stripe link when `deposit_amount > 0`.

Expected: a deposit-link email arrives, and its description reads "Deposit for ZZTEST Phase2's event" — **not** "50% deposit", which verifies Task 6 in production.

- [ ] **Step 4: Pay the $1 with a real card**

Click through and pay. This must be a real card in live mode — a test-mode card proves nothing about the production configuration, which is the entire point of this gate.

- [ ] **Step 5: Verify the webhook fired and the chain completed**

Within a minute:

```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
  "https://funkymonkeyadmin.netlify.app/api/bookings?reference=<REF>&email=<EMAIL>" \
  | python3 -m json.tool | grep -E "status|deposit_paid|balance_due"
```

Expected: `status` is `confirmed`, `deposit_paid` is `true`, `balance_due` reduced by $1. Plus two more emails — client confirmation and admin "Deposit In" — and a `booking_changes` entry reading "Deposit paid via Stripe".

- [ ] **Step 6: Record the result — this is the gate**

Write the outcome into the plan file as a checked line. If any step failed, **stop and report**. Do not start Phase 3. The likely failure points, in order: webhook secret missing (status never flips), Resend domain unverified (charge succeeds, no email), Stripe still in test mode (the link never accepts a real card).

- [ ] **Step 7: Refund the $1 and clean up**

Refund through the Stripe dashboard, or exercise `/api/refund` and get a second endpoint verified for free. Then set the ZZTEST booking's status to `cancelled`. **Do not delete the row** — the `bookings` table is real history and the standing rule is never to bulk-delete from it. A cancelled ZZTEST row is harmless and documents the test.

- [ ] **Step 8: Commit the outcome**

```bash
git add docs/superpowers/plans/2026-07-31-crm-takeover-phase-1-2.md
git commit -m "docs: record Phase 2 live money-path result"
```

---

## Phase 2 Gate

Phases 3–5 get planned **only after** Task 10 passes. Their shape depends on what the live run reveals — particularly whether Stripe and Resend behave in production, which nothing before this point has ever established.

When the gate passes, return to `superpowers:writing-plans` with the spec to plan Phase 3 (`booking_items` + the client accept flow).
