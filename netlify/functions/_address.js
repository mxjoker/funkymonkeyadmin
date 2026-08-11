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

module.exports = { fullAddress, PARTS };
