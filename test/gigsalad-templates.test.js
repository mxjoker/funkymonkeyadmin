const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = require('../netlify/functions/_templates.js');
const list = Array.isArray(TEMPLATES) ? TEMPLATES : (TEMPLATES.TEMPLATES || TEMPLATES.templates);
const gs = list.find(t => t.template_key === 'gigsalad_confirmed');

// GigSalad takes the client's money and adds its own fees on top, so every
// figure we hold is the wrong figure to show them — our total is not what they
// paid. This template's whole job is to say the right things while quoting none
// of them.

test('the GigSalad confirmation exists and is a button, not a trigger', () => {
  assert.ok(gs, 'gigsalad_confirmed must be seeded');
  assert.strictEqual(gs.trigger_event, 'manual',
    'a seeded template that fires on its own breaks the templates-wiring invariant');
  assert.strictEqual(gs.recipient, 'client');
});

test('it quotes no money, because our figures are not what GigSalad charged', () => {
  const body = gs.body_html + ' ' + (gs.body_sms || '') + ' ' + gs.subject;
  for (const token of ['{{total_price}}', '{{deposit_amount}}', '{{balance_due}}',
                       '{{balance_total}}', '{{service_fee}}', '{{service_price}}',
                       '{{amount_paid}}']) {
    assert.ok(!body.includes(token), `must not quote ${token} — the fees make it wrong`);
  }
  assert.ok(!/\$\s*\{\{/.test(body), 'no templated dollar figure at all');
});

test('it offers no way to pay us', () => {
  const body = gs.body_html + ' ' + (gs.body_sms || '');
  for (const token of ['{{deposit_link}}', '{{balance_link}}', '{{payment_link}}']) {
    assert.ok(!body.includes(token), `must not carry ${token} — GigSalad already collected`);
  }
});

test('it does send them to the details page, which is the point', () => {
  // This is the one workflow that captures the email and SMS consent GigSalad
  // never gave us.
  assert.ok(gs.body_html.includes('{{finalise_link}}'));
  assert.ok((gs.body_sms || '').includes('{{finalise_link}}'));
});

test('it says who actually holds the payment', () => {
  assert.match(gs.body_html, /GigSalad/,
    'the client must be told where their money went, or they will ask');
});

test('its SMS half carries the opt-out the carrier requires', () => {
  assert.match(gs.body_sms, /Reply STOP/i);
});

test('it sits in the booking group, not the money group', () => {
  // Decades pick the section in the Automations tab: 10-15 is money to the
  // client, 20s is the booking. A confirmation filed under money is findable
  // only by accident.
  assert.ok(gs.sort_order >= 20 && gs.sort_order <= 29,
    `sort_order ${gs.sort_order} puts it in the wrong section`);
});

test('admin picks it by source, and mints no Stripe session for a platform booking', () => {
  const html = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
  const fn = html.slice(html.indexOf('const platform ='), html.indexOf("'finalisation_link_no_deposit'") + 40);
  assert.match(fn, /depositAmount > 0 && !platform/,
    'a platform booking must not have a Stripe deposit session minted for it');
  assert.match(fn, /platform \? 'gigsalad_confirmed'/,
    'a platform booking must get its own template');
});

test('the manual send door refuses a payment template for a platform booking', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/automations.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function sendTemplate('), src.indexOf('async function sendAutomationMessage('));
  assert.ok(fn.includes('platformBooked(booking)'),
    'pressing "send the deposit link" on a GigSalad booking is a slip, and this is every manual send\'s one door');
  assert.ok(fn.includes('asksForPayment('),
    'refusal must key on whether the body asks for money, not on the template name');
});
