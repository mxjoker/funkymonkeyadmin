// Wall-clock time plus an IANA zone -> an absolute instant, with no dependency.
//
// This is the mirror of the note in calendar.js about building dates in UTC and
// formatting them as wall-clock strings. Outbound must AVOID shifting, because
// the ICS carries TZID and the digits are local. Inbound must DELIBERATELY
// shift, exactly once, here at the boundary — after which everything downstream
// is an absolute instant and timezone stops being a consideration.

// What the wall clock reads in `tz` at instant `d`, as a UTC-epoch number.
// Intl gives us the parts; Date.UTC turns them back into a comparable number.
function wallClockAsUTC(d, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // Intl renders midnight as hour 24 in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
}

// Two passes settle DST. The first guess is off by the offset; correcting by
// the offset measured AT that guess lands on the right side of a transition in
// every case except the non-existent spring-forward hour, which resolves
// forward — the same thing calendar clients do.
function zonedToInstant(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    guess = want - (wallClockAsUTC(new Date(guess), tz) - guess);
  }
  return new Date(guess);
}

// Local midnight to the NEXT local midnight. Computed by adding a calendar day
// rather than 24 hours, so the 25-hour fall-back day and the 23-hour
// spring-forward day are both exactly one day.
function dayBoundsInZone(isoDate, tz) {
  const [y, mo, d] = String(isoDate).split('-').map(Number);
  const start = zonedToInstant(y, mo, d, 0, 0, tz);
  const nxt = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = zonedToInstant(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), 0, 0, tz);
  return { start, end };
}

module.exports = { zonedToInstant, dayBoundsInZone };
