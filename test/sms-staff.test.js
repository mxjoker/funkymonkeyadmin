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

const { smsSegments } = require('../netlify/functions/_sms.js');
const { renderSms } = require('../netlify/functions/_sms.js');
const { TEMPLATES } = require('../netlify/functions/_templates.js');
const tpl = (k) => TEMPLATES.find((t) => t.template_key === k);

// The gig offer used to list lettered roles for the crew to reply with, and
// sms-webhook.js parsed those replies. Removed 2026-08-20 — the text names the
// gig and sends them to the portal, which is where interest is registered.
const GIG = {
  service_name: 'Foam Party', event_zip: '73013', event_time: '6:00 PM',
  event_date: new Date(2026, 7, 23),
};
const OFFER_EXTRA = { portal_link: 'https://funkymonkeyadmin.netlify.app/staff-portal.html' };

test('the gig offer text names the gig, the portal and the opt-out', () => {
  const txt = renderSms(tpl('staff_gig_available').body_sms, GIG, null, OFFER_EXTRA);
  assert.match(txt, /Foam Party/);
  assert.match(txt, /staff-portal\.html/);
  assert.match(txt, /Reply STOP to opt out/);
});

test('the gig offer text asks for no reply codes at all', () => {
  const txt = renderSms(tpl('staff_gig_available').body_sms, GIG, null, OFFER_EXTRA);
  assert.ok(!/\ba\)/.test(txt) && !/reply with/i.test(txt),
    `the offer still asks for a coded reply: ${txt}`);
});

test('both staff texts fit two segments', () => {
  for (const key of ['staff_gig_available', 'staff_assigned']) {
    const txt = renderSms(tpl(key).body_sms, GIG, null,
      { ...OFFER_EXTRA, load_time: '4:30 PM' });
    const segs = smsSegments(txt);
    assert.ok(segs <= 2, `${key} must fit two segments, was ${segs} (${txt.length} chars)`);
  }
});

// A text quoting a load time with no way to see the rest of the gig is the
// failure the portal link prevents.
test('the assignment text carries the load time and the portal', () => {
  const txt = renderSms(tpl('staff_assigned').body_sms, GIG, null,
    { ...OFFER_EXTRA, load_time: '4:30 PM' });
  assert.match(txt, /Load up 4:30 PM/);
  assert.match(txt, /staff-portal\.html/);
});
