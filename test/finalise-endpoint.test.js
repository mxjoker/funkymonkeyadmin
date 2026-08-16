const { test } = require('node:test');
const assert = require('node:assert');
const { buildFinaliseResponse, FINALISE_FIELDS } = require('../netlify/functions/finalise.js');

// The client sees their own data, which is a wider set than PUBLIC_FIELDS —
// but it must still never carry anything internal.
test('the finalisation view never exposes internal fields', () => {
  const row = {
    reference: 'FM-1', client_name: 'Dana', client_phone: '4055417953',
    admin_notes: 'chase for deposit', stripe_session_id: 'cs_x',
    stripe_payment_intent_id: 'pi_x', payment_ref: 'x', id: 7,
  };
  const out = buildFinaliseResponse(row);
  assert.strictEqual(out.client_phone, '4055417953', 'their own phone is theirs to correct');
  for (const leak of ['admin_notes', 'stripe_session_id', 'stripe_payment_intent_id', 'payment_ref', 'id']) {
    assert.ok(!(leak in out), `${leak} must not reach the client`);
  }
});

test('every client-editable field is present in the view', () => {
  const { CLIENT_EDITABLE } = require('../netlify/functions/_finalise.js');
  for (const f of CLIENT_EDITABLE) {
    assert.ok(FINALISE_FIELDS.includes(f), `${f} is editable but not readable — the form could not show it`);
  }
});

// The page must be able to tell the client what they owe and offer the link,
// without those being editable.
test('the view carries the money figures read-only', () => {
  const out = buildFinaliseResponse({ total_price: 450, deposit_amount: 100, balance_due: 350, stripe_payment_link: 'https://pay' });
  assert.strictEqual(out.total_price, 450);
  assert.strictEqual(out.deposit_amount, 100);
  assert.strictEqual(out.stripe_payment_link, 'https://pay');
});

// A missing link is the state that must be visible rather than rendering a
// dead button — the admin creates it when sending the email, and if that step
// was skipped the page has to say so.
test('a booking with no payment link says so rather than pretending', () => {
  const out = buildFinaliseResponse({ reference: 'FM-1' });
  assert.strictEqual(out.stripe_payment_link, '');
});
