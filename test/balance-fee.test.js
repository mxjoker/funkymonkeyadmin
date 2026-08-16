const { test } = require('node:test');
const assert = require('node:assert');
const { balanceCharge, SERVICE_FEE_RATE, balanceIsDerivable } = require('../netlify/functions/_items.js');

test('the fee is 5% of the balance, itemised', () => {
  const c = balanceCharge({ balance_due: 400 });
  assert.deepStrictEqual(c, { balance: 400, fee: 20, total: 420 });
});

// The whole point of one formula: no deposit means balance_due IS the whole
// amount, so the no-deposit case needs no special rule.
test('a booking that never took a deposit is charged on its whole amount', () => {
  const c = balanceCharge({ balance_due: 385 });
  assert.strictEqual(c.fee, 19.25);
  assert.strictEqual(c.total, 404.25);
});

test('money is rounded to cents and the three lines always add up', () => {
  const c = balanceCharge({ balance_due: 333.33 });
  assert.strictEqual(c.fee, 16.67);
  assert.strictEqual(c.total, 350);
  assert.strictEqual(Math.round((c.balance + c.fee) * 100), Math.round(c.total * 100));
});

test('pg NUMERIC strings are money too', () => {
  assert.strictEqual(balanceCharge({ balance_due: '400.00' }).fee, 20);
});

test('nothing owed means nothing charged', () => {
  for (const v of [0, null, undefined, -100, 'abc']) {
    assert.deepStrictEqual(balanceCharge({ balance_due: v }), { balance: 0, fee: 0, total: 0 },
      `balance_due=${v} should charge nothing`);
  }
  assert.deepStrictEqual(balanceCharge(null), { balance: 0, fee: 0, total: 0 });
});

// The invariant the whole design hangs on. Folding the fee into balance_due
// would make the stored balance permanently un-derivable, and booking.js:269
// would then refuse to recompute this booking's balance ever again.
test('computing the fee does not touch the row, so the balance stays derivable', () => {
  const row = { total_price: 500, mileage_cost: 0, deposit_amount: 100, balance_due: 400 };
  const before = JSON.stringify(row);
  const c = balanceCharge(row);
  assert.strictEqual(JSON.stringify(row), before, 'balanceCharge mutated the booking row');
  assert.strictEqual(c.fee, 20);
  assert.ok(balanceIsDerivable(row), 'balance stopped being derivable');
  // And the fee is emphatically not the balance.
  assert.notStrictEqual(c.total, Number(row.balance_due));
});

test('the rate is a single named constant', () => {
  assert.strictEqual(SERVICE_FEE_RATE, 0.05);
});
