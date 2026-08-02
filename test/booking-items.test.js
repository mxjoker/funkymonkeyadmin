const { test } = require('node:test');
const assert = require('node:assert');
const { rollupItems, normaliseItems, balanceIsDerivable } = require('../netlify/functions/_items');

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

test('a balance the formula explains is derivable', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: 970, mileage_cost: 48, deposit_amount: 100, balance_due: 918 }), true);
});

test('a fully-paid booking whose balance was zeroed out-of-band is NOT derivable', () => {
  // Mica Andrews 25-354, real production shape: paid in full, balance zeroed
  // directly, deposit_amount never updated. Recomputing would bill $1,114.
  assert.strictEqual(balanceIsDerivable(
    { total_price: 902, mileage_cost: 212, deposit_amount: 0, balance_due: 0 }), false);
});

test('a deposit-paid booking with a partial balance is still derivable', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: 461, mileage_cost: 116, deposit_amount: 100, balance_due: 477 }), true);
});

test('the formula clamps at zero, so an over-deposited booking is derivable', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: 100, mileage_cost: 0, deposit_amount: 500, balance_due: 0 }), true);
});

test('half a cent of float drift does not make a balance underivable', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: 970.004, mileage_cost: 48, deposit_amount: 100, balance_due: 918 }), true);
});

test('null and missing columns are treated as zero, not NaN', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: null, mileage_cost: null, deposit_amount: null, balance_due: null }), true);
  assert.strictEqual(balanceIsDerivable({}), true);
});

// Pins the 0.005 tolerance constant: a regression that widened it (e.g. to
// absorb whole-dollar drift) would let this pass, quietly reopening the bug.
test('a balance off by two cents is NOT derivable — pins the half-cent tolerance', () => {
  assert.strictEqual(balanceIsDerivable(
    { total_price: 100, mileage_cost: 0, deposit_amount: 0, balance_due: 99.98 }), false);
});

// Regression for booking.js:228 injecting balance_due for the change-logging
// loop, then the items block reading that injected value back as if it were
// the caller's own explicit input. A deposit_amount+items PATCH on a 500/100
// booking (400 owed) that adds a line to reach 800 must land on 600, not on
// the pre-edit-total figure of 300 the bug used to persist.
test('deposit + items in one PATCH must land on the rollup balance, not the pre-edit total', () => {
  const roll = rollupItems([
    { name: 'Foam Party', price: 500, quantity: 1, kind: 'service' },
    { name: 'Extra Package', price: 300, quantity: 1, kind: 'service' },
  ]);
  assert.strictEqual(roll.total_price, 800);
  const depositAmount = 200;
  const correctBalance = Math.max(0, roll.total_price + roll.mileage_cost - depositAmount);
  assert.strictEqual(correctBalance, 600);

  // The bug's output: balance left at what the pre-edit total_price (500)
  // implied — 300 — which the row's own total_price (800) no longer explains.
  assert.strictEqual(balanceIsDerivable(
    { total_price: roll.total_price, mileage_cost: roll.mileage_cost, deposit_amount: depositAmount, balance_due: 300 }), false);

  // The fix's output: derivable, and the guard that protects every other
  // recompute in the system stays armed on this row.
  assert.strictEqual(balanceIsDerivable(
    { total_price: roll.total_price, mileage_cost: roll.mileage_cost, deposit_amount: depositAmount, balance_due: correctBalance }), true);
});
