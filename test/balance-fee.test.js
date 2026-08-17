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

// booking.balance_due is exactly the column a balance payment zeroes, so it
// can't be trusted to reconstruct what was fee vs. balance after the fact.
// create-stripe-link.js stamps the split into session metadata instead —
// Stripe signs the whole payload, so it can't go stale in transit.
test('metadata present and consistent: itemised from metadata, balance cleared', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.itemised, true);
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.balance, 400);
  assert.strictEqual(e.fee, 20);
});

// A second webhook delivery for the same balance (retry, or genuinely a
// repeat) must not read the itemisation off the row's CURRENT balance_due,
// which is already 0 by the time this fires a second time.
test('a repeat balance payment still itemises from metadata, not from the already-zeroed row', () => {
  const row = { ...PAID_DEPOSIT, balance_due: 0 };
  const e = paymentEffect(row, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.itemised, true);
  assert.strictEqual(e.balance, 400, 'itemisation read $0 off the row instead of metadata');
  assert.strictEqual(e.fee, 20, 'itemisation read $420 off the row instead of metadata');
});

// The link was minted for $400 owed; before it was paid, the quote grew to
// $500 owed. The $420 payment covers the old balance and fee but leaves $100
// of the new balance owing — that shortfall must not be written off.
test('a quote raised after the link was minted leaves the shortfall owing', () => {
  const row = { ...PAID_DEPOSIT, balance_due: 500 };
  const e = paymentEffect(row, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.balance_due, 100);
  assert.strictEqual(e.itemised, true);
});

test('missing metadata falls back to treating the whole payment as balance, unitemised', () => {
  const row = { ...PAID_DEPOSIT, balance_due: 1000 };
  const e = paymentEffect(row, 420, 'balance', null);
  assert.strictEqual(e.itemised, false);
  assert.ok(e.warning, 'no warning was set for an unitemised balance payment');
  assert.strictEqual(e.balance_due, 580, 'balance was not reduced by the amount actually paid');
});

test('metadata that does not add up to what was charged is treated as untrustworthy', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 5 });
  assert.strictEqual(e.itemised, false);
  assert.ok(e.warning, 'no warning was set for inconsistent metadata');
  assert.strictEqual(e.balance_due, 0);
});

// accounting-export.js counts revenue only for status IN
// ('confirmed','completed') and staff-assignments.js staffs only
// accepted/confirmed. A $0-deposit booking that pays its whole amount by
// balance link used to stay at 'quoted' with deposit_paid=false — the client
// told they were paid up for a booking the books never saw and nobody was
// scheduled to work.
test('a pre-payment booking that pays in full by balance link is promoted to confirmed', () => {
  const row = { total_price: 300, mileage_cost: 25, deposit_amount: 0, balance_due: 325,
                deposit_paid: false, payment_method: '', status: 'quoted' };
  const e = paymentEffect(row, 341.25, 'balance', { balance: 325, fee: 16.25 });
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.status, 'confirmed', 'a fully paid booking stayed invisible to revenue and staffing');
  // There was no deposit. Claiming one was paid would be a second untruth.
  assert.strictEqual(e.deposit_paid, false);
  assert.strictEqual(e.deposit_amount, 0);
});

test('every pre-payment status is promoted, and only those', () => {
  for (const status of ['draft', 'review', 'quoted', 'accepted']) {
    const row = { deposit_amount: 0, balance_due: 325, deposit_paid: false, status };
    assert.strictEqual(paymentEffect(row, 341.25, 'balance', { balance: 325, fee: 16.25 }).status,
      'confirmed', `status=${status} was not promoted`);
  }
});

// Promotion only ever moves forward.
test('a completed booking is never dragged backwards to confirmed', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.status, 'completed');
});

test('an unrecognised status is left exactly as it was', () => {
  const row = { ...PAID_DEPOSIT, status: 'cancelled' };
  assert.strictEqual(paymentEffect(row, 420, 'balance', { balance: 400, fee: 20 }).status, 'cancelled');
});

// The shortfall cases are precisely where b.balance_due and the computed
// balance disagree, so the promotion must read the computed one.
test('a shortfall left owing does not promote the status', () => {
  const row = { total_price: 600, mileage_cost: 0, deposit_amount: 0, balance_due: 500,
                deposit_paid: false, payment_method: '', status: 'quoted' };
  const e = paymentEffect(row, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.balance_due, 100);
  assert.strictEqual(e.status, 'quoted', 'a booking still owing $100 was promoted to confirmed');
});

test('an unitemised balance payment that clears the balance still promotes', () => {
  const row = { deposit_amount: 0, balance_due: 325, deposit_paid: false, status: 'accepted' };
  const e = paymentEffect(row, 325, 'balance', null);
  assert.strictEqual(e.itemised, false);
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.status, 'confirmed');
});

test('a deposit payment still confirms, promotion or not', () => {
  const row = { total_price: 500, mileage_cost: 0, deposit_amount: 0, balance_due: 500,
                deposit_paid: false, payment_method: '', status: 'quoted' };
  assert.strictEqual(paymentEffect(row, 100, 'deposit').status, 'confirmed');
});

// The fee is charged and shown to the client but was stored in no queryable
// column, so Stripe payouts could not reconcile against the books by exactly
// the fee on every balance payment. effect.fee is what the webhook's UPDATE
// accumulates into service_fee_collected — it must always be a number.
test('a deposit payment contributes no service fee', () => {
  const row = { total_price: 500, mileage_cost: 0, deposit_amount: 0, balance_due: 500,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  assert.strictEqual(paymentEffect(row, 100, 'deposit').fee, 0);
});

test('an itemised balance payment contributes exactly the fee Stripe collected', () => {
  assert.strictEqual(paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 20 }).fee, 20);
});

// In the fallback the split is genuinely unknown, so recording a guessed fee
// would be worse than recording none.
test('an unitemised balance payment contributes 0, never a guess', () => {
  assert.strictEqual(paymentEffect(PAID_DEPOSIT, 420, 'balance', null).fee, 0);
  assert.strictEqual(paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 5 }).fee, 0);
});

// The fee is a record, never an input. It must not leak into any column the
// balance is derived from.
test('recording the fee never moves the money columns', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.deposit_amount, 100);
  assert.strictEqual(e.balance_due, 0);
  assert.ok(!('total_price' in e), 'paymentEffect started writing total_price');
  assert.ok(!('mileage_cost' in e), 'paymentEffect started writing mileage_cost');
});

const { balanceReceiptCopy } = require('../netlify/functions/stripe-webhook.js');

// A quote raised after the link was minted, or metadata Stripe couldn't
// confirm, can leave a genuine shortfall after a "balance" payment (see the
// tests above: balance_due 100 and 580). Telling the client "settled in
// full" while balance_due still shows money owed misleads them into
// thinking they can stop paying — the receipt copy must reflect which case
// this is, not assume every balance payment finishes the booking.
test('a fully settled balance payment keeps the exact subject and "settled in full" wording', () => {
  const copy = balanceReceiptCopy({ balance_due: 0 });
  assert.strictEqual(copy.subject, "Payment received — you're all paid up! 🎉 Funky Monkey Events");
  assert.match(copy.headline, /settled in full/);
});

test('a balance payment that leaves a shortfall does not claim to be settled', () => {
  const copy = balanceReceiptCopy({ balance_due: 580 });
  assert.ok(!/settled in full/.test(copy.headline), 'a booking still owed $580 was told it was settled in full');
  assert.notStrictEqual(copy.subject, "Payment received — you're all paid up! 🎉 Funky Monkey Events");
});

test('the shortfall wording names the amount still owed, matching effect.balance_due exactly', () => {
  const effect = paymentEffect({ balance_due: 500 }, 420, 'balance', { balance: 400, fee: 20 });
  assert.strictEqual(effect.balance_due, 100);
  const copy = balanceReceiptCopy(effect);
  assert.match(copy.headline, /\$100\.00/);
});
