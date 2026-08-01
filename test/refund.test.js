const { test } = require('node:test');
const assert = require('node:assert');

function loadRefund() {
  delete require.cache[require.resolve('../netlify/functions/refund.js')];
  return require('../netlify/functions/refund.js');
}

// Capture what we actually send to Stripe.
function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, params: new URLSearchParams(opts.body) });
    return {
      ok: response.ok !== false,
      status: response.status || (response.ok === false ? 400 : 200),
      json: async () => response.json ?? { id: 're_test', status: 'succeeded' }
    };
  };
  return calls;
}

// Stripe's refund `reason` is an enum: duplicate | fraudulent |
// requested_by_customer. The code used to forward our own description
// ('Deposit refund', 'Partial refund', 'Full refund'), so Stripe rejected
// EVERY refund this endpoint ever attempted.
test('a free-text reason is not sent to Stripe as `reason`', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const calls = stubFetch({ ok: true });
  const { processStripeRefund } = loadRefund();

  await processStripeRefund('pi_123', 100, 'Deposit refund');

  assert.strictEqual(calls[0].params.get('reason'), 'requested_by_customer',
    'an invalid enum value must be replaced, not forwarded');
});

test('the human note survives as metadata', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const calls = stubFetch({ ok: true });
  const { processStripeRefund } = loadRefund();

  await processStripeRefund('pi_123', 100, 'Deposit refund');

  assert.strictEqual(calls[0].params.get('metadata[note]'), 'Deposit refund');
});

test('a genuine Stripe enum value is passed through untouched', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const calls = stubFetch({ ok: true });
  const { processStripeRefund } = loadRefund();

  await processStripeRefund('pi_123', 100, 'fraudulent');

  assert.strictEqual(calls[0].params.get('reason'), 'fraudulent');
});

test('amount and payment_intent are sent correctly', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const calls = stubFetch({ ok: true });
  const { processStripeRefund } = loadRefund();

  await processStripeRefund('pi_abc', 100, 'Full refund');

  assert.strictEqual(calls[0].params.get('payment_intent'), 'pi_abc');
  assert.strictEqual(calls[0].params.get('amount'), '100', 'amount is in cents');
});

// The old fallback was a bare 'Stripe refund failed', which told the admin
// nothing and hid the invalid-reason bug above.
test('a Stripe error surfaces Stripe\'s own message', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  stubFetch({ ok: false, status: 400, json: { error: { message: 'Invalid reason: must be one of duplicate, fraudulent, requested_by_customer' } } });
  const { processStripeRefund } = loadRefund();

  await assert.rejects(
    () => processStripeRefund('pi_123', 100, 'Deposit refund'),
    /must be one of duplicate/,
    'the admin must see why Stripe refused'
  );
});

test('an error with no message still names something useful', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  stubFetch({ ok: false, status: 402, json: { error: { code: 'charge_already_refunded' } } });
  const { processStripeRefund } = loadRefund();

  await assert.rejects(
    () => processStripeRefund('pi_123', 100, 'Full refund'),
    /charge_already_refunded/
  );
});
