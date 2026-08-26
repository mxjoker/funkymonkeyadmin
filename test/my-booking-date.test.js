// The client-facing finalisation page renders event_date one day early for
// every viewer west of UTC.
//
// pg hands back a DATE column as a JS Date, which JSON.stringify writes as
// "2026-08-23T00:00:00.000Z". my-booking.html's formatDate saw the "T", passed
// the whole string to new Date() — parsed as UTC midnight — and then formatted
// it in the VIEWER's zone, landing on 7pm the previous evening in Central.
// Admin, the staff portal, confirmation.html and every email slice to
// YYYY-MM-DD first, so only the page the client reads before paying disagreed.
//
// Booking FM-K9Z96NRU: client saw Saturday August 22, admin said Aug 23.

// Must be set before anything touches Date. A UTC test runner cannot tell the
// broken formatter from the fixed one — both agree at offset zero — so this
// file is meaningless without it, and the guard below proves it took.
process.env.TZ = 'America/Chicago';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the test itself is running west of UTC, or it proves nothing', () => {
  assert.strictEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Chicago');
  assert.strictEqual(new Date('2026-08-23T00:00:00.000Z').getDate(), 22,
    'a UTC-midnight timestamp must land on the 22nd here, or this suite is vacuous');
});

// Lift formatDate out of the page and run it in a bare context, so a reach for
// `document` throws rather than quietly passing. Same trick as bookings-sort.
function loadFormatDate(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const a = src.indexOf('    function formatDate(dateStr) {');
  assert.ok(a !== -1, `formatDate not found in ${file}`);
  const b = src.indexOf('\n    }', a) + '\n    }'.length;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + '\nout = formatDate;', ctx);
  return ctx.out;
}

const formatDate = loadFormatDate('my-booking.html');

test('a DATE column serialised as UTC midnight renders its own calendar day', () => {
  assert.match(formatDate('2026-08-23T00:00:00.000Z'), /August 23, 2026/);
});

test('the ISO and date-only forms of one date render identically', () => {
  // The two shapes the API can return for the same day. Anything that treats
  // them differently is reading a timestamp where a date was meant.
  assert.strictEqual(formatDate('2026-08-23T00:00:00.000Z'), formatDate('2026-08-23'));
});

test('the finalisation page agrees with the confirmation page it mirrors', () => {
  // confirmation.html already carries this fix; my-booking.html is its twin
  // and was the copy that never got it.
  const twin = loadFormatDate('confirmation.html');
  for (const v of ['2026-08-23T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z']) {
    assert.strictEqual(formatDate(v), twin(v), `disagreed on ${v}`);
  }
});

test('a missing or unparseable date is still handled', () => {
  assert.strictEqual(formatDate(''), 'TBD');
  assert.strictEqual(formatDate(null), 'TBD');
  assert.strictEqual(formatDate('not a date'), 'not a date');
});
