const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const FINALISE = SRC('netlify/functions/finalise.js');
const PAGE = SRC('my-booking.html');
const ADMIN = SRC('admin.html');

// ── Why this file exists ────────────────────────────────────────────────────
// A Stripe Checkout Session expires 24 hours after it is created, and 24h is
// also the longest expiry Stripe will accept. Any flow that STORES a checkout
// URL and shows it again later is showing a dead page. FM-KNNVZY8J hit exactly
// that on 2026-08-20 — the button on her finalisation page pointed at a session
// minted 26 hours earlier, and she could not pay until a fresh link was sent.

test('the finalisation page mints a session instead of carrying one', () => {
  assert.match(FINALISE, /body\.action === 'pay_link'/, 'the pay_link action is gone');
  assert.match(PAGE, /action: 'pay_link'/, 'the page no longer asks for a session');
  assert.ok(!/href="\$\{esc\(booking\.stripe_payment_link\)\}"/.test(PAGE),
    'the page is linking a stored checkout URL again — it will be expired by tomorrow');
});

// The endpoint is public: reference + email is the whole key. A browser that
// could name the amount could name $0.01.
test('pay_link takes its amount from the row, never from the request', () => {
  const block = FINALISE.slice(FINALISE.indexOf("body.action === 'pay_link'"),
                               FINALISE.indexOf("return withClient(async (c) => {\n      await ensureBookingChanges"));
  // Deposit from the row's deposit_amount, balance from balanceCharge(row).
  // The request names the KIND and nothing else.
  assert.match(block, /Number\(booking\.deposit_amount \|\| 0\)/, 'the deposit amount must come from the row');
  assert.match(block, /balanceCharge\(booking\)/, 'the balance amount must come from the row');
  assert.ok(!/body\.amount|opts\.amount/.test(block), 'the request can name the price');
  // The $100 fallback this codebase has shipped twice.
  assert.ok(!/\|\|\s*100\b/.test(block), 'a fallback deposit amount is back');
  assert.match(block, /charge\.balance > 0/, 'a $0 deposit or a settled balance must not be billable');
});

test('pay_link refuses a booking whose deposit is already paid', () => {
  const block = FINALISE.slice(FINALISE.indexOf("body.action === 'pay_link'"),
                               FINALISE.indexOf('return json(200, { url: session.url })'));
  assert.match(block, /booking\.deposit_paid/, 'a paid deposit could be charged twice');
  assert.match(block, /409/, 'the double-payment refusal should be a 409');
});

test('pay_link authenticates with the same key as the rest of the page', () => {
  const block = FINALISE.slice(FINALISE.indexOf("body.action === 'pay_link'"),
                               FINALISE.indexOf('return json(200, { url: session.url })'));
  assert.match(block, /await authenticate\(c, reference, email\)/, 'the endpoint is unauthenticated');
});

// The admin's finalisation email used to reuse a stored link, which is how a
// 26-hour-old session got emailed as if it were live.
test('sending a finalisation link always mints a fresh session', () => {
  const fn = ADMIN.slice(ADMIN.indexOf('async function sendFinalisationLink'),
                         ADMIN.indexOf('async function recordClientPayment'));
  assert.ok(!/!b\.stripe_payment_link\s*&&/.test(fn),
    'the reuse check is back — a re-sent finalisation email will carry an expired link');
  assert.match(fn, /if \(depositAmount > 0\)/, 'a $0-deposit booking must still not get a link');
});

// The promotion must happen only after the send actually succeeded — a booking
// marked Quoted when nothing left the building is a lie the board tells you
// every time you look at it.
test('the status is promoted after the send, not before it', () => {
  const fn = ADMIN.slice(ADMIN.indexOf('async function sendFinalisationLink'),
                         ADMIN.indexOf('async function recordClientPayment'));
  const send = fn.indexOf("if (!res.ok) throw new Error");
  const promote = fn.indexOf('statusAfterFinalisationSent(b.status)');
  assert.ok(send !== -1 && promote > send,
    'the status is written before the send is known to have worked');
  assert.match(fn.slice(promote), /patch\(id, \{ status: promoted \}\)/,
    'the promotion no longer goes through patch(), so it will not be logged');
});

// ── One link, not two ───────────────────────────────────────────────────────
// Joe, 2026-08-20: "why would we not just use that finalization link always?"
// Both client-facing emails now point at the finalisation page, which mints
// checkout on press. Neither carries a session that can be dead on arrival.
test('no client template emails a raw Stripe checkout URL', () => {
  const { TEMPLATES } = require('../netlify/functions/_templates.js');
  for (const t of TEMPLATES.filter((t) => t.recipient === 'client')) {
    assert.ok(!/pay\.stripe\.com|checkout\.stripe\.com/.test(t.body_html),
      `${t.template_key} hardcodes a Stripe URL`);
    // {{payment_link}} resolves to whatever session the caller passes, which is
    // exactly the thing that expires. The finalisation page is the durable one.
    assert.ok(!t.body_html.includes('{{payment_link}}'),
      `${t.template_key} still sends a checkout session that expires in 24h`);
  }
});
