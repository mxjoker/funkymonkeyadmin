# CRM Takeover Phase 4 — Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CRM becomes the system of record for intake, quoting and deposits. The Wix "Book Now" button points at `booking-form.html`, PPM goes read-only, and the final PPM export is reconciled into the CRM by `reference` with nothing lost.

**Architecture:** The cutover itself is a two-minute button change; everything expensive happens before it. A reconciliation script diffs the final PPM CSV export against `bookings` on the `reference` key (PPM's `Ref.`, the established strong key) and reports three buckets — missing from CRM, drifted, CRM-native — so the existing `import-bookings.js` can close the gap before the button moves. Two correctness gaps found on 2026-08-05 are fixed first because the cutover's own gate depends on them: the public booking form never declares a brand, and the server silently coerces any brand it does not recognise to `fme`.

**Tech Stack:** Node 20 CommonJS Netlify Functions, `pg` against Neon Postgres, `node --test` (no framework, no new dependencies), vanilla-JS single-file front ends.

**Spec:** `docs/superpowers/specs/2026-07-31-crm-takeover-design.md` (Phase 4, and Decision 4).

## Global Constraints

Copied verbatim from the spec and from project memory. Every task's requirements implicitly include this section.

- **`git push` does not deploy.** Every deploy needs a manual Trigger deploy at `https://app.netlify.com/projects/funkymonkeyadmin/deploys`. Joe conserves deploy credits — **this whole phase ships in ONE publish**, at Task 5. From [[deploys-do-not-happen-on-push]].
- **Netlify env vars must be written in the dashboard**, never via the MCP connector, whose writes report success without persisting. From [[netlify-connector-env-writes-unreliable]].
- **`npx netlify dev` runs against the LIVE Neon production database.** There is no local database. Anything a browser gate creates or edits is a real row in the production CRM alongside 668 real customer bookings.
- **`EMAIL_ALLOWLIST` state is UNVERIFIED as of 2026-08-05.** The spec says it should be active through Phases 1–3; commit `40a434b` says it was not. Task 0 establishes the truth. **Until Task 0 completes, assume every email this phase sends is REAL** and scope any email-touching gate to a booking whose `client_email` is the owner's own address.
- **Never bulk-delete booking rows.** 668 rows are real imported customer records. `created_at` is uniformly the 2026-05-07 import date, so judge urgency by `event_date`.
- **The seven statuses are `draft, review, quoted, accepted, confirmed, completed, cancelled`.** `pending` was retired and its last nine rows were migrated on 2026-08-05. Do not reintroduce it.
- **`IS NOT NULL` is a dead test on any text column in this schema** — every text column is `DEFAULT ''`. Use `COALESCE(col,'') <> ''`. From [[silent-failure-bug-class]] instance 6.
- **Never let a failure path report success.** Any check that cannot fail is a bug, not a safeguard. This codebase's recurring defect, ten instances and counting. From [[silent-failure-bug-class]].
- **No direct `api.resend.com` calls in new code.** Use `sendEmail` from `_email.js`. `test/_email.test.js:110` is a repo-wide source scan over every function except _email.js, and it currently passes — there are no grandfathered exceptions left.
- **`total_price` excludes travel.** `balance_due = max(0, total_price + mileage_cost - deposit_amount)`. From [[money-path-invariants]].
- **Dry run before apply, always.** Every script in this repo defaults to dry run and requires an explicit `--apply`. Follow that convention.

---

## Pre-flight state (verified 2026-08-05, do not re-derive)

- `main` is at `b26083f`, pushed, and **published** — live `admin.html` is byte-identical to local.
- Phases 1, 2 and 3 are complete. Phase 2's gate passed for real: booking 683 / ref `26-301`, $1.00 live charge, `deposit_paid=true`, webhook fired. See [[crm-takeover-phase-status]].
- `bookings` holds **zero** `pending` rows. Status spread: 581 completed, 66 confirmed, 9 review, 8 accepted, 2 cancelled, 2 quoted.
- 489 bookings were linked to catalogue services on 2026-08-05; `import-bookings.js` now writes `service_id` on insert. ~176 rows remain unlinked because their names are genuinely ambiguous ("Custom Event" ×159, "Magic Show" ×11, one-off titles). See [[staffing-hinges-on-service-id]].
- `import-data.csv` at the repo root is a **29-row sample** export, not the final one. Its header row is the authoritative column list; `Ref.` is column 33.
- Designated test booking from Phase 3: **`FM-E5EFPPQX`, id 717**. Reuse it. Do not create additional test bookings and do not delete any other row.
- Three credentials have never been rotated and sat in plaintext for months: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`. See [[production-env-truth]].

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/reconcile-ppm-export.js` | **Create.** Diffs a PPM CSV export against `bookings` on `reference`. Read-only, always. Never writes. |
| `netlify/functions/_csv.js` | **Create.** The RFC-4180-ish line parser currently trapped inside `import-bookings.js`, extracted so the reconciler and the importer share one implementation. |
| `netlify/functions/import-bookings.js` | **Modify.** Consume `_csv.js` instead of its private copy. |
| `netlify/functions/bookings.js:412` | **Modify.** Stop silently coercing unknown brands to `fme`. |
| `booking-form.html` | **Modify.** Declare the brand on submit. |
| `test/csv.test.js` | **Create.** Parser edge cases — quoted commas, embedded quotes, trailing empties. |
| `test/brand.test.js` | **Create.** Brand normalisation must reject, not coerce. |
| `docs/CUTOVER.md` | **Create.** The runbook Joe follows on the day, and the rollback. |

---

## Task 0: Establish credential and allowlist truth

**Files:** none — this is verification against the live deployment, performed by the owner.

**Interfaces:**
- Consumes: nothing
- Produces: a known-good `EMAIL_ALLOWLIST` state that Task 5 depends on; rotated credentials

This task is owner-side and blocks nothing else in the plan except Task 5. Run it first anyway — a rotation that breaks something should surface while PPM is still a live fallback, not after.

- [ ] **Step 1: Read the health endpoint and record every line**

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://funkymonkeyadmin.netlify.app/api/health | python3 -m json.tool
```

Record `email_allowlist`, `stripe_key` (live vs test), `stripe_webhook_secret`, `resend_key`, and `last_successful_email` verbatim into `docs/CUTOVER.md` under a "Pre-cutover state" heading. This is the before-picture; a rotation that silently breaks something is only detectable against it.

- [ ] **Step 2: Decide the allowlist, explicitly**

The spec says clear `EMAIL_ALLOWLIST` at cutover. If Step 1 shows it already clear, that is the intended end state — record that it was already clear and move on. If it is set, leave it set until Task 5 and clear it there, so the cutover's own test booking is the first real send.

Do not change it in this step either way. The point is to know.

- [ ] **Step 3: Rotate `RESEND_API_KEY`**

Resend has no roll operation — keys are create-and-delete only, so the order is create → deploy → verify → delete.

1. Resend dashboard → API Keys → Create, **Full access**.
2. Netlify → Site configuration → Environment variables → update `RESEND_API_KEY`. **Dashboard, not the connector.**
3. Do NOT trigger a deploy yet — Task 5 is the single publish. The old key stays valid until Step 6, so nothing breaks in the meantime.

- [ ] **Step 4: Rotate `STRIPE_SECRET_KEY`**

Stripe → Developers → API keys → roll the secret key with an overlap window. Put the new `sk_live_…` into Netlify. Same deferral: do not deploy yet.

- [ ] **Step 5: Rotate `STRIPE_WEBHOOK_SECRET`**

Stripe → Developers → Webhooks → the endpoint pointing at `funkymonkeyadmin.netlify.app/api/stripe-webhook` → Signing secret → Reveal / roll. This is per-endpoint, not per-account, and rotating the API key does not change it.

`stripe-webhook.js:22-26` is fail-closed: a wrong secret does not create a security hole, it makes every deposit silently never confirm. That failure mode is exactly why Task 5's gate re-runs a real charge.

- [ ] **Step 6: After Task 5's deploy — verify, then revoke**

Deferred to Task 5 Step 8. Old credentials are revoked only after the new ones are proven live. Note it here so it is not forgotten:
- Resend → delete the old key (and the unused "Local FM test" key, once Resend's Logs page confirms it has no sends in the last 30 days).
- Stripe → revoke the old secret key.

---

## Task 1: Extract the CSV parser

**Files:**
- Create: `netlify/functions/_csv.js`
- Modify: `netlify/functions/import-bookings.js:96-109` (delete the private copy), and its `require` block
- Test: `test/csv.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `parseCSVLine(line) -> string[]`, `parseCSV(text) -> { headers: string[], rows: object[] }`. Task 2's reconciler consumes both.

Reconciliation must parse the same CSV the importer parses, with the same quirks, or the diff is meaningless. Two copies of a CSV parser is the bug, not the duplication.

- [ ] **Step 1: Write the failing test**

Create `test/csv.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCSVLine, parseCSV } = require('../netlify/functions/_csv');

test('a quoted field containing a comma stays one field', () => {
  // Real PPM data: "Addr. line 1" is routinely "306 Stephany dr, Apt 2".
  assert.deepStrictEqual(
    parseCSVLine('"a","b, still b","c"'),
    ['a', 'b, still b', 'c']
  );
});

test('unquoted fields are trimmed', () => {
  assert.deepStrictEqual(parseCSVLine('a, b ,c'), ['a', 'b', 'c']);
});

test('trailing empty fields are preserved, not dropped', () => {
  // PPM exports 60+ columns and pads the tail with empties. Dropping them
  // shifts every subsequent column and silently mis-maps the whole row.
  assert.deepStrictEqual(parseCSVLine('a,b,,'), ['a', 'b', '', '']);
});

test('an empty line yields one empty field, never a crash', () => {
  assert.deepStrictEqual(parseCSVLine(''), ['']);
});

test('parseCSV maps rows onto headers by name', () => {
  const { headers, rows } = parseCSV('"Ref.","Client name"\n"26-250","Kiley Mixon"');
  assert.deepStrictEqual(headers, ['Ref.', 'Client name']);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]['Ref.'], '26-250');
  assert.strictEqual(rows[0]['Client name'], 'Kiley Mixon');
});

test('a row with fewer fields than headers yields empty strings, not undefined', () => {
  // '' matches this schema's DEFAULT '' convention; undefined would make
  // COALESCE-style guards downstream behave differently for short rows.
  const { rows } = parseCSV('"a","b","c"\n"1"');
  assert.strictEqual(rows[0].b, '');
  assert.strictEqual(rows[0].c, '');
});

test('a blank trailing line does not become a phantom row', () => {
  const { rows } = parseCSV('"Ref."\n"26-250"\n\n');
  assert.strictEqual(rows.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/csv.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_csv'`

- [ ] **Step 3: Create the module**

Create `netlify/functions/_csv.js`. The `parseCSVLine` body is moved verbatim from `import-bookings.js:96-109` — do not rewrite it, its trimming and quote handling are what the existing 668-row import was built against.

```js
// Extracted from import-bookings.js so the importer and
// scripts/reconcile-ppm-export.js parse the PPM export identically. A second
// implementation would make a reconciliation diff meaningless: it could report
// drift that is really just two parsers disagreeing.

// Splits one CSV line, honouring double-quoted fields that contain commas.
// Trailing empty fields are preserved — PPM pads its 60+ column export with
// them, and dropping them shifts every later column.
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

// Parses a whole export into header-keyed objects. Short rows are padded with
// '' rather than left undefined, matching this schema's DEFAULT '' convention.
function parseCSV(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const fields = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] !== undefined ? fields[i] : ''; });
    return obj;
  });

  return { headers, rows };
}

module.exports = { parseCSVLine, parseCSV };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/csv.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point the importer at the shared module**

In `netlify/functions/import-bookings.js`, delete the private `parseCSVLine` function (lines 96-109) and add to the require block near `_service-map`:

```js
const { parseCSVLine } = require('./_csv');
```

- [ ] **Step 6: Verify nothing else regressed**

Run: `npm test`
Expected: PASS, 120 tests (114 existing + 6 new).

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_csv.js netlify/functions/import-bookings.js test/csv.test.js
git commit -m "refactor: share one CSV parser between the importer and reconciliation"
```

---

## Task 2: The reconciliation report

**Files:**
- Create: `scripts/reconcile-ppm-export.js`
- Test: none — this script only reads, and its logic is set arithmetic over data the tests cannot fixture honestly. Its correctness is established by running it against the real export in Step 3.

**Interfaces:**
- Consumes: `parseCSV` from `netlify/functions/_csv.js` (Task 1)
- Produces: a three-bucket report the owner acts on before the button moves

**This script must never write.** Remediation is `import-bookings.js`, which already has its own dry run. Keeping the reader and the writer separate means a reconciliation run can never itself corrupt the thing it is measuring.

- [ ] **Step 1: Write the script**

Create `scripts/reconcile-ppm-export.js`:

```js
#!/usr/bin/env node
/**
 * Read-only: diff a PPM CSV export against the CRM's bookings table.
 *
 * This is the last gate before the Wix button moves. PPM's `Ref.` (e.g.
 * "26-250") is the established strong key and lands in bookings.reference
 * unchanged, so the diff is an exact join — no fuzzy name or date matching,
 * which would invent matches that are not there.
 *
 * Three buckets:
 *   MISSING  — in the export, not in the CRM. These are the in-flight bookings
 *              a cutover would lose. Remediate with import-bookings.js.
 *   DRIFTED  — in both, but event_date / status / total disagree. PPM is the
 *              source of truth until the button moves, so PPM wins.
 *   CRM-ONLY — in the CRM, not the export. Expected and fine: bookings taken
 *              through the CRM form, plus every historical row PPM has since
 *              archived. Reported as a count, not a list, unless --verbose.
 *
 *   node scripts/reconcile-ppm-export.js <export.csv>
 *   node scripts/reconcile-ppm-export.js <export.csv> --verbose
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
const { parseCSV } = require('../netlify/functions/_csv');

const VERBOSE = process.argv.includes('--verbose');
const csvPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

// Mirrors import-bookings.js STATUS_MAP. Duplicated deliberately: that map is
// an import-time transform, and coupling this comparison to it would mean a
// future edit there silently changes what "drift" means here.
const STATUS_MAP = {
  'Confirmed': 'confirmed',
  'Confirmed+': 'confirmed',
  'Balance settled': 'completed',
  'Processing': 'accepted',
  'Pending': 'review',
  'Unprocessed': 'review',
  'Cancelled': 'cancelled',
  'Dropped / Cancelled': 'cancelled',
  'Completed': 'completed',
};

// "29 May 2026" -> "2026-05-29". Returns '' for anything unparseable rather
// than throwing: one malformed date must not abort a 600-row reconciliation.
const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                 Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function ppmDate(s) {
  const [d, m, y] = String(s || '').trim().split(/\s+/);
  if (!d || !MONTHS[m] || !y) return '';
  return `${y}-${MONTHS[m]}-${String(d).padStart(2, '0')}`;
}

const money = (s) => Number(String(s || '0').replace(/[^0-9.-]/g, '')) || 0;

async function main() {
  if (!csvPath) {
    console.error('Usage: node scripts/reconcile-ppm-export.js <export.csv> [--verbose]');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`No such file: ${csvPath}`);
    process.exit(1);
  }

  const { headers, rows } = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (!headers.includes('Ref.')) {
    console.error(`Export has no "Ref." column — got: ${headers.slice(0, 8).join(', ')}…`);
    console.error('Without the join key this reconciliation cannot run. Re-export from PPM.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const { rows: crmRows } = await pool.query(
      `SELECT reference, status, event_date::text AS event_date, total_price::float8 AS total_price
       FROM bookings WHERE COALESCE(reference,'') <> ''`
    );
    const crm = new Map(crmRows.map((r) => [r.reference.trim().toUpperCase(), r]));

    const missing = [];
    const drifted = [];
    const seen = new Set();

    for (const row of rows) {
      const ref = String(row['Ref.'] || '').trim().toUpperCase();
      if (!ref) continue;
      seen.add(ref);

      const found = crm.get(ref);
      if (!found) {
        missing.push({
          ref,
          client: row['Client name'] || '',
          date: ppmDate(row['Event date']),
          status: STATUS_MAP[row['Event status']] || 'review',
          total: money(row['Tot. price']),
        });
        continue;
      }

      const deltas = [];
      const ppmStatus = STATUS_MAP[row['Event status']] || 'review';
      const ppmEventDate = ppmDate(row['Event date']);
      const ppmTotal = money(row['Tot. price']);

      if (ppmEventDate && ppmEventDate !== found.event_date) {
        deltas.push(`event_date PPM=${ppmEventDate} CRM=${found.event_date}`);
      }
      if (ppmStatus !== found.status) {
        deltas.push(`status PPM=${ppmStatus} CRM=${found.status}`);
      }
      // Cent-level tolerance: both sides round independently.
      if (Math.abs(ppmTotal - Number(found.total_price)) > 0.01) {
        deltas.push(`total PPM=${ppmTotal.toFixed(2)} CRM=${Number(found.total_price).toFixed(2)}`);
      }
      if (deltas.length) drifted.push({ ref, client: row['Client name'] || '', deltas });
    }

    const crmOnly = crmRows.filter((r) => !seen.has(r.reference.trim().toUpperCase()));

    console.log(`PPM export:   ${rows.length} rows`);
    console.log(`CRM bookings: ${crmRows.length} with a reference\n`);

    console.log(`── MISSING from CRM (${missing.length}) — these are lost if the button moves now`);
    for (const m of missing) {
      console.log(`   ${m.ref.padEnd(10)} ${m.date || '(no date)'}  ${m.status.padEnd(10)} $${m.total.toFixed(2)}  ${m.client}`);
    }

    console.log(`\n── DRIFTED (${drifted.length}) — PPM is source of truth until cutover`);
    for (const d of drifted) {
      console.log(`   ${d.ref.padEnd(10)} ${d.client}`);
      for (const delta of d.deltas) console.log(`      ${delta}`);
    }

    console.log(`\n── CRM-only (${crmOnly.length}) — expected: CRM-native bookings + PPM's archived history`);
    if (VERBOSE) {
      for (const c of crmOnly) console.log(`   ${c.reference.padEnd(12)} ${c.event_date}  ${c.status}`);
    } else {
      console.log('   (re-run with --verbose to list)');
    }

    console.log(`\nCutover is safe when MISSING is 0 and every DRIFTED row has been`);
    console.log(`reconciled by hand or accepted as known.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Smoke-test against the sample export**

Run: `node scripts/reconcile-ppm-export.js import-data.csv`

Expected: it completes and prints three buckets. `import-data.csv` is a 29-row sample already imported, so MISSING should be at or near 0. A large MISSING count here means the `Ref.` join is broken — stop and investigate before trusting it on the real export.

- [ ] **Step 3: Verify the failure paths actually fail**

Two checks, because a reconciliation that cannot report a problem is worse than none:

```bash
node scripts/reconcile-ppm-export.js /nonexistent.csv          # expect: "No such file", exit 1
printf '"a","b"\n"1","2"\n' > /tmp/noref.csv
node scripts/reconcile-ppm-export.js /tmp/noref.csv            # expect: 'no "Ref." column', exit 1
```

Confirm both exit non-zero. If either prints a clean report instead, the guard is decorative — fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/reconcile-ppm-export.js
git commit -m "feat: read-only PPM export reconciliation on the reference key"
```

---

## Task 3: Brand attribution

**Files:**
- Modify: `netlify/functions/bookings.js:412`
- Modify: `booking-form.html` (the submit payload)
- Test: `test/brand.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `normaliseBrand(input) -> 'fme'|'jcm'|'fmms'` exported from `bookings.js`, consumed by Task 5's gate

**Why this is in Phase 4 and not Phase 5.** The spec's Phase 4 gate is "a real test booking placed through the Wix button lands in the CRM with **correct brand attribution**." Verified 2026-08-05: `booking-form.html` never sends `brand` at all, and `bookings.js:412` reads `b.brand === 'jcm' ? 'jcm' : 'fme'` — a binary coercion that turns anything unrecognised into `fme` without a word. Every public booking is therefore `fme` by accident rather than by decision, and the gate as written cannot fail. That is [[silent-failure-bug-class]] again, and it also pre-breaks Phase 5: the moment `fmms` exists, line 412 silently swallows it.

- [ ] **Step 1: Write the failing test**

Create `test/brand.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normaliseBrand } = require('../netlify/functions/bookings');

// The business is one company (FME) with JCM as Joe's premium tier and FMMS
// taking lower-paid magic work without eroding JCM's rates. A brand field that
// silently collapses to 'fme' destroys exactly the distinction that protects
// those rates.

test('each real brand survives unchanged', () => {
  assert.strictEqual(normaliseBrand('fme'), 'fme');
  assert.strictEqual(normaliseBrand('jcm'), 'jcm');
  assert.strictEqual(normaliseBrand('fmms'), 'fmms');
});

test('case and surrounding space do not matter', () => {
  assert.strictEqual(normaliseBrand('  JCM '), 'jcm');
});

test('an absent brand defaults to fme', () => {
  // Matches the column default and every historical row.
  assert.strictEqual(normaliseBrand(''), 'fme');
  assert.strictEqual(normaliseBrand(null), 'fme');
  assert.strictEqual(normaliseBrand(undefined), 'fme');
});

test('an unrecognised brand throws instead of becoming fme', () => {
  // The old line 412 coerced silently. A typo'd brand must be loud: it is a
  // revenue-attribution error, and the previous behaviour made it invisible.
  assert.throws(() => normaliseBrand('jmc'), /unknown brand/i);
  assert.throws(() => normaliseBrand('funky'), /unknown brand/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/brand.test.js`
Expected: FAIL — `normaliseBrand is not a function`

- [ ] **Step 3: Implement `normaliseBrand`**

In `netlify/functions/bookings.js`, near the top with the other constants:

```js
// The three brand tiers. FME is the company; JCM is Joe's premium service; FMMS
// takes lower-paid magic work so it does not erode JCM's rates. A silent
// coercion here misattributes revenue between tiers, so an unknown value throws.
const BRANDS = new Set(['fme', 'jcm', 'fmms']);

function normaliseBrand(input) {
  const b = String(input == null ? '' : input).trim().toLowerCase();
  if (b === '') return 'fme';
  if (!BRANDS.has(b)) throw new Error(`unknown brand: ${b}`);
  return b;
}
```

Replace line 412's `b.brand === 'jcm' ? 'jcm' : 'fme',` with `normaliseBrand(b.brand),`.

Export it alongside whatever `bookings.js` already exports:

```js
module.exports.normaliseBrand = normaliseBrand;
```

- [ ] **Step 4: Make the throw a 400, not a 500**

`normaliseBrand` throws, and an uncaught throw in the POST handler becomes an opaque 500. Wrap the call site so a bad brand tells the caller what is wrong. In the POST validation block, before the insert:

```js
let brand;
try {
  brand = normaliseBrand(b.brand);
} catch (e) {
  return json(400, { error: e.message });
}
```

Then pass `brand` into the insert in place of the inline call.

- [ ] **Step 5: Run the tests**

Run: `node --test test/brand.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Declare the brand on the public form**

`booking-form.html` posts to `/api/bookings`. Find the submit payload and add the brand explicitly:

```js
// funkymonkeyevents.com is the FME brand. Sent explicitly rather than relying
// on the column default so the wire format says what it means — and so a future
// jcm/fmms landing page is a one-line change here, not a schema question.
brand: 'fme',
```

- [ ] **Step 7: Verify the whole suite**

Run: `npm test`
Expected: PASS, 124 tests.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/bookings.js booking-form.html test/brand.test.js
git commit -m "fix: brand attribution rejects unknown values instead of coercing to fme"
```

---

## Task 4: The cutover runbook

**Files:**
- Create: `docs/CUTOVER.md`

**Interfaces:**
- Consumes: Tasks 0–3
- Produces: the document Joe follows on the day

A runbook written during the cutover is written under pressure. Write it now, execute it in Task 5.

- [ ] **Step 1: Write `docs/CUTOVER.md`**

```markdown
# PPM → CRM Cutover Runbook

**Rollback at every stage is repointing the Wix button back. Two minutes.**

## Pre-cutover state
(Filled in by Phase 4 Task 0 Step 1 — health output, verbatim.)

## Order of operations

1. **Freeze PPM.** Stop taking new bookings there. Announce nothing publicly yet.
2. **Final export.** PPM → export all bookings to CSV. Save as `ppm-final-export.csv`.
3. **Reconcile.**
   `node scripts/reconcile-ppm-export.js ppm-final-export.csv`
   Do not proceed while MISSING > 0.
4. **Close the gap.** For each MISSING row:
   `node netlify/functions/import-bookings.js` — dry run first, then apply.
   Re-run the reconciler until MISSING is 0.
5. **Link services.** `node scripts/backfill-service-ids.js` (dry run, then
   `--apply`). Newly imported rows carry a service_id already; this catches
   anything the map could not resolve and lists what needs a human.
6. **Deploy.** Netlify → Trigger deploy. The single publish for Phase 4.
7. **Verify** (see Gate below).
8. **Move the button.** Wix → the Book Now button → change its target to
   `https://funkymonkeyadmin.netlify.app/booking-form.html`.
9. **PPM read-only.** Leave the account live for historical lookup. Do not
   cancel the subscription until one full booking cycle has run through the CRM.
10. **Revoke old credentials** (Phase 4 Task 0 Step 6).

## Gate

A real test booking through the live Wix button that:
- lands in the CRM with `brand = 'fme'`
- generates a working Stripe deposit link
- takes a real $1 charge that flips status to `confirmed` via the webhook
- sends a confirmation email that arrives

Refund the $1 afterwards.

## Rollback

- **Button:** repoint at PPM. Two minutes, and it is the only one-way door.
- **Code:** `git revert <phase-4 commits>` then Trigger deploy.
- **Imported rows:** identify by `reference` from the reconciler's MISSING list.
  Never bulk-delete; 668 rows are real customers.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CUTOVER.md
git commit -m "docs: cutover runbook and rollback"
```

---

## Task 5: Execute the cutover

**Files:** none — this executes against production.

**Interfaces:**
- Consumes: everything above
- Produces: the go/no-go for Phase 5

**This is the phase's single publish.** Everything from Tasks 1–5 ships in one Trigger deploy.

- [ ] **Step 1: Tag the rollback point**

```bash
git tag pre-phase-4 && git push --tags
```

- [ ] **Step 2: Freeze PPM and take the final export**

Follow `docs/CUTOVER.md` steps 1–2.

- [ ] **Step 3: Reconcile until MISSING is 0**

Follow `docs/CUTOVER.md` steps 3–5. This is the step that takes real time; do not rush it and do not skip a DRIFTED row by assuming PPM and the CRM agree.

- [ ] **Step 4: Merge and publish**

```bash
git checkout main && git merge <phase-4 branch> && git push
```

Then Netlify → Trigger deploy. Wait for "Published".

- [ ] **Step 5: Verify the deploy actually published**

`git push` does not deploy, and a green checkmark is not proof the new bytes are being served. Diff the live file against local:

```bash
curl -s https://funkymonkeyadmin.netlify.app/booking-form.html -o /tmp/live-form.html
grep -c "brand" /tmp/live-form.html   # expect >= 1
```

- [ ] **Step 6: Clear `EMAIL_ALLOWLIST` if Task 0 found it set**

Netlify dashboard → remove the variable → Trigger deploy. Skip entirely if Task 0 Step 2 recorded it already clear.

- [ ] **Step 7: Run the gate**

Follow the Gate section of `docs/CUTOVER.md`. All four conditions, in order. A failure at any one stops the cutover — the button has not moved yet, so nothing is lost.

Then move the button (`docs/CUTOVER.md` step 8) and repeat the gate once through the live Wix path.

- [ ] **Step 8: Revoke the old credentials**

Only now, with the new ones proven live: Task 0 Step 6.

- [ ] **Step 9: Record the outcome**

Append the result to `docs/CUTOVER.md` — date, test booking reference, Stripe charge id, and anything that surprised you.

```bash
git add docs/CUTOVER.md
git commit -m "docs: cutover executed <date>"
```

---

## Task 6: Housekeeping

**Files:**
- Modify: `.gitignore`
- Modify: `docs/ROADMAP.md`

Small, real, and cheap to lose track of. Not blocking; do it while the reconciliation runs.

- [ ] **Step 1: Deal with `deno.lock`**

An untracked Deno lockfile in a Node project, present since before 2026-08-05. Nothing in the repo reads it. Delete it, and ignore it so it does not reappear:

```bash
rm -f deno.lock
printf '\n# Stray Deno lockfile — this is a Node project\ndeno.lock\n' >> .gitignore
```

- [ ] **Step 2: Reconcile the ROADMAP with reality**

`docs/ROADMAP.md:75` already carries an "## SMS (removed)" section, so Phase 1's item is done. Add Phase 4's outcome and strike anything the takeover has since made false.

- [ ] **Step 3: Commit**

```bash
git add .gitignore docs/ROADMAP.md
git commit -m "chore: ignore the stray deno lockfile, refresh the roadmap"
```

---

## Explicitly out of scope

Recorded so they are decisions, not oversights:

- **Multi-service bookings only staff their first service line.** `rollupItems()` takes `services[0]`, so booking 717 ("Foam Party + Face Painting + Cotton Candy") resolves staff for the foam party alone. Real, but it lives in the staffing subsystem, which Connecteam has already won (spec Decision 3) and which no staff member has ever logged into. Fix it when staffing is actually used.
- **~176 bookings remain unlinked to a catalogue service.** "Custom Event" (159), "Magic Show" (11) and one-off titles are genuinely ambiguous; adding them to `_service-map.js` would be guessing. They surface in the admin as unlinked and get resolved by hand.
- **Phase 5 (the `fmms` brand tier).** Task 3 makes the column ready — `normaliseBrand` already accepts `fmms` — but the admin UI and the revenue reporting that separates the tiers are Phase 5's work.
- **The Astro website and DNS cutover.** Separate project, per spec Decision 4. Phase 4 patches the existing Wix button only.
- **Splitting `admin.html`.** 302 KB in one file. Separate sub-project, per the spec's non-goals.

---

## Self-review notes

- **Spec coverage.** Phase 4's four spec requirements map to: reconciliation → Task 2 + Task 5 Step 3; Wix button → Task 4 + Task 5 Step 7; PPM read-only → `docs/CUTOVER.md` step 9; clear `EMAIL_ALLOWLIST` → Task 0 Step 2 + Task 5 Step 6. The spec's gate ("correct brand attribution") could not be met as written — `booking-form.html` sends no brand — so Task 3 was added to make the gate capable of failing.
- **Ordering.** Task 0 is owner-side and blocks only Task 5, so it runs in parallel. Task 1 must precede Task 2 (shared parser). Task 3 is independent of Tasks 1–2.
- **One publish.** Tasks 1–4 commit but never deploy. Task 5 Step 4 is the only Trigger deploy in the phase.
- **Removed mid-write.** A task to consolidate `auth.js` and `test-email.js` onto `sendEmail` was drafted and cut: both already route through it, and its proposed test duplicated the passing scan in `test/_email.test.js`. A test that cannot fail is the exact defect this plan warns about elsewhere.
