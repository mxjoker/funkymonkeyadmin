const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');

// Run the helpers in a bare context so any reach for `document` throws rather
// than silently passing against a stub.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE TIME HELPERS');
  const b = HTML.indexOf('// ══ END PURE TIME HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure time-helper sentinels missing from staff-portal.html');
  const ctx = {};
  vm.createContext(ctx);
  // timeRange calls fmtTime, which lives just above the block.
  const fmtTime = HTML.slice(HTML.indexOf('function fmtTime(t)'), HTML.indexOf('// ══ PURE TIME HELPERS'));
  vm.runInContext(fmtTime + HTML.slice(a, b) +
    '\nout = { addMinutes, timeRange, fmtDuration };', ctx);
  return ctx.out;
}

const { addMinutes, timeRange, fmtDuration } = loadHelpers();

test('a party end time is the start plus the service duration', () => {
  assert.strictEqual(addMinutes('14:00', 90), '15:30');
  assert.strictEqual(addMinutes('10:00', 45), '10:45');
  assert.strictEqual(addMinutes('09:30', 120), '11:30');
});

test('Postgres time values with seconds are accepted', () => {
  // event_time and schedule_start come back as "14:00:00".
  assert.strictEqual(addMinutes('14:00:00', 60), '15:00');
});

test('an evening gig running past midnight wraps instead of reading 26:30', () => {
  assert.strictEqual(addMinutes('23:00', 180), '02:00');
  assert.strictEqual(addMinutes('22:30', 90), '00:00');
});

test('an unusable time or duration yields no end time at all', () => {
  // Showing a staff member a fabricated finish time is worse than showing none.
  for (const t of ['', null, undefined, 'TBD']) {
    assert.strictEqual(addMinutes(t, 60), '', `${JSON.stringify(t)} must not produce a time`);
  }
  for (const d of [null, undefined, 'soon', NaN]) {
    assert.strictEqual(addMinutes('14:00', d), '', `duration ${JSON.stringify(d)} must not produce a time`);
  }
});

test('a range reads start to finish in 12-hour time', () => {
  assert.strictEqual(timeRange('14:00', 90), '2:00 PM – 3:30 PM');
  assert.strictEqual(timeRange('10:00', 45), '10:00 AM – 10:45 AM');
});

test('midnight and noon are not confused', () => {
  assert.strictEqual(timeRange('00:00', 60), '12:00 AM – 1:00 AM');
  assert.strictEqual(timeRange('12:00', 60), '12:00 PM – 1:00 PM');
});

test('an unknown duration shows the start alone, not a wrong range', () => {
  // A booking whose service has no duration_minutes still has a start time.
  assert.strictEqual(timeRange('14:00', null), '2:00 PM');
  assert.strictEqual(timeRange('14:00', undefined), '2:00 PM');
});

test('no start time means no range at all', () => {
  for (const t of ['', null, undefined]) assert.strictEqual(timeRange(t, 90), '');
});

test('shift length reads in hours and minutes', () => {
  assert.strictEqual(fmtDuration(375), '6h 15m');
  assert.strictEqual(fmtDuration(120), '2h');
  assert.strictEqual(fmtDuration(45), '45m');
  assert.strictEqual(fmtDuration(60), '1h');
});

test('a missing or zero shift length shows nothing rather than "0m"', () => {
  for (const v of [0, null, undefined, '', 'x', -30]) {
    assert.strictEqual(fmtDuration(v), '', `${JSON.stringify(v)} should render as empty`);
  }
});

test('a real shift beats the party window it contains', () => {
  // autoCalcTimes: schedule_start = event_time - load - drive - setup, and
  // total_minutes covers load, both drives, setup, party, pack-out, unload.
  // The shift must start before the party and end after it.
  const shiftStart = '12:15', shiftMins = 375;   // 6h15 total
  const partyStart = '14:00', partyMins = 90;
  assert.strictEqual(timeRange(shiftStart, shiftMins), '12:15 PM – 6:30 PM');
  assert.strictEqual(timeRange(partyStart, partyMins), '2:00 PM – 3:30 PM');
  const toMins = (t) => Number(t.slice(0,2)) * 60 + Number(t.slice(3,5));
  assert.ok(toMins(shiftStart) < toMins(partyStart), 'shift starts before the party');
  assert.ok(toMins(addMinutes(shiftStart, shiftMins)) > toMins(addMinutes(partyStart, partyMins)),
    'shift ends after the party');
});
