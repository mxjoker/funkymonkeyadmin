const { test } = require('node:test');
const assert = require('node:assert');
const { wantsSms, wantsEmail } = require('../netlify/functions/staff-assignments.js');

// comms_preference already existed on the staff table with an 'sms' option in
// both the admin and portal UIs, labelled "coming soon". This is that switch
// finally meaning something — not a second opt-in mechanism.
test('only staff who asked for SMS get SMS', () => {
  assert.strictEqual(wantsSms({ comms_preference: 'sms' }),   true);
  assert.strictEqual(wantsSms({ comms_preference: 'both' }),  true);
  assert.strictEqual(wantsSms({ comms_preference: 'email' }), false);
  assert.strictEqual(wantsSms({ comms_preference: 'call' }),  false);
});

// The column defaults to 'email' but old rows may hold NULL or ''. Neither is
// consent.
test('an unset preference is not consent', () => {
  assert.strictEqual(wantsSms({}), false);
  assert.strictEqual(wantsSms({ comms_preference: null }), false);
  assert.strictEqual(wantsSms({ comms_preference: '' }), false);
  assert.strictEqual(wantsSms(null), false);
});

// Only an explicit SMS-only choice suppresses email. Everything else — 'both',
// the legacy 'call', and unset — still gets one; the signature bug in this
// codebase is silent non-delivery, and defaulting to "send it" avoids it.
test('email goes out unless SMS-only was explicitly chosen', () => {
  assert.strictEqual(wantsEmail({ comms_preference: 'email' }), true);
  assert.strictEqual(wantsEmail({ comms_preference: 'both' }),  true);
  assert.strictEqual(wantsEmail({ comms_preference: 'sms' }),   false);
  assert.strictEqual(wantsEmail({ comms_preference: 'call' }),  true);
  assert.strictEqual(wantsEmail({}), true);
  assert.strictEqual(wantsEmail({ comms_preference: null }), true);
  assert.strictEqual(wantsEmail({ comms_preference: '' }), true);
  assert.strictEqual(wantsEmail(null), true);
});
