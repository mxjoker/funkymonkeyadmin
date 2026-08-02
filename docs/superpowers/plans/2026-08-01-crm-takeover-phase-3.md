# CRM Takeover Phase 3 — `booking_items` + Client-Facing Quote Accept

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a multi-service package ("Foam Party + Face Painting + Cotton Candy") expressible as real line items on a booking, and let a client accept a quote from `my-booking.html` without Joe touching anything.

**Architecture:** A `booking_items` child table becomes the source of truth for what a booking is selling. The legacy `service_id` / `service_name` / `service_price` / `addons` / `addon_total` / `mileage_cost` columns stay populated — recomputed from the items on every write by one pure function — so invoices, the accounting export, Stripe, and the PPM sync keep working untouched through the deprecation window. Reads fall back to the legacy columns when a booking has no items, so the backfill is not a hard cutover. The accept flow reuses the `reference` + `client_email` authentication that `bookings.js` and `coi-request.js` already implement.

**Tech Stack:** Node 20 CommonJS Netlify Functions, `pg` against Neon Postgres, `node --test` (no framework), vanilla-JS single-file front ends, `pdf-lib` for invoices.

## Global Constraints

Copied verbatim from the spec and from project memory. Every task's requirements implicitly include this section.

- **Legacy columns stay populated.** From `2026-07-31-crm-takeover-design.md`: "Phase 3's migration keeps the legacy `service_*` columns populated throughout the deprecation window, so the new table can be abandoned without data loss." Never stop writing them in this phase.
- **`total_price` excludes travel.** The existing balance formula is `balance_due = max(0, total_price + mileage_cost - deposit_amount)` (`bookings.js:329`, `booking.js:196-197`). A rollup that folds travel into `total_price` double-counts it into every balance and every invoice. This is the single highest-risk arithmetic in the phase.
- **`IS NOT NULL` is a dead test on any text column in this schema** — every text column is `DEFAULT ''`. Use `COALESCE(col,'') <> ''`. From [[silent-failure-bug-class]] instance 6.
- **Never let a failure path report success.** Any check that cannot fail is a bug, not a safeguard. From [[silent-failure-bug-class]].
- **No direct `api.resend.com` calls.** Use `sendEmail` from `_email.js`. `test/_email.test.js:114` is a repo-wide source scan that fails the build otherwise.
- **No `linear-gradient` in email chrome or buttons.** Gmail strips it. `test/_email.test.js:383` is a repo-wide source scan.
- **Never bulk-delete booking rows.** 666 rows are real imported customer records. `created_at` is uniformly the 2026-05-07 import date, so judge urgency by `event_date`.
- **The seven statuses are `draft, review, quoted, accepted, confirmed, completed, cancelled`.** `pending` is retired but survives in nine live rows until `scripts/migrate-pending-to-accepted.js` runs.
- **`git push` does not deploy.** Every deploy needs a manual Trigger deploy at `https://app.netlify.com/projects/funkymonkeyadmin/deploys`. Joe conserves deploy credits — this whole phase ships in **one** publish. From [[deploys-do-not-happen-on-push]].
- **Netlify env vars must be written in the dashboard**, never via the MCP connector, whose writes report success without persisting. From [[netlify-connector-env-writes-unreliable]].
- **`npx netlify dev` runs against the LIVE Neon production database.** There is no local database. Anything a browser gate creates or edits is a real row in the production CRM alongside 666 real customer bookings. Every browser gate in this plan therefore uses **one designated test booking — `FM-E5EFPPQX`, id 717, client name `ZZ TEST — DO NOT BOOK (Phase 3 gate)`** — and never a real customer's record. Do not create additional test bookings; reuse that one. Do not delete any other row for any reason.
- **`EMAIL_ALLOWLIST` is NOT active. Every email this phase sends is REAL.** Corrected 2026-08-02 — earlier revisions of this plan said sends would be suppressed, and five agents were briefed on that false premise. The owner cleared it deliberately. Evidence: all 32 `email_log` rows read `status='sent'` and none has ever read `suppressed`; the daily cron sent a genuine Post-Event Follow-up to a real customer (`silverdappled@aol.com`, booking `26-273`) on 2026-08-02 at 14:02 UTC. The local `.env` has never contained `EMAIL_ALLOWLIST` either, so `netlify dev` sends real mail too. **Scope every gate that touches an email path to a booking whose `client_email` is the owner's own address.**

---

## Pre-flight state (verified 2026-08-01, do not re-derive)

- Local `main` is at `90e3dc7`, **14 commits behind `origin/main`** (`8b99e65`). Phases 1–2 and all 39 tests exist only on `origin/main`.
- `feat/admin-direct-entry` (24 commits, `2634ef0`) branched from the stale local `main`, so it predates Phases 1–2.
- A trial `git merge origin/main` into `feat/admin-direct-entry` **auto-merges with zero conflicts**, and `npm test` passes 39/39 on the result. `client.js` correctly resolves to `origin/main`'s shared `sendEmail` (the pre-Phase-1 shadow sender and its `linear-gradient` chrome do not survive the merge). Task 0 is therefore mechanical — but it must still be *run*, not assumed.
- The branch has **never been opened in a browser**. Task 0 fixes that.

---

## File Structure

| File | Responsibility |
|---|---|
| `netlify/functions/_items.js` | **New.** `booking_items` DDL, the pure `rollupItems` function, and the replace-on-save / read helpers. The only place item arithmetic lives. |
| `netlify/functions/accept-quote.js` | **New.** Client-facing `quoted` → `accepted` transition, authenticated by `reference` + `client_email`. |
| `netlify/functions/bookings.js` | POST accepts `items`; public GET returns `items`. |
| `netlify/functions/booking.js` | PATCH accepts `items` and logs item changes. |
| `netlify/functions/generate-invoice.js` | Line-items table reads `booking_items`, falls back to legacy columns. |
| `netlify/functions/accounting-export.js` | Financials CSV gains an `items` column; revenue-by-service groups by item. |
| `admin.html` | Multi-service quote builder in the booking modal. |
| `my-booking.html` | Item lines, seven-status labels, Accept button. |
| `netlify.toml` | `/api/accept-quote` redirect. |
| `scripts/backfill-booking-items.js` | **New.** One-off backfill with dry-run default and a snapshot rollback. |
| `test/booking-items.test.js` | **New.** Unit tests for `rollupItems`. |
| `test/accept-quote.test.js` | **New.** Unit tests for the accept transition guard. |

---

## Task 0: Reconcile `main` and land the admin-direct-entry branch

Phase 3 needs both lines of work: the fixed `_email.js` from Phase 1 (for the accept notification) and the `accepted` status plus editable booking modal from the branch. This task produces one trunk.

**Files:**
- Modify: working tree only — no source edits expected. If the merge produces a conflict, stop and report rather than resolving creatively.

**Interfaces:**
- Produces: a `main` at or ahead of `origin/main` containing all 24 branch commits, `npm test` green at 39/39, and a browser-verified admin UI.

- [ ] **Step 1: Fast-forward local `main` to `origin/main`**

```bash
cd ~/Downloads/FME-Backend
git fetch origin
git checkout main
git merge --ff-only origin/main
git log --oneline -1
```

Expected: `8b99e65 fix: seven more invisible gradient buttons, incl. client-facing ones`. If `--ff-only` refuses, local `main` has commits that were never pushed — stop and report; do not force.

- [ ] **Step 2: Confirm the reconciled baseline is green before merging anything into it**

```bash
npm test 2>&1 | tail -8
```

Expected: `pass 39`, `fail 0`.

- [ ] **Step 3: Merge the branch into `main`**

```bash
git merge --no-ff feat/admin-direct-entry -m "merge: admin direct entry onto the Phase 1-2 trunk

feat/admin-direct-entry branched from a pre-Phase-1-2 main. The four
overlapping functions (automations, bookings, client, stripe-webhook)
auto-merge; client.js resolves to the shared sendEmail from _email.js,
so the pre-Phase-1 shadow sender does not come back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: clean merge, no conflict markers.

- [ ] **Step 4: Verify the merge did not resurrect the Phase 1 bugs**

```bash
grep -c "api.resend.com" netlify/functions/client.js   # expect 0
grep -c "linear-gradient" netlify/functions/client.js  # expect 0
grep -n "require('./_email')" netlify/functions/client.js  # expect a hit on line 3
npm test 2>&1 | tail -8
```

Expected: `0`, `0`, a match, and `pass 39 / fail 0`. If `api.resend.com` returns non-zero, `test/_email.test.js:114` will have failed too — do not "fix" the test.

- [ ] **Step 5: Confirm the merged status handling covers both models**

```bash
grep -n "status IN\|ALLOWED_STATUS" netlify/functions/stripe-webhook.js netlify/functions/automations.js netlify/functions/create-bookings.js
```

Expected: the webhook and automations lists contain **both** `'pending'` (nine legacy rows) and `'accepted'`; `create-bookings.js` `ALLOWED_STATUS` holds all seven new statuses. If `accepted` is missing anywhere, the branch's half of the merge was lost.

- [ ] **Step 6: Browser-verify the admin UI — the thing that has never been done**

Start the site locally and drive it. Per [[admin-direct-entry-branch-unmerged]] this branch's every check to date was static or API-level.

```bash
npx netlify dev
```

Then in Chrome, against `http://localhost:8888/admin.html`, confirm all four:
1. `+ Booking` opens the modal, and saving with **only** a client name creates a `draft` (no validation error).
2. Opening an existing booking, editing `Event Time`, and clicking **Save Details** shows the `✓ Saved` flash and persists across a reload.
3. The Clients tab lists clients and a client row opens the client sheet.
4. The status pills render with the correct colours and `.badge-pending` still styles the nine legacy rows.

Record what you saw. If any of the four fails, fix it in this task — it is a pre-existing defect on the branch, and Phase 3 builds directly on top of the modal.

- [ ] **Step 7: Commit any browser fixes and tag the rollback point**

```bash
git add -A
git commit -m "fix: defects found in first browser run of the booking modal

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" || echo "no fixes needed"
git tag pre-phase-3
git log --oneline -1
```

The `pre-phase-3` tag follows the existing `pre-hardening` convention and is the rollback point for everything below.

---

## Task 1: `_items.js` — schema and the rollup function

The arithmetic lives in one pure function so it can be tested without a database. Everything else in the phase calls it.

**Files:**
- Create: `netlify/functions/_items.js`
- Test: `test/booking-items.test.js`

**Interfaces:**
- Consumes: `withClient` / a `pg` client passed in by the caller. Nothing from Task 0 beyond a green trunk.
- Produces:
  - `ensureBookingItems(client) -> Promise<void>`
  - `rollupItems(items) -> { service_id: string, service_name: string, service_price: number, addons: Array<{name,price}>, addon_total: number, mileage_cost: number, total_price: number }`
  - `normaliseItems(raw) -> Array<{service_id,name,price,quantity,kind,sort_order}>`
  - `replaceItems(client, bookingId, items) -> Promise<Array<item>>`
  - `getItems(client, bookingId) -> Promise<Array<item>>`
  - `getItemsForBookings(client, bookingIds) -> Promise<Map<number, Array<item>>>`
  - `ITEM_KINDS = ['service','addon','travel','custom']`

- [ ] **Step 1: Write the failing tests**

Create `test/booking-items.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { rollupItems, normaliseItems } = require('../netlify/functions/_items');

test('a single service rolls up to the legacy columns unchanged', () => {
  const r = rollupItems([
    { service_id: 'foam_single', name: 'Foam Party — Single Cannon', price: 385, quantity: 1, kind: 'service' },
  ]);
  assert.strictEqual(r.service_id, 'foam_single');
  assert.strictEqual(r.service_name, 'Foam Party — Single Cannon');
  assert.strictEqual(r.service_price, 385);
  assert.strictEqual(r.total_price, 385);
  assert.deepStrictEqual(r.addons, []);
  assert.strictEqual(r.addon_total, 0);
  assert.strictEqual(r.mileage_cost, 0);
});

test('three services join into one service_name and sum into service_price', () => {
  const r = rollupItems([
    { service_id: 'foam_single',  name: 'Foam Party — Single Cannon', price: 385, quantity: 1, kind: 'service', sort_order: 0 },
    { service_id: 'face_paint',   name: 'Face Painting',              price: 200, quantity: 1, kind: 'service', sort_order: 1 },
    { service_id: 'cotton_candy', name: 'Live Spun Cotton Candy',     price: 385, quantity: 1, kind: 'service', sort_order: 2 },
  ]);
  assert.strictEqual(r.service_name, 'Foam Party — Single Cannon + Face Painting + Live Spun Cotton Candy');
  assert.strictEqual(r.service_price, 970);
  assert.strictEqual(r.total_price, 970);
  // The first service by sort_order owns the legacy single-value service_id.
  assert.strictEqual(r.service_id, 'foam_single');
});

// This is the constraint that protects every balance_due in the system.
test('travel is excluded from total_price and reported as mileage_cost', () => {
  const r = rollupItems([
    { name: 'Foam Party', price: 385, quantity: 1, kind: 'service' },
    { name: 'Travel (32 miles)', price: 48, quantity: 1, kind: 'travel' },
  ]);
  assert.strictEqual(r.total_price, 385, 'travel must not be folded into total_price');
  assert.strictEqual(r.mileage_cost, 48);
  // balance_due = total_price + mileage_cost - deposit, per bookings.js:329
  assert.strictEqual(r.total_price + r.mileage_cost - 100, 333);
});

test('addons roll into the legacy JSONB shape and addon_total', () => {
  const r = rollupItems([
    { name: 'Foam Party', price: 385, quantity: 1, kind: 'service' },
    { name: 'Extra Hour', price: 85, quantity: 2, kind: 'addon' },
    { name: 'Balloon Animals', price: 75, quantity: 1, kind: 'addon' },
  ]);
  assert.deepStrictEqual(r.addons, [
    { name: 'Extra Hour', price: 85 },
    { name: 'Balloon Animals', price: 75 },
  ]);
  assert.strictEqual(r.addon_total, 245, '85 x 2 + 75');
  assert.strictEqual(r.total_price, 630, 'service + addons, no travel');
});

test('quantity multiplies the line', () => {
  const r = rollupItems([
    { name: 'Face Painting', price: 200, quantity: 3, kind: 'service' },
  ]);
  assert.strictEqual(r.service_price, 600);
  assert.strictEqual(r.total_price, 600);
});

test('an empty or non-array input rolls up to zeroes, not NaN', () => {
  for (const input of [[], null, undefined, 'nonsense']) {
    const r = rollupItems(input);
    assert.strictEqual(r.total_price, 0);
    assert.strictEqual(r.service_price, 0);
    assert.strictEqual(r.mileage_cost, 0);
    assert.strictEqual(r.service_name, '');
    assert.strictEqual(r.service_id, '');
    assert.deepStrictEqual(r.addons, []);
  }
});

test('a custom line counts toward the total but not toward service or addon', () => {
  const r = rollupItems([
    { name: 'Foam Party', price: 385, quantity: 1, kind: 'service' },
    { name: 'Wacky Casino Night — bespoke', price: 500, quantity: 1, kind: 'custom' },
  ]);
  assert.strictEqual(r.total_price, 885);
  assert.strictEqual(r.service_price, 385);
  assert.strictEqual(r.addon_total, 0);
});

test('normaliseItems clamps prices, defaults quantity, and rejects unknown kinds', () => {
  const items = normaliseItems([
    { name: '  Foam Party  ', price: '385.00', kind: 'service' },
    { name: 'Bad', price: -50, quantity: 0, kind: 'nonsense' },
    { name: '', price: 100, kind: 'addon' },
  ]);
  assert.strictEqual(items.length, 2, 'the nameless row is dropped');
  assert.strictEqual(items[0].name, 'Foam Party');
  assert.strictEqual(items[0].price, 385);
  assert.strictEqual(items[0].quantity, 1);
  assert.strictEqual(items[1].price, 0, 'negative price clamps to 0');
  assert.strictEqual(items[1].quantity, 1, 'quantity below 1 clamps to 1');
  assert.strictEqual(items[1].kind, 'custom', 'unknown kind falls back to custom');
});

test('normaliseItems assigns sort_order by position', () => {
  const items = normaliseItems([
    { name: 'A', price: 1, kind: 'service' },
    { name: 'B', price: 2, kind: 'service' },
  ]);
  assert.strictEqual(items[0].sort_order, 0);
  assert.strictEqual(items[1].sort_order, 1);
});

test('normaliseItems caps a runaway payload rather than writing 10000 rows', () => {
  const items = normaliseItems(Array.from({ length: 500 }, (_, i) => ({ name: 'X' + i, price: 1, kind: 'service' })));
  assert.strictEqual(items.length, 50);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test 2>&1 | grep -E "booking-items|Cannot find module|fail"
```

Expected: FAIL with `Cannot find module '../netlify/functions/_items'`.

- [ ] **Step 3: Write `netlify/functions/_items.js`**

```js
// booking_items — one row per thing being sold on a booking.
//
// The legacy bookings.service_* / addons / addon_total / mileage_cost columns
// remain the contract for invoices, Stripe, the accounting export and the PPM
// sync. rollupItems() is the single place that derives them from the items, so
// there is exactly one definition of what a booking costs.

const ITEM_KINDS = ['service', 'addon', 'travel', 'custom'];

// ponytail: 50 lines is far past any real package (the largest historical
// booking has 4). The cap exists so a malformed client payload cannot write
// unbounded rows, not because 50 is meaningful.
const MAX_ITEMS = 50;

async function ensureBookingItems(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS booking_items (
      id         SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      service_id VARCHAR(64)  DEFAULT '',
      name       VARCHAR(255) NOT NULL,
      price      NUMERIC(10,2) NOT NULL DEFAULT 0,
      quantity   INTEGER      NOT NULL DEFAULT 1,
      kind       VARCHAR(16)  NOT NULL DEFAULT 'service',
      sort_order INTEGER      DEFAULT 0,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id, sort_order)'
  );
}

function clampPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100000);
}

// Accepts whatever the admin UI or a client posts and returns rows safe to
// write. Anything nameless is dropped — a line item with no description is not
// a line item.
function normaliseItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((i) => ({
      service_id: String((i && i.service_id) || '').trim().slice(0, 64),
      name:       String((i && i.name) || '').trim().slice(0, 255),
      price:      clampPrice(i && i.price),
      quantity:   Math.min(Math.max(Math.floor(Number((i && i.quantity)) || 1), 1), 1000),
      kind:       ITEM_KINDS.includes(i && i.kind) ? i.kind : 'custom',
    }))
    .filter((i) => i.name !== '')
    .slice(0, MAX_ITEMS)
    .map((i, idx) => ({ ...i, sort_order: idx }));
}

const lineTotal = (i) => clampPrice(i.price) * Math.max(1, Number(i.quantity) || 1);
const sum = (arr) => arr.reduce((s, i) => s + lineTotal(i), 0);

// Derives the legacy bookings columns from a set of items.
//
// total_price EXCLUDES travel. The balance formula in bookings.js:329 and
// booking.js:196 is `total_price + mileage_cost - deposit_amount`, so folding
// travel into total_price would double-charge it on every invoice and every
// balance. Do not "simplify" this into one sum.
function rollupItems(items) {
  const list = Array.isArray(items) ? items : [];
  const byOrder = [...list].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const services = byOrder.filter((i) => i.kind === 'service');
  const addons   = byOrder.filter((i) => i.kind === 'addon');
  const travel   = byOrder.filter((i) => i.kind === 'travel');
  const billable = byOrder.filter((i) => i.kind !== 'travel');

  return {
    service_id:    services.length ? String(services[0].service_id || '') : '',
    service_name:  services.map((i) => i.name).join(' + '),
    service_price: sum(services),
    addons:        addons.map((i) => ({ name: i.name, price: clampPrice(i.price) })),
    addon_total:   sum(addons),
    mileage_cost:  sum(travel),
    total_price:   sum(billable),
  };
}

async function getItems(client, bookingId) {
  const { rows } = await client.query(
    `SELECT id, booking_id, service_id, name, price::float8 AS price, quantity, kind, sort_order
     FROM booking_items WHERE booking_id = $1 ORDER BY sort_order, id`,
    [bookingId]
  );
  return rows;
}

// Batched sibling of getItems for list endpoints — one query instead of N.
async function getItemsForBookings(client, bookingIds) {
  const map = new Map();
  if (!bookingIds || !bookingIds.length) return map;
  const { rows } = await client.query(
    `SELECT id, booking_id, service_id, name, price::float8 AS price, quantity, kind, sort_order
     FROM booking_items WHERE booking_id = ANY($1) ORDER BY booking_id, sort_order, id`,
    [bookingIds]
  );
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push(r);
  }
  return map;
}

// Replace-on-save. A quote is edited as a whole, so diffing rows would buy
// nothing but a chance to get it wrong. Runs in the caller's transaction.
async function replaceItems(client, bookingId, items) {
  const clean = normaliseItems(items);
  await client.query('DELETE FROM booking_items WHERE booking_id = $1', [bookingId]);
  for (const i of clean) {
    await client.query(
      `INSERT INTO booking_items (booking_id, service_id, name, price, quantity, kind, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [bookingId, i.service_id, i.name, i.price, i.quantity, i.kind, i.sort_order]
    );
  }
  return getItems(client, bookingId);
}

module.exports = {
  ITEM_KINDS, ensureBookingItems, normaliseItems, rollupItems,
  getItems, getItemsForBookings, replaceItems,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test 2>&1 | tail -10
```

Expected: `pass 49`, `fail 0` (39 existing + 10 new).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_items.js test/booking-items.test.js
git commit -m "feat: booking_items schema and the rollup that derives the legacy columns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Backfill the 666 existing bookings

**Files:**
- Create: `scripts/backfill-booking-items.js`

**Interfaces:**
- Consumes: `ensureBookingItems`, `normaliseItems` from `netlify/functions/_items.js` (Task 1).
- Produces: one `service` item per booking, plus one `addon` item per entry in the existing `addons` JSONB, plus one `travel` item where `mileage_cost > 0`.

**Why not literally "one item each":** the spec's own gate requires the invoice to render correctly, and Task 4 makes the invoice read items when items exist. A booking whose `addons` JSONB holds two upsells would silently lose those two lines from its invoice if only the service row were backfilled. Expanding addons and travel into items keeps every existing invoice byte-identical. Flag this to Joe when the dry run is reviewed.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-booking-items.js`:

```js
#!/usr/bin/env node
/**
 * One-off: give every existing booking a booking_items representation.
 *
 * Context: docs/superpowers/specs/2026-07-31-crm-takeover-design.md Phase 3.
 *
 * Per booking this writes:
 *   - one 'service' item from service_name / service_price / service_id
 *   - one 'addon'   item per entry in the addons JSONB
 *   - one 'travel'  item when mileage_cost > 0
 *
 * That is more than "one item each" deliberately: generate-invoice.js reads
 * items in preference to the legacy columns once this ships, so a booking with
 * addons would lose those lines from its invoice if only the service row were
 * written.
 *
 * The legacy columns are NOT touched. This is additive and reversible.
 *
 * Dry run (default) prints a summary and writes nothing:
 *   node scripts/backfill-booking-items.js
 *
 * Apply, after reading the dry run:
 *   node scripts/backfill-booking-items.js --apply
 *
 * Rollback — deletes only the rows this script created:
 *   node scripts/backfill-booking-items.js --rollback
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { Pool } = require('pg');
const { ensureBookingItems, normaliseItems, rollupItems } = require('../netlify/functions/_items');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd',
  '2026-08-01-crm-takeover-phase-3', 'booking-items-rollback.json');

// Build the item list for one booking row from its legacy columns.
function itemsFor(b) {
  const items = [];

  // COALESCE(col,'') <> '' rather than IS NOT NULL — every text column in this
  // schema is DEFAULT '', so IS NOT NULL is a dead test. See the silent-failure
  // memory, instance 6.
  const name = String(b.service_name || '').trim();
  if (name !== '') {
    items.push({ service_id: b.service_id || '', name, price: Number(b.service_price || 0), quantity: 1, kind: 'service' });
  }

  const addons = Array.isArray(b.addons) ? b.addons : [];
  for (const a of addons) {
    const an = String((a && a.name) || '').trim();
    if (an !== '') items.push({ name: an, price: Number((a && a.price) || 0), quantity: 1, kind: 'addon' });
  }

  if (Number(b.mileage_cost || 0) > 0) {
    const miles = Number(b.mileage_miles || 0);
    items.push({ name: miles > 0 ? `Travel (${miles} miles)` : 'Travel', price: Number(b.mileage_cost), quantity: 1, kind: 'travel' });
  }

  // ── Balancing line ────────────────────────────────────────────────────────
  // Measured against production on 2026-08-01: of 667 bookings, only 481 have
  // total_price == service_price + addon_total. 164 carry MORE — $32,339.42 in
  // total — because the legacy schema had exactly one service slot, so
  // multi-service packages were folded into total_price with no line-item
  // trail. That unexplained money is the whole reason this phase exists.
  //
  // Without this line the backfilled items would under-explain the total, and
  // the first quote edit after Phase 3 ships would recompute total_price from
  // the items and silently delete the difference. Booking 24-329 would fall
  // from $3,000 to $875 because someone corrected a typo.
  //
  // Travel is excluded from the comparison because total_price excludes travel,
  // per the same rule rollupItems() follows.
  const billable = items
    .filter(i => i.kind !== 'travel')
    .reduce((s, i) => s + Number(i.price || 0) * Math.max(1, Number(i.quantity) || 1), 0);
  const gap = +(Number(b.total_price || 0) - billable).toFixed(2);
  if (gap > 0.005) {
    items.push({ name: 'Unitemised balance (pre-Phase-3 import)', price: gap, quantity: 1, kind: 'custom' });
  }
  // A negative gap cannot be represented — normaliseItems clamps price to >= 0,
  // and inventing a discount would be a guess about money. 22 bookings are in
  // that state (service_price exceeds total_price, mostly completed events
  // recorded with total_price = 0). They are reported by the dry run and left
  // alone deliberately: the data was already wrong before this script existed.

  return normaliseItems(items);
}

async function main() {
  const client = await pool.connect();
  try {
    if (ROLLBACK) {
      if (!fs.existsSync(SNAPSHOT)) {
        console.error('No snapshot at ' + SNAPSHOT + ' — nothing to roll back.');
        process.exit(1);
      }
      const ids = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).ids;
      const r = await client.query('DELETE FROM booking_items WHERE booking_id = ANY($1)', [ids]);
      console.log(`Deleted ${r.rowCount} booking_items rows across ${ids.length} bookings.`);
      return;
    }

    await ensureBookingItems(client);

    // Only bookings with no items yet — the script is safe to re-run.
    const { rows } = await client.query(`
      SELECT b.id, b.reference, b.service_id, b.service_name, b.service_price,
             b.addons, b.addon_total, b.mileage_cost, b.mileage_miles, b.total_price
      FROM bookings b
      WHERE NOT EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = b.id)
      ORDER BY b.id
    `);

    if (!rows.length) {
      console.log('Every booking already has items. Nothing to do.');
      return;
    }

    // Report, before writing anything, every booking whose rolled-up total
    // would disagree with its stored total_price. These are the rows a human
    // needs to look at — a mismatch means the legacy columns were already
    // internally inconsistent, and the backfill will not invent agreement.
    const drift = [];
    let noService = 0, itemCount = 0;
    for (const b of rows) {
      const items = itemsFor(b);
      itemCount += items.length;
      if (!items.some(i => i.kind === 'service')) noService++;
      const rolled = rollupItems(items);
      const stored = Number(b.total_price || 0);
      if (Math.abs(rolled.total_price - stored) > 0.005) {
        drift.push({
          reference: b.reference, stored_total: stored,
          rolled_total: rolled.total_price, delta: +(rolled.total_price - stored).toFixed(2),
        });
      }
    }

    console.log(`\n${rows.length} bookings without items → ${itemCount} item rows would be written.`);
    console.log(`${noService} booking(s) have no service_name and will get no 'service' item.`);
    if (drift.length) {
      console.log(`\n${drift.length} booking(s) whose rolled-up total disagrees with stored total_price:`);
      console.table(drift.slice(0, 40));
      if (drift.length > 40) console.log(`… and ${drift.length - 40} more.`);
      console.log(
        '\nThis does NOT block the backfill — total_price is left untouched and remains\n' +
        'authoritative. It means those bookings carry a custom or negotiated price that\n' +
        'the line items do not explain. Review before clearing the deprecation window.'
      );
    }

    if (!APPLY) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply.');
      return;
    }

    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ written_at: new Date().toISOString(), ids: rows.map(r => r.id) }, null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    await client.query('BEGIN');
    let written = 0;
    for (const b of rows) {
      for (const i of itemsFor(b)) {
        await client.query(
          `INSERT INTO booking_items (booking_id, service_id, name, price, quantity, kind, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [b.id, i.service_id, i.name, i.price, i.quantity, i.kind, i.sort_order]
        );
        written++;
      }
    }
    await client.query('COMMIT');
    console.log(`Wrote ${written} booking_items rows across ${rows.length} bookings.`);

    const { rows: check } = await client.query(
      'SELECT COUNT(DISTINCT booking_id)::int AS bookings, COUNT(*)::int AS items FROM booking_items'
    );
    console.log(`Verified: ${check[0].items} items across ${check[0].bookings} bookings.`);
  } finally {
    client.release();
  }
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
```

- [ ] **Step 2: Syntax-check, then run the dry run against live Neon**

```bash
node --check scripts/backfill-booking-items.js && echo "syntax ok"
node scripts/backfill-booking-items.js
```

Expected: a count near 666 bookings, an item count somewhat higher, and a drift table. **Read the drift table before continuing.** Do not apply yet — report the numbers first.

- [ ] **Step 3: Commit the script (not the data change)**

```bash
git add scripts/backfill-booking-items.js
git commit -m "feat: booking_items backfill script, dry-run by default

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Apply, after the dry-run numbers have been reported and accepted**

```bash
node scripts/backfill-booking-items.js --apply
```

Expected: a snapshot path, a written count, and the verification line. If the verified booking count is materially below the dry-run count, stop — the transaction did not do what it claimed.

---

## Task 3: Write path — accept `items` on create and edit

**Files:**
- Modify: `netlify/functions/bookings.js:331-430` (POST) and `netlify/functions/booking.js:87-287` (PATCH)

**Interfaces:**
- Consumes: `ensureBookingItems`, `replaceItems`, `rollupItems`, `normaliseItems` from `_items.js` (Task 1).
- Produces: both endpoints accept an optional `items` array. When present, it is authoritative and the legacy columns are overwritten from `rollupItems`. When absent, behaviour is byte-identical to today.

- [ ] **Step 1: Wire `items` into `bookings.js` POST**

In `netlify/functions/bookings.js`, add to the requires at the top (after line 5):

```js
const { ensureBookingItems, replaceItems, rollupItems, normaliseItems } = require('./_items');
```

Immediately after `const booking = rows[0];` (currently line 416), insert:

```js
      // Items are authoritative when supplied. The legacy columns are then
      // derived, never hand-set, so there is one definition of the price.
      let items = [];
      const posted = normaliseItems(b.items);
      if (posted.length) {
        await ensureBookingItems(client);
        items = await replaceItems(client, booking.id, posted);
        const roll = rollupItems(items);
        const newBalance = Math.max(0, roll.total_price + roll.mileage_cost - Number(booking.deposit_amount || 0));
        const { rows: re } = await client.query(
          `UPDATE bookings SET service_id=$1, service_name=$2, service_price=$3,
                  addons=$4, addon_total=$5, mileage_cost=$6, total_price=$7,
                  balance_due=$8, updated_at=NOW()
           WHERE id=$9 RETURNING *`,
          [roll.service_id, roll.service_name, roll.service_price,
           JSON.stringify(roll.addons), roll.addon_total, roll.mileage_cost,
           roll.total_price, newBalance, booking.id]
        );
        Object.assign(booking, re[0]);
      }
```

Then change the final return (currently line 429) to include the items:

```js
      return json(201, { success: true, reference: booking.reference, id: booking.id, booking, items });
```

- [ ] **Step 2: Verify the create path still behaves without `items`**

```bash
node --check netlify/functions/bookings.js && echo "syntax ok"
npm test 2>&1 | tail -6
```

Expected: syntax ok, `pass 49 / fail 0`. The existing tests cover the email paths that this must not disturb.

- [ ] **Step 3: Wire `items` into `booking.js` PATCH**

In `netlify/functions/booking.js`, add to the requires (after line 4):

```js
const { ensureBookingItems, replaceItems, rollupItems, normaliseItems, getItems } = require('./_items');
```

Insert this block immediately **before** the `// Auto-generate Stripe link when confirmed` comment (currently line 208), i.e. after the balance recompute block ends at line 206:

```js
        // ── Items (Phase 3) ────────────────────────────────────────────────
        // A supplied items array replaces the whole set and re-derives every
        // legacy money column. Runs before the Stripe-link block below so a
        // link generated on this same PATCH quotes the new deposit basis.
        // A non-empty array is required, not merely a present key. An empty
        // array would otherwise delete every item and zero total_price,
        // service_price, addon_total, mileage_cost and balance_due on a real
        // booking — so an admin form that PATCHed before its item rows loaded
        // would silently wipe a customer's quote. A genuine quote always has
        // at least one line, so nothing legitimate is lost by ignoring [].
        // The guard lives here, where every caller routes through, rather than
        // in the UI: trusting the caller is this codebase's documented
        // recurring failure mode.
        let items = null;
        if (Array.isArray(u.items) && u.items.length > 0) {
          await ensureBookingItems(c);
          const before = await getItems(c, parseInt(id));
          items = await replaceItems(c, parseInt(id), u.items);
          const roll = rollupItems(items);
          const newBalance = Math.max(0,
            roll.total_price + roll.mileage_cost - Number(updated.deposit_amount || 0));
          const r4 = await c.query(
            `UPDATE bookings SET service_id=$1, service_name=$2, service_price=$3,
                    addons=$4, addon_total=$5, mileage_cost=$6, total_price=$7,
                    balance_due=$8, updated_at=NOW()
             WHERE id=$9 RETURNING *`,
            [roll.service_id, roll.service_name, roll.service_price,
             JSON.stringify(roll.addons), roll.addon_total, roll.mileage_cost,
             roll.total_price, newBalance, parseInt(id)]
          );
          updated = r4.rows[0];

          // Traceability: the spec chose a child table over the addons JSONB
          // precisely so quote edits leave a trail. Log the whole before/after
          // line set, not just a count.
          const fmt = (list) => list.length
            ? list.map(i => `${i.name} x${i.quantity} $${Number(i.price).toFixed(2)}`).join('; ')
            : '—';
          if (fmt(before) !== fmt(items)) {
            await logChange(c, parseInt(id), 'Quote items changed', `${fmt(before)} → ${fmt(items)}`);
          }
        }
```

Then change the PATCH return (currently line 286) from `return json(200, updated);` to:

```js
        return json(200, items === null ? updated : { ...updated, items });
```

**Note on the field-level logging loop** (lines 274-284): it iterates `colMap`, and `items` is not in `colMap`, so it will not double-log. But `service_name`, `service_price`, `total_price` and `mileage_cost` **are** in `colMap` — they will only log if the caller also sent them explicitly, which the admin UI will not do once Task 5 lands. That is correct: the `Quote items changed` line is the record.

- [ ] **Step 4: Verify**

```bash
node --check netlify/functions/booking.js && echo "syntax ok"
npm test 2>&1 | tail -6
```

Expected: syntax ok, `pass 49 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/bookings.js netlify/functions/booking.js
git commit -m "feat: create and edit a booking from line items, deriving the legacy columns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Read path — items in the API, the invoice PDF, and the accounting export

This is the task the spec's gate actually tests. All three consumers read items when present and fall back to the legacy columns when not.

**Files:**
- Modify: `netlify/functions/bookings.js:10-22` (PUBLIC_FIELDS + the two GET-by-reference paths)
- Modify: `netlify/functions/generate-invoice.js:155-177`
- Modify: `netlify/functions/accounting-export.js:44-83` and `:141-165`

**Interfaces:**
- Consumes: `getItems`, `rollupItems` from `_items.js` (Task 1).
- Produces: `GET /api/bookings?reference=…&email=…` returns `{ bookings: [ { …publicFields, items: [...] } ] }`.

- [ ] **Step 1: Add `items` to the public booking payload**

In `netlify/functions/bookings.js`, add `'items'` to the end of `PUBLIC_FIELDS` (line 15, after `'created_at',`):

```js
  'deposit_amount', 'deposit_paid', 'balance_due', 'payment_amount', 'created_at',
  'items',
```

In the **admin** GET-by-reference branch (currently lines 171-179), replace the body with:

```js
        return withClient(async (client) => {
          await ensureTable(client);
          await ensureBookingItems(client);
          const { rows } = await client.query(
            'SELECT * FROM bookings WHERE reference = $1',
            [ref]
          );
          if (!rows.length) return json(404, { error: 'Not found' });
          rows[0].items = await getItems(client, rows[0].id);
          return json(200, { bookings: rows });
        });
```

In the **public** GET-by-reference branch (currently lines 186-198), replace the body with:

```js
      return withClient(async (client) => {
        await ensureTable(client);
        await ensureBookingItems(client);
        const { rows } = await client.query(
          'SELECT * FROM bookings WHERE reference = $1',
          [ref]
        );
        // Return 404 on not-found OR email mismatch (don't reveal existence)
        if (!rows.length) return json(404, { error: 'Not found' });
        if ((rows[0].client_email || '').toLowerCase() !== emailParam) {
          return json(404, { error: 'Not found' });
        }
        rows[0].items = await getItems(client, rows[0].id);
        return json(200, { bookings: [pickPublicFields(rows[0])] });
      });
```

In the **admin list** branch (currently lines 219-238), attach items in one batched query — insert after the `const { rows } = await client.query(...)` and before `return json(200, rows);`:

```js
      await ensureBookingItems(client);
      const itemMap = await getItemsForBookings(client, rows.map(r => r.id));
      for (const r of rows) r.items = itemMap.get(r.id) || [];
      return json(200, rows);
```

Add `getItems` and `getItemsForBookings` to the `_items.js` require added in Task 3 Step 1:

```js
const { ensureBookingItems, replaceItems, rollupItems, normaliseItems, getItems, getItemsForBookings } = require('./_items');
```

- [ ] **Step 2: Make the invoice PDF read items**

In `netlify/functions/generate-invoice.js`, add to the requires at the top:

```js
const { ensureBookingItems, getItems } = require('./_items');
```

Find where the booking row is loaded (search for `SELECT * FROM bookings`) and immediately after it, add:

```js
      await ensureBookingItems(client);
      booking.items = await getItems(client, booking.id);
```

Then replace the whole line-items block — the "Service line", "Add-ons" and "Mileage" sections, currently lines 155-177 — with:

```js
      // Line items. booking_items is authoritative when the booking has any;
      // bookings created before Phase 3 and never re-saved fall back to the
      // legacy columns, which the backfill has already mirrored anyway.
      const invoiceLines = (booking.items && booking.items.length)
        ? booking.items.map(i => ({
            label: i.name,
            qty: i.quantity,
            amount: Number(i.price || 0) * Math.max(1, Number(i.quantity) || 1),
            primary: i.kind === 'service',
          }))
        : [
            { label: booking.service_name || 'Service', qty: 1, amount: Number(booking.service_price || 0), primary: true },
            ...(Array.isArray(booking.addons) ? booking.addons : []).map(a => ({
              label: a.name, qty: 1, amount: Number(a.price || 0), primary: false,
            })),
            ...(Number(booking.mileage_cost) > 0
              ? [{ label: `Travel (${booking.mileage_miles || 0} miles)`, qty: 1, amount: Number(booking.mileage_cost), primary: false }]
              : []),
          ];

      for (const line of invoiceLines) {
        const size = line.primary ? 10 : 9;
        const useFont = line.primary ? fontBold : font;
        const colour = line.primary ? darkBlue : gray;
        page.drawText(`${line.primary ? '' : '  + '}${String(line.label).substring(0, 46)}`,
          { x: 60, y, size, font: useFont, color: colour });
        page.drawText(String(line.qty), { x: 400, y, size, font, color: line.primary ? darkGray : gray });
        page.drawText(`$${line.amount.toFixed(2)}`, { x: 480, y, size, font, color: line.primary ? darkGray : gray });
        y -= line.primary ? 20 : 18;
      }
```

The totals block below it is unchanged — it reads `booking.total_price` / `balance_due`, which Task 3 keeps correct.

- [ ] **Step 3: Make the accounting export read items**

In `netlify/functions/accounting-export.js`, in `getBookingFinancials` (line 45), add an items column to the SELECT. Insert after `b.service_name,` (line 51):

```js
      COALESCE((
        SELECT string_agg(bi.name || CASE WHEN bi.quantity > 1 THEN ' x' || bi.quantity ELSE '' END, ' + ' ORDER BY bi.sort_order, bi.id)
        FROM booking_items bi WHERE bi.booking_id = b.id
      ), b.service_name) AS items,
```

Then add the column to the financials CSV header list (line 214 area) — insert `{ key: 'items', label: 'Line Items' },` immediately after the existing `{ key: 'service_name', label: 'Service' },` in the **financials** section only.

Replace `getRevenueByService` (lines 141-165) with a version that groups by line item, so a three-service package contributes to all three services rather than to one concatenated string:

```js
/**
 * Get revenue summary by service.
 *
 * Groups by booking_items.name so a multi-service package contributes to each
 * service it contains. Revenue is apportioned across a booking's billable
 * items by their share of the line total — a package's $970 splits 385/200/385
 * rather than counting $970 three times.
 *
 * Bookings with no items fall back to a single synthetic line from
 * service_name, so pre-Phase-3 rows that were never backfilled still appear.
 */
async function getRevenueByService(client, startDate, endDate) {
  const query = `
    WITH lines AS (
      SELECT b.id AS booking_id,
             COALESCE(bi.name, b.service_name) AS service_name,
             COALESCE(bi.price * GREATEST(bi.quantity, 1), b.total_price) AS line_amount
      FROM bookings b
      LEFT JOIN booking_items bi
        ON bi.booking_id = b.id AND bi.kind <> 'travel'
      WHERE b.event_date >= $1 AND b.event_date <= $2
        AND b.status IN ('confirmed', 'completed')
    ),
    shares AS (
      SELECT l.booking_id, l.service_name,
             CASE WHEN SUM(l.line_amount) OVER (PARTITION BY l.booking_id) > 0
                  THEN l.line_amount / SUM(l.line_amount) OVER (PARTITION BY l.booking_id)
                  ELSE 0 END AS share
      FROM lines l
    )
    SELECT
      s.service_name,
      COUNT(DISTINCT s.booking_id)                                    AS booking_count,
      SUM(b.total_price * s.share)                                    AS total_revenue,
      SUM(b.total_price * s.share) / NULLIF(COUNT(DISTINCT s.booking_id), 0) AS avg_price,
      SUM(COALESCE(sp.total_staff_cost, 0) * s.share)                 AS total_staff_cost,
      SUM(b.total_price * s.share) - SUM(COALESCE(sp.total_staff_cost, 0) * s.share) AS gross_profit
    FROM shares s
    JOIN bookings b ON b.id = s.booking_id
    LEFT JOIN (
      SELECT booking_id, SUM(amount) AS total_staff_cost
      FROM staff_payments
      GROUP BY booking_id
    ) sp ON sp.booking_id = b.id
    WHERE COALESCE(s.service_name, '') <> ''
    GROUP BY s.service_name
    ORDER BY total_revenue DESC
  `;

  const result = await client.query(query, [startDate, endDate]);
  return result.rows;
}
```

- [ ] **Step 4: Verify all three read paths compile and the suite is green**

```bash
for f in bookings booking generate-invoice accounting-export _items; do node --check netlify/functions/$f.js || echo "FAILED $f"; done
npm test 2>&1 | tail -6
```

Expected: no `FAILED` lines, `pass 49 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/bookings.js netlify/functions/generate-invoice.js netlify/functions/accounting-export.js
git commit -m "feat: invoice, export and API read booking_items with legacy fallback

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Admin UI — build a multi-service quote

**Files:**
- Modify: `netlify/functions/booking.js` — the `sets.length` guard and the main UPDATE (Step 0).
- Modify: `admin.html` — the quote block at lines 1479-1551, and `saveBookingEdits`.

**Interfaces:**
- Consumes: `PATCH /api/booking/:id` accepting `{ items: [...] }` (Task 3); `GET /api/bookings` returning `items` (Task 4); `catServices` / `catAddons` already loaded at `admin.html:3636`.
- Produces: no new API surface.

- [ ] **Step 0: Fix the PATCH guard that rejects an items-only save**

Found by driving the browser on 2026-08-01, after a save failed with a 400. A plan defect, not an implementation one: static checks and all 49 unit tests pass with this bug present, because it only appears on a real request.

`booking.js` builds its `sets` array from `colMap` only. `items` is deliberately absent from `colMap` — it writes to `booking_items`, not to a `bookings` column. So `if (!sets.length) return json(400, ...)` fires on a PATCH that carries only `items`, returning "No fields to update" before the items block further down ever runs. That is precisely what Step 3's `saveBookingEdits` sends, since it deletes the derived money keys and lets the server own them.

Replace:

```js
        if (!sets.length) return json(400, { error: "No fields to update" });
```

with:

```js
        // `items` never appears in colMap — it writes to booking_items, not to
        // a bookings column — so an items-only PATCH would be rejected here as
        // "No fields to update" before the items block below ever ran. The
        // admin quote builder sends exactly that shape, because it deletes the
        // derived money keys and lets rollupItems own them.
        const hasItems = Array.isArray(u.items) && u.items.length > 0;
        if (!sets.length && !hasItems) return json(400, { error: "No fields to update" });
```

Then make the main UPDATE conditional, because `SET ${sets.join(",")}` produces invalid SQL when `sets` is empty. Replace:

```js
        vals.push(parseInt(id));
        const r = await c.query(
          `UPDATE bookings SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
          vals
        );
        if (!r.rows.length) return json(404, { error: "Not found" });

        let updated = r.rows[0];
```

with:

```js
        // An items-only PATCH has no bookings columns to set. Skip the UPDATE
        // entirely rather than emitting `SET , updated_at=NOW()`; the items
        // block below writes the derived columns and bumps updated_at itself.
        let updated = prev;
        if (sets.length) {
          vals.push(parseInt(id));
          const r = await c.query(
            `UPDATE bookings SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
            vals
          );
          if (!r.rows.length) return json(404, { error: "Not found" });
          updated = r.rows[0];
        }
```

Verify: `node --check netlify/functions/booking.js`, then `npm test` still at 49/49. The browser checks in Step 5 are what actually prove this fix — a save must now persist.

- [ ] **Step 1: Replace the quote block markup**

In `admin.html`, replace lines 1479-1486 (the `addons` / `mileageRow` / `extraRow` const block) with:

```js
  // Items are authoritative. A booking with none (never re-saved since the
  // backfill, or brand new) starts from its legacy columns so the editor is
  // never blank on a booking that clearly has a price.
  const items = Array.isArray(b.items) && b.items.length ? b.items : legacyToItems(b);
```

and add these two helpers next to `parseAddons` (find it and put them immediately after):

```js
// Mirrors _items.js itemsFor() in scripts/backfill-booking-items.js — used only
// to seed the editor for a booking that predates the backfill.
function legacyToItems(b) {
  const out = [];
  if (String(b.service_name || '').trim()) {
    out.push({ service_id: b.service_id || '', name: b.service_name, price: Number(b.service_price || 0), quantity: 1, kind: 'service' });
  }
  for (const a of parseAddons(b.addons)) {
    out.push({ service_id: '', name: a.name, price: Number(a.price || 0), quantity: 1, kind: 'addon' });
  }
  if (Number(b.mileage_cost || 0) > 0) {
    out.push({ service_id: '', name: `Travel (${b.mileage_miles || 0} miles)`, price: Number(b.mileage_cost), quantity: 1, kind: 'travel' });
  }
  return out;
}

function itemRowHtml(i, idx) {
  const kinds = ['service', 'addon', 'travel', 'custom'];
  return `<div class="q-row item-row" data-item-row="${idx}">
    <select class="item-f" data-if="kind" style="max-width:96px">
      ${kinds.map(k => `<option value="${k}" ${k === i.kind ? 'selected' : ''}>${k}</option>`).join('')}
    </select>
    <input class="item-f" data-if="name" value="${esc(i.name || '')}" placeholder="Description" style="flex:1;min-width:140px">
    <input class="item-f" data-if="quantity" type="number" min="1" step="1" value="${Number(i.quantity) || 1}" style="max-width:64px">
    <input class="item-f" data-if="price" type="number" step="0.01" min="0" value="${Number(i.price) || 0}" style="max-width:104px">
    <input type="hidden" class="item-f" data-if="service_id" value="${esc(i.service_id || '')}">
    <button class="btn btn-outline btn-sm" onclick="removeItemRow(this)" title="Remove">✕</button>
  </div>`;
}
```

Then replace the Quote block markup (lines 1526-1536) with:

```js
    <!-- Quote -->
    <div class="quote-block">
      <span class="section-label">Quote Breakdown</span>
      <div id="items-list-${b.id}">
        ${items.map(itemRowHtml).join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <button class="btn btn-outline btn-sm" onclick="addItemRow('${b.id}')">+ Line</button>
        <select id="item-picker-${b.id}" onchange="addItemFromCatalogue('${b.id}', this)" style="max-width:260px">
          <option value="">+ From catalogue…</option>
          <optgroup label="Services">
            ${(catServices || []).map(s => `<option value="svc:${esc(s.service_id)}">${esc(s.name)} — $${Number(s.price).toFixed(2)}</option>`).join('')}
          </optgroup>
          <optgroup label="Add-ons">
            ${(catAddons || []).map(a => `<option value="add:${esc(a.addon_id)}">${esc(a.name)} — $${Number(a.price).toFixed(2)}</option>`).join('')}
          </optgroup>
        </select>
        <span style="margin-left:auto;font-weight:600" id="items-total-${b.id}"></span>
      </div>
```

Leave the deposit / balance rows below it exactly as they are — Task 3 keeps `deposit_amount` and `balance_due` correct server-side.

- [ ] **Step 2: Add the row helpers and the live total**

Add near `openBooking`:

```js
function readItemRows(bookingId) {
  const host = document.getElementById('items-list-' + bookingId);
  if (!host) return [];
  return [...host.querySelectorAll('[data-item-row]')].map(row => {
    const get = (f) => { const el = row.querySelector(`[data-if="${f}"]`); return el ? el.value : ''; };
    return { service_id: get('service_id'), name: get('name'), price: Number(get('price')) || 0,
             quantity: Number(get('quantity')) || 1, kind: get('kind') || 'custom' };
  }).filter(i => i.name.trim() !== '');
}

// Mirrors rollupItems() in _items.js: travel is excluded from the total.
function renderItemsTotal(bookingId) {
  const rows = readItemRows(bookingId);
  const total = rows.filter(i => i.kind !== 'travel')
                    .reduce((s, i) => s + i.price * Math.max(1, i.quantity), 0);
  const travel = rows.filter(i => i.kind === 'travel')
                     .reduce((s, i) => s + i.price * Math.max(1, i.quantity), 0);
  const el = document.getElementById('items-total-' + bookingId);
  if (el) el.textContent = `Total $${total.toFixed(2)}` + (travel > 0 ? ` + $${travel.toFixed(2)} travel` : '');
}

function addItemRow(bookingId, seed) {
  const host = document.getElementById('items-list-' + bookingId);
  if (!host) return;
  const idx = host.querySelectorAll('[data-item-row]').length;
  host.insertAdjacentHTML('beforeend', itemRowHtml(seed || { kind: 'service', name: '', price: 0, quantity: 1, service_id: '' }, idx));
  renderItemsTotal(bookingId);
}

function addItemFromCatalogue(bookingId, sel) {
  const v = sel.value;
  if (!v) return;
  const [kind, id] = v.split(':');
  if (kind === 'svc') {
    const s = (catServices || []).find(x => x.service_id === id);
    if (s) addItemRow(bookingId, { kind: 'service', name: s.name, price: Number(s.price), quantity: 1, service_id: s.service_id });
  } else {
    const a = (catAddons || []).find(x => x.addon_id === id);
    if (a) addItemRow(bookingId, { kind: 'addon', name: a.name, price: Number(a.price), quantity: 1, service_id: '' });
  }
  sel.value = '';
}

function removeItemRow(btn) {
  const row = btn.closest('[data-item-row]');
  const host = row && row.parentElement;
  if (row) row.remove();
  if (host) renderItemsTotal(host.id.replace('items-list-', ''));
}
```

Wire the live total by delegating input events — add inside `openBooking` after `modal-body` is populated:

```js
  const itemsHost = document.getElementById('items-list-' + b.id);
  if (itemsHost) {
    itemsHost.addEventListener('input', () => renderItemsTotal(b.id));
    itemsHost.addEventListener('change', () => renderItemsTotal(b.id));
    renderItemsTotal(b.id);
  }
```

- [ ] **Step 3: Send `items` on save**

Find `saveBookingEdits` and include the item rows in the PATCH body. The existing function collects `.bk-edit` fields into a payload object; add before the `fetch`:

```js
  // Items replace the whole quote. service_name / service_price / total_price /
  // mileage_cost are derived server-side from these, so do not also send them —
  // _items.js rollupItems() is the single source of that arithmetic.
  payload.items = readItemRows(id);
  delete payload.service_name;
  delete payload.service_price;
  delete payload.total_price;
  delete payload.mileage_cost;
```

Do the same in whichever function POSTs a new booking from the modal (the `isNew` path), adding `items: readItemRows('new')` to its body.

- [ ] **Step 4: Verify the inline script parses**

`admin.html` is a 5.5k-line single file with no build step, so extract and syntax-check the inline script the same way the branch's earlier tasks did:

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('admin.html','utf8');
const m=[...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
fs.writeFileSync('/private/tmp/claude-501/-Users-joecoover2022-Downloads-FME-Backend/491fde57-7176-4c60-a9d4-31137a85d86c/scratchpad/admin-inline.js', m.map(x=>x[1]).join('\n;\n'));
console.log('extracted', m.length, 'blocks');
"
node --check /private/tmp/claude-501/-Users-joecoover2022-Downloads-FME-Backend/491fde57-7176-4c60-a9d4-31137a85d86c/scratchpad/admin-inline.js && echo "admin.html inline JS parses"
```

Expected: `admin.html inline JS parses`.

- [ ] **Step 5: Drive it in a browser — this is the task's real test**

```bash
npx netlify dev
```

`netlify dev` connects to the live production database — see Global Constraints. Open **only** the designated test booking `FM-E5EFPPQX` (id 717, `ZZ TEST — DO NOT BOOK (Phase 3 gate)`). Never rebuild a real customer's quote. Then:
1. Add "Foam Party — Single Cannon", "Face Painting" and "Live Spun Cotton Candy" from the catalogue picker.
2. Confirm the live total reads `Total $970.00`.
3. Save Details, reload the page, reopen the booking — all three lines are still there.
4. Confirm the booking's row in the list now shows the joined service name.
5. Add a `travel` line at $48 and confirm the total still reads `$970.00 + $48.00 travel`, and after saving, `Balance Due` = `970 + 48 − deposit`.

Step 5 is the constraint from the Global Constraints section. If travel lands inside the total, stop and fix `rollupItems` before continuing.

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat: multi-service quote builder in the booking modal

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The accept endpoint

**Files:**
- Create: `netlify/functions/accept-quote.js`
- Create: `test/accept-quote.test.js`
- Modify: `netlify.toml`

**Interfaces:**
- Consumes: `sendEmail`, `wrap`, `esc`, `logChange`, `logEmail`, `logStatus`, `ensureEmailLog`, `ensureBookingChanges`, `fireStatusAutomations` from `_email.js`; `getItems`, `ensureBookingItems` from `_items.js`.
- Produces: `POST /api/accept-quote` with body `{ reference, client_email }` → `200 { success: true, status: 'accepted', reference }`, `404` on unknown reference or email mismatch, `409 { error, status }` when the booking is not in `quoted`.

- [ ] **Step 1: Write the failing test**

Create `test/accept-quote.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { acceptOutcome } = require('../netlify/functions/accept-quote');

// The transition guard is the whole safety story for this endpoint, so it is a
// pure function that can be tested without a database.

test('a quoted booking accepts', () => {
  const r = acceptOutcome({ rowCount: 1, current: 'quoted' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.status, 'accepted');
});

test('an already-accepted booking is idempotent, not an error', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'accepted' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.status, 'accepted');
  assert.strictEqual(r.body.already, true);
});

test('a confirmed booking cannot be walked backwards to accepted', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'confirmed' });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.status, 'confirmed');
});

test('a cancelled booking cannot be accepted', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'cancelled' });
  assert.strictEqual(r.statusCode, 409);
});

test('a draft or review booking has no quote to accept', () => {
  for (const s of ['draft', 'review']) {
    assert.strictEqual(acceptOutcome({ rowCount: 0, current: s }).statusCode, 409);
  }
});

// The guard must be capable of failing. A conditional UPDATE that matched
// nothing MUST NOT be reported as a success — that is the recurring bug class
// in this codebase (see the silent-failure memory).
test('zero rows updated is never reported as a fresh acceptance', () => {
  for (const s of ['draft', 'review', 'quoted', 'confirmed', 'completed', 'cancelled', 'pending']) {
    const r = acceptOutcome({ rowCount: 0, current: s });
    assert.notStrictEqual(
      JSON.stringify(r.body), JSON.stringify({ success: true, status: 'accepted' }),
      `status ${s} with rowCount 0 must not look like a fresh accept`
    );
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test 2>&1 | grep -E "accept-quote|Cannot find module"
```

Expected: FAIL with `Cannot find module '../netlify/functions/accept-quote'`.

- [ ] **Step 3: Write `netlify/functions/accept-quote.js`**

```js
// netlify/functions/accept-quote.js
// Client-facing quote acceptance. Authenticated the same way my-booking.html
// already authenticates everything else: booking reference + the client email
// stored on that booking. No admin token, no session.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const {
  wrap, esc, sendEmail, logEmail, logStatus, logChange,
  ensureEmailLog, ensureBookingChanges, fireStatusAutomations,
} = require('./_email');
const { ensureBookingItems, getItems } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

/**
 * Decide what a conditional `UPDATE … WHERE status='quoted'` means.
 *
 * Pure so it can be tested without a database, and separate so the "did it
 * actually change anything" question has one answer. rowCount 0 means the WHERE
 * did not match — it must never read as a successful transition.
 *
 * @param {{rowCount: number, current: string}} r
 */
function acceptOutcome(r) {
  if (r.rowCount === 1) return { statusCode: 200, body: { success: true, status: 'accepted' } };
  if (r.current === 'accepted') return { statusCode: 200, body: { success: true, status: 'accepted', already: true } };
  return {
    statusCode: 409,
    body: {
      error: `This booking is '${r.current}' and cannot be accepted. Only a quoted booking can be.`,
      status: r.current,
    },
  };
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const reference = String(body.reference || '').trim().toUpperCase();
  const email = String(body.client_email || '').trim().toLowerCase();
  if (!reference || !email) return json(400, { error: 'reference and client_email are required' });

  return withClient(async (c) => {
    try {
      await ensureEmailLog(c);
      await ensureBookingChanges(c);
      await ensureBookingItems(c);

      // Authenticate: reference AND matching email, or 404 without revealing
      // whether the reference exists. Same shape as bookings.js:194.
      const { rows: found } = await c.query(
        'SELECT id, reference, status, client_name, client_email, event_date, total_price, balance_due, deposit_amount FROM bookings WHERE reference = $1',
        [reference]
      );
      if (!found.length) return json(404, { error: 'Booking not found' });
      if ((found[0].client_email || '').toLowerCase() !== email) return json(404, { error: 'Booking not found' });

      const booking = found[0];

      // Conditional update — the WHERE is the guard. A read-then-write would
      // race two clicks into two acceptances and two notification emails.
      const upd = await c.query(
        `UPDATE bookings SET status='accepted', updated_at=NOW()
         WHERE id=$1 AND status='quoted' RETURNING *`,
        [booking.id]
      );

      const outcome = acceptOutcome({ rowCount: upd.rowCount, current: booking.status });
      if (outcome.statusCode !== 200) return json(409, outcome.body);
      if (outcome.body.already) return json(200, { ...outcome.body, reference: booking.reference });

      const updated = upd.rows[0];
      await logChange(c, booking.id, 'Status changed', `quoted → accepted`);
      await logChange(c, booking.id, 'Quote accepted by client', `via my-booking.html by ${email}`);

      const items = await getItems(c, booking.id);
      const lines = items.length
        ? items.map(i => `<li>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''} — $${(Number(i.price) * Math.max(1, i.quantity)).toFixed(2)}</li>`).join('')
        : `<li>${esc(updated.service_name || 'Service')} — $${Number(updated.service_price || 0).toFixed(2)}</li>`;

      const dateStr = updated.event_date
        ? new Date(String(updated.event_date).split('T')[0] + 'T00:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : 'TBD';

      // Owner notification. Plain background colour, never a gradient — Gmail
      // strips linear-gradient and test/_email.test.js scans for it.
      const subject = `✅ Quote ACCEPTED — ${updated.reference} — ${updated.client_name || 'client'}`;
      const html = wrap(`
        <h2>Quote accepted</h2>
        <p><strong>${esc(updated.client_name || 'A client')}</strong> just accepted their quote from the booking page.</p>
        <p><strong>Ref:</strong> ${esc(updated.reference)}</p>
        <p><strong>Date:</strong> ${dateStr}</p>
        <ul>${lines}</ul>
        <p><strong>Total:</strong> $${Number(updated.total_price || 0).toFixed(2)}</p>
        <p><strong>Deposit to collect:</strong> $${Number(updated.deposit_amount || 0).toFixed(2)}</p>
        <p>Next step: send the deposit link.</p>
        <br/>
        <a href="${SITE}/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>
      `);

      // sendEmail throws on failure. The status change has already committed
      // and is the thing that matters — a failed notification must not undo it
      // or 500 the client. Log the real outcome either way.
      try {
        const res = await sendEmail(NOTIFY, subject, html);
        await logEmail(c, booking.id, null, 'Quote accepted', subject, NOTIFY, 'admin', logStatus(res));
      } catch (e) {
        console.error('accept-quote notify failed:', e.message);
        await logEmail(c, booking.id, null, 'Quote accepted', subject, NOTIFY, 'admin', 'failed', e.message);
      }

      // Any admin-configured rules for the 'accepted' rung fire too. This is
      // additive — there are none today, and it costs one indexed query.
      await fireStatusAutomations(c, updated, 'accepted', updated.stripe_payment_link || null);

      return json(200, { success: true, status: 'accepted', reference: updated.reference });
    } catch (e) {
      console.error('accept-quote error:', e.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

exports.acceptOutcome = acceptOutcome;
```

- [ ] **Step 4: Add the redirect**

In `netlify.toml`, add immediately after the `/api/coi-request` block:

```toml
[[redirects]]
  from = "/api/accept-quote"
  to = "/.netlify/functions/accept-quote"
  status = 200
```

- [ ] **Step 5: Run the tests**

```bash
node --check netlify/functions/accept-quote.js && echo "syntax ok"
npm test 2>&1 | tail -6
```

Expected: syntax ok, `pass 55 / fail 0` (49 + 6 accept tests).

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/accept-quote.js test/accept-quote.test.js netlify.toml
git commit -m "feat: client-facing quote accept endpoint, quoted -> accepted

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: `my-booking.html` — line items, seven statuses, Accept button

**Files:**
- Modify: `my-booking.html:383-433` (`displayBooking`), `:451-460` (`formatStatus`), and the script's action area.

**Interfaces:**
- Consumes: `GET /api/bookings?reference=…&email=…` now returning `items` (Task 4); `POST /api/accept-quote` (Task 6).

- [ ] **Step 1: Render the line items**

In `my-booking.html`, inside `displayBooking`, replace the single `Service` detail row (lines 390-393) with:

```js
        ${(Array.isArray(booking.items) && booking.items.length
          ? booking.items.map(i => `
            <div class="detail-row">
              <span class="detail-label">${i.kind === 'service' ? 'Service' : i.kind === 'travel' ? 'Travel' : 'Add-on'}</span>
              <span class="detail-value">${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''} — $${(Number(i.price) * Math.max(1, Number(i.quantity) || 1)).toFixed(2)}</span>
            </div>`).join('')
          : `
            <div class="detail-row">
              <span class="detail-label">Service</span>
              <span class="detail-value">${esc(booking.service_name)}</span>
            </div>`)}
```

- [ ] **Step 2: Give `formatStatus` all seven statuses**

Replace `formatStatus` (lines 451-460) with:

```js
    function formatStatus(status) {
      const labels = {
        draft:     '📝 Being Prepared',
        review:    '📋 Under Review',
        quoted:    '💬 Quote Ready',
        accepted:  '🤝 Accepted — Deposit Next',
        pending:   '⏳ Pending Confirmation',
        confirmed: '✅ Confirmed',
        completed: '🎉 Completed',
        cancelled: '❌ Cancelled'
      };
      return labels[status] || status;
    }
```

`pending` stays until `scripts/migrate-pending-to-accepted.js` has run against the nine legacy rows — dropping it would render a bare `pending` to those clients.

- [ ] **Step 3: Add the Accept button, shown only on a quoted booking**

At the end of the `detailsHtml` template in `displayBooking`, before the closing backtick, append:

```js
        ${booking.status === 'quoted' ? `
          <div style="margin-top:20px;padding-top:20px;border-top:1px solid rgba(255,255,255,.12);text-align:center">
            <p style="color:#A78BCA;line-height:1.6;margin-bottom:14px">
              Happy with this quote? Accept it and we'll send your deposit link to confirm the date.
            </p>
            <button id="accept-btn" onclick="acceptQuote()"
              style="background:#FF6B00;color:#0F0A1E;padding:14px 32px;border:none;border-radius:10px;font-weight:900;font-size:15px;cursor:pointer">
              Accept This Quote
            </button>
            <div id="accept-msg" style="margin-top:12px;font-size:14px"></div>
          </div>
        ` : ''}
```

The button uses a flat `#FF6B00`, not a gradient — same reason as the emails, and this page's CTA styling is what `test/_email.test.js:383` was written after.

- [ ] **Step 4: Add the handler**

Add next to `requestCOI`:

```js
    async function acceptQuote() {
      if (!currentBooking) return;
      const btn = document.getElementById('accept-btn');
      const msg = document.getElementById('accept-msg');
      btn.disabled = true;
      btn.textContent = 'Accepting…';
      msg.textContent = '';

      try {
        const res = await fetch('/api/accept-quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: currentBooking.reference,
            client_email: currentBooking.client_email
          })
        });
        const data = await res.json();

        // Report what the server actually said. A non-ok response with a body
        // is not a success, and its message is more useful than a generic one.
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

        currentBooking.status = 'accepted';
        msg.style.color = '#4ade80';
        msg.textContent = "🎉 Accepted! We'll email your deposit link shortly.";
        btn.style.display = 'none';
        displayBooking(currentBooking);
      } catch (e) {
        console.error('Accept error:', e);
        msg.style.color = '#f87171';
        msg.textContent = e.message + ' — call us on (405) 431-6625 if this looks wrong.';
        btn.disabled = false;
        btn.textContent = 'Accept This Quote';
      }
    }
```

- [ ] **Step 5: Syntax-check and drive it**

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('my-booking.html','utf8');
const m=[...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
fs.writeFileSync('/private/tmp/claude-501/-Users-joecoover2022-Downloads-FME-Backend/491fde57-7176-4c60-a9d4-31137a85d86c/scratchpad/mybooking-inline.js', m.map(x=>x[1]).join('\n;\n'));
console.log('extracted', m.length, 'blocks');
"
node --check /private/tmp/claude-501/-Users-joecoover2022-Downloads-FME-Backend/491fde57-7176-4c60-a9d4-31137a85d86c/scratchpad/mybooking-inline.js && echo "my-booking.html inline JS parses"
```

Then with `npx netlify dev` running, at `http://localhost:8888/my-booking.html`, look up the designated test booking `FM-E5EFPPQX` after setting it to `quoted` in the admin UI. It has no `client_email`, and the lookup requires a matching one — so first set its email to `joe.coover@gmail.com` in the admin modal — the owner's own address, which is what keeps a real outbound send harmless. Confirm: the line items render, the Accept button appears, clicking it flips the status, and the button disappears on the re-render. Then reload and confirm the Accept button is **gone** (status is now `accepted`).

- [ ] **Step 6: Commit**

```bash
git add my-booking.html
git commit -m "feat: line items, seven status labels and quote accept on the client page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7b: Normalise the 83 mileage-inclusive bookings

Added 2026-08-02, approved by the owner. Not in the original spec — it surfaced from Task 2's dry run and must land before Task 8's deploy, because Task 3's balance recompute is what arms it.

**Files:**
- Create: `scripts/normalise-mileage-totals.js`

**Interfaces:**
- Consumes: `rollupItems`, `getItems` from `netlify/functions/_items.js`.
- Produces: nothing other tasks import. A one-off, like `scripts/backfill-booking-items.js`.

**The defect.** 83 of 667 bookings store `total_price` INCLUDING `mileage_cost`. The other 481 that reconcile exclude it, which is what every formula in the codebase assumes: `balance_due = max(0, total_price + mileage_cost - deposit_amount)` (`bookings.js:329`, `booking.js:196-197`).

Nobody has been overcharged — 78 of the 83 store a `balance_due` that is correct as it stands, and none stores the double-counted figure. The bug is latent in the *recompute* path: the moment one of those bookings is edited, its balance inflates by the travel amount. **10 confirmed bookings with unpaid balances are exposed, totalling $1,248.54 of inflation** — worst cases Heather Ross `26-266` ($611.80 → $838.60) and Michael Avila `26-264` ($1,026.80 → $1,253.60). Phase 3 makes an edit far more likely, because Task 3 recomputes the balance on every quote change.

**The backfill copied the defect into the items.** All 83 received a balancing line, and on 81 of them it equals `mileage_cost` exactly — so travel is recorded twice, once as a `travel` item and once inside `Unitemised balance (pre-Phase-3 import)`. Fixing `bookings` alone would leave the items still wrong.

**The fix, per booking:**
- `total_price := total_price - mileage_cost`, so it excludes travel like every other row.
- Recompute the balancing line as `new_total_price - (sum of billable items excluding the balancing line)`. Where that is `<= 0.005`, delete the line instead.
- **`balance_due` must NOT change.** The corrected formula yields exactly the number already stored. If a row's `balance_due` would move, that row is not the simple case — refuse it and report it rather than guessing.

Aggregate effect: reported revenue falls **$8,887.12**, which is the point — those 83 were overstating relative to the other 481, and the accounting export already tracks mileage separately on its expenses sheet.

- [ ] **Step 1: Write the script**

Model it on `scripts/backfill-booking-items.js` — same `.env` loader, same `--apply` / `--rollback` flags, same snapshot-to-`.superpowers/sdd/…` rollback, same tone of safety comment. Requirements it must meet, each of which is a real failure mode here:

1. **Select only the simple case.** A booking qualifies only when `ABS((service_price + addon_total + mileage_cost) - total_price) <= 0.005 AND mileage_cost > 0`. Anything else is left alone.
2. **Refuse rather than guess.** Before writing, compute the post-fix `balance_due` for every candidate. If any row's would differ from its stored value by more than half a cent, print those rows and abort the whole batch. Do not fix "most" of them.
3. **Snapshot before writing**, holding each booking's id, `total_price`, `balance_due`, and the id and price of the balancing line — enough to reverse both tables. Write it before `BEGIN`, so the only reachable failure state is "snapshot exists, nothing written", which rolls back harmlessly.
4. **One transaction** for the whole batch.
5. **Dry run by default**, printing the candidate count, the aggregate `total_price` reduction, how many balancing lines would be reduced versus deleted, and the 10 at-risk open bookings by reference with their before/after.
6. Use `COALESCE(col,'') <> ''` rather than `IS NOT NULL` anywhere a text column is tested — `IS NOT NULL` is a dead test on this schema.
7. Do not touch `mileage_cost`, `service_price`, `addon_total`, `deposit_amount`, `balance_due`, or any `service`/`travel` item. The only writes are `bookings.total_price` and the one balancing `booking_items` row per booking.

- [ ] **Step 2: Syntax-check and dry-run**

```bash
node --check scripts/normalise-mileage-totals.js && echo "syntax ok"
node scripts/normalise-mileage-totals.js
```

Expected: 83 candidates, aggregate reduction $8,887.12, and no refusal. **Report the numbers and stop.** The owner reviews before anything is written.

- [ ] **Step 3: Commit the script (not the data change)**

```bash
git add scripts/normalise-mileage-totals.js
git commit -m "feat: normalise the 83 bookings whose total_price includes mileage

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Apply, only after the dry-run numbers are accepted**

```bash
node scripts/normalise-mileage-totals.js --apply
```

Then verify independently, not from the script's own output: every one of the 83 must satisfy `total_price == service_price + addon_total`; `balance_due` must be unchanged for all 83; `sum(total_price)` across all bookings must have fallen by exactly $8,887.12; and for each of the 83, `rollupItems(getItems(...))` must now reproduce the stored `total_price` and `mileage_cost`.

---

## Task 8: Gate, deploy, and the deferred key rotation

**Files:**
- Modify: `docs/ROADMAP.md`
- No source changes expected.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the full suite one last time**

```bash
npm test 2>&1 | tail -8
```

Expected: `pass 55`, `fail 0`. Do not proceed on anything else.

- [ ] **Step 2: Run the spec's gate — a 3-service package in all three consumers**

The spec's gate is explicit: *"a 3-service package quote renders correctly in the client view, the invoice PDF, and the accounting export — all three, because all three read line items."*

With `npx netlify dev` running, using the designated test booking `FM-E5EFPPQX` (id 717) and no other:

1. **Admin:** build a quote of Foam Party ($385) + Face Painting ($200) + Cotton Candy ($385), plus a $48 travel line. Set an `event_date` so the accounting export's date range can find it. Set status to `quoted`. Confirm `total_price` = 970 and `balance_due` = 970 + 48 − deposit.
2. **Client view:** `my-booking.html`, look the booking up, confirm all four lines render and the Accept button appears.
3. **Invoice PDF:** click Download PDF. Confirm four line rows, `Total: $970.00`, and the travel line listed separately — not folded into the total.
4. **Accounting export:** `GET /api/accounting-export` for a range covering the event date. Confirm the financials CSV `Line Items` column reads `Foam Party — Single Cannon + Face Painting + Live Spun Cotton Candy + Travel (…)`.

   The revenue-by-service sheet filters `status IN ('confirmed','completed')` (`accounting-export.js:158`), so a `quoted` test booking will **not** appear there — that is the query working, not a bug. To check that half of the gate, set the test booking to `confirmed` in the admin UI, re-run the export, confirm the three services appear separately with apportioned revenue summing to $970, then set it back to `quoted` before step 5. Setting it to `confirmed` will attempt to generate a Stripe deposit link against the **live** Stripe key (`booking.js:209`); the deposit is $0 on this row after the quote rebuild only if you leave `deposit_amount` at 0 — if it is non-zero a real Stripe Checkout session is created. That costs nothing and charges nobody, but note the session id if one appears.
5. **Accept:** click Accept on the client page. Confirm the status flips to `accepted`, a `Quote accepted by client` row lands in the booking's activity log, and `email_log` holds a row for the owner notification with `status='sent'`. That send is REAL — the allowlist is not suppressing anything — which is why the test booking's address must be the owner's own.

Record the actual numbers seen at each step. A gate that was not run is a gate that failed.

- [ ] **Step 3: Update the roadmap and commit**

Add a Phase 3 completion entry to `docs/ROADMAP.md` noting: `booking_items` live, backfilled row counts as actually reported by the script, legacy columns still populated, deprecation window open.

```bash
git add docs/ROADMAP.md
git commit -m "docs: Phase 3 complete — booking_items and client quote accept

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push and deploy — one publish for the whole phase**

```bash
git push origin main
git ls-remote origin main    # confirm the SHA actually arrived
```

Then **manually** trigger the deploy — pushing does nothing on its own:
`https://app.netlify.com/projects/funkymonkeyadmin/deploys` → **Trigger deploy → Deploy site**.

- [ ] **Step 5: Verify the deploy actually published**

Two checks, per [[deploys-do-not-happen-on-push]]. A `state: ready` on the old deploy id means nothing shipped.

```bash
# Functional probe: the new endpoint must exist. 400 (bad body) proves the
# function is live; 404 means the old bundle is still being served.
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://funkymonkeyadmin.netlify.app/api/accept-quote \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: `400`. A `404` means the deploy did not publish — go back to Step 4.

Then read `currentDeploy.id` via the Netlify connector's `get-project` and confirm it **changed**.

Do **not** probe `automations-scheduled` over HTTP to test the deploy — it would run the batch and send real mail.

- [ ] **Step 6: Rotate the Stripe key and Neon connection string**

Joe's decision on 2026-08-01 was to batch this with the Phase 3 deploy rather than defer it further. Both secrets sat readable in plaintext for months (see [[production-env-truth]]).

1. **Stripe:** dashboard → Developers → API keys → roll the live secret key. Copy the new `sk_live_…`.
2. **Neon:** console → the project's role → reset password. Copy the new connection string.
3. **Netlify:** `https://app.netlify.com/projects/funkymonkeyadmin/configuration/env` → update `STRIPE_SECRET_KEY` and `DATABASE_URL` **in the dashboard**. Never via the MCP connector — its writes report success without persisting, and one previous attempt left a live variable in a shape nobody asked for ([[netlify-connector-env-writes-unreliable]]).
4. Trigger a redeploy so the functions pick up the new values.
5. **Verify, do not assume:**

```bash
# /api/health is admin-only, so this proves the DB connection works end to end.
curl -s -o /dev/null -w "%{http_code}\n" https://funkymonkeyadmin.netlify.app/api/health
# Expected: 401 — the function is live and rejecting an unauthenticated caller.
```

Then log into the admin UI, open `/api/health`, and confirm it reports the Stripe key as live-mode and the database as reachable. Finally open one booking and confirm the list still loads — that is the real proof `DATABASE_URL` took.

If `STRIPE_WEBHOOK_SECRET` is unchanged, the webhook keeps working; rolling the secret key does not invalidate it. Do not touch it.

---

## Self-Review

**Spec coverage.** Phase 3 has three numbered requirements plus a gate:

| Spec requirement | Task |
|---|---|
| 1. `booking_items` table, backfill, changelog coverage | Task 1 (table), Task 2 (backfill), Task 3 Step 3 (`Quote items changed` changelog line) |
| 2. Admin UI: build a multi-service quote | Task 5 |
| 3. Client accept: `quoted` → `accepted`, Accept button, endpoint, owner notification | Task 6 (endpoint + notification), Task 7 (button + transition in the UI) |
| Gate: 3-service package in client view, invoice PDF, accounting export | Task 4 (all three read paths), Task 8 Step 2 (the gate itself) |
| Rollback: legacy `service_*` kept populated | Global Constraints; enforced in Task 3, verified in Task 8 Step 2 |
| Risk: migration corrupts 632 real bookings | Task 2 — additive only, dry-run default, snapshot rollback, `pre-phase-3` tag in Task 0 |

Task 0 is not in the spec; it exists because the pre-flight state made it a prerequisite, and Joe chose it explicitly.

**Placeholder scan.** No TBDs, no "add error handling", no "similar to Task N". Every code step carries the code. The one deliberate deferral is the `ponytail:` note on `MAX_ITEMS` in `_items.js`, which names its own ceiling.

**Type consistency.** `rollupItems` returns the same seven keys everywhere it is consumed (Tasks 3, 4, 5). `normaliseItems` output shape (`service_id, name, price, quantity, kind, sort_order`) matches the `booking_items` columns, the `itemRowHtml` fields, and `readItemRows` output. `acceptOutcome({rowCount, current})` has one signature, used identically in the handler and the test. `getItems` / `getItemsForBookings` both return rows with `price` cast to `float8`, so no consumer has to handle `pg`'s NUMERIC-as-string.

**One known gap, stated rather than hidden.** `create-stripe-link.js` and `stripe-webhook.js` still read `booking.service_name` for the Stripe line-item description. With a multi-service package that becomes the joined string, which is correct but can exceed what Stripe renders comfortably. It is cosmetic, affects only the Stripe checkout page, and is left alone deliberately — reopening the money path is not worth it inside this phase. Worth a one-line truncation in Phase 4 when that file is touched anyway.
