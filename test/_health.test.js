const { test } = require('node:test');
const assert = require('node:assert');
const { inspectConfig } = require('../netlify/functions/_health.js');

function find(result, name) {
  return result.checks.find(c => c.name === name);
}

test('flags a missing Resend key', () => {
  const r = inspectConfig({});
  assert.strictEqual(find(r, 'resend_key').ok, false);
  assert.strictEqual(r.ok, false);
});

test('flags a missing Stripe webhook secret', () => {
  const r = inspectConfig({ STRIPE_SECRET_KEY: 'sk_live_x' });
  assert.strictEqual(find(r, 'stripe_webhook_secret').ok, false);
});

test('reports Stripe test-mode as a distinct state, not a pass', () => {
  const r = inspectConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' });
  const c = find(r, 'stripe_key');
  assert.strictEqual(c.ok, true, 'a test key is present and valid');
  assert.match(c.detail, /test mode/i, 'but it must say so loudly');
});

test('reports the allowlist as active when set', () => {
  const r = inspectConfig({ EMAIL_ALLOWLIST: 'joe.coover@gmail.com' });
  const c = find(r, 'email_allowlist');
  assert.match(c.detail, /joe\.coover@gmail\.com/);
});

test('all green when everything is configured for production', () => {
  const r = inspectConfig({
    RESEND_API_KEY: 're_x',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    DATABASE_URL: 'postgres://x'
  });
  assert.strictEqual(r.ok, true);
});
