const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

// Same trick as test/bookings-sort.test.js: run the PURE HELPERS block in a
// bare context so a stray reach for `document` throws instead of silently
// passing.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { overpaidBookings };', ctx);
  return ctx.out;
}

const { overpaidBookings } = loadHelpers();

// stripe-webhook.js's paymentEffect sets bookings.overpayment_amount when a
// deposit payment would have raised balance_due or regressed status on an
// already-settled booking — see stripe-webhook.js's comment. This is the
// dashboard banner's counting logic.
test('overpaidBookings: counts only bookings with a positive overpayment_amount', () => {
  const bookings = [
    { id: 1, overpayment_amount: 100 },
    { id: 2, overpayment_amount: null },
    { id: 3 },
    { id: 4, overpayment_amount: 0 },
    { id: 5, overpayment_amount: 42.5 },
  ];
  assert.deepStrictEqual(overpaidBookings(bookings).map(b => b.id), [1, 5]);
});

test('overpaidBookings: a string from Postgres NUMERIC still counts', () => {
  // node-postgres returns NUMERIC columns as strings, not numbers.
  assert.strictEqual(overpaidBookings([{ id: 1, overpayment_amount: '100.00' }]).length, 1);
});

test('overpaidBookings: no bookings, no crash', () => {
  assert.strictEqual(overpaidBookings([]).length, 0);
  assert.strictEqual(overpaidBookings(undefined).length, 0);
});
