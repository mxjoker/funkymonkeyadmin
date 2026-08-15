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

const { buildOfferMap, offerText } = require('../netlify/functions/staff-assignments.js');
const { smsSegments } = require('../netlify/functions/_sms.js');

// The letter→role map is stored on the outbound sms_log row so a reply resolves
// against what was actually offered, not against the open-gig list at reply
// time. Slots change; "b" must not mean something different two hours later.
test('an offer map keys each letter to a booking and a role', () => {
  const map = buildOfferMap(['Foam Operator', 'Setup'], 42);
  assert.deepStrictEqual(map, {
    a: { booking_id: 42, tag_filled: 'Foam Operator' },
    b: { booking_id: 42, tag_filled: 'Setup' }
  });
});

test('a single matching role still gets a letter', () => {
  assert.deepStrictEqual(buildOfferMap(['Driver'], 7), { a: { booking_id: 7, tag_filled: 'Driver' } });
});

test('the offer text lists every letter and the STOP notice', () => {
  const map = buildOfferMap(['Foam Operator', 'Setup'], 42);
  const txt = offerText({ service_name: 'Foam Party', event_zip: '73013', event_time: '6:00 PM' }, 'Sun, 8/23/2026', map);
  assert.match(txt, /a\) Foam Operator/);
  assert.match(txt, /b\) Setup/);
  assert.match(txt, /Reply STOP to opt out/);
  const segs = smsSegments(txt);
  assert.ok(segs <= 2, `offer must fit two segments, was ${segs} (${txt.length} chars)`);
});
