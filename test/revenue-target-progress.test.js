const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

// Same trick as test/bookings-sort.test.js: run the PURE HELPERS block in a
// bare vm context so a reach for `document` throws instead of silently passing.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { targetProgress };', ctx);
  return ctx.out;
}

const { targetProgress } = loadHelpers();

test('no target set (null/0/undefined) renders nothing', () => {
  assert.strictEqual(targetProgress(1000, null), null);
  assert.strictEqual(targetProgress(1000, 0), null);
  assert.strictEqual(targetProgress(1000, undefined), null);
});

test('target set, revenue below it — a percentage under 100', () => {
  assert.strictEqual(targetProgress(2100, 4200), 50);
});

test('revenue above target — over 100%, not clamped', () => {
  // Beating a goal is information, not an overflow to hide.
  assert.strictEqual(targetProgress(6300, 4200), 150);
});

test('a target of 0 must not divide by zero', () => {
  assert.strictEqual(targetProgress(500, 0), null);
  assert.strictEqual(Number.isNaN(targetProgress(500, 0)), false);
});

test('no revenue yet against a real target is 0%, not null', () => {
  assert.strictEqual(targetProgress(0, 4200), 0);
});
