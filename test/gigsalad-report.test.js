const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsm = require('node:fs');
const { platformReconciliationRows } = require('../netlify/functions/accounting-export.js');

const SRC = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/accounting-export.js'), 'utf8');

const paid = { reference: 'GS-1', status: 'completed', event_date: '2026-07-25', client_name: 'Amanda',
  service_name: 'Teen Birthday Party Magic Show', source: 'gigsalad', total_price: '385.00',
  deposit_amount: '20.00', platform_payout: '365.75', platform_payout_at: '2026-07-27' };
const due = { reference: 'GS-2', status: 'confirmed', event_date: '2026-11-07', client_name: 'Mike',
  service_name: 'House Party Magic Show', source: 'gigsalad', total_price: '485.00',
  deposit_amount: '20.00', platform_payout: null, platform_payout_at: null };

test('the cut is what we billed minus what actually landed', () => {
  const [row] = platformReconciliationRows([paid]);
  assert.strictEqual(row.platform_cut, 19.25);
  assert.strictEqual(row.payout, 365.75);
  assert.strictEqual(row.payout_status, 'paid');
});

// The trap this report exists to avoid. A payout that has not arrived is NULL,
// not zero: subtracting from zero would print the entire fee as though GigSalad
// had kept everything, which is the $100-deposit-default bug in a new column.
test('a payout that has not arrived is blank, never zero', () => {
  const [row] = platformReconciliationRows([due]);
  assert.strictEqual(row.payout, null, 'an un-arrived payout must not become 0');
  assert.strictEqual(row.platform_cut, null, 'and its cut is unknowable, not the whole price');
  assert.strictEqual(row.payout_status, 'due');
});

test('a genuine zero payout is not confused with an absent one', () => {
  const [row] = platformReconciliationRows([{ ...due, platform_payout: '0.00', platform_payout_at: '2026-11-09' }]);
  assert.strictEqual(row.payout, 0);
  assert.strictEqual(row.platform_cut, 485, 'they kept all of it — that is a fact, and different from unknown');
  assert.strictEqual(row.payout_status, 'paid');
});

// "How much money has reached me", not "how much is promised".
test('the total sums only what actually landed', () => {
  const rows = platformReconciliationRows([paid, due]);
  const total = rows[rows.length - 1];
  assert.strictEqual(total.reference, 'TOTAL');
  assert.strictEqual(total.total_price, 870, 'our price counts both gigs');
  assert.strictEqual(total.payout, 365.75, 'only the arrived payout');
  assert.strictEqual(total.platform_cut, 19.25);
  assert.strictEqual(total.payout_status, '1 awaiting payout');
});

test('no platform bookings means no spurious TOTAL row', () => {
  assert.deepStrictEqual(platformReconciliationRows([]), []);
});

test('money arithmetic does not drift into floating-point noise', () => {
  const rows = platformReconciliationRows([
    { ...paid, total_price: '385.10', platform_payout: '365.75' },
    { ...paid, reference: 'GS-3', total_price: '0.30', platform_payout: '0.10' },
  ]);
  assert.strictEqual(rows[0].platform_cut, 19.35);
  assert.strictEqual(rows[1].platform_cut, 0.2, 'not 0.19999999999999998');
  assert.strictEqual(rows[rows.length - 1].total_price, 385.4);
});

// The query side, which the pure function cannot cover.
test('the query selects platform bookings by source, not by reference prefix', () => {
  // To the end of the function body, not to the first '}' — which is the
  // destructuring in `const { rows }` and yields almost nothing to assert on.
  const q = SRC.split('async function getPlatformReconciliation')[1].split('return rows;')[0];
  assert.ok(/COALESCE\(b\.source, 'direct'\) <> 'direct'/.test(q),
    'anything not direct — so a platform added later needs no change here');
  assert.ok(!/GS-/.test(q), 'a reference prefix is a naming convention, not a fact about who collected');
  assert.ok(/b\.status <> 'cancelled'/.test(q), 'a cancelled gig has no money to reconcile');
  assert.ok(/event_date BETWEEN \$1 AND \$2/.test(q), 'it must honour the same date range as every other report');
});

test('the report is reachable as its own export type', () => {
  assert.ok(/case 'gigsalad':/.test(SRC));
  assert.ok(/gigsalad_reconciliation_\$\{startDate\}_to_\$\{endDate\}\.csv/.test(SRC), 'it needs its own filename');
  assert.ok(/label: 'Payout Received'/.test(SRC) && /label: 'Platform Cut'/.test(SRC));
});

// ── The wiring that feeds it ────────────────────────────────────────────────
const ADMIN = fsm.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const PATCH = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/booking.js'), 'utf8');
const CREATE = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/bookings.js'), 'utf8');
const FINALISE = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/_finalise.js'), 'utf8');

test('the columns exist and the payout one is nullable', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS platform_payout NUMERIC\(10,2\)"/.test(CREATE),
    'no DEFAULT 0 — absent and zero must stay distinguishable');
  assert.ok(/ADD COLUMN IF NOT EXISTS platform_payout_at DATE"/.test(CREATE));
});

test('an admin can record a payout and a client cannot', () => {
  assert.ok(/platform_payout:\s+"platform_payout"/.test(PATCH), 'admin PATCH must accept it');
  assert.ok(/platform_payout_at:\s+"platform_payout_at"/.test(PATCH));
  assert.ok(!/platform_payout/.test(FINALISE.split('const CLIENT_EDITABLE')[1].split(']')[0]),
    'it must not be client-editable — this is money we received, not a detail they supply');
});

// A cleared <input> posts ''. Postgres rejects that for NUMERIC and DATE, so
// the save would 500 — and the fix must be NULL, not 0.
test('clearing the payout stores NULL rather than failing or storing zero', () => {
  const numeric = PATCH.split("for (const f of ['guest_count'")[1].split(']')[0];
  assert.ok(/'platform_payout'/.test(numeric), 'blank payout must be coerced to null');
  const dates = PATCH.split("for (const f of ['event_date'")[1].split(']')[0];
  assert.ok(/'platform_payout_at'/.test(dates), 'blank payout date must be coerced to null');
});

test('the payout fields only appear on a platform booking', () => {
  assert.ok(/\$\{isPlatformBooked\(b\) \? `/.test(ADMIN), 'they are meaningless on a direct booking');
  assert.ok(/function isPlatformBooked\(b\)/.test(ADMIN));
  assert.ok(!/const platform = String\(b\.source \|\| 'direct'\)\.toLowerCase\(\) !== 'direct';/.test(ADMIN),
    'the inline copy must be gone — one predicate, like _source.js server-side');
});

test('the export is reachable from the admin UI', () => {
  assert.ok(/downloadExport\('gigsalad'\)/.test(ADMIN), 'a report nobody can press is not a report');
});
