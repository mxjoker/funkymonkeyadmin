const { test } = require('node:test');
const assert = require('node:assert');
const { esc, fold, parseTime, buildEvent, CALENDAR_STATUSES } = require('../netlify/functions/calendar');

// ── Why this is tested ──────────────────────────────────────────────────────
// RFC 5545 is unforgiving and calendar clients reject a malformed feed in
// SILENCE — no error, the calendar simply stays empty. That is this codebase's
// signature failure mode, so the escaping, folding and time handling get real
// tests rather than a hopeful glance.

test('special characters are escaped, not passed through', () => {
  // A client called "Smith, John; Jr" would otherwise terminate the field
  // early and shift every property after it.
  assert.strictEqual(esc('Smith, John; Jr'), 'Smith\\, John\\; Jr');
  assert.strictEqual(esc('back\\slash'), 'back\\\\slash');
  assert.strictEqual(esc('line one\nline two'), 'line one\\nline two');
  assert.strictEqual(esc(null), '');
});

test('long lines fold at 75 characters with a leading space', () => {
  const line = 'DESCRIPTION:' + 'x'.repeat(200);
  const folded = fold(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1, 'must actually fold');
  assert.strictEqual(parts[0].length, 75);
  for (const p of parts.slice(1)) assert.ok(p.startsWith(' '), 'continuation lines start with a space');
  // Unfolding must reproduce the original exactly.
  assert.strictEqual(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('a short line is left alone', () => {
  assert.strictEqual(fold('SUMMARY:Foam Party'), 'SUMMARY:Foam Party');
});

test('times parse from the formats the CRM actually stores', () => {
  assert.deepStrictEqual(parseTime('18:00'), { h: 18, m: 0 });
  assert.deepStrictEqual(parseTime('6:00 PM'), { h: 18, m: 0 });
  assert.deepStrictEqual(parseTime('12:30 AM'), { h: 0, m: 30 });
  assert.deepStrictEqual(parseTime('09:15:00'), { h: 9, m: 15 });
});

test('an unparseable or missing time returns null rather than guessing', () => {
  // The event then becomes all-day, which is honest. Inventing 9am would put
  // a gig on the calendar at a time nobody agreed to.
  for (const v of ['', null, undefined, 'TBD', '25:00', '12:99']) {
    assert.strictEqual(parseTime(v), null, `${v} must not parse`);
  }
});

const NOW = new Date('2026-08-11T12:00:00Z');
const base = {
  id: 42, status: 'confirmed', service_name: 'Foam Party', client_name: 'Jane Doe',
  event_date: '2026-09-05', event_time: '14:00', duration_minutes: 90,
  event_location: '123 Main St', event_zip: '73118', total_price: 500, balance_due: 400,
};

test('a timed event carries local wall-clock times with a TZID', () => {
  const ics = buildEvent(base, [], NOW).join('\r\n');
  // 14:00 local must stay 14:00 in the output. Netlify runs UTC and a laptop
  // does not; if the server's zone leaked in, this shifts by hours.
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20260905T140000/);
  assert.match(ics, /DTEND;TZID=America\/Chicago:20260905T153000/, '90 minutes later');
});

test('duration falls back to 90 minutes when the service has none', () => {
  const ics = buildEvent({ ...base, duration_minutes: null }, [], NOW).join('\r\n');
  assert.match(ics, /DTEND;TZID=America\/Chicago:20260905T153000/);
});

test('a booking with no time becomes an all-day event, not a 9am guess', () => {
  const ics = buildEvent({ ...base, event_time: '' }, [], NOW).join('\r\n');
  assert.match(ics, /DTSTART;VALUE=DATE:20260905/);
  assert.match(ics, /DTEND;VALUE=DATE:20260906/, 'all-day DTEND is the next day');
  // Only DTSTART/DTEND must be time-free. DTSTAMP is when the feed was built
  // and legitimately carries a clock time.
  assert.doesNotMatch(ics, /DTSTART[^\r\n]*T\d{6}/, 'no invented start time');
  assert.doesNotMatch(ics, /DTEND[^\r\n]*T\d{6}/, 'no invented end time');
});

test('staff appear in the description with their role', () => {
  const ics = buildEvent(base, [
    { name: 'Troy', role: 'Foam Party', status: 'assigned' },
    { name: 'Amie', role: 'Driver', status: 'interested' },
  ], NOW).join('\r\n');
  assert.match(ics, /Troy — Foam Party/);
  assert.match(ics, /Amie — Driver \(interested\)/, 'a non-assigned status is called out');
});

test('an unstaffed booking says so rather than showing an empty list', () => {
  const ics = buildEvent(base, [], NOW).join('\r\n');
  assert.match(ics, /nobody assigned yet/);
});

test('the UID is stable across rebuilds so events update instead of duplicating', () => {
  const a = buildEvent(base, [], NOW).join('\r\n');
  const b = buildEvent({ ...base, client_name: 'Renamed' }, [], new Date('2027-01-01T00:00:00Z')).join('\r\n');
  const uid = (s) => s.match(/UID:(.+)/)[1];
  assert.strictEqual(uid(a), uid(b), 'same booking, same UID');
  assert.strictEqual(uid(a), 'booking-42@funkymonkeyadmin');
});

test('every event is a balanced VEVENT block', () => {
  const ics = buildEvent(base, [], NOW);
  assert.strictEqual(ics[0], 'BEGIN:VEVENT');
  assert.strictEqual(ics[ics.length - 1], 'END:VEVENT');
});

test('cancelled and review bookings never reach the calendar', () => {
  // A cancelled gig must disappear from the phone; an enquiry that may never
  // happen must not clutter the month.
  assert.ok(!CALENDAR_STATUSES.includes('cancelled'));
  assert.ok(!CALENDAR_STATUSES.includes('review'));
  assert.ok(!CALENDAR_STATUSES.includes('draft'));
  assert.ok(CALENDAR_STATUSES.includes('confirmed'));
  assert.ok(CALENDAR_STATUSES.includes('accepted'));
});

test('the total shown includes travel, so it is never smaller than the balance', () => {
  // total_price EXCLUDES travel. Showing it raw next to balance_due produced
  // "Total $1250.00 · Balance $1401.20" on a real booking — a balance larger
  // than the total, which reads as a bug to anyone glancing at their phone.
  const ics = buildEvent(
    { ...base, total_price: 1250, mileage_cost: 151.20, balance_due: 1401.20 },
    [], NOW
  ).join('\r\n');
  assert.match(ics, /Total \$1401\.20 \(incl\. travel\)/);
  assert.doesNotMatch(ics, /Total \$1250\.00/, 'the travel-excluding figure must not be shown');
});

test('a booking with no travel shows a plain total', () => {
  const ics = buildEvent({ ...base, total_price: 500, mileage_cost: 0, balance_due: 400 }, [], NOW).join('\r\n');
  assert.match(ics, /Total \$500\.00/);
  assert.doesNotMatch(ics, /incl\. travel/);
  // The balance used to share this line as "· Balance $400.00 due". It now has
  // its own line as an instruction (see the collect tests below) — the figure
  // did not go anywhere, it just stopped being a footnote to the total.
  assert.match(ics, /COLLECT \$400\.00 from the client/);
  assert.doesNotMatch(ics, /Balance \$400\.00 due/);
});

// ── Address completeness ────────────────────────────────────────────────────
// The calendar entry is the only thing you have standing in a car park. If
// LOCATION says "KinderCare" it is decoration; if it says the street, town and
// zip it is directions. The 2026-05-07 import kept Venue and threw the street
// address away, leaving 17 of 19 upcoming bookings unnavigable.
const { fullAddress } = require('../netlify/functions/_address');

test('a full address is built from PPM parts, venue first', () => {
  assert.strictEqual(
    fullAddress({ 'Venue': 'KinderCare', 'Addr. line 1': '1812 North Eastern Ave', 'Town': 'Moore', 'County': 'Oklahoma' }),
    'KinderCare, 1812 North Eastern Ave, Moore, Oklahoma'
  );
});

test('the postcode is left out — it lives in event_zip and would print twice', () => {
  const a = fullAddress({ 'Addr. line 1': '1 High St', 'Town': 'Moore', 'Postcode': '73160' });
  assert.doesNotMatch(a, /73160/);
});

test('repeated parts are collapsed', () => {
  // PPM stores Venue "Home" with Town "Home", and Town/County both "Oklahoma".
  assert.strictEqual(fullAddress({ 'Venue': 'Home', 'Town': 'Home' }), 'Home');
  assert.strictEqual(fullAddress({ 'Town': 'Oklahoma', 'County': 'Oklahoma' }), 'Oklahoma');
});

test('an empty row yields an empty string, not a pile of commas', () => {
  assert.strictEqual(fullAddress({}), '');
  assert.strictEqual(fullAddress(null), '');
});

test('the calendar LOCATION carries street and zip together', () => {
  const ics = buildEvent(
    { ...base, event_location: 'KinderCare, 1812 North Eastern Ave, Moore, Oklahoma', event_zip: '73160' },
    [], NOW
  ).join('\r\n');
  // Folding may split the line, so unfold before asserting.
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /LOCATION:KinderCare\\, 1812 North Eastern Ave\\, Moore\\, Oklahoma\\, 73160/);
});

// ── Calendar titles use the internal short name ──────────────────────────────
// The customer-facing name says nothing about how long a gig runs. The
// calendar is read on a phone at 8am, so it gets the ops name instead.

test('the summary prefers the service short name over the customer name', () => {
  const ics = buildEvent({ ...base, short_name: 'Foam 45min Single Cannon' }, [], NOW).join('\r\n');
  assert.match(ics, /SUMMARY:Foam 45min Single Cannon — Jane Doe/);
});

test('a booking with no short name keeps the customer-facing name', () => {
  // Custom quotes carry no service_id, so nothing to look a short name up by.
  for (const v of ['', null, undefined]) {
    const ics = buildEvent({ ...base, short_name: v }, [], NOW).join('\r\n');
    assert.match(ics, /SUMMARY:Foam Party — Jane Doe/, `short_name ${JSON.stringify(v)}`);
  }
});

test('extra services on a booking are counted, not silently dropped', () => {
  // service_name is a ' + ' join of every service (_items.js rollupItems) but
  // short_name names only the first. Losing the rest would understate the gig.
  const ics = buildEvent({
    ...base,
    service_name: 'Foam Party — Single Cannon + Face Painting + Live Spun Cotton Candy',
    short_name: 'Foam 45min Single Cannon',
  }, [], NOW).join('\r\n');
  assert.match(ics, /SUMMARY:Foam 45min Single Cannon \+2 — Jane Doe/);
});

test('a single-service booking gets no +0 suffix', () => {
  const ics = buildEvent({
    ...base, service_name: 'Foam Party — Single Cannon', short_name: 'Foam 45min Single Cannon',
  }, [], NOW).join('\r\n');
  assert.match(ics, /SUMMARY:Foam 45min Single Cannon — Jane Doe/);
  assert.ok(!/\+0/.test(ics), 'must not emit a +0 count');
});

test('a booking with neither name still produces a valid summary', () => {
  const ics = buildEvent({ ...base, service_name: null, short_name: null }, [], NOW).join('\r\n');
  assert.match(ics, /SUMMARY:Event — Jane Doe/);
});

// ── Call time ───────────────────────────────────────────────────────────────
// What time anyone has to be at the house is the thing this feed could not
// answer, and the reason it is read off the assignment rather than recomputed
// is that the crew have already been texted a figure. These tests pin the two
// together: buildEvent must print schedule_start, not its own arithmetic.

const CREW = [{
  name: 'Aliza', role: 'Magician', status: 'assigned',
  schedule_start: '13:45:00', total_minutes: 275, drive_minutes_each_way: 45,
}];

test('the call time is the assignment\'s schedule_start, in plain 12-hour time', () => {
  const ics = buildEvent({ ...base, zip_known: true }, CREW, NOW).join('\r\n');
  assert.match(ics, /Call time: 1:45 PM at the house/);
  // 13:45 + 275 minutes. Both figures come off the same assignment row, so a
  // per-role override can never produce a home time from someone else\'s shift.
  assert.match(ics, /Home by ~6:20 PM/);
  assert.match(ics, /45 min drive each way/);
});

test('the earliest crew member sets the call time, and their shift sets the way home', () => {
  const crew = [
    { name: 'Late', status: 'assigned', schedule_start: '15:00:00', total_minutes: 60 },
    { name: 'Early', status: 'assigned', schedule_start: '13:00:00', total_minutes: 300 },
  ];
  const ics = buildEvent({ ...base, zip_known: true }, crew, NOW).join('\r\n');
  assert.match(ics, /Call time: 1:00 PM/, 'the first to turn up');
  assert.match(ics, /Home by ~6:00 PM/, '13:00 + 300, not 15:00 + 300 or 13:00 + 60');
});

test('a crew member with no computed times does not fake a call time', () => {
  // schedule_start is only computed once somebody is assigned, so an
  // "interested" row legitimately has none. Treating null as midnight would
  // put "Call time: 12:00 AM" on the gig.
  const ics = buildEvent({ ...base, zip_known: true },
    [{ name: 'Maybe', status: 'interested', schedule_start: null }], NOW).join('\r\n');
  assert.match(ics, /Call time: not set — nobody staffed yet/);
  assert.doesNotMatch(ics, /12:00 AM/);
});

test('an unknown ZIP says the times are a guess, where the times are read', () => {
  // getDriveMins falls back to 30 minutes for a ZIP it does not know, which
  // makes the call time fiction rather than merely imprecise.
  const ics = buildEvent({ ...base, zip_known: false, event_zip: '99999' }, CREW, NOW).join('\r\n');
  assert.match(ics, /Times are a guess/);
  assert.match(ics, /99999/);
  // ...and a known ZIP does not nag.
  const ok = buildEvent({ ...base, zip_known: true }, CREW, NOW).join('\r\n');
  assert.doesNotMatch(ok, /Times are a guess/);
});

// ── What the crew collect ───────────────────────────────────────────────────

test('the amount to collect is the balance itself, with no service fee on it', () => {
  const { balanceCharge } = require('../netlify/functions/_items.js');
  const ics = buildEvent({ ...base, balance_due: 745 }, CREW, NOW).join('\r\n');
  assert.match(ics, /COLLECT \$745\.00 from the client/);
  // The 5% lives only on a Stripe session. Printing the fee-bearing figure
  // would have someone take $782.25 in cash at a birthday party.
  assert.strictEqual(balanceCharge({ balance_due: 745 }).total, 782.25);
  assert.doesNotMatch(ics, /782\.25/);
});

test('nothing owed, nothing priced and platform-paid are three different sentences', () => {
  const line = (over) => buildEvent({ ...base, ...over }, CREW, NOW).join('\r\n');
  assert.match(line({ balance_due: 0 }), /Paid in full — collect nothing/);
  assert.match(line({ balance_due: null }), /Not priced yet — collect nothing/);
  // A GigSalad client already paid the platform; asking again bills them twice.
  assert.match(line({ balance_due: 800, source: 'gigsalad' }), /Paid through GigSalad — collect nothing/);
  assert.doesNotMatch(line({ balance_due: 800, source: 'gigsalad' }), /COLLECT/);
});

test('a completed gig is not nagged about staffing it', () => {
  // The feed carries 90 days of history. "nobody staffed yet" on a gig that
  // already happened is a nag about a decision nobody can make any more.
  const done = buildEvent({ ...base, status: 'completed' }, [], NOW).join('\r\n');
  assert.doesNotMatch(done, /Call time/);
  const upcoming = buildEvent({ ...base, status: 'confirmed' }, [], NOW).join('\r\n');
  assert.match(upcoming, /Call time: not set — nobody staffed yet/);
});

test('a missing ZIP and an unknown ZIP are different complaints', () => {
  const none = buildEvent({ ...base, zip_known: false, event_zip: '' }, CREW, NOW).join('\r\n');
  assert.match(none, /this booking has no ZIP/, 'the fix for this is to fill a field in');
  assert.doesNotMatch(none, /\(none\)/);
  const odd = buildEvent({ ...base, zip_known: false, event_zip: '99999' }, CREW, NOW).join('\r\n');
  assert.match(odd, /no drive time for ZIP 99999/, 'the fix for this is to set a drive time');
});

test('the reference, venue and surface ride along', () => {
  const ics = buildEvent({ ...base, reference: 'FM-ABC12345', venue: 'The MAC', surface_type: 'grass' },
    CREW, NOW).join('\r\n');
  assert.match(ics, /FM-ABC12345/, 'the reference was already fetched and thrown away');
  assert.match(ics, /Venue: The MAC · Surface: grass/);
});

test('the sections are separated by real blank lines', () => {
  // They were not: the filter that dropped empty fields dropped the deliberate
  // separators too, so the notes arrived as one wall of text on a phone.
  const ics = buildEvent({ ...base, zip_known: true }, CREW, NOW).join('\r\n');
  const desc = ics.match(/DESCRIPTION:(.*)/)[1];
  assert.match(desc, /\\n\\nCall time/, 'a blank line before the times');
  assert.match(desc, /\\n\\nStaff:/, 'a blank line before the crew');
});
