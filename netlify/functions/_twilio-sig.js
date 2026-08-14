// netlify/functions/_twilio-sig.js — Twilio webhook signature verification.
//
// Shared by sms-status.js and sms-webhook.js. Not optional on either: without
// it, anyone who learns the URL can forge a delivery receipt, register gig
// interest as somebody else, or opt a client out of their own booking texts.
//
// The URL is rebuilt from SITE_URL and a fixed path rather than from request
// headers. Netlify sits behind a proxy, so Host/X-Forwarded-Proto are not
// reliably the values Twilio signed — deriving the URL from them is the classic
// way this check "works in testing and rejects everything in production".
// Consequence: Twilio must be pointed at exactly `${SITE_URL}/api/sms-status`
// and `${SITE_URL}/api/sms-webhook`, with no query string.

const crypto = require('node:crypto');

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body || '')) out[k] = v;
  return out;
}

function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function verifyTwilio(event, path) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const header = event.headers && (event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature']);
  // No token configured is a rejection, not a bypass. A misconfigured
  // deployment must fail closed.
  if (!token || !header) return false;

  const site = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const expected = twilioSignature(token, site + path, parseForm(event.body));

  const a = Buffer.from(header, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyTwilio, twilioSignature, parseForm };
