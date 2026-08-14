// netlify/functions/_sms.js — the one door to Twilio.
//
// Mirrors _email.js on purpose: a single sender means opt-out and quiet hours
// are enforced in one place rather than at nine call sites, and the log is
// complete because nothing else can send.
//
// A previous _sms.js was deleted in 90e3dc7 as an unused sender. It is not
// being resurrected — it returned null on every error path, so a caller could
// not tell a delivered message from a missing API key. This one returns a
// status for every outcome and writes a row for every one of them.

const { fmtEventDate, reviewLinkFor } = require('./_email');

const TZ = 'America/Chicago';

// ── Phone normalisation ──────────────────────────────────────────────────────
// Load-bearing: applied on send AND on inbound lookup. If the two ever disagree
// a reply stops matching the person who sent it, and nothing errors.
//
// Deliberately strict. The old version did `if (digits.length >= 11) return
// '+' + digits`, which turned a mistyped 14-digit string into a valid-looking
// E.164 number — texting a stranger a client's address rather than failing.
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// ── Quiet hours ──────────────────────────────────────────────────────────────
// 8am–9pm Central. Intl rather than a fixed offset: Oklahoma is UTC-5 in summer
// and UTC-6 in winter, so a hardcoded offset is an hour wrong for four months
// of the year — in the direction of texting people at 7am.
// hourCycle 'h23' rather than hour12:false, which yields "24" for midnight on
// some ICU builds.
function centralHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hourCycle: 'h23'
  }).format(date));
}

function isQuietHours(date = new Date()) {
  const h = centralHour(date);
  return h < 8 || h >= 21;
}

// ── Plain-text template renderer ─────────────────────────────────────────────
// Same token names as _email.js render(), but NOT the same function: render()
// runs every value through esc(), so "O'Brien" would arrive as "O&#39;Brien",
// and its {{deposit_link}} is a whole <div>. Same vocabulary, different medium.
function renderSms(template, booking = {}, link) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  return String(template || '')
    .replace(/{{client_first_name}}/g, firstName)
    .replace(/{{client_name}}/g,       booking.client_name || '')
    .replace(/{{guests_of_honour}}/g,  booking.guests_of_honour || booking.child_name || 'everyone')
    .replace(/{{child_name}}/g,        booking.child_name || '')
    .replace(/{{review_link}}/g,       reviewLinkFor(booking))
    .replace(/{{service_name}}/g,      booking.service_name || '')
    .replace(/{{event_date}}/g,        fmtEventDate(booking.event_date, { weekday: 'short', month: 'numeric', day: 'numeric' }) || 'TBD')
    .replace(/{{event_time}}/g,        booking.event_time || '')
    .replace(/{{event_zip}}/g,         booking.event_zip  || '')
    .replace(/{{total_price}}/g,       Number(booking.total_price   || 0).toFixed(2))
    // NOT `|| 100`. Schools and libraries book with deposit_amount = 0 and must
    // never be texted a demand for money the booking does not want.
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount || 0).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due    || 0).toFixed(2))
    .replace(/{{reference}}/g,         booking.reference || '')
    .replace(/{{payment_link}}/g,      link || '');
}

// ── Letter reply parsing ─────────────────────────────────────────────────────
// An offer lists roles as lettered options; a reply may combine them ("ac").
// Resolved against the offer_map stored on THAT outbound message, never against
// the live open-gig list — otherwise "b" means something different two hours
// later, because slots change.
//
// ponytail: a reply of more than MAX_PICK letters is treated as prose and
// forwarded to Joe rather than parsed. Offers never carry more than a handful
// of roles, and "sorry can't make it" must not come back as
// "Didn't recognise 's','o','r','y'". Raise MAX_PICK if offers ever get longer.
const MAX_PICK = 6;

function parseLetters(reply, offerMap) {
  const valid = Object.keys(offerMap || {});
  const letters = String(reply || '').toLowerCase().replace(/[^a-z]/g, '');
  const picked = [], unknown = [], seen = new Set();

  if (!letters || letters.length > MAX_PICK) return { picked, unknown, freeform: true };

  for (const ch of letters) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    (valid.includes(ch) ? picked : unknown).push(ch);
  }
  // Nothing recognised at all — this is prose, not a mistyped selection.
  if (!picked.length) return { picked: [], unknown: [], freeform: true };
  return { picked, unknown, freeform: false };
}

module.exports = { normalisePhone, isQuietHours, renderSms, parseLetters };
