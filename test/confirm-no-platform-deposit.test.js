const { test } = require('node:test');
const assert = require('node:assert');
const { createStripeLink } = require('../netlify/functions/booking.js');

// Confirming a booking mints a deposit checkout. A GigSalad client has already
// paid GigSalad, so confirming theirs must not produce a link to pay again.
test('confirming a platform booking mints no deposit link', async () => {
  const realFetch = global.fetch, realKey = process.env.STRIPE_SECRET_KEY;
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, json: async () => ({ url: 'https://stripe.test/x' }) }; };
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  try {
    assert.strictEqual(await createStripeLink({ id: 1, deposit_amount: 20, source: 'gigsalad' }), null);
    assert.strictEqual(called, 0, 'Stripe must not be called for a GigSalad booking');
    // The direct path still mints, so the guard is not simply switching minting off.
    assert.strictEqual(await createStripeLink({ id: 2, deposit_amount: 20, source: 'direct' }), 'https://stripe.test/x');
    assert.strictEqual(called, 1);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = realKey;
  }
});
