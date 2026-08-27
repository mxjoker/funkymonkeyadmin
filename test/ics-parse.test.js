const { test } = require('node:test');
const assert = require('node:assert');
const { parseIcs } = require('../netlify/functions/_ics.js');

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
