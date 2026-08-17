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
    '\nout = { addMinutes, timeRange, fmtDuration, clockedHoursLabel, reportButtonVisible };', ctx);
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

// ── The two display rules the clock added ────────────────────────────────────
const { clockedHoursLabel, reportButtonVisible } = loadHelpers();

test('a worked span reads as hours and minutes', () => {
  assert.strictEqual(
    clockedHoursLabel({ clocked_in_at: '2026-08-15T14:00:00Z', clocked_out_at: '2026-08-15T20:30:00Z' }),
    '6h 30m');
});

// The bug: this is the one clock display the person being PAID actually reads,
// and it had no cap check. A forgotten clock-out rendered "⏱ Worked 25h 00m" as
// fact while _timeclock.js refused the span and payroll quietly paid the
// estimate. Both other mirrors flag an over-cap span; this one must too.
test('a span past the 16-hour cap is flagged, not presented as hours worked', () => {
  const label = clockedHoursLabel({ clocked_in_at: '2026-08-15T09:00:00Z', clocked_out_at: '2026-08-16T10:00:00Z' });
  assert.ok(!/25h/.test(label), `showed a span payroll will refuse: ${label}`);
  assert.match(label, /check|⚠/i, `an over-cap span must read as a problem: ${label}`);
});

test('exactly 16 hours is still a shift, 16h and a second is not', () => {
  const at = (ms) => ({ clocked_in_at: new Date(0).toISOString(), clocked_out_at: new Date(ms).toISOString() });
  assert.strictEqual(clockedHoursLabel(at(16 * 3600000)), '16h 00m');
  assert.match(clockedHoursLabel(at(16 * 3600000 + 1000)), /check|⚠/i);
});

test('an incomplete or backwards clock shows no figure', () => {
  assert.strictEqual(clockedHoursLabel({ clocked_in_at: '2026-08-15T14:00:00Z' }), '—');
  assert.strictEqual(clockedHoursLabel({ clocked_in_at: '2026-08-15T14:00:00Z', clocked_out_at: '2026-08-15T13:00:00Z' }), '—');
});

// The bug: the report button was gated on `completed` alone, so a worker who
// tapped Clock Out before writing the report lost the button entirely, and the
// only way back was stepping to `completed` — which NULLs clocked_out_at.
test('the post-gig report is still reachable after clocking out', () => {
  assert.strictEqual(reportButtonVisible({ checklist_status: 'completed' }), true);
  assert.strictEqual(reportButtonVisible({ checklist_status: 'clocked_out' }), true);
});

test('the report is not offered before the gig is done', () => {
  for (const s of ['upcoming', 'clocked_in', 'on_my_way', 'arrived']) {
    assert.strictEqual(reportButtonVisible({ checklist_status: s }), false, s);
  }
  assert.strictEqual(reportButtonVisible({}), false);
});

test('a report already submitted is not offered again', () => {
  assert.strictEqual(reportButtonVisible({ checklist_status: 'clocked_out', survey_submitted_at: '2026-08-15T21:00:00Z' }), false);
  assert.strictEqual(reportButtonVisible({ checklist_status: 'completed', survey_submitted_at: '2026-08-15T21:00:00Z' }), false);
});
