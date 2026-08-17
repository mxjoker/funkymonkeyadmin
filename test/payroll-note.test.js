const { test } = require('node:test');
const assert = require('node:assert');
const { paymentNote } = require('../netlify/functions/payroll.js');

// IMPORTANT 3: p.hours may now be the MEASURED figure while raw_hours/
// total_minutes are still the ESTIMATE. The old note compared p.hours against
// p.raw_hours regardless of source, so a gig where the clock beat the estimate
// satisfied `p.hours > p.raw_hours` and got stamped "(5h min applied)" when no
// floor applied at all — e.g. "390 min raw (45 min drive ea.) → 7.2h paid
// (5h min applied)", which is self-contradictory since 390 min is 6.5h.
// hours_source is not persisted anywhere else, so this note is the only
// record of how the hours were derived and it has to describe itself
// correctly.

test('a measured span above the floor states the source, no floor claim', () => {
  const note = paymentNote({
    hours_source: 'measured', measured_hours: 6.5, hours: 6.5,
    raw_hours: 6, total_minutes: 360, drive_minutes: 30,
  });
  assert.strictEqual(note, 'Measured 6.5h clocked → 6.5h paid');
});

test('a measured span the floor actually lifted says so', () => {
  const note = paymentNote({
    hours_source: 'measured', measured_hours: 3, hours: 5,
    raw_hours: 6, total_minutes: 360, drive_minutes: 30,
  });
  assert.strictEqual(note, 'Measured 3h clocked → 5h paid (5h min applied)');
});

// The exact bug: total_minutes=390 (6.5h) is the ESTIMATE, but the clock
// measured a shorter/different span and paid 7.2h. The floor never applied —
// 7.2 > 6.5 is just measured beating the estimate, not the 5h minimum firing.
test('a measured span above the stale estimate never claims the 5h floor', () => {
  const note = paymentNote({
    hours_source: 'measured', measured_hours: 7.2, hours: 7.2,
    raw_hours: 6.5, total_minutes: 390, drive_minutes: 45,
  });
  assert.doesNotMatch(note, /5h min applied/);
  assert.strictEqual(note, 'Measured 7.2h clocked → 7.2h paid');
});

test('an estimated payment keeps the original string, unchanged', () => {
  const note = paymentNote({
    hours_source: 'estimated', measured_hours: null, hours: 6.5,
    raw_hours: 6.5, total_minutes: 390, drive_minutes: 45,
  });
  assert.strictEqual(note, 'Auto-generated: 390 min raw (45 min drive ea.) → 6.5h paid');
});

test('an estimated payment the floor genuinely lifted still says so', () => {
  const note = paymentNote({
    hours_source: 'estimated', measured_hours: null, hours: 5,
    raw_hours: 2.5, total_minutes: 150, drive_minutes: 15,
  });
  assert.strictEqual(note, 'Auto-generated: 150 min raw (15 min drive ea.) → 5h paid (5h min applied)');
});
