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
  const { events } = parseIcs(cal(...ev(
    'UID:r4@test', 'SUMMARY:MWF',
    'DTSTART;TZID=America/Chicago:20260907T090000',
    'DTEND;TZID=America/Chicago:20260907T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-09', '2026-09-11']
  );
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
