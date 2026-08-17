const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionParams } = require('../netlify/functions/create-stripe-link.js');

const BASE = {
  client: 'Amanda Petty', email: 'a@example.com', service: 'Foam Party',
  bookingRef: 'FM-ABC123', bookingId: 42, dbId: 42,
};

// Regression: the deposit session must be exactly what it was before balance
// mode existed. Every session Stripe has ever created for this business is
// this shape.
test('a deposit session is one line item and no fee', () => {
  const p = buildSessionParams({ ...BASE, kind: 'deposit', amount: 100, fee: 0 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '10000');
  assert.match(p.get('line_items[0][price_data][product_data][name]'), /^Deposit — Foam Party$/);
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), null, 'deposit grew a second line item');
  assert.strictEqual(p.get('metadata[payment_kind]'), 'deposit');
});

test('a balance session itemises balance and fee as separate lines', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 20 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '40000');
  assert.strictEqual(p.get('line_items[0][price_data][product_data][name]'), 'Balance — Foam Party');
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), '2000');
  assert.strictEqual(p.get('line_items[1][price_data][product_data][name]'), 'Service fee (5%)');
  assert.strictEqual(p.get('metadata[payment_kind]'), 'balance');
});

// stripe-webhook.js's paymentEffect reads these back to itemise the receipt
// and to work out how much of the payment went to the balance. Without them it
// falls back to a non-itemised receipt and logs loudly, so their absence is a
// real regression even though nothing throws.
test('a balance session carries the balance and fee it was minted with', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 20 });
  assert.strictEqual(p.get('metadata[balance_amount]'), '400.00');
  assert.strictEqual(p.get('metadata[fee_amount]'), '20.00');
});

test('a zero fee is still stamped, so the webhook can tell it from a missing one', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 0 });
  assert.strictEqual(p.get('metadata[fee_amount]'), '0.00');
});

test('a deposit session carries no balance metadata', () => {
  const p = buildSessionParams({ ...BASE, kind: 'deposit', amount: 100, fee: 0 });
  assert.strictEqual(p.get('metadata[balance_amount]'), null);
});

// The one word this must never say. A 5% card-only surcharge exceeds Stripe's
// cost of acceptance and falls under Visa/Mastercard surcharge rules; a
// service fee on every payment method does not.
test('the fee is never described to the client as a card or processing fee', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 20 });
  const text = p.toString();
  for (const word of ['surcharge', 'card fee', 'processing fee', 'convenience']) {
    assert.ok(!text.toLowerCase().includes(word), `session copy says "${word}"`);
  }
});

test('rounding to Stripe cents is exact, not floating', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 333.33, fee: 16.67 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '33333');
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), '1667');
});

test('a zero fee produces no fee line even in balance mode', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 0 });
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), null);
});

test('both kinds carry the ids the webhook matches on', () => {
  for (const kind of ['deposit', 'balance']) {
    const p = buildSessionParams({ ...BASE, kind, amount: 100, fee: kind === 'balance' ? 5 : 0 });
    assert.strictEqual(p.get('metadata[booking_db_id]'), '42');
    assert.strictEqual(p.get('client_reference_id'), 'FM-ABC123');
  }
});
