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

const { paymentEffect } = require('../netlify/functions/stripe-webhook.js');

const PAID_DEPOSIT = {
  total_price: 500, mileage_cost: 0, deposit_amount: 100, balance_due: 400,
  deposit_paid: true, payment_method: 'stripe', status: 'completed',
};

// Before payment_kind existed, this row paying its $420 balance link came back
// with deposit_amount=420, status='confirmed' and balance_due=80 — $80 still
// owed by someone who had just paid in full.
test('a balance payment clears the balance and leaves the deposit alone', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance');
  assert.strictEqual(e.kind, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.deposit_amount, 100, 'the balance payment overwrote the deposit');
  assert.strictEqual(e.deposit_paid, true);
  assert.strictEqual(e.status, 'completed', 'a completed booking was dragged back to confirmed');
  assert.match(e.logAction, /Balance/);
});

// The fee is part of what was charged, never part of what was owed.
test('the service fee does not survive into balance_due as a credit or a debt', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.notStrictEqual(e.balance_due, -20);
});

test('a no-deposit booking paying its whole amount by balance link ends up settled', () => {
  const row = { total_price: 300, mileage_cost: 25, deposit_amount: 0, balance_due: 325,
                deposit_paid: false, payment_method: '', status: 'confirmed' };
  const e = paymentEffect(row, 341.25, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.deposit_amount, 0);
  assert.strictEqual(e.deposit_paid, false);
});

// Regression: the deposit path must behave exactly as it did before the branch.
test('a deposit payment still confirms the booking and derives the balance', () => {
  const row = { total_price: 500, mileage_cost: 30, deposit_amount: 0, balance_due: 530,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  const e = paymentEffect(row, 100, 'deposit');
  assert.strictEqual(e.kind, 'deposit');
  assert.strictEqual(e.deposit_paid, true);
  assert.strictEqual(e.deposit_amount, 100);
  assert.strictEqual(e.status, 'confirmed');
  assert.strictEqual(e.balance_due, 430);
  assert.strictEqual(e.payment_method, 'stripe');
});

// Every session created before this change carries no payment_kind at all.
test('a session with no payment_kind is treated as a deposit, as it always was', () => {
  const row = { total_price: 200, mileage_cost: 0, deposit_amount: 0, balance_due: 200,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  for (const kind of [undefined, null, '', 'nonsense']) {
    assert.strictEqual(paymentEffect(row, 100, kind).kind, 'deposit', `kind=${kind}`);
  }
});

test('overpaying a deposit never produces a negative balance', () => {
  const row = { total_price: 100, mileage_cost: 0, deposit_amount: 0, balance_due: 100,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  assert.strictEqual(paymentEffect(row, 150, 'deposit').balance_due, 0);
});
