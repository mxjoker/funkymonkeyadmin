// netlify/functions/_reference.js — the one reference generator, shared by
// bookings (FM-) and camps (CAMP-) so the two never drift into different
// randomness, alphabets, or ambiguous characters. Extracted from
// bookings.js:186, which minted FM- refs inline before camps needed the same
// scheme with a different prefix.
const crypto = require('crypto');

// 32 chars, no ambiguous I/O/1/0 — a support call reading a reference over
// the phone must never hit a character that could be either of two letters.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// prefix + 8 chars of crypto-random base32 (~40 bits of randomness). Caller
// retries on a UNIQUE (or, here, SELECT-then-insert) collision.
function generateReference(prefix = 'FM-') {
  const bytes = crypto.randomBytes(8);
  let r = prefix;
  for (let i = 0; i < 8; i++) r += CHARS[bytes[i] % 32];
  return r;
}

module.exports = { generateReference };
