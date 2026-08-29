const { test } = require('node:test');
const assert = require('node:assert');
const { paymentEffect } = require('../netlify/functions/stripe-webhook.js');

// Stripe links live 24h (see create-stripe-link.js's comment above the
// balance-mode guard). This is a stale deposit link paid AFTER the booking
// was already settled and marked completed — a real, reachable window, not a
// contrived one.
//
// $500 total, already fully collected ($100 deposit + $400 balance),
// status already 'completed'. The deposit branch recomputes balance_due
// from scratch as total - amountPaid, ignoring that the deposit was already
// paid and the balance already settled, and forces status back to
// 'confirmed'. The pinning values below ($400, 'confirmed') are the bug —
// this booking owes nothing and is done.
const SETTLED_BOOKING = {
  id: 42,
  reference: 'FM-ABC123',
  status: 'completed',
  balance_due: 0,
  total_price: 500,
  mileage_cost: 0,
  deposit_amount: 100,
  deposit_paid: true,
};

// Was the pinning test for the bug — paymentEffect used to recompute
// balance_due from scratch as total + mileage - amountPaid with no regard
// for what was already owed (50000 + 0 - 10000 cents = $400), and force
// status to 'confirmed' unconditionally. Confirmed against unpatched code
// (see .superpowers/sdd/deposit-rebill-report.md for the RED/GREEN
// transcript): this booking owed $0 and was 'completed'; the bug showed
// $400 owing and 'confirmed'. Now pins the fixed invariant instead: a
// payment can never raise balance_due, and status can never regress.
test('FIXED: a stale deposit payment on a settled booking cannot raise balance_due', () => {
  const effect = paymentEffect(SETTLED_BOOKING, 100, 'deposit', null);
  assert.strictEqual(effect.balance_due, 0,
    'balance_due rose above what it already was — a customer would be shown a debt they do not owe');
});

test('FIXED: a stale deposit payment cannot demote a completed booking', () => {
  const effect = paymentEffect(SETTLED_BOOKING, 100, 'deposit', null);
  assert.strictEqual(effect.status, 'completed',
    'a payment demoted a completed booking back to confirmed');
});

test('deposit branch on a settled booking: the clamp is flagged for a human, not silently absorbed', () => {
  const effect = paymentEffect(SETTLED_BOOKING, 100, 'deposit', null);
  assert.strictEqual(effect.overpaymentFlagged, true);
  assert.strictEqual(effect.overpaymentAmount, 100);
});

// ── Sanity: the ordinary case (nothing settled yet) is untouched ───────────
test('deposit branch on a fresh booking still confirms and computes the real remaining balance', () => {
  const fresh = { id: 1, status: 'quoted', balance_due: 500, total_price: 500, mileage_cost: 0 };
  const effect = paymentEffect(fresh, 100, 'deposit', null);
  assert.strictEqual(effect.balance_due, 400);
  assert.strictEqual(effect.status, 'confirmed');
  assert.strictEqual(effect.overpaymentFlagged, undefined);
});

test('deposit branch with mileage still adds mileage into the real remaining balance', () => {
  const fresh = { id: 2, status: 'accepted', balance_due: 550, total_price: 500, mileage_cost: 50 };
  const effect = paymentEffect(fresh, 100, 'deposit', null);
  assert.strictEqual(effect.balance_due, 450);
  assert.strictEqual(effect.status, 'confirmed');
});

// A deposit paid in full (amountPaid >= total) on an already-completed
// booking must not regress status even though balance_due does not rise
// (both are already/still 0) — this is the case the status check alone
// catches that a balance-only guard would miss.
test('a full-amount stale deposit on a completed booking still does not regress status', () => {
  const paidInFull = { ...SETTLED_BOOKING, balance_due: 0 };
  const effect = paymentEffect(paidInFull, 500, 'deposit', null);
  assert.strictEqual(effect.balance_due, 0);
  assert.strictEqual(effect.status, 'completed');
  assert.strictEqual(effect.overpaymentFlagged, true);
});

test('a cancelled booking is never revived by a stray deposit payment', () => {
  const cancelled = { id: 9, status: 'cancelled', balance_due: 0, total_price: 500, mileage_cost: 0 };
  const effect = paymentEffect(cancelled, 100, 'deposit', null);
  assert.strictEqual(effect.status, 'cancelled');
  assert.strictEqual(effect.overpaymentFlagged, true);
});
