const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AUTO = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const code = AUTO.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// The whole point of the consent record is that it documents a real opt-in.
// An admin who could clear a STOP would be overriding the client's own
// instruction — the one action this record exists to make impossible.
test('nothing in the admin can delete a client STOP', () => {
  assert.ok(!/DELETE FROM sms_optout/i.test(code),
    'automations.js must never delete from sms_optout — only a client texting START may');
  const handler = code.split("action === 'set_sms_consent'")[1].split('return json(200')[0];
  assert.ok(!/sms_optout/i.test(handler),
    'recording consent must not touch the opt-out list');
});

test('consent and opt-out are reported as separate facts', () => {
  const get = code.split("type === 'sms_consent'")[1].split('return json(200')[1].split('}')[0];
  for (const field of ['consent', 'opted_out', 'phone_usable']) {
    assert.ok(new RegExp(field).test(get), `the consent endpoint must report ${field}`);
  }
});

test('an opt-out is shown instead of, not beneath, a recorded consent', () => {
  // A green "texts OK" with a small red footnote is how someone texts a person
  // who told them to stop. The opt-out branch returns before consent renders.
  const fn = HTML.split('async function loadSmsConsent')[1].split('\nasync function setSmsConsent')[0];
  const optoutIdx = fn.indexOf('c.opted_out');
  const consentIdx = fn.indexOf('if (c.consent)');
  assert.ok(optoutIdx !== -1 && consentIdx !== -1, 'both branches must exist');
  assert.ok(optoutIdx < consentIdx, 'the opt-out check must come first and return early');
});

test('consent cannot be recorded against an untextable number', () => {
  const handler = code.split("action === 'set_sms_consent'")[1].split('UPDATE bookings SET sms_consent=TRUE')[0];
  assert.ok(/normalisePhone/.test(handler),
    'recording consent must verify the number can actually be texted');
});

test('how consent was obtained is required and constrained', () => {
  const handler = code.split("action === 'set_sms_consent'")[1].split('UPDATE bookings SET sms_consent=TRUE')[0];
  assert.ok(/HOW\[how\]/.test(handler), 'the method must be validated against a known set');
  assert.ok(/Say how consent was given/.test(handler), 'a missing method must be refused, not stored vaguely');
});

test('withdrawing consent clears the timestamp, not just the flag', () => {
  const handler = code.split("action === 'set_sms_consent'")[1].split('consent: false')[0];
  assert.ok(/sms_consent=FALSE/.test(handler) && /sms_consent_at=NULL/.test(handler),
    'a stale consent date left behind reads as evidence of an opt-in that was withdrawn');
});
