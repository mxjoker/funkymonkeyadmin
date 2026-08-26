const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../booking-form.html'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  HTML.slice(HTML.indexOf('// ══ PURE HELPERS'), HTML.indexOf('// ══ END PURE HELPERS')) +
  '\nout = { quoteTotals };', ctx);
const { quoteTotals } = ctx.out;

// The server does balance_due = total_price + mileage_cost - deposit_amount.
// If total_price already contains the travel fee, the client is billed it twice.
test('total_price excludes travel, so the server cannot double-charge it', () => {
  const { totalPrice, balanceDue } = quoteTotals(730, 0, 150, 199, 100);
  assert.strictEqual(totalPrice, 880, 'travel must not be folded into total_price');
  // Mandy Mason #779: stored $1178, owed $979.
  assert.strictEqual(totalPrice + 199 - 100, 979, 'the server formula must land on the real balance');
  assert.strictEqual(balanceDue, 979, 'the form must quote the same balance the server stores');
});

test('the balance the client is shown is travel-inclusive', () => {
  const { allIn, balanceDue } = quoteTotals(385, 0, 0, 15, 100);
  assert.strictEqual(allIn, 400, 'the review screen shows the all-in price');
  assert.strictEqual(balanceDue, 300);
});

test('no travel fee means total_price and the all-in price agree', () => {
  const { totalPrice, allIn, balanceDue } = quoteTotals(385, 50, 75, 0, 100);
  assert.strictEqual(totalPrice, 510);
  assert.strictEqual(allIn, 510);
  assert.strictEqual(balanceDue, 410);
});

test('a deposit larger than the bill does not produce a negative balance', () => {
  assert.strictEqual(quoteTotals(50, 0, 0, 0, 100).balanceDue, 0);
});
