// One place that turns PPM's six address columns into a single line.
//
// Shared by import-bookings.js (so new imports keep the address) and
// scripts/backfill-addresses.js (so the ones already imported get it back).
// Two copies of this would drift, and the whole point is that the string in
// event_location is the same string whichever path wrote it.
//
// The import this replaces did:
//     let eventLocation = obj['Venue'] || '';
//     if (!eventLocation) eventLocation = obj['Addr. line 1'] || '';
// — venue instead of address, and the address discarded. Fine in the admin
// where you can look the client up; useless on a phone, where the calendar
// entry is all you have and it has to be tappable for directions.

// Deliberately excludes the postcode: it lives in event_zip, and the calendar
// joins the two. Including it here would print it twice.
const PARTS = ['Venue', 'Addr. line 1', 'Addr. line 2', 'Addr. line 3', 'Town', 'County'];

function fullAddress(row) {
  const seen = new Set();
  const bits = [];
  for (const k of PARTS) {
    const v = String((row && row[k]) || '').trim();
    if (!v) continue;
    // PPM repeats itself — Venue "Home" with Town "Home", or Town and County
    // both "Oklahoma". A line that says "Home, Home" helps nobody.
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bits.push(v);
  }
  return bits.join(', ');
}

// ── Keeping the postcode out of the address line ─────────────────────────────
// fullAddress above excludes the postcode by construction, because PPM handed
// it over in its own column. Nothing enforced that for the OTHER writers: an
// address typed into the admin or pasted into the booking form arrives as
// "3001 Rossmore Place Oklahoma City, OK 73120", so the ZIP ends up stored
// twice, printed twice on the calendar, and — worst — free to disagree with
// event_zip, which is the field mileage and travel cost are calculated from.
//
// splitZip pulls a trailing US ZIP off an address line and hands both back.
// Trailing only, and 5 or 5+4 only: a house number is also five digits, and
// "12345 Main St" must not lose its number to a greedy match.
function splitZip(address) {
  const raw = String(address || '').trim();
  const m = raw.match(/[,\s]+(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return { address: raw, zip: '' };
  return { address: raw.slice(0, m.index).replace(/[,\s]+$/, ''), zip: m[1] };
}

// Normalises the pair for any writer. The ZIP already on the record wins when
// the two disagree — it is the one mileage was calculated from, and silently
// preferring a pasted string over a computed price is this codebase's signature
// bug. The disagreement is reported so a human can settle it.
function normaliseAddress(location, zip) {
  const split = splitZip(location);
  const existing = String(zip || '').trim();
  if (!split.zip)                return { location: split.address, zip: existing, conflict: null };
  if (!existing)                 return { location: split.address, zip: split.zip, conflict: null };
  if (existing.slice(0, 5) === split.zip) return { location: split.address, zip: existing, conflict: null };
  return { location: split.address, zip: existing, conflict: `address ends ${split.zip} but event_zip is ${existing}` };
}

module.exports = { fullAddress, PARTS, splitZip, normaliseAddress };
