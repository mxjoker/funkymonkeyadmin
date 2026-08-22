const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInbound } = require('../netlify/functions/sms-webhook.js');
const fs = require('node:fs');
const path = require('node:path');

// STOP/START/HELP are carrier-level obligations and must never reach gig logic.
test('opt-out keywords are recognised in the shapes people send them', () => {
  for (const s of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'CANCEL', 'QUIT', 'END']) {
    assert.strictEqual(classifyInbound(s), 'stop', `failed on ${JSON.stringify(s)}`);
  }
});

test('start and help are their own routes', () => {
  assert.strictEqual(classifyInbound('START'), 'start');
  assert.strictEqual(classifyInbound('unstop'), 'start');
  assert.strictEqual(classifyInbound('HELP'), 'help');
  assert.strictEqual(classifyInbound('info'), 'help');
});

// "I can't stop thinking about the foam party" is not an opt-out. Only a
// keyword-only message is.
test('a keyword inside a sentence is not an opt-out', () => {
  assert.strictEqual(classifyInbound("can't stop thinking about it"), 'message');
  assert.strictEqual(classifyInbound('a'), 'message');
  assert.strictEqual(classifyInbound(''), 'message');
});

// ── The reply codes are gone (2026-08-20) ──────────────────────────────────
// A gig offer used to list lettered roles and the webhook parsed the reply into
// an interest row. Joe: "too confusing. Just tell them to check the portal."
// A staff member texting "a" now reaches a human, which is the point — but only
// if none of the parsing survives to swallow it first.
const SRC = (f) => fs.readFileSync(path.join(__dirname, '../netlify/functions', f), 'utf8');

test('nothing parses an inbound message into a gig selection any more', () => {
  for (const f of ['sms-webhook.js', '_sms.js', 'staff-assignments.js']) {
    const src = SRC(f);
    for (const gone of ['parseLetters', 'buildOfferMap', 'offerText', 'replyForLetters', 'latestOffer']) {
      assert.ok(!src.includes(gone), `${f} still references ${gone}`);
    }
  }
});

// The offer_map column stays on sms_log — the rows already written are the
// record of what was offered to whom — but nothing may write it again, because
// a written offer_map is what made a reply parseable.
test('no new sms_log row carries an offer map', () => {
  const src = SRC('_sms.js');
  const insert = src.slice(src.indexOf('INSERT INTO sms_log'), src.indexOf('RETURNING id'));
  assert.ok(!insert.includes('offer_map'), 'logSms is writing an offer_map again');
});

// A staff member who replies to a gig text must reach Joe rather than silence.
test('an unrecognised message is forwarded, not answered by a parser', () => {
  const src = SRC('sms-webhook.js');
  assert.match(src, /NOTIFY_SMS/, 'the forward to Joe is gone');
  assert.ok(!/expressInterest/.test(src), 'the webhook still registers interest from a text');
});

// HELP is a carrier obligation and must not describe a feature that no longer
// exists — "reply with the letters" would now be a lie.
test('the HELP reply points at the portal, not at reply codes', () => {
  const src = SRC('sms-webhook.js');
  const help = src.slice(src.indexOf("kind === 'help'"), src.indexOf("kind === 'help'") + 400);
  assert.ok(!/letters/i.test(help), 'HELP still tells people to reply with letters');
  assert.match(help, /portal/i, 'HELP should point staff at the portal');
  assert.match(help, /STOP/, 'HELP must still name the opt-out keyword');
});
