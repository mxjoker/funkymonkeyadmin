const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInbound, replyForLetters } = require('../netlify/functions/sms-webhook.js');
const { parseLetters } = require('../netlify/functions/_sms.js');

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

// Unrecognised letters get an answer, not silence.
test('an unrecognised letter is named back to the sender', () => {
  const out = replyForLetters(['a'], ['d'], { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' }, c: { tag_filled: 'Driver' } });
  assert.match(out, /Didn't recognise 'd'/);
  assert.match(out, /a, b, c/);
});

test('a clean selection confirms the roles by name', () => {
  const out = replyForLetters(['a', 'b'], [], { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' } });
  assert.match(out, /Foam Operator/);
  assert.match(out, /Setup/);
  assert.doesNotMatch(out, /Didn't recognise/);
});

// The combined case, driven through the real parser rather than hand-built
// arrays: "ad" against an offer with only a/b/c picks 'a' and flags 'd'.
test('a reply mixing a valid and an invalid letter confirms one and flags the other', () => {
  const offerMap = { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' }, c: { tag_filled: 'Driver' } };
  const { picked, unknown, freeform } = parseLetters('ad', offerMap);
  assert.strictEqual(freeform, false);
  assert.deepStrictEqual(picked, ['a']);
  assert.deepStrictEqual(unknown, ['d']);
  const out = replyForLetters(picked, unknown, offerMap);
  assert.match(out, /Foam Operator/);
  assert.match(out, /Didn't recognise 'd'/);
});

// A booking that closed between the offer going out and the reply arriving
// (completed/cancelled/fully staffed) must not silently register interest,
// and the sender must not be met with silence either.
test('a letter for a gig that has since closed is named, not silently registered', () => {
  const out = replyForLetters(['a'], [], { a: { tag_filled: 'Foam Operator' }, b: { tag_filled: 'Setup' } }, ['b']);
  assert.match(out, /Foam Operator/);
  assert.match(out, /Setup/);
  assert.match(out, /already closed/);
});

// Every letter offered has since closed: nothing gets registered, but the
// reply must still say something — an empty string is silent-nothing by SMS.
test('a reply where every letter has closed still gets a non-empty reply', () => {
  const out = replyForLetters([], [], { a: { tag_filled: 'Foam Operator' } }, ['a']);
  assert.notStrictEqual(out, '');
  assert.match(out, /already closed/);
});
