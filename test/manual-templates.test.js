const { test } = require('node:test');
const assert = require('node:assert');
const { MANUAL_TEMPLATES } = require('../netlify/functions/automations.js');
const { render } = require('../netlify/functions/_email.js');
const { renderSms } = require('../netlify/functions/_sms.js');

const byKey = (k) => MANUAL_TEMPLATES.find((t) => t.template_key === k);

const BOOKING = {
  id: 1, reference: 'FM-TEST01', client_name: "Siobhan O'Brien",
  service_name: 'Foam Party', event_date: '2026-09-12',
  deposit_amount: 150, total_price: 600, balance_due: 450,
  client_email: 'client@example.com',
  stripe_payment_link: 'https://pay.stripe.com/dep_123'
};

test('every manual template resolves all of its tokens', () => {
  for (const t of MANUAL_TEMPLATES) {
    const out = render(t.body_html, BOOKING, BOOKING.stripe_payment_link) +
                render(t.subject, BOOKING, BOOKING.stripe_payment_link);
    assert.ok(!/\{\{[a-z_]+\}\}/.test(out),
      `${t.template_key} left an unresolved token: ${(out.match(/\{\{[a-z_]+\}\}/g) || []).join(', ')}`);
    if (t.body_sms) {
      const sms = renderSms(t.body_sms, BOOKING, BOOKING.stripe_payment_link);
      assert.ok(!/\{\{[a-z_]+\}\}/.test(sms), `${t.template_key} SMS left an unresolved token`);
    }
  }
});

// The reason there are two finalisation templates rather than one. Schools and
// libraries book with deposit_amount = 0; the admin picks the variant by
// amount, and this one must never ask them for money the booking doesn't want.
test('the no-deposit finalisation template never asks for a deposit', () => {
  const t = byKey('finalisation_link_no_deposit');
  const out = (render(t.body_html, { ...BOOKING, deposit_amount: 0 }, null) + ' ' + t.body_sms).toLowerCase();
  assert.ok(!out.includes('deposit'), `no-deposit template mentions a deposit: ${out}`);
  assert.ok(!out.includes('pay'), `no-deposit template asks for payment: ${out}`);
});

test('the deposit template carries a real pay link and the right amount', () => {
  const out = render(byKey('deposit_link_ready').body_html, BOOKING, BOOKING.stripe_payment_link);
  assert.ok(out.includes('https://pay.stripe.com/dep_123'), 'deposit template lost its pay link');
  assert.ok(out.includes('$150.00'), 'deposit template lost the deposit amount');
  // NOT the $100 fallback this codebase has been bitten by before.
  assert.ok(!out.includes('$100.00'), 'a fallback amount leaked into the deposit template');
});

test('a template key is unique, or the seed silently keeps only one', () => {
  const keys = MANUAL_TEMPLATES.map((t) => t.template_key);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate template_key: ${keys.join(', ')}`);
});
