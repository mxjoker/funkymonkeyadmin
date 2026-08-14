const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInbound, replyForLetters } = require('../netlify/functions/sms-webhook.js');

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
