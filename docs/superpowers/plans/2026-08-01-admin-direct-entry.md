# Admin Direct Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner create a booking during a phone call, edit every field of it afterwards, and open an editable client record — all from the admin dashboard.

**Architecture:** Three existing files change and none are created, apart from one test script. `bookings.js` gains an admin-authenticated draft path on its POST. `booking.js` widens its PATCH column allowlist and logs every field change. `admin.html` turns its read-only booking modal into an editable one, reuses that same modal for creation, and rewires the Clients tab onto the `client.js` API that already exists but has never been called.

**Tech Stack:** Netlify Functions (CommonJS, Node), `pg` against Neon Postgres, a single hand-written `admin.html` (no build step, no framework). No test framework — tests are plain Node scripts using `assert`, run with `node`.

**Source spec:** `docs/superpowers/specs/2026-08-01-admin-direct-entry-design.md`

## Global Constraints

- **No new dependencies.** `package.json` has exactly two: `pg` and `pdf-lib`. Keep it that way.
- **No migration scripts.** All schema changes go in the `ADD COLUMN IF NOT EXISTS` array at `netlify/functions/bookings.js:79-122`, following the pattern already there.
- **`status` has no CHECK constraint** (`bookings.js:32`, `VARCHAR(32) DEFAULT 'review'`). New status values need no DDL.
- **The seven statuses are exactly:** `draft`, `review`, `quoted`, `accepted`, `confirmed`, `completed`, `cancelled`.
- **Tests hit the live Neon database.** There is no test database. Every test must delete the rows it creates, in a `finally`, without exception.
- **Never bulk-delete from `bookings`.** It holds ~632 real imported records whose `created_at` is uniformly the 2026-05-07 import date. Tests delete only by the exact `reference` they just created.
- **`EMAIL_ALLOWLIST` must be set** to the owner's address before starting (CRM-takeover Phase 1). Nothing here sends mail, but the fields being made editable feed templates that do.
- **Commit after every task.** The branch is `feat/admin-direct-entry`.

---

### Task 1: `STATUSES` constant and the three new status values

Status strings are currently hardcoded in eight places in `admin.html`. Adding three values means editing all eight, so replace them with one constant first. This task is pure refactor plus three additive values — no behaviour changes for existing bookings.

**Files:**
- Modify: `admin.html:110-114` (CSS pill classes), `admin.html:398-405` (filter `<option>` list), `admin.html:1436` (pill row inside `openBooking`)

**Interfaces:**
- Consumes: nothing.
- Produces: a module-level `const STATUSES` — an array of `{ id, label, bg, border, fg }` objects — and a `statusPillCss()` function returning a CSS string. Tasks 5 and 6 read `STATUSES`.

- [ ] **Step 1: Add the `STATUSES` constant**

Put this immediately after the `EVENT_TYPES` array that ends at `admin.html:886`:

```javascript
// ── Booking statuses ──
// Single source of truth. Referenced by the filter dropdown, the modal pill
// row, the dashboard counters, and the injected pill CSS below.
// draft    — phone-call shell record, may be missing name/email/date/service
// quoted   — quote sent, awaiting the client's yes
// accepted — client said yes, deposit not yet paid
const STATUSES = [
  { id:'draft',     label:'Draft',     bg:'#f5f3ff', border:'#c4b5fd', fg:'#5b21b6' },
  { id:'review',    label:'Review',    bg:'#fef9c3', border:'#fbbf24', fg:'#854d0e' },
  { id:'quoted',    label:'Quoted',    bg:'#ffedd5', border:'#fdba74', fg:'#9a3412' },
  { id:'accepted',  label:'Accepted',  bg:'#fef3c7', border:'#fcd34d', fg:'#92400e' },
  { id:'confirmed', label:'Confirmed', bg:'#d1fae5', border:'#6ee7b7', fg:'#065f46' },
  { id:'completed', label:'Completed', bg:'#f3f4f6', border:'#d1d5db', fg:'#374151' },
  { id:'cancelled', label:'Cancelled', bg:'#fee2e2', border:'#fca5a5', fg:'#991b1b' },
];
```

- [ ] **Step 2: Replace the five hardcoded pill CSS rules**

Delete lines 110-114 of `admin.html` — the five `.status-pill.active-*` rules — and leave `.status-pills`, `.status-pill`, and `.status-pill:hover` (lines 107-109) untouched. Then add this function directly below the `STATUSES` constant:

```javascript
// The .active-<id> rules used to be five hand-written CSS blocks. Generated
// from STATUSES so a new status needs no CSS edit.
function injectStatusCss() {
  const css = STATUSES.map(s =>
    `.status-pill.active-${s.id}{background:${s.bg};border-color:${s.border};color:${s.fg}}`
  ).join('');
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
injectStatusCss();
```

- [ ] **Step 3: Replace the filter dropdown options**

At `admin.html:398`, replace the whole `<select id="filter-status">` element with an empty one:

```html
<select id="filter-status" onchange="renderBookingsTable()" style="min-width:140px">
  <option value="">All Statuses</option>
</select>
```

Then populate it from the constant — add this immediately below `injectStatusCss();`:

```javascript
document.getElementById('filter-status').insertAdjacentHTML('beforeend',
  STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join(''));
```

- [ ] **Step 4: Replace the pill row inside `openBooking`**

At `admin.html:1436-1438`, replace:

```javascript
      ${['review','pending','confirmed','completed','cancelled'].map(s =>
        `<button class="status-pill ${b.status===s?'active-'+s:''}" onclick="setStatus('${b.id}','${s}')">${s}</button>`
      ).join('')}
```

with:

```javascript
      ${STATUSES.map(s =>
        `<button class="status-pill ${b.status===s.id?'active-'+s.id:''}" onclick="setStatus('${b.id}','${s.id}')">${s.label}</button>`
      ).join('')}
```

Note the old code emitted the raw id as the button text and relied on `text-transform:capitalize`; the new code uses `s.label`. That is intentional and the CSS rule is harmless.

- [ ] **Step 5: Verify in the browser**

Run: open `admin.html` against the deployed API (or `netlify dev` if it is configured), log in, and open the Bookings page.
Expected: the status filter lists seven options in the order Draft, Review, Quoted, Accepted, Confirmed, Completed, Cancelled. Open any existing booking — its current status pill is still highlighted in the same colour it was before, and seven pills are shown.

Note: `pending` is deliberately absent from `STATUSES`. Existing rows with `status='pending'` still render (the dashboard counters at `:1075`, `:1243` still reference it and are left alone in this task) but the pill will not highlight. Task 7 addresses the counters.

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "refactor: STATUSES constant, add draft/quoted/accepted"
```

---

### Task 2: Six new columns

**Files:**
- Modify: `netlify/functions/bookings.js:79-122` (the `cols` array inside `ensureTable`)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `surface_type`, `organisation_name`, `occasion`, `deposit_paid_at`, `deposit_method`, `deposit_ref` on the `bookings` table. Tasks 4, 5, and 6 read and write them.

- [ ] **Step 1: Add the six ALTER statements**

In `netlify/functions/bookings.js`, immediately after the `brand` line at `:122` and before the closing `];` at `:123`, add:

```javascript
    // ── Admin direct entry (spec 2026-08-01) ──
    // Surface type drives foam party setup and liability; organisation_name
    // gives corporate and library bookings somewhere to record the org;
    // occasion frees event_type from doing double duty.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS surface_type VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS organisation_name VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS occasion VARCHAR(64) DEFAULT ''",
    // The deposit becomes its own payment record. payment_method/amount/ref
    // stay as the final-balance record — accounting-export.js:57 already
    // treats them that way.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_method VARCHAR(50) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_ref VARCHAR(255) DEFAULT ''",
```

Note the preceding line (`brand`) currently has no trailing comma — add one.

- [ ] **Step 2: Trigger the migration and verify**

`ensureTable` runs on the first request after deploy. Trigger it and check:

```bash
node -e '
const fs=require("fs"),path=require("path");
const envPath=path.join(process.cwd(),".env");
if(!process.env.DATABASE_URL&&fs.existsSync(envPath)){for(const l of fs.readFileSync(envPath,"utf8").split("\n")){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim());if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name = ANY($2)`,
  ["bookings",["surface_type","organisation_name","occasion","deposit_paid_at","deposit_method","deposit_ref"]])
 .then(r=>{console.log(r.rows.map(x=>x.column_name).sort().join(", "));return pool.end();});
'
```

Expected before deploy: an empty line. After the function has run once against production: `deposit_method, deposit_paid_at, deposit_ref, occasion, organisation_name, surface_type`.

If you are running locally with `netlify dev`, hit `GET /api/bookings` once to make `ensureTable` fire, then re-run the check.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/bookings.js
git commit -m "feat: six columns for admin direct entry"
```

---

### Task 3: Draft POST path

`POST /api/bookings` is the public booking form's endpoint and is deliberately unauthenticated. This task adds one authenticated branch through it: an admin posting `status: 'draft'` may omit the four required fields. Everything else — length caps, numeric clamping, NaN rejection — stays in force for drafts too.

**Files:**
- Modify: `netlify/functions/bookings.js:229-364`
- Create: `scripts/test-direct-entry.js`

**Interfaces:**
- Consumes: `requireAuth(event, ['admin'])` and `unauthorized()` from `./_auth` — both are already imported at `bookings.js:3`.
- Produces: `POST /api/bookings` with `{ status: 'draft', ... }` and an admin bearer token returns **201** with `{ success, reference, id, booking }`. The `booking` key is new — the endpoint currently returns only `{ success, reference, id }` (`bookings.js:372`), and the browser needs the full row to push into `allBookings`. Adding a key is additive, so `booking-form.html`, which reads `reference`, is unaffected. Task 6 consumes `data.booking`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-direct-entry.js`:

```javascript
#!/usr/bin/env node
/**
 * Self-checks for admin direct entry (spec 2026-08-01).
 *
 * Runs against the LIVE Neon database — there is no test database. Every
 * booking it creates is deleted in the finally block, by exact reference.
 * Never add a query here that deletes by anything but a reference this
 * script generated.
 *
 * Run: node scripts/test-direct-entry.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// requireAuth accepts AGENT_API_TOKEN as an admin bearer with no session row,
// provided it is at least 32 chars (_auth.js:153-156). Set before requiring
// the handlers so the module reads it.
const TOKEN = 'test-direct-entry-token-0123456789abcdef';
process.env.AGENT_API_TOKEN = TOKEN;

const bookings = require('../netlify/functions/bookings');
const { getPool } = require('../netlify/functions/_db');

const post = (body, token) => bookings.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: JSON.stringify(body),
  queryStringParameters: {},
  path: '/api/bookings',
});

async function main() {
  const created = [];
  try {
    // 1. An admin may save a draft carrying only a name.
    const res = await post({ status: 'draft', client_name: 'Phone Caller' }, TOKEN);
    assert.strictEqual(res.statusCode, 201, `draft POST returned ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    created.push(body.reference);
    const row = body.booking;
    assert.ok(row, 'POST must return the created row under `booking`');
    assert.strictEqual(row.status, 'draft', `expected status draft, got ${row.status}`);
    assert.strictEqual(row.client_name, 'Phone Caller');
    assert.strictEqual(row.event_date, null, 'a draft with no date must store NULL');
    console.log('  ok  admin draft with only a name is accepted');

    // 2. The identical POST without a token is rejected.
    const noAuth = await post({ status: 'draft', client_name: 'Phone Caller' }, null);
    assert.strictEqual(noAuth.statusCode, 401,
      `unauthenticated draft returned ${noAuth.statusCode}, expected 401`);
    console.log('  ok  unauthenticated draft is rejected');

    // 3. The public path still enforces its required fields.
    const publicPost = await post({ client_name: 'Web Visitor' }, null);
    assert.strictEqual(publicPost.statusCode, 400,
      `public POST without email returned ${publicPost.statusCode}, expected 400`);
    console.log('  ok  public POST still requires email/date/service');

    console.log('\nAll direct-entry checks passed.');
  } finally {
    if (created.length) {
      const pool = getPool();
      const c = await pool.connect();
      try {
        for (const ref of created) {
          await c.query('DELETE FROM bookings WHERE reference=$1', [ref]);
          console.log(`  cleaned up ${ref}`);
        }
      } finally { c.release(); }
    }
    process.exit(0);
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/test-direct-entry.js`
Expected: FAIL on the first assertion — `draft POST returned 400: {"error":"client_email is required"}`.

- [ ] **Step 3: Add the draft branch**

In `netlify/functions/bookings.js`, inside the `if (event.httpMethod === 'POST')` block, immediately after the JSON parse (`:235`) and before the `// ── Validation` comment (`:237`), insert:

```javascript
    // ── Admin draft path (spec 2026-08-01) ────────────────────────────────────
    // A booking taken over the phone rarely has an email to hand. An
    // authenticated admin may post status:'draft' and skip the four required
    // fields. Everything below — length caps, numeric clamping, NaN rejection —
    // still applies, so a draft cannot write a malformed row. The relaxation is
    // gated on the token, not on the 'draft' string, so the public form cannot
    // post itself a draft to bypass validation.
    const isDraft = b.status === 'draft';
    if (isDraft) {
      const auth = await requireAuth(event, ['admin']);
      if (!auth) return unauthorized();
    }
```

- [ ] **Step 4: Relax the four checks**

Still in `bookings.js`, change the four validation blocks at `:238-256` to read:

```javascript
    const clientName = String(b.client_name || '').trim();
    if (!isDraft && !clientName) return json(400, { error: 'client_name is required' });
    if (clientName.length > 120) return json(400, { error: 'client_name too long (max 120)' });

    const clientEmail = String(b.client_email || '').trim();
    if (!isDraft && !clientEmail) return json(400, { error: 'client_email is required' });
    if (clientEmail.length > 200) return json(400, { error: 'client_email too long (max 200)' });
    // Plausible email check — applies whenever one is supplied, draft or not
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return json(400, { error: 'client_email is not valid' });
    }

    // A date is required unless this is a draft, but a supplied date must
    // always parse. Empty string becomes NULL — Postgres rejects '' for DATE.
    if (!isDraft && (!b.event_date || isNaN(Date.parse(String(b.event_date))))) {
      return json(400, { error: 'event_date must be a parseable date' });
    }
    if (b.event_date && isNaN(Date.parse(String(b.event_date)))) {
      return json(400, { error: 'event_date must be a parseable date' });
    }
    const eventDate = b.event_date || null;

    if (!isDraft && !b.service_id && !b.service_name) {
      return json(400, { error: 'service_id or service_name is required' });
    }
```

- [ ] **Step 5: Parameterise the status and use the coerced date**

In the INSERT at `:313-334`, change the hardcoded status:

```javascript
          $1, $29,
```

(it currently reads `$1, 'review',`). The column order is unchanged; `$29` simply lands in the `status` position.

In the values array, change `b.event_date,` at `:347` to:

```javascript
        eventDate,
```

and append one final element after `b.brand === 'jcm' ? 'jcm' : 'fme',` at `:363`:

```javascript
        isDraft ? 'draft' : 'review',
```

- [ ] **Step 6: Skip the emails for drafts and return the row**

`bookings.js:368-372` currently emails on every POST and returns only three keys. A draft is a half-record taken while the owner is still on the phone — the client may have no email address at all, and the owner does not need a "new booking" notification about a call they are on. Replace `:367-372`:

```javascript
      // Await both — in a serverless function the container may terminate as soon
      // as the handler returns, dropping any unawaited fetch calls to Resend.
      await sendBookingEmails(booking);
      await notifyMatchingStaff(booking).catch(e => console.error('Staff notify error:', e.message));

      return json(201, { success: true, reference: booking.reference, id: booking.id });
```

with:

```javascript
      // Await both — in a serverless function the container may terminate as soon
      // as the handler returns, dropping any unawaited fetch calls to Resend.
      // Drafts send nothing: the record is half-finished, the client may have no
      // email address yet, and the owner is on the phone with them right now.
      if (!isDraft) {
        await sendBookingEmails(booking);
        await notifyMatchingStaff(booking).catch(e => console.error('Staff notify error:', e.message));
      }

      // `booking` is additive — booking-form.html reads `reference` and is
      // unaffected. The admin UI needs the full row for its local state.
      return json(201, { success: true, reference: booking.reference, id: booking.id, booking });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node scripts/test-direct-entry.js`
Expected: three `ok` lines, then `All direct-entry checks passed.`, then one `cleaned up FM-XXXXXXXX` line.

- [ ] **Step 8: Confirm the cleanup actually ran**

Run:

```bash
node -e '
const fs=require("fs"),path=require("path");
const envPath=path.join(process.cwd(),".env");
if(!process.env.DATABASE_URL&&fs.existsSync(envPath)){for(const l of fs.readFileSync(envPath,"utf8").split("\n")){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim());if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
pool.query("SELECT COUNT(*)::int n FROM bookings WHERE client_name IN ($1,$2)",["Phone Caller","Web Visitor"])
 .then(r=>{console.log("leftover test rows:",r.rows[0].n);return pool.end();});
'
```

Expected: `leftover test rows: 0`. If it is not 0, stop and delete them by reference before continuing.

- [ ] **Step 9: Commit**

```bash
git add netlify/functions/bookings.js scripts/test-direct-entry.js
git commit -m "feat: admin draft path on POST /api/bookings"
```

---

### Task 4: Widen the PATCH allowlist and log every change

**Files:**
- Modify: `netlify/functions/booking.js:87-198`
- Modify: `scripts/test-direct-entry.js`

**Interfaces:**
- Consumes: `logChange(client, bookingId, action, detail)` from `./_email` — already imported at `booking.js:3`. It writes to `booking_changes(booking_id, action, detail)`. Do **not** use `booking-changelog.js`'s `logChange`, which has a different six-argument signature and writes different columns of the same table.
- Produces: `PATCH /api/booking/:id` accepting every field listed in Step 3, each writing a `booking_changes` row. Task 5 calls this from the browser.

- [ ] **Step 1: Write the failing test**

In `scripts/test-direct-entry.js`, add this require beside the existing one:

```javascript
const booking = require('../netlify/functions/booking');
```

and this helper beside `post`:

```javascript
const patch = (id, body) => booking.handler({
  httpMethod: 'PATCH',
  headers: { authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify(body),
  queryStringParameters: { id: String(id) },
  path: '/api/booking/' + id,
});
```

Then insert this check inside `main()`, after check 3 and before the final `console.log`:

```javascript
    // 4. Editing a previously un-editable field works and is logged.
    const target = row; // the draft created in check 1
    const patched = await patch(target.id, {
      event_date: '2026-12-25',
      client_phone: '405-555-0100',
      surface_type: 'grass',
    });
    assert.strictEqual(patched.statusCode, 200, `PATCH returned ${patched.statusCode}: ${patched.body}`);
    const after = JSON.parse(patched.body);
    assert.strictEqual(after.client_phone, '405-555-0100');
    assert.strictEqual(after.surface_type, 'grass');
    assert.ok(after.event_date, 'event_date should now be set');

    const pool0 = getPool();
    const c0 = await pool0.connect();
    let logged;
    try {
      const { rows } = await c0.query(
        'SELECT action FROM booking_changes WHERE booking_id=$1', [target.id]
      );
      logged = rows.map(r => r.action);
    } finally { c0.release(); }
    assert.ok(logged.some(a => a.includes('event_date')),
      `expected an event_date change log, got: ${JSON.stringify(logged)}`);
    console.log('  ok  event_date is editable and logged');
```

The cleanup block already deletes the booking by reference. Add a matching delete for its change rows — inside the `finally`, before the bookings delete:

```javascript
          await c.query(
            'DELETE FROM booking_changes WHERE booking_id IN (SELECT id FROM bookings WHERE reference=$1)',
            [ref]
          );
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/test-direct-entry.js`
Expected: FAIL on check 4 — `PATCH returned 400: {"error":"No fields to update"}`, because none of `event_date`, `client_phone`, or `surface_type` is in the allowlist yet.

- [ ] **Step 3: Extend `colMap`**

In `netlify/functions/booking.js`, add these entries to the `colMap` object at `:90-114`, after the `venue` line:

```javascript
          // ── Admin direct entry (spec 2026-08-01) ──
          event_date:        "event_date",
          event_time:        "event_time",
          event_location:    "event_location",
          event_zip:         "event_zip",
          event_type:        "event_type",
          guest_count:       "guest_count",
          client_name:       "client_name",
          client_phone:      "client_phone",
          client_email:      "client_email",
          referral_source:   "referral_source",
          service_id:        "service_id",
          service_name:      "service_name",
          service_price:     "service_price",
          total_price:       "total_price",
          mileage_miles:     "mileage_miles",
          mileage_cost:      "mileage_cost",
          surface_type:      "surface_type",
          organisation_name: "organisation_name",
          occasion:          "occasion",
          deposit_paid_at:   "deposit_paid_at",
          deposit_method:    "deposit_method",
          deposit_ref:       "deposit_ref",
```

- [ ] **Step 4: Coerce empty strings for the date and numeric columns**

Postgres rejects `''` for DATE, TIMESTAMPTZ, INTEGER, and NUMERIC. The browser sends `''` for a cleared input. Add this immediately after the `const u = JSON.parse(...)` line at `:88`:

```javascript
        // A cleared <input> posts '' — Postgres rejects that for non-text
        // columns. Only touch keys actually present, so no null is invented.
        for (const f of ['event_date', 'confirmation_deadline', 'deposit_paid_at']) {
          if (f in u && u[f] === '') u[f] = null;
        }
        for (const f of ['guest_count', 'service_price', 'total_price',
                         'mileage_miles', 'mileage_cost', 'deposit_amount',
                         'balance_due', 'extra_hours', 'extra_hours_cost',
                         'payment_amount']) {
          if (f in u && u[f] === '') u[f] = null;
        }
```

- [ ] **Step 5: Fetch the whole previous row instead of only the status**

Replace the status-only fetch at `:117-121`:

```javascript
        // Fetch old status for change log (only when a status change is incoming)
        let prevStatus = null;
        if (u.status) {
          const prev = await c.query('SELECT status FROM bookings WHERE id=$1', [parseInt(id)]);
          prevStatus = prev.rows[0]?.status || '?';
        }
```

with a fetch of the full row, which the field-level logging in Step 6 needs:

```javascript
        // The whole previous row — field-level change logging below diffs
        // against it. One extra SELECT per PATCH, which is negligible next to
        // the traceability the spec asks for.
        const prevRes = await c.query('SELECT * FROM bookings WHERE id=$1', [parseInt(id)]);
        if (!prevRes.rows.length) return json(404, { error: "Not found" });
        const prev = prevRes.rows[0];
        const prevStatus = prev.status || '?';
```

- [ ] **Step 6: Log every changed field**

In `booking.js`, after the `admin_notes` log block at `:196-198` and before `return json(200, updated);` at `:200`, add:

```javascript
        // Field-level logging for everything the allowlist now accepts.
        // These six already have bespoke log lines above — skip them so a
        // single edit does not produce two rows.
        const LOGGED_ELSEWHERE = new Set([
          'status', 'admin_notes', 'contract_signed',
          'payment_method', 'payment_amount', 'payment_ref',
        ]);
        for (const [k, col] of Object.entries(colMap)) {
          if (u[k] === undefined || LOGGED_ELSEWHERE.has(col)) continue;
          const before = prev[col], after = updated[col];
          const bs = before === null || before === undefined ? '' : String(before);
          const as = after  === null || after  === undefined ? '' : String(after);
          if (bs !== as) {
            await logChange(c, parseInt(id), `${col} changed`, `${bs || '—'} → ${as || '—'}`);
          }
        }
```

Because `colMap` maps several aliases onto one column (`paymentMethod` and `payment_method`, `contractSigned` and `contract_signed`), the `LOGGED_ELSEWHERE` check is against the column name rather than the key, which covers both spellings.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node scripts/test-direct-entry.js`
Expected: four `ok` lines, `All direct-entry checks passed.`, and the cleanup lines.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/booking.js scripts/test-direct-entry.js
git commit -m "feat: PATCH every booking field, log each change"
```

---

### Task 5: Editable booking modal

**Files:**
- Modify: `admin.html:1418-1520` (`openBooking`), and add `saveBookingEdits` beside `saveAdminNotes` at `:2198`

**Interfaces:**
- Consumes: `patch(id, payload)` at `admin.html:2398`, `STATUSES` from Task 1, the widened allowlist from Task 4.
- Produces: `bookingField(label, name, value, type, opts)` returning an HTML string, and `async saveBookingEdits(id)`. Task 6 calls both.

- [ ] **Step 1: Add the field helper**

Insert directly above `function openBooking(id)` at `admin.html:1418`:

```javascript
// Renders one editable cell in the booking detail grid. `name` must be a key
// the PATCH allowlist accepts (booking.js colMap) — anything else is silently
// dropped by the API.
function bookingField(label, name, value, type = 'text', opts = null) {
  const v = value === null || value === undefined ? '' : String(value);
  const input = opts
    ? `<select class="bk-edit" data-f="${name}">
         <option value=""></option>
         ${opts.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
       </select>`
    : `<input class="bk-edit" data-f="${name}" type="${type}" value="${esc(v)}">`;
  return `<div class="detail-field"><label>${label}</label>${input}</div>`;
}
```

Add the matching CSS beside `.detail-field` (search `admin.html` for `.detail-field{` and add below it):

```css
.bk-edit{width:100%;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px;font-size:.875rem;font-family:inherit;background:#fff}
.bk-edit:focus{outline:none;border-color:#a855f7}
```

- [ ] **Step 2: Replace the read-only detail grid**

In `openBooking`, replace the whole `<div class="detail-grid">…</div>` block at `:1442-1455` with:

```javascript
    <div class="detail-grid">
      ${bookingField('Client', 'client_name', b.client_name)}
      ${bookingField('Organisation', 'organisation_name', b.organisation_name)}
      ${bookingField('Phone', 'client_phone', b.client_phone, 'tel')}
      ${bookingField('Email', 'client_email', b.client_email, 'email')}
      ${bookingField('Referral', 'referral_source', b.referral_source)}
      ${bookingField('Customer Type', 'customer_type', b.customer_type)}
      ${bookingField('Event Date', 'event_date', (b.event_date || '').slice(0, 10), 'date')}
      ${bookingField('Event Time', 'event_time', b.event_time, 'time')}
      ${bookingField('Occasion', 'occasion', b.occasion, 'text',
        ['Birthday','Fun day / Carnival','Wedding','Corporate','Community','School','Library','Other'])}
      ${bookingField('Event Type', 'event_type', b.event_type)}
      ${bookingField('Guests', 'guest_count', b.guest_count, 'number')}
      ${bookingField('ZIP', 'event_zip', b.event_zip)}
      ${bookingField('Location', 'event_location', b.event_location)}
      ${bookingField('Venue', 'venue', b.venue)}
      ${bookingField('Surface', 'surface_type', b.surface_type, 'text',
        ['Grass','Concrete','Asphalt','Indoor — hard floor','Indoor — carpet','Turf','Other'])}
      ${bookingField('🎂 Birthday Person', 'child_name', b.child_name)}
      ${bookingField('⭐ Guests of Honour', 'guests_of_honour', b.guests_of_honour)}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin:-8px 0 18px">
      <button class="btn btn-primary btn-sm" onclick="saveBookingEdits('${b.id}')">Save Details</button>
      <span class="text-muted" id="bk-flash-${b.id}" style="font-size:.8rem"></span>
    </div>
```

`b.event_date` arrives from Postgres as an ISO timestamp; `<input type="date">` needs `YYYY-MM-DD`, which is why it is sliced.

- [ ] **Step 3: Make the pricing fields editable too**

In the same function, replace the first `<div class="q-row">` of the quote block at `:1462`:

```javascript
      <div class="q-row"><span>${esc(b.service_name||'Service')}</span><span>${Number(b.service_price||0)>0?'$'+Number(b.service_price).toFixed(2):'Custom quote'}</span></div>
```

with editable fields for the service and both money columns:

```javascript
      <div class="q-row">
        <input class="bk-edit" data-f="service_name" value="${esc(b.service_name || '')}" placeholder="Service" style="max-width:60%">
        <input class="bk-edit" data-f="service_price" type="number" step="0.01" value="${b.service_price ?? ''}" style="max-width:110px">
      </div>
```

and replace the Total row at `:1464`:

```javascript
      <div class="q-row"><span>Total</span><span>${Number(b.total_price||0)>0?'$'+Number(b.total_price).toFixed(2):'Custom'}</span></div>
```

with:

```javascript
      <div class="q-row">
        <span>Total</span>
        <input class="bk-edit" data-f="total_price" type="number" step="0.01" value="${b.total_price ?? ''}" style="max-width:110px">
      </div>
```

- [ ] **Step 4: Add the deposit record fields**

Immediately after the `deposit-row` div at `:1465`, add:

```javascript
      <div class="q-row sub">
        <span>Deposit received</span>
        <input class="bk-edit" data-f="deposit_paid_at" type="date"
               value="${(b.deposit_paid_at || '').slice(0, 10)}" style="max-width:150px">
      </div>
      <div class="q-row sub">
        <span>Deposit method / ref</span>
        <span style="display:flex;gap:6px">
          <input class="bk-edit" data-f="deposit_method" value="${esc(b.deposit_method || '')}" placeholder="Stripe / cash / Venmo" style="max-width:150px">
          <input class="bk-edit" data-f="deposit_ref" value="${esc(b.deposit_ref || '')}" placeholder="ref" style="max-width:110px">
        </span>
      </div>
```

- [ ] **Step 5: Write the save function**

Add beside `saveAdminNotes` at `admin.html:2198`:

```javascript
// ── Booking detail — collect every [data-f] input and PATCH in one call ──
async function saveBookingEdits(id) {
  const payload = {};
  document.querySelectorAll('#modal-body .bk-edit').forEach(el => {
    payload[el.dataset.f] = el.value;
  });
  try {
    const updated = await patch(id, payload);
    // Keep local state in sync so re-opening the modal shows the new values
    const i = allBookings.findIndex(x => String(x.id) === String(id));
    if (i > -1) allBookings[i] = updated;
    flash('bk-flash-' + id);
    renderBookingsTable();
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}
```

- [ ] **Step 6: Verify in the browser**

Run: open the admin dashboard, open any booking, change the phone number and the surface type, click Save Details.
Expected: the flash indicator fires, the bookings table behind the modal reflects any changed name or date, and re-opening the booking shows the new values. Then check the log:

```bash
node -e '
const fs=require("fs"),path=require("path");
const envPath=path.join(process.cwd(),".env");
if(!process.env.DATABASE_URL&&fs.existsSync(envPath)){for(const l of fs.readFileSync(envPath,"utf8").split("\n")){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim());if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
pool.query("SELECT action,detail,created_at FROM booking_changes ORDER BY created_at DESC LIMIT 5")
 .then(r=>{console.table(r.rows);return pool.end();});
'
```

Expected: rows reading `client_phone changed` and `surface_type changed` with sensible before → after details.

- [ ] **Step 7: Commit**

```bash
git add admin.html
git commit -m "feat: editable booking detail modal"
```

---

### Task 6: `+ Booking` button

The add form is the edit modal opened against an empty record. `openBooking` gains a null-id path; nothing else changes.

**Files:**
- Modify: `admin.html:1418` (`openBooking` signature), `admin.html:2198` area (`saveBookingEdits`), `admin.html:392` (toolbar)

**Interfaces:**
- Consumes: `bookingField`, `saveBookingEdits`, `STATUSES`, and the draft POST from Task 3.
- Produces: `openBooking(null)` opens an empty modal; saving it POSTs a draft and reloads the table.

- [ ] **Step 1: Let `openBooking` accept null**

Replace the first three lines of `openBooking` at `:1418-1422`:

```javascript
function openBooking(id) {
  const b = allBookings.find(x => String(x.id) === String(id));
  if (!b) return;

  document.getElementById('modal-title').textContent = `${b.reference||'Booking'} — ${b.client_name}`;
```

with:

```javascript
// id === null opens an empty modal for a new booking taken over the phone.
// Saving it POSTs a draft; every other path is identical to editing.
function openBooking(id) {
  const isNew = id === null || id === undefined;
  const b = isNew
    ? { id: 'new', status: 'draft', addons: [] }
    : allBookings.find(x => String(x.id) === String(id));
  if (!b) return;

  document.getElementById('modal-title').textContent = isNew
    ? 'New Booking'
    : `${b.reference||'Booking'} — ${b.client_name}`;
```

The rest of the function already tolerates undefined fields — every interpolation uses `|| ''`, `??`, or a conditional.

- [ ] **Step 2: Hide the sections that need a saved row**

A new booking has no Stripe link, invoice, COI, or change log to show. In `openBooking`, wrap the Stripe block (`:1469-1477`), the invoice block (`:1479-1485`), and the COI block (`:1487-1493`) so they render only for saved bookings. Change each opening line from `<!-- Stripe link -->` style markup to a conditional — for example the Stripe block becomes:

```javascript
    ${isNew ? '' : `
    <!-- Stripe link -->
    <div class="stripe-block">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:.875rem">💳 Stripe Deposit Link</strong>
        <button class="btn btn-primary btn-sm" onclick="sendStripeLink('${b.id}')">Send to Client</button>
      </div>
      ${b.stripe_payment_link?`<div class="stripe-result">Last link: <a href="${b.stripe_payment_link}" target="_blank" style="color:#7c3aed">Open →</a></div>`:''}
      <div class="stripe-result" id="stripe-msg-${b.id}"></div>
    </div>`}
```

Apply the same `${isNew ? '' : \`…\`}` wrapper to the invoice and COI blocks, leaving their contents byte-identical.

Also make the status pill row read-only for a new booking — `setStatus` PATCHes an id that does not exist yet. Change the pill row from Task 1 Step 4 to:

```javascript
      ${STATUSES.map(s =>
        `<button class="status-pill ${b.status===s.id?'active-'+s.id:''}" ${isNew ? 'disabled' : `onclick="setStatus('${b.id}','${s.id}')"`}>${s.label}</button>`
      ).join('')}
```

- [ ] **Step 3: Teach `saveBookingEdits` to create**

Replace the `saveBookingEdits` written in Task 5 with:

```javascript
// ── Booking detail — collect every [data-f] input and save in one call ──
// id === 'new' creates a draft; anything else patches.
async function saveBookingEdits(id) {
  const payload = {};
  document.querySelectorAll('#modal-body .bk-edit').forEach(el => {
    payload[el.dataset.f] = el.value;
  });
  try {
    if (id === 'new') {
      payload.status = 'draft';
      const res = await apiFetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Request failed');
      }
      const data = await res.json();
      allBookings.unshift(data.booking);
      closeModal();
      renderBookingsTable();
      openBooking(data.booking.id);
      return;
    }
    const updated = await patch(id, payload);
    const i = allBookings.findIndex(x => String(x.id) === String(id));
    if (i > -1) allBookings[i] = updated;
    flash('bk-flash-' + id);
    renderBookingsTable();
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}
```

Reopening the saved booking is deliberate: it swaps the empty shell for the real record, so the Stripe, invoice, and COI blocks appear and the status pills become live.

`closeModal()` is the existing helper at `admin.html:1627`; it removes the `open` class from `#booking-modal`. No new function is needed.

- [ ] **Step 4: Guard the post-render hooks**

`openBooking` ends (`admin.html:1611-1623`) by opening the modal and then loading the activity feed and task checklist for `b.id`. For a new booking that id is the string `'new'`, so those two fetches would 404. Wrap them:

```javascript
  document.getElementById('booking-modal').classList.add('open');

  if (!isNew) {
```

— placing the existing `loadBookingActivity` and `loadBookingTasks` blocks inside that `if`, and closing it before the function's final `}`. Leave the `classList.add('open')` call outside the guard: a new booking still has to show its modal.

- [ ] **Step 5: Add the button**

At `admin.html:392`, inside the filter card's first row and before the search input, add:

```html
            <button class="btn btn-primary" onclick="openBooking(null)" style="white-space:nowrap">+ Booking</button>
```

- [ ] **Step 6: Verify the phone workflow end to end**

Run: open the dashboard, click `+ Booking`, type only a name, click Save Details.
Expected: the modal reopens titled with a new `FM-` reference, the status pills are live with Draft highlighted, and the booking appears in the table with status `draft`. Filter the table to Draft and confirm it is there.

Then delete the test row:

```bash
node -e '
const fs=require("fs"),path=require("path");
const envPath=path.join(process.cwd(),".env");
if(!process.env.DATABASE_URL&&fs.existsSync(envPath)){for(const l of fs.readFileSync(envPath,"utf8").split("\n")){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim());if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const REF=process.argv[1];
pool.query("DELETE FROM bookings WHERE reference=$1",[REF]).then(r=>{console.log("deleted",r.rowCount);return pool.end();});
' FM-XXXXXXXX
```

Substitute the reference the modal showed. Delete by reference only.

- [ ] **Step 7: Commit**

```bash
git add admin.html
git commit -m "feat: + Booking button for phone intake"
```

---

### Task 7: Editable client sheet

`client.js` serves `clients` and `client_interactions` over GET/PATCH/POST/DELETE and has never been called from the UI. `renderClients` ignores it and aggregates `allBookings` in JavaScript instead. This task verifies the API against the live database, then rewires the tab onto it.

**Files:**
- Modify: `admin.html:494-503` (Clients page markup), `admin.html:2464-2485` (`renderClients`), and the dashboard counters at `:1075`, `:1078`, `:1243`
- Modify: `scripts/test-direct-entry.js`

**Interfaces:**
- Consumes: `GET /api/client?email=<addr>` returning `{ ...clientRow, name, bookings: [], interactions: [] }`, and `PATCH /api/client?email=<addr>` accepting `notes`, `tags`, `birthday`, `follow_up_date`, `name`, `preferred_profile`, `annual_event_month`, `annual_event_note` (`client.js:150`).
- Produces: `openClient(email)` and `saveClient(email)`.

- [ ] **Step 1: Verify `client.js` against the live database first**

The spec flags this as an assumption — the table has never been exercised through the UI. Prove it before building on it. Add to `scripts/test-direct-entry.js`, inside `main()` after check 4:

```javascript
    // 5. client.js round-trips against the live clients table.
    const clientFn = require('../netlify/functions/client');
    const TEST_EMAIL = 'direct-entry-selfcheck@example.invalid';
    const callClient = (method, body) => clientFn.handler({
      httpMethod: method,
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      queryStringParameters: { email: TEST_EMAIL },
      body: body ? JSON.stringify(body) : null,
      path: '/api/client',
    });

    const gotClient = await callClient('GET');
    assert.strictEqual(gotClient.statusCode, 200, `client GET returned ${gotClient.statusCode}: ${gotClient.body}`);
    const cRec = JSON.parse(gotClient.body);
    assert.ok(Array.isArray(cRec.bookings), 'client GET must return a bookings array');
    assert.ok(Array.isArray(cRec.interactions), 'client GET must return an interactions array');

    const patchedClient = await callClient('PATCH', { notes: 'selfcheck note', tags: 'vip' });
    assert.strictEqual(patchedClient.statusCode, 200, `client PATCH returned ${patchedClient.statusCode}: ${patchedClient.body}`);
    assert.strictEqual(JSON.parse(patchedClient.body).notes, 'selfcheck note');
    console.log('  ok  client.js GET and PATCH round-trip');
```

And in the `finally` block, before the bookings cleanup, add:

```javascript
      const p2 = getPool();
      const c2 = await p2.connect();
      try {
        await c2.query('DELETE FROM clients WHERE email=$1', ['direct-entry-selfcheck@example.invalid']);
      } finally { c2.release(); }
```

Note `client.js` GET upserts the email it is given, which is why the cleanup is unconditional.

- [ ] **Step 2: Run the verification**

Run: `node scripts/test-direct-entry.js`
Expected: five `ok` lines. If check 5 fails, stop — the spec's assumption is wrong and `client.js` needs fixing before the UI is wired to it. Report the exact failure rather than working around it.

- [ ] **Step 3: Commit the verification separately**

```bash
git add scripts/test-direct-entry.js
git commit -m "test: verify client.js round-trips before wiring the UI"
```

- [ ] **Step 4: Add the search box and organisation column**

Replace the Clients page markup at `admin.html:494-503`:

```html
    <!-- ══ CLIENTS ══ -->
    <div class="page" id="page-clients">
      <div class="page-hdr"><h1>Clients</h1></div>
      <div class="card">
        <div class="card-body" style="padding:16px">
          <input type="text" id="client-search" placeholder="🔍 Search name, email, phone, organisation..."
                 oninput="renderClients()" style="width:100%;max-width:360px">
        </div>
        <table>
          <thead><tr><th>Name</th><th>Organisation</th><th>Email</th><th>Phone</th><th>Bookings</th><th>Total Spent</th><th>Last Event</th></tr></thead>
          <tbody id="clients-tbody"></tbody>
        </table>
      </div>
    </div>
```

- [ ] **Step 5: Make rows searchable and clickable**

Replace `renderClients` at `admin.html:2464-2485`:

```javascript
function renderClients() {
  const q = (document.getElementById('client-search')?.value || '').toLowerCase().trim();
  const map = {};
  allBookings.forEach(b => {
    const k = b.client_email || b.client_name;
    if (!k) return;
    if (!map[k]) map[k] = {
      name: b.client_name, email: b.client_email, phone: b.client_phone,
      org: b.organisation_name || '', count: 0, total: 0, last: null,
    };
    map[k].count++;
    map[k].total += Number(b.total_price || 0);
    if (b.organisation_name && !map[k].org) map[k].org = b.organisation_name;
    if (!map[k].last || b.event_date > map[k].last) map[k].last = b.event_date;
  });
  const clients = Object.values(map)
    .filter(c => !q || [c.name, c.email, c.phone, c.org]
      .some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => b.total - a.total);

  document.getElementById('clients-tbody').innerHTML = clients.length
    ? clients.map(c => `
      <tr ${c.email ? `onclick="openClient('${esc(c.email)}')" style="cursor:pointer"` : ''}>
        <td style="font-weight:600">${esc(c.name)}</td>
        <td>${esc(c.org || '—')}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${c.count}</td>
        <td>$${c.total.toFixed(0)}</td>
        <td>${fmtDate(c.last)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="table-empty">${q ? 'No matches' : 'No clients yet'}</td></tr>`;
}
```

The bookings aggregation stays — it is what produces the count, total, and last-event columns, and `client.js` does not compute them. The API supplies the editable fields, which the modal fetches on open.

- [ ] **Step 6: Add the client modal**

Add below `renderClients`:

```javascript
// ── Client sheet — the clients table and client.js have existed since the
// beginning; this is the first thing that calls them. ──
async function openClient(email) {
  document.getElementById('modal-title').textContent = email;
  document.getElementById('modal-body').innerHTML = '<div class="text-muted">Loading…</div>';
  document.getElementById('booking-modal').classList.add('open');

  const res = await apiFetch('/api/client?email=' + encodeURIComponent(email));
  if (!res.ok) {
    document.getElementById('modal-body').innerHTML = '<div class="text-muted">Could not load this client.</div>';
    return;
  }
  const c = await res.json();
  const e = encodeURIComponent(email);

  document.getElementById('modal-body').innerHTML = `
    <div class="detail-grid">
      ${bookingField('Name', 'name', c.name)}
      ${bookingField('Birthday', 'birthday', (c.birthday || '').slice(0, 10), 'date')}
      ${bookingField('Follow up on', 'follow_up_date', (c.follow_up_date || '').slice(0, 10), 'date')}
      ${bookingField('Tags', 'tags', c.tags)}
      ${bookingField('Annual event month', 'annual_event_month', c.annual_event_month, 'number')}
      ${bookingField('Annual event note', 'annual_event_note', c.annual_event_note)}
    </div>
    <div class="notes-block">
      <span class="section-label">Notes</span>
      <textarea class="bk-edit" data-f="notes" rows="4">${esc(c.notes || '')}</textarea>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin:12px 0 18px">
      <button class="btn btn-primary btn-sm" onclick="saveClient('${e}')">Save Client</button>
      <span class="text-muted" id="cl-flash" style="font-size:.8rem"></span>
    </div>
    <div style="margin-bottom:18px">
      <span class="section-label">Bookings (${c.bookings.length})</span>
      ${c.bookings.map(b => `<div class="q-row"><span>${esc(b.reference || '')} — ${esc(b.service_name || '')}</span><span>${fmtDate(b.event_date)}</span></div>`).join('') || '<div class="text-muted">None</div>'}
    </div>
    <div>
      <span class="section-label">Interactions (${c.interactions.length})</span>
      ${c.interactions.map(i => `<div class="q-row sub"><span>${esc(i.note || '')}</span><span>${fmtDate(i.created_at)}</span></div>`).join('') || '<div class="text-muted">None logged</div>'}
    </div>`;
}

async function saveClient(encodedEmail) {
  const payload = {};
  document.querySelectorAll('#modal-body .bk-edit').forEach(el => {
    payload[el.dataset.f] = el.value;
  });
  const res = await apiFetch('/api/client?email=' + encodedEmail, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) flash('cl-flash');
  else alert('Failed to save client');
}
```

`#booking-modal` and its `open` class are the same mechanism `openBooking` uses at `admin.html:1609`; the client sheet reuses the one modal shell rather than adding a second.

- [ ] **Step 7: Keep drafts out of the daily counters**

Drafts are half-records and must not inflate the work queues. At `admin.html:1243`, change:

```javascript
    .filter(b => ['review','pending'].includes(b.status))
```

to:

```javascript
    .filter(b => ['review','pending','quoted','accepted'].includes(b.status))
```

Leave `:1075` (`status === 'review'`) and `:1078` (`status === 'pending'` without a Stripe link) alone — both are already narrow enough that drafts cannot reach them.

- [ ] **Step 8: Verify in the browser**

Run: open the Clients tab, type part of a client's name in the search box, click their row.
Expected: the modal loads their record, lists their bookings and interactions, and typing a note then clicking Save Client flashes success. Reopening the row shows the saved note.

- [ ] **Step 9: Run the full test script one final time**

Run: `node scripts/test-direct-entry.js`
Expected: five `ok` lines, `All direct-entry checks passed.`, and every cleanup line.

- [ ] **Step 10: Commit**

```bash
git add admin.html
git commit -m "feat: editable client sheet wired to client.js"
```

---

## Done means

- `+ Booking` saves a record with only a name typed in.
- Every field in the booking modal is editable and each edit writes a `booking_changes` row.
- The Clients tab searches, opens, and saves notes, tags, birthday, and follow-up date.
- `node scripts/test-direct-entry.js` passes and leaves nothing behind.
- No new dependencies, no migration scripts, one new file (`scripts/test-direct-entry.js`).

## Deliberately not here

`booking_items` and multi-service quotes stay in CRM-takeover Phase 3, along with PPM's `Booking pathway → Chosen package` cascade. PPM's "Status-Related Validation Issues" checker is not built. `admin.html` is not split.
