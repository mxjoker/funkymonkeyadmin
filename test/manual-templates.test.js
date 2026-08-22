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

// Every {{token}} in every body must be one the renderers resolve or one the
// template DECLARES as an extra. A token that is neither renders as a literal
// "{{amount_paid}}" in a bill — which is what this catches, at the one place a
// new template gets added.
const stub = (t) => Object.fromEntries((t.extras || []).map((k) => [k, 'X']));

test('every template resolves all of its tokens', () => {
  for (const t of MANUAL_TEMPLATES) {
    const out = render(t.body_html, BOOKING, BOOKING.stripe_payment_link, stub(t)) +
                render(t.subject, BOOKING, BOOKING.stripe_payment_link, stub(t));
    assert.ok(!/\{\{[a-z_]+\}\}/.test(out),
      `${t.template_key} left an unresolved token: ${(out.match(/\{\{[a-z_]+\}\}/g) || []).join(', ')}`);
    if (t.body_sms) {
      const sms = renderSms(t.body_sms, BOOKING, BOOKING.stripe_payment_link, stub(t));
      assert.ok(!/\{\{[a-z_]+\}\}/.test(sms), `${t.template_key} SMS left an unresolved token`);
    }
  }
});

// An extra nobody uses is a caller that stopped passing it, or a wording edit
// that dropped the token — both mean a message quietly missing its numbers.
test('every declared extra is actually used by its template', () => {
  for (const t of MANUAL_TEMPLATES) {
    for (const k of t.extras || []) {
      assert.ok((t.subject + t.body_html + (t.body_sms || '')).includes('{{' + k + '}}'),
        `${t.template_key} declares extra "${k}" but never uses it`);
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

// The deposit email points at the finalisation PAGE, not at a Stripe session:
// a session dies 24 hours after it is minted, and a client opening the email on
// Thursday found a dead page (FM-KNNVZY8J, 2026-08-20). The page mints checkout
// when they press Pay.
test('the deposit template links to the finalisation page, not a Stripe session', () => {
  const t = byKey('deposit_link_ready');
  const out = render(t.body_html, BOOKING, BOOKING.stripe_payment_link);
  assert.ok(!out.includes('pay.stripe.com'),
    'the deposit email carries a Stripe URL again — it will be expired by tomorrow');
  assert.match(t.body_html, /\{\{finalise_link\}\}/, 'the deposit email lost its link entirely');
  assert.ok(out.includes('/my-booking.html') || out.includes('reference='),
    `the finalise link did not render: ${out.slice(0, 200)}`);
});

test('the deposit template still names the right amount', () => {
  const out = render(byKey('deposit_link_ready').body_html, BOOKING, null);
  assert.ok(out.includes('$150.00'), 'deposit template lost the deposit amount');
  // NOT the $100 fallback this codebase has been bitten by before.
  assert.ok(!out.includes('$100.00'), 'a fallback amount leaked into the deposit template');
});
test('a template key is unique, or the seed silently keeps only one', () => {
  const keys = MANUAL_TEMPLATES.map((t) => t.template_key);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate template_key: ${keys.join(', ')}`);
});

// create-stripe-link.js calls sendTemplate without ever running ensureTables(),
// so on a cold database the templates would not exist and a client would get a
// Stripe link with no email about it. sendTemplate seeds and retries once.
test('sendTemplate seeds the templates if the lookup misses', async () => {
  const { sendTemplate } = require('../netlify/functions/automations.js');
  let seeded = false;
  let lookups = 0;
  const client = {
    query: async (sql) => {
      if (/INSERT INTO automation_rules/i.test(sql)) { seeded = true; return { rows: [] }; }
      if (/SELECT \* FROM automation_rules WHERE template_key/i.test(sql)) {
        lookups++;
        return { rows: seeded ? [{ id: 9, name: 'Deposit link ready', subject: 'S', body_html: '<p>B</p>', channel: 'email', body_sms: '' }] : [] };
      }
      return { rows: [] };
    }
  };
  const res = await sendTemplate(client, { id: 1, client_email: 'a@b.com' }, 'deposit_link_ready', null);

  assert.ok(seeded, 'a missing template must trigger a seed, not a silent no-send');
  assert.strictEqual(lookups, 2, 'the template must be looked up again after seeding');
  // No RESEND_API_KEY in tests, so the send itself fails — but it must fail on
  // the transport, having found the template, not on the template being absent.
  assert.ok(!/is missing/.test(res.error || ''),
    `sendTemplate gave up before seeding: ${JSON.stringify(res)}`);
});

// ── The balance email ───────────────────────────────────────────────────────
// It was an HTML literal in create-stripe-link.js until 2026-08-20: the only
// way to reword a bill was a code change and a deploy.
test('the balance template itemises the balance, the fee and the total', () => {
  const out = render(byKey('balance_link_ready').body_html, BOOKING, null);
  assert.ok(out.includes('$450.00'), 'lost the balance');
  assert.ok(out.includes('$22.50'), 'lost the 5% service fee');
  assert.ok(out.includes('$472.50'), 'lost the total due');
  // The link is the finalisation page, which mints the session on press — a
  // checkout URL emailed here would be expired by the next evening.
  assert.ok(out.includes('reference=') || out.includes('/my-booking.html'), 'lost the pay link');
});

// The three figures must agree with the Stripe session to the cent — this is
// the document a client checks the arithmetic on.
test('the emailed total is the one Stripe will charge', () => {
  const { balanceCharge } = require('../netlify/functions/_items.js');
  const c = balanceCharge(BOOKING);
  const out = render(byKey('balance_link_ready').body_html, BOOKING, 'x');
  assert.ok(out.includes('$' + c.total.toFixed(2)), `email total is not $${c.total.toFixed(2)}`);
});

// A 5% card-only surcharge would breach Visa/Mastercard surcharge rules. The
// wording is load-bearing, in the email as much as on the Stripe page.
test('no client template calls the fee a card or processing fee', () => {
  for (const t of MANUAL_TEMPLATES) {
    const text = (t.subject + ' ' + t.body_html + ' ' + (t.body_sms || '')).toLowerCase();
    for (const word of ['surcharge', 'card fee', 'processing fee', 'convenience']) {
      assert.ok(!text.includes(word), `${t.template_key} says "${word}"`);
    }
  }
});

// The point of the exercise: no client-facing copy left in the function.
test('create-stripe-link.js sends no email of its own any more', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../netlify/functions/create-stripe-link.js'), 'utf8');
  assert.ok(!/sendEmail\(/.test(src),
    'an inline sendEmail is back in create-stripe-link.js — it belongs in a template');
});

// ── The rule editor must not re-trigger a manual template ───────────────────
// The trigger <select> has no 'manual' option, so a template rule rendered
// through it comes up on the FIRST option — status_change / confirmed — and
// saving an edited wording turned the deposit email into an automation that
// mailed a pay link to every booking reaching 'confirmed'. A fixed label and a
// hidden input keep the trigger the rule already has.
test('the rule editor shows a template a fixed trigger, not the dropdown', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../admin.html'), 'utf8');
  const modal = html.slice(html.indexOf('function openRuleModal'),
                           html.indexOf('function updateRuleTriggerUI'));
  assert.ok(modal.includes('${r.template_key ?'),
    'the rule editor stopped branching on template_key — editing a template can retrigger it');
  assert.ok(/<input type="hidden" id="rule-trigger" value="\$\{r\.trigger_event === 'system' \? 'system' : 'manual'\}">/.test(modal),
    'saveRule reads #rule-trigger; without the hidden input a template save picks the first option');
});
