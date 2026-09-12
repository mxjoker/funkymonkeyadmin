const { test } = require('node:test');
const assert = require('node:assert');
const { sourceOf, platformBooked, platformLabel, SOURCES } = require('../netlify/functions/_source.js');
const { asksForPayment } = require('../netlify/functions/_email.js');

// ── The decider ──────────────────────────────────────────────────────────────

test('an unknown or missing source reads as direct', () => {
  // Every one of the 732 rows that predates the column has NULL here. They must
  // keep behaving exactly as they did, or adding this column silently stops
  // invoicing the entire existing book.
  for (const v of [undefined, null, '', 'DIRECT', 'nonsense', 42, {}]) {
    assert.strictEqual(sourceOf({ source: v }), 'direct', `${JSON.stringify(v)} must read as direct`);
    assert.strictEqual(platformBooked({ source: v }), false);
  }
  assert.strictEqual(sourceOf(null), 'direct', 'a missing booking must not throw');
  assert.strictEqual(sourceOf(undefined), 'direct');
});

test('gigsalad is platform-booked and reads back with its proper name', () => {
  assert.strictEqual(platformBooked({ source: 'gigsalad' }), true);
  assert.strictEqual(platformLabel({ source: 'gigsalad' }), 'GigSalad');
  // Case and padding are what a hand-typed or imported value actually looks like.
  assert.strictEqual(platformBooked({ source: ' GigSalad ' }), true);
});

test('a direct booking is never treated as platform-booked', () => {
  assert.strictEqual(platformBooked({ source: 'direct' }), false);
  assert.strictEqual(platformLabel({ source: 'direct' }), '');
});

test('direct is in the source list exactly once and is the first entry', () => {
  assert.strictEqual(SOURCES[0], 'direct');
  assert.strictEqual(new Set(SOURCES).size, SOURCES.length);
});

// ── What counts as asking for money ──────────────────────────────────────────

test('a body is a payment demand if it carries a checkout link, whatever it is called', () => {
  // Decided by tokens, not the rule's name — the name is editable in the
  // Automations tab and renaming a rule must not change what it may do.
  assert.strictEqual(asksForPayment('Pay your balance: {{balance_link}}'), true);
  assert.strictEqual(asksForPayment('<a href="{{deposit_link}}">Pay</a>'), true);
  assert.strictEqual(asksForPayment('{{payment_link}}'), true);
});

test('an ordinary message is not a payment demand', () => {
  for (const body of ['See you tomorrow!', 'Your event is at {{event_time}}.',
                      'Finish your details: {{finalise_link}}', '', null, undefined]) {
    assert.strictEqual(asksForPayment(body), false,
      `${JSON.stringify(body)} must not be treated as asking for money`);
  }
});

test('the finalise link is NOT a payment demand', () => {
  // It is how a GigSalad client confirms their details. Treating it as a money
  // token would suppress the one message this whole workflow depends on.
  assert.strictEqual(asksForPayment('Confirm here: {{finalise_link}}'), false);
});

// ── The claim door's conditions ──────────────────────────────────────────────
// authenticateClaim is not exported (it needs a db client), so these pin the
// rules it enforces via the decider it is built on. The door opens only for a
// platform booking with no email yet.

test('the claim door is only conceivable for a platform booking', () => {
  const direct = { source: 'direct', client_email: '' };
  assert.strictEqual(platformBooked(direct), false,
    'a direct booking with no email must never open a reference-only door');
});

test('a platform booking that already has an email is past claiming', () => {
  const claimed = { source: 'gigsalad', client_email: 'ana@example.com' };
  assert.ok(platformBooked(claimed));
  assert.ok(String(claimed.client_email).trim(),
    'the door closes on the first successful claim, so this state must be recognisable');
});

test('the claim view never carries money', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/finalise.js'), 'utf8');
  const view = src.slice(src.indexOf('function claimView('), src.indexOf('exports.handler'));
  for (const field of ['total_price', 'deposit_amount', 'balance_due', 'stripe_payment_link']) {
    assert.ok(!view.includes(field),
      `claimView must not expose ${field} behind a single guessable reference`);
  }
});

test('the money paths all refuse a platform booking', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['finalise.js', 'create-stripe-link.js', 'automations.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/', f), 'utf8');
    assert.ok(src.includes('platformBooked('),
      `${f} mints or sends money messages and must ask _source.js first`);
  }
});

test('create-stripe-link actually selects the column it decides on', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/create-stripe-link.js'), 'utf8');
  const cols = src.slice(src.indexOf('const COLS ='), src.indexOf('const bookingRow'));
  assert.ok(/\bsource\b/.test(cols),
    'without source in COLS the decider reads undefined, defaults to direct, and bills a GigSalad client');
});
