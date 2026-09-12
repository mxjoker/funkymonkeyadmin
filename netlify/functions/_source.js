// netlify/functions/_source.js — where a booking came from, and therefore who
// collects the money for it.
//
// This exists as ONE decider for the same reason _brand.js does: four writers
// each grew their own version of the brand rule and three of them were wrong.
// A money decision spread across the deposit button, the balance button, the
// rule engine and the finalise page would go the same way.
//
// The question it answers is narrow and is NOT "how did they hear about us" —
// that is `referral_source`, which is marketing data, free text, and empty on
// 716 of 732 bookings. This one decides whether WE bill the client at all.

// 'direct' is every booking taken through our own form, the phone, or admin
// entry: we quote it, we collect the deposit, we chase the balance.
//
// A platform value means the platform took the client's money and pays us.
// Asking that client for a deposit or a balance bills them twice for one gig.
const DIRECT = 'direct';

// Platforms that collect from the client on our behalf. Adding The Bash or
// Thumbtack later is one entry here, not a second mechanism.
const PLATFORMS = Object.freeze({
  gigsalad: 'GigSalad',
});

const SOURCES = Object.freeze([DIRECT, ...Object.keys(PLATFORMS)]);

// Anything unrecognised — NULL on every row that predates this column, a typo,
// an old import — reads as 'direct'. That is the safe default in exactly one
// direction: it keeps today's behaviour for all 732 existing bookings, and the
// failure mode is a payment request that should not have gone out rather than a
// gig we silently never invoice. The first is embarrassing and recoverable; the
// second is unpaid work nobody notices.
function sourceOf(booking) {
  const raw = String((booking && booking.source) || '').trim().toLowerCase();
  return SOURCES.includes(raw) ? raw : DIRECT;
}

// The one question the money paths ask. True means the client already paid the
// platform: send no deposit request, mint no balance link, chase nothing.
function platformBooked(booking) {
  return sourceOf(booking) !== DIRECT;
}

// For display and for message wording — "paid through GigSalad" reads better
// than "paid through gigsalad", and a template should never have to case it.
function platformLabel(booking) {
  return PLATFORMS[sourceOf(booking)] || '';
}

module.exports = { DIRECT, PLATFORMS, SOURCES, sourceOf, platformBooked, platformLabel };
