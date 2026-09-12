const { test } = require('node:test');
const assert = require('node:assert');
const { unresolvedLinkToken } = require('../netlify/functions/_email.js');

// The bug this exists to stop, measured 2026-09-12: 21 of 21 upcoming bookings
// that owe money have an empty stripe_balance_link, because a balance link is
// minted on press rather than stored. The drafted "Balance due" SMS rule uses
// {{balance_link}}, so switching it on would have texted all 21 a demand for
// money with a blank where the link belongs.

const BOOKING = {
  reference: 'FM-ABC123',
  client_email: 'dana@example.com',
  stripe_payment_link: 'https://checkout.stripe.com/deposit',
  stripe_balance_link: '',
};

test('a balance text with no balance link is refused', () => {
  assert.strictEqual(
    unresolvedLinkToken('sms', 'Your balance is due: {{balance_link}}', BOOKING, null),
    '{{balance_link}}');
});

test('a balance text IS allowed once the link exists', () => {
  assert.strictEqual(
    unresolvedLinkToken('sms', 'Your balance is due: {{balance_link}}',
      { ...BOOKING, stripe_balance_link: 'https://checkout.stripe.com/balance' }, null),
    null);
});

// The false-positive side is the dangerous one: a guard that blocks a message
// which would have been fine is a silent outage of its own.
test('a body with no link token is never blocked', () => {
  for (const body of ['See you tomorrow!', '', null, undefined, 'Call us on (405) 431-6625']) {
    assert.strictEqual(unresolvedLinkToken('sms', body, BOOKING, null), null,
      `${JSON.stringify(body)} asks for no link and must send`);
  }
});

test('the SMS fallback to the stored deposit link is respected', () => {
  // renderSms resolves {{payment_link}} as link || booking.stripe_payment_link.
  // The three scheduled loops pass link=null, so a guard that only looked at
  // `link` would block every scheduled deposit reminder ever sent.
  assert.strictEqual(
    unresolvedLinkToken('sms', 'Pay here: {{payment_link}}', BOOKING, null), null);
  assert.strictEqual(
    unresolvedLinkToken('sms', 'Pay here: {{deposit_link}}', BOOKING, null), null);
});

test('email is checked against render()\'s fallbacks, not renderSms\'s', () => {
  // render() resolves {{deposit_link}} from stripeLink ALONE — it does not fall
  // back to the stored link the way renderSms does. A guard that disagreed with
  // its own renderer would pass a message that renders blank.
  assert.strictEqual(
    unresolvedLinkToken('email', '<p>{{deposit_link}}</p>', BOOKING, null),
    '{{deposit_link}}');
  assert.strictEqual(
    unresolvedLinkToken('email', '<p>{{deposit_link}}</p>', BOOKING, 'https://checkout.stripe.com/x'),
    null);
});

test('email never checks {{balance_link}}, because render() does not resolve it', () => {
  // Blocking on it would stop an email over a token that was never this
  // channel's to fill. That it renders as a literal is a separate problem,
  // already covered by the manual-template token test.
  assert.strictEqual(
    unresolvedLinkToken('email', '<p>{{balance_link}}</p>', BOOKING, null), null);
});

test('a finalise link is unresolvable without both halves of the auth key', () => {
  // finaliseLinkFor returns '' with no reference or no email, because the page
  // authenticates on both and a link missing either 404s on the first click.
  const body = 'Finish your booking: {{finalise_link}}';
  assert.strictEqual(unresolvedLinkToken('sms', body, BOOKING, null), null);
  assert.strictEqual(
    unresolvedLinkToken('sms', body, { ...BOOKING, client_email: '' }, null),
    '{{finalise_link}}');
  assert.strictEqual(
    unresolvedLinkToken('sms', body, { ...BOOKING, reference: '' }, null),
    '{{finalise_link}}');
});

test('an unknown channel blocks nothing', () => {
  assert.strictEqual(unresolvedLinkToken('carrier-pigeon', '{{balance_link}}', BOOKING, null), null);
});

test('a missing booking does not throw', () => {
  // The scheduled loops hand this whatever the query returned.
  assert.strictEqual(unresolvedLinkToken('sms', 'x {{balance_link}}', null, null), '{{balance_link}}');
  assert.strictEqual(unresolvedLinkToken('sms', 'no tokens here', null, null), null);
});
