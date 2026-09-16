const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AUTO = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations.js'), 'utf8');
const seed = () => AUTO.split('const CLIENT_SMS_DRAFTS = [')[1].split('];')[0];

// These are the first rules in the system that can text a CUSTOMER. Everything
// here is about them not doing that by accident.
test('every client SMS draft is seeded switched off', () => {
  const insert = AUTO.split('CLIENT_SMS_DRAFTS')[2];
  assert.ok(/VALUES \(\$1, FALSE,/.test(insert), 'a customer-facing text must not seed itself live');
  assert.ok(/ON CONFLICT \(template_key\) DO NOTHING/.test(insert),
    'DO UPDATE would overwrite wording, or the on/off switch, that Joe has since changed');
});

test('the trigger loops that would fire them all require active=TRUE', () => {
  for (const ev of ['status_change', 'days_before_event']) {
    const clause = AUTO.split(`trigger_event='${ev}'`)[0].split('WHERE').pop();
    assert.ok(/active=TRUE/.test(clause), `${ev} must not fire an inactive rule`);
  }
});

// A Stripe checkout URL dies in 24 hours. A balance link is minted on press
// now, so stripe_balance_link is empty on every upcoming booking that owes
// money — a text built on it would demand payment and show a blank.
test('no draft carries an expiring or empty payment link', () => {
  const s = seed();
  assert.ok(!/{{balance_link}}/.test(s), 'balance_link is empty on every upcoming booking');
  assert.ok(!/{{payment_link}}|{{deposit_link}}/.test(s), 'a minted checkout link expires in 24h');
  assert.ok((s.match(/{{finalise_link}}/g) || []).length >= 2, 'the money drafts need the stable link');
});

// 10DLC compliance: the campaign was approved on sample messages that carry it.
test('every draft body carries the opt-out sentence', () => {
  const bodies = seed().split('\n').filter((l) => /Hi {{client_first_name}}|We're all set/.test(l));
  assert.ok(bodies.length >= 3, 'expected three draft bodies, found ' + bodies.length);
  for (const b of bodies) assert.ok(/Reply STOP to opt out/.test(b), 'missing opt-out: ' + b.slice(0, 50));
});

// Rule 1 already emails a confirmation and rule 2 a reminder. 'both' here would
// send the same message twice by two routes.
test('the drafts are SMS-only, so nothing doubles up with an existing email', () => {
  assert.ok(/'', '', \$5, 'sms',/.test(AUTO.split('CLIENT_SMS_DRAFTS')[2]), 'channel must be sms');
});

// The gate that makes switching one on survivable: it reaches only people who
// ticked the box, not the 644 bookings with a phone number on file.
test('client SMS is refused without consent', () => {
  assert.ok(/booking\.sms_consent !== true/.test(AUTO), 'the consent gate must still exist');
});
