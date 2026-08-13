const { test } = require('node:test');
const assert = require('node:assert');
const { paymentLogEntry } = require('../netlify/functions/booking.js');

// Recording a payment and clearing a mis-keyed one arrive as the SAME shape —
// both PATCH payment_amount and payment_method — so the activity log has to
// tell them apart by value. Getting this wrong writes "Payment recorded $0.00"
// against a booking whose deposit just went back to unpaid, which is the one
// place a money trail must not be ambiguous.

const CLEAR = { deposit_paid: false, payment_amount: null, payment_method: '', payment_ref: '' };

test('clearing a payment is logged as cleared, not as a $0.00 payment', () => {
  const e = paymentLogEntry(CLEAR, { payment_amount: '385.00', payment_method: 'cash' });
  assert.strictEqual(e.action, 'Payment cleared');
  assert.match(e.detail, /was \$385\.00 cash/);
});

test('the cleared amount is carried into the detail from the PREVIOUS row', () => {
  // The new row is empty by definition, so a log built only from `u` could
  // never say what was undone.
  const e = paymentLogEntry(CLEAR, { payment_amount: '1250.5', payment_method: 'venmo' });
  assert.match(e.detail, /\$1250\.50/);
  assert.match(e.detail, /venmo/);
});

test('clearing a booking that never had an amount still logs honestly', () => {
  const e = paymentLogEntry(CLEAR, { payment_amount: null, payment_method: '' });
  assert.strictEqual(e.action, 'Payment cleared');
  assert.strictEqual(e.detail, 'no amount was recorded');
});

test('a real payment is still logged as recorded', () => {
  const e = paymentLogEntry(
    { payment_amount: 385, payment_method: 'cash', payment_ref: 'chk 1021' }, {});
  assert.strictEqual(e.action, 'Payment recorded');
  assert.strictEqual(e.detail, '$385.00 cash — Ref: chk 1021');
});

test('a payment with no ref omits the ref clause entirely', () => {
  const e = paymentLogEntry({ payment_amount: 200, payment_method: 'zelle' }, {});
  assert.strictEqual(e.detail, '$200.00 zelle');
});

test('a PATCH that is not about payment produces no payment log line', () => {
  // Editing a phone number must not write a payment row.
  assert.strictEqual(paymentLogEntry({ client_phone: '4055551234' }, {}), null);
  assert.strictEqual(paymentLogEntry({ payment_amount: 100 }, {}), null, 'amount alone is not enough');
  assert.strictEqual(paymentLogEntry({ payment_method: 'cash' }, {}), null, 'method alone is not enough');
});

test('a zero amount with a method is a recording, not a clear', () => {
  // Both must be empty to count as clearing. A $0 cash entry is someone
  // deliberately logging a waived deposit and should read as recorded.
  const e = paymentLogEntry({ payment_amount: 0, payment_method: 'cash' }, { payment_amount: '50' });
  assert.strictEqual(e.action, 'Payment recorded');
  assert.strictEqual(e.detail, '$0.00 cash');
});

test('string amounts from a form post are handled like numbers', () => {
  assert.strictEqual(paymentLogEntry({ payment_amount: '385', payment_method: 'cash' }, {}).action,
    'Payment recorded');
  // '' is normalised to null by booking.js before this runs, but be safe.
  assert.strictEqual(paymentLogEntry({ payment_amount: '', payment_method: '' }, {}).action,
    'Payment cleared');
});
