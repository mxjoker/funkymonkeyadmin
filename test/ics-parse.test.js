const { test } = require('node:test');
const assert = require('node:assert');
const { parseIcs, unescapeText } = require('../netlify/functions/_ics.js');
const { esc } = require('../netlify/functions/calendar.js');

const TZ = 'America/Chicago';
const WIN = { windowStart: new Date('2026-01-01T00:00:00Z'), windowEnd: new Date('2027-12-31T00:00:00Z'), tz: TZ };

const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

test('a TZID event resolves to the right instant', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:a@test', 'SUMMARY:Dentist',
    'DTSTART;TZID=America/Chicago:20260912T140000',
    'DTEND;TZID=America/Chicago:20260912T150000',
  )), WIN);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].summary, 'Dentist');
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
  assert.strictEqual(events[0].endsAt.toISOString(), '2026-09-12T20:00:00.000Z');
  assert.strictEqual(events[0].allDay, false);
});

test('a UTC event is taken as-is', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:b@test', 'SUMMARY:Call', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
});

test('a floating time is read as Central', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:c@test', 'SUMMARY:Floaty', 'DTSTART:20260912T140000', 'DTEND:20260912T150000',
  )), WIN);
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
});

test('an all-day event covers local midnight to local midnight', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:d@test', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102',
  )), WIN);
  assert.strictEqual(events[0].allDay, true);
  // 1 Nov 2026 is the 25-hour fall-back day.
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(events[0].endsAt.toISOString(),   '2026-11-02T06:00:00.000Z');
});

test('an all-day event with no DTEND lasts one day (RFC 5545 3.6.1), not zero', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:d2@test', 'SUMMARY:Family trip to Dallas', 'DTSTART;VALUE=DATE:20261101',
  )), WIN);
  assert.strictEqual(events[0].allDay, true);
  // Same 25-hour fall-back day as the explicit-DTEND all-day test above —
  // local midnight 1 Nov to local midnight 2 Nov.
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(events[0].endsAt.toISOString(),   '2026-11-02T06:00:00.000Z');
});

test('DURATION is honoured when DTEND is absent', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:e@test', 'SUMMARY:Short', 'DTSTART:20260912T190000Z', 'DURATION:PT90M',
  )), WIN);
  assert.strictEqual(events[0].endsAt.toISOString(), '2026-09-12T20:30:00.000Z');
});

test('a timed event with neither DTEND nor DURATION is treated as zero-length', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:f@test', 'SUMMARY:Point', 'DTSTART:20260912T190000Z',
  )), WIN);
  assert.strictEqual(events[0].endsAt.getTime(), events[0].startsAt.getTime());
});

test('folded continuation lines are rejoined', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:g@test',
    'SUMMARY:A very long summary that the calendar server has wrapped acro',
    ' ss two lines',
    'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].summary, 'A very long summary that the calendar server has wrapped across two lines');
});

test('escaped characters in SUMMARY are unescaped', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:h@test', 'SUMMARY:Lunch\\, then gym\\; maybe', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].summary, 'Lunch, then gym; maybe');
});

test('a CANCELLED event is not busy', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:i@test', 'SUMMARY:Off', 'STATUS:CANCELLED', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('a TRANSPARENT event is not busy — that is what Google Free means', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:j@test', 'SUMMARY:FYI', 'TRANSP:TRANSPARENT', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('events outside the window are dropped', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:k@test', 'SUMMARY:Ancient', 'DTSTART:20200912T190000Z', 'DTEND:20200912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('an event with no DTSTART is skipped and warned about, never silently dropped', () => {
  const { events, warnings } = parseIcs(cal(...ev('UID:l@test', 'SUMMARY:Broken')), WIN);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Broken/);
});

test('results are sorted by start', () => {
  const { events } = parseIcs(cal(
    ...ev('UID:m@test', 'SUMMARY:Later',  'DTSTART:20260912T200000Z', 'DTEND:20260912T210000Z'),
    ...ev('UID:n@test', 'SUMMARY:Sooner', 'DTSTART:20260912T180000Z', 'DTEND:20260912T190000Z'),
  ), WIN);
  assert.deepStrictEqual(events.map(e => e.summary), ['Sooner', 'Later']);
});

test('a truncated feed (last VEVENT never closed) recovers the event and warns, never silently drops it', () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:o@test', 'SUMMARY:Wedding in Tulsa',
    'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
    // no END:VEVENT, no END:VCALENDAR — the download stopped mid-stream.
  ].join('\r\n');
  const { events, warnings } = parseIcs(text, WIN);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].summary, 'Wedding in Tulsa');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Wedding in Tulsa/);
});

test('a BEGIN:VEVENT arriving while one is still open displaces it exactly once — recovered and warned, not lost, not double-counted', () => {
  const text = cal(
    'BEGIN:VEVENT', 'UID:p@test', 'SUMMARY:First',
    'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
    // no END:VEVENT before the next BEGIN:VEVENT displaces it
    'BEGIN:VEVENT', 'UID:q@test', 'SUMMARY:Second',
    'DTSTART:20260912T210000Z', 'DTEND:20260912T220000Z',
    'END:VEVENT',
  );
  const { events, warnings } = parseIcs(text, WIN);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map(e => e.summary), ['First', 'Second']);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /First/);
});

test('an unterminated event with no usable DTSTART is skipped, but still warned about', () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:r@test', 'SUMMARY:No Start',
    // no DTSTART at all, and the feed is truncated on top of that
  ].join('\r\n');
  const { events, warnings } = parseIcs(text, WIN);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(warnings.length, 2); // "never closed" + finishEvent's own "no start time"
  assert.match(warnings.join(' '), /No Start/);
});

test('a weekly rule expands across the window', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r1@test', 'SUMMARY:School run',
    'DTSTART;TZID=America/Chicago:20260907T150000',
    'DTEND;TZID=America/Chicago:20260907T160000',
    'RRULE:FREQ=WEEKLY;COUNT=4',
  )), WIN);
  assert.strictEqual(events.length, 4);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
  );
});

test('UNTIL terminates the series', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r2@test', 'SUMMARY:Standup',
    'DTSTART:20260907T140000Z', 'DTEND:20260907T143000Z',
    'RRULE:FREQ=DAILY;UNTIL=20260910T000000Z',
  )), WIN);
  assert.strictEqual(events.length, 3); // 7th, 8th, 9th
});

test('INTERVAL is honoured', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r3@test', 'SUMMARY:Fortnightly',
    'DTSTART:20260907T140000Z', 'DTEND:20260907T150000Z',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-21', '2026-10-05']
  );
});

test('BYDAY generates several days per week', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r4@test', 'SUMMARY:MWF',
    'DTSTART;TZID=America/Chicago:20260907T090000',
    'DTEND;TZID=America/Chicago:20260907T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-09', '2026-09-11']
  );
  // BYDAY is genuinely supported on WEEKLY — pin that the fix for the
  // MONTHLY/DAILY case below does not regress the one FREQ where it works.
  assert.strictEqual(warnings.length, 0);
});

test('BYDAY on MONTHLY is supported and honours a bare entry as every matching weekday in the month', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r11@test', 'SUMMARY:Every Monday (monthly)',
    'DTSTART:20260105T140000Z', 'DTEND:20260105T150000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=MO;COUNT=3',
  )), WIN);
  // 5 Jan 2026 is a Monday; COUNT=3 exhausts within January itself.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-05', '2026-01-12', '2026-01-19']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=WEEKLY;BYDAY=TU;WKST=SU expands weekly with no warning ("Magic Class")', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g1@test', 'SUMMARY:Magic Class',
    'DTSTART:20260901T140000Z', 'DTEND:20260901T150000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;WKST=SU;COUNT=3',
  )), WIN);
  // 1 Sep 2026 is a Tuesday.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-01', '2026-09-08', '2026-09-15']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU (every weekday) expands with no warning', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g2@test', 'SUMMARY:Every weekday',
    'DTSTART:20260831T140000Z', 'DTEND:20260831T150000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU;COUNT=5',
  )), WIN);
  // 31 Aug 2026 is a Monday.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYDAY=1FR expands to the first Friday of successive months ("Paseo 1st Friday")', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g3@test', 'SUMMARY:Paseo 1st Friday',
    'DTSTART:20260102T190000Z', 'DTEND:20260102T220000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=1FR;COUNT=3',
  )), WIN);
  // 2 Jan 2026 is the first Friday of January; 6 Feb and 6 Mar follow.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-02', '2026-02-06', '2026-03-06']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYDAY=1TH expands to the first Thursday of successive months ("First Thursdays Classen Curve")', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g4@test', 'SUMMARY:First Thursdays Classen Curve',
    'DTSTART:20260101T190000Z', 'DTEND:20260101T220000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=1TH;COUNT=3',
  )), WIN);
  // 1 Jan 2026 is the first Thursday of January; 5 Feb and 5 Mar follow.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-01', '2026-02-05', '2026-03-05']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYDAY=-1FR expands to the last Friday, including a 5-Friday month', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g5@test', 'SUMMARY:Last Friday social',
    'DTSTART:20260424T190000Z', 'DTEND:20260424T220000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=2',
  )), WIN);
  // April 2026 has 4 Fridays (3,10,17,24) so the last is the 24th. May 2026
  // has 5 Fridays (1,8,15,22,29) — the last Friday is the 5th one, 29 May,
  // not "the 4th Friday" a naive fixed-count implementation might produce.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-04-24', '2026-05-29']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYMONTHDAY=15 expands monthly on the 15th', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g6@test', 'SUMMARY:Rent due',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-15', '2026-02-15', '2026-03-15']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYMONTHDAY=-1 expands to the last day across a 31-day, a 28-day (Feb), and back to a 31-day month', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g7@test', 'SUMMARY:Month-end close',
    'DTSTART:20260131T140000Z', 'DTEND:20260131T150000Z',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3',
  )), WIN);
  // Jan 2026 has 31 days, Feb 2026 (not a leap year) has 28, Mar has 31.
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-31', '2026-02-28', '2026-03-31']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=17 expands an annual birthday', () => {
  // WIN's windowEnd (2027-12-31) is too short for a 3-year expectation — give
  // this one its own wider window rather than widening WIN, which other
  // tests' expectations depend on staying put.
  const win3y = { windowStart: WIN.windowStart, windowEnd: new Date('2029-12-31T00:00:00Z'), tz: WIN.tz };
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g8@test', 'SUMMARY:Birthday',
    'DTSTART:20260317T140000Z', 'DTEND:20260317T150000Z',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=17;COUNT=3',
  )), win3y);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-03-17', '2027-03-17', '2028-03-17']
  );
  assert.strictEqual(warnings.length, 0);
});

test('FREQ=MONTHLY;BYMONTHDAY=29,30,31 skips months where none of those days exist, without corrupting the month after', () => {
  // This is the case that would have caught the cursor-overflow bug on its
  // own, independent of the BYMONTHDAY=-1 test: a cursor sitting on day 31
  // rolls "Feb 31" forward into March when stepped with setUTCMonth, which
  // both skips February AND leaves March expanding from the wrong anchor.
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:g9@test', 'SUMMARY:Near month-end',
    'DTSTART:20260129T140000Z', 'DTEND:20260129T150000Z',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=29,30,31;COUNT=6',
  )), WIN);
  // Jan 2026: 29, 30, 31 all exist. Feb 2026 (28 days, not leap): none of
  // 29/30/31 exist — the month is skipped entirely, not silently dropped.
  // Mar 2026: 29, 30, 31 all exist again, and March must still be itself
  // (not rolled forward from a corrupted February).
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-29', '2026-01-30', '2026-01-31', '2026-03-29', '2026-03-30', '2026-03-31']
  );
  assert.strictEqual(warnings.length, 0);
});

test('BYDAY on DAILY is unsupported for the same reason', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r12@test', 'SUMMARY:MWF (daily, wrongly)',
    'DTSTART:20260105T140000Z', 'DTEND:20260105T150000Z',
    'RRULE:FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=3',
  )), WIN);
  assert.strictEqual(events.length, 1, 'only the first instance is kept');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /MWF \(daily, wrongly\)/);
  assert.match(warnings[0], /BYDAY/);
});

test('EXDATE removes an occurrence', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r5@test', 'SUMMARY:Weekly',
    'DTSTART;TZID=America/Chicago:20260907T150000',
    'DTEND;TZID=America/Chicago:20260907T160000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE;TZID=America/Chicago:20260914T150000',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-21']
  );
});

test('a MONTHLY rule steps by calendar month', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r6@test', 'SUMMARY:Monthly',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-15', '2026-02-15', '2026-03-15']
  );
});

test('an unsupported rule keeps the first instance AND warns — never silence', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r7@test', 'SUMMARY:Third Thursday',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;BYSETPOS=3;BYDAY=TH',
  )), WIN);
  assert.strictEqual(events.length, 1, 'the first instance is still busy');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Third Thursday/);
  assert.match(warnings[0], /BYSETPOS/);
});

test('expansion stops at the window end rather than running forever', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r8@test', 'SUMMARY:Endless',
    'DTSTART:20260101T140000Z', 'DTEND:20260101T150000Z',
    'RRULE:FREQ=DAILY',
  )), { windowStart: new Date('2026-01-01T00:00:00Z'), windowEnd: new Date('2026-01-11T00:00:00Z'), tz: TZ });
  assert.strictEqual(events.length, 10);
});

test('an old daily rule with no COUNT/UNTIL exhausts the occurrence cap before reaching the window, and warns rather than silently expanding to zero', () => {
  // MAX_OCCURRENCES (1000) counts from DTSTART, not from the window. A DAILY
  // rule started here in 2020 uses its whole 1000-occurrence budget by
  // ~2022-09 — years before this WIN's 2026-01-01 start — so it would
  // otherwise produce zero occurrences with no warning at all, the same
  // silent-standing-commitment failure as the WKST/BYDAY cases above.
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r13@test', 'SUMMARY:Standing daily reminder',
    'DTSTART:20200101T140000Z', 'DTEND:20200101T143000Z',
    'RRULE:FREQ=DAILY',
  )), WIN);
  assert.strictEqual(events.length, 0, 'the cap is exhausted long before DTSTART+1000 days reaches the window');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Standing daily reminder/);
  assert.match(warnings[0], /too many occurrences/i);
});

test('a weekly rule holds its local wall-clock time across the fall-back DST transition', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r9@test', 'SUMMARY:Weekly 3pm',
    'DTSTART;TZID=America/Chicago:20261023T150000',
    'DTEND;TZID=America/Chicago:20261023T160000',
    'RRULE:FREQ=WEEKLY;COUNT=4',
  )), WIN);
  assert.strictEqual(events.length, 4);
  const localClock = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(d);
  // The UTC instant legitimately shifts by an hour across the Nov 1 fall-back
  // (CDT -5 to CST -6) — asserting on it would obscure the property being
  // pinned, which is that the LOCAL clock reading never moves off 15:00.
  assert.deepStrictEqual(events.map(e => localClock(e.startsAt)), ['15:00', '15:00', '15:00', '15:00']);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13']
  );
});

test('WKST is not honoured, so a rule carrying it takes the unsupported path rather than expanding silently wrong', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r10@test', 'SUMMARY:Weekend split',
    'DTSTART:20260906T140000Z', 'DTEND:20260906T150000Z',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA;WKST=MO',
  )), WIN);
  assert.strictEqual(events.length, 1, 'only the first instance is kept');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Weekend split/);
  assert.match(warnings[0], /WKST/);
});

test('unescapeText round-trips through calendar.js esc(), including a literal backslash-n and a trailing backslash', () => {
  const cases = [
    'Lunch, then gym; maybe',
    'a literal backslash then n: \\n (not a newline)',
    'trailing backslash: \\',
    'multi\nline\nsummary',
    'semicolons; and, commas, and\\backslashes\\',
  ];
  for (const original of cases) {
    assert.strictEqual(unescapeText(esc(original)), original, `round-trip failed for: ${JSON.stringify(original)}`);
  }
});
