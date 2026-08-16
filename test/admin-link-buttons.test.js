const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { depositLinkAmount };', ctx);
  return ctx.out;
}

const { depositLinkAmount } = loadHelpers();

// The bug this file exists for: a school or library booking is deliberately
// $0 deposit, and the old `Number(b.deposit_amount) || 100` billed it $100 for
// money the booking never asked for.
test('a deliberate $0 deposit charges nothing, not $100', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 0 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '0' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: null }), 0);
  assert.strictEqual(depositLinkAmount({}), 0);
});

test('a real deposit passes through, including as a NUMERIC string from pg', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 100 }), 100);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '150.00' }), 150);
});

test('junk never becomes a charge', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: -50 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: 'abc' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: Infinity }), 0);
});

// The literal that caused it, gone for good.
test('the $100 fallback literal is not in admin.html any more', () => {
  assert.ok(!/deposit_amount\s*\)\s*\|\|\s*100/.test(HTML),
    'the `Number(b.deposit_amount) || 100` fallback is back');
});
