const { test } = require('node:test');
const assert = require('node:assert');
const { wantsSms } = require('../netlify/functions/staff-assignments.js');

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
