const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

function loadSig() {
  delete require.cache[require.resolve('../netlify/functions/_twilio-sig.js')];
  return require('../netlify/functions/_twilio-sig.js');
}

// Build the header Twilio would send, using Twilio's documented algorithm:
// HMAC-SHA1 over the full URL followed by every POST param sorted by key,
// concatenated as key+value, base64-encoded.
function signed(token, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function twilioEvent(params, { token = 'tok_test', path = '/api/sms-status', tamper = false } = {}) {
  const url = 'https://funkymonkeyadmin.netlify.app' + path;
  const sig = signed(token, url, params);
  return {
    httpMethod: 'POST',
    headers: { 'x-twilio-signature': tamper ? 'Zm9yZ2VkCg==' : sig },
    body: new URLSearchParams(params).toString()
  };
}

test('a correctly signed request verifies', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
  assert.strictEqual(verifyTwilio(twilioEvent(params), '/api/sms-status'), true);
});

// Without this check anyone with the URL can forge replies — registering
// interest as another staff member, or opting a client out.
test('a forged signature is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
  assert.strictEqual(verifyTwilio(twilioEvent(params, { tamper: true }), '/api/sms-status'), false);
});

test('a request signed with the wrong token is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1' };
  assert.strictEqual(verifyTwilio(twilioEvent(params, { token: 'wrong_token' }), '/api/sms-status'), false);
});

test('a request with a tampered body is rejected', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.SITE_URL = 'https://funkymonkeyadmin.netlify.app';
  const { verifyTwilio } = loadSig();
  const ev = twilioEvent({ MessageSid: 'SM1', MessageStatus: 'delivered' });
  ev.body = new URLSearchParams({ MessageSid: 'SM1', MessageStatus: 'failed' }).toString();
  assert.strictEqual(verifyTwilio(ev, '/api/sms-status'), false);
});

test('a missing signature header is rejected, not waved through', () => {
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  const { verifyTwilio } = loadSig();
  assert.strictEqual(verifyTwilio({ headers: {}, body: 'MessageSid=SM1' }, '/api/sms-status'), false);
});

test('a missing auth token rejects rather than skipping verification', () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  const { verifyTwilio } = loadSig();
  const params = { MessageSid: 'SM1' };
  assert.strictEqual(verifyTwilio(twilioEvent(params), '/api/sms-status'), false);
});

test('parseForm decodes a urlencoded body including + and %', () => {
  const { parseForm } = loadSig();
  const out = parseForm('Body=a+c&From=%2B14055417953');
  assert.strictEqual(out.Body, 'a c');
  assert.strictEqual(out.From, '+14055417953');
});
