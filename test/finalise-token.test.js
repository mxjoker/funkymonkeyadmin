const { test } = require('node:test');
const assert = require('node:assert');
const { render, finaliseLinkFor } = require('../netlify/functions/_email.js');
const { renderSms } = require('../netlify/functions/_sms.js');

const BOOKING = { reference: 'FM-MUDVW9PM', client_email: 'dana@example.com', client_name: 'Dana Ruiz' };

test('the finalisation link carries the reference and the email', () => {
  const url = finaliseLinkFor(BOOKING);
  assert.match(url, /my-booking\.html/);
  assert.match(url, /ref=FM-MUDVW9PM/);
  assert.match(url, /email=dana%40example\.com/, 'the email must be URL-encoded or the link breaks on the @');
});

// A booking with no email cannot be finalised by link — the auth needs it.
// Better an empty token than a link that 404s the moment it is clicked.
test('a booking with no client email produces no link', () => {
  assert.strictEqual(finaliseLinkFor({ reference: 'FM-1' }), '');
});

test('{{finalise_link}} renders in email templates', () => {
  const out = render('Click here: {{finalise_link}}', BOOKING);
  assert.match(out, /ref=FM-MUDVW9PM/);
  assert.doesNotMatch(out, /{{finalise_link}}/);
});

// The SMS renderer has its own token list; a token that works in one and not
// the other is exactly the divergence the shared rule editor invites.
test('{{finalise_link}} renders in SMS templates too', () => {
  const out = renderSms('Finish up: {{finalise_link}}', BOOKING);
  assert.match(out, /ref=FM-MUDVW9PM/);
  assert.doesNotMatch(out, /{{finalise_link}}/);
});
