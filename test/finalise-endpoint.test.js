const { test } = require('node:test');
const assert = require('node:assert');
const { buildFinaliseResponse, FINALISE_FIELDS, emailMatches } = require('../netlify/functions/finalise.js');

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

// Fix 3: `row[f] ?? (typeof row[f] === 'number' ? 0 : '')` was dead code — by
// the time `??` falls through, row[f] is null/undefined, so its typeof can
// never be 'number'. A NULL total_price rendered as '' and a page doing
// `$${total_price}` showed a bare "$" on the deposit-collection page.
test('a NULL money field reads as the number 0, not an empty string', () => {
  const out = buildFinaliseResponse({ reference: 'FM-1', total_price: null, deposit_amount: null, balance_due: null });
  assert.strictEqual(out.total_price, 0);
  assert.strictEqual(out.deposit_amount, 0);
  assert.strictEqual(out.balance_due, 0);
});

// ── Fix 1: the auth bypass ───────────────────────────────────────────────
// emailMatches is the actual security boundary for GET/PATCH — authenticate()
// just calls it against a DB row. It must return false for every combination
// of an empty stored email (drafts, PPM-synced rows with no email) against an
// empty/blank/missing supplied one — otherwise '' !== '' reads as a match and
// anyone holding only the reference can read and edit an email-less booking.
test('an empty email never authenticates, on either side', () => {
  const storedEmpties = ['', null, undefined];
  const suppliedEmpties = ['', '   ', null, undefined];
  for (const stored of storedEmpties) {
    for (const supplied of suppliedEmpties) {
      assert.strictEqual(
        emailMatches(stored, supplied), false,
        `stored=${JSON.stringify(stored)} supplied=${JSON.stringify(supplied)} must not authenticate`
      );
    }
  }
  // A populated stored email against an empty supplied one must also fail —
  // the bypass this closes is exactly "supply nothing, get in anyway".
  for (const supplied of suppliedEmpties) {
    assert.strictEqual(emailMatches('dana@example.com', supplied), false);
  }
});

test('a genuine case-insensitive match still authenticates', () => {
  assert.strictEqual(emailMatches('Dana@Example.com', 'dana@example.com'), true);
  assert.strictEqual(emailMatches('dana@example.com', '  Dana@EXAMPLE.com  '), true);
});

test('a mismatched non-empty email does not authenticate', () => {
  assert.strictEqual(emailMatches('dana@example.com', 'someone-else@example.com'), false);
});
