const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SA = read('netlify/functions/staff-assignments.js');
const BOOKING = read('netlify/functions/booking.js');

// schedule_start, total_minutes and drive_minutes_each_way are DERIVED from the
// booking's time, date, ZIP and service. autoCalcTimes skips any row that
// already has total_minutes, so once written they never refreshed: booking
// 26-143 kept a 30-minute drive to a town 81 miles away and told its crew
// member to leave 70 minutes too late, discovered two days before the gig.
test('a booking edit that moves the schedule invalidates the derived times', () => {
  assert.match(BOOKING, /const SCHEDULE_INPUTS = \['event_time', 'event_date', 'event_zip', 'service_id'\]/);
  assert.match(BOOKING, /invalidateDerivedTimes\(c, parseInt\(id\)\)/);
});

// service_id moves through the items rollup, which never appears in the PATCH
// payload — so watching `u` would have missed exactly the case that matters.
test('it compares stored values, not the payload', () => {
  const block = BOOKING.split('const SCHEDULE_INPUTS')[1].split('}')[0];
  assert.match(block, /String\(prev\[f\] \?\? ''\) !== String\(updated\[f\] \?\? ''\)/);
  assert.ok(!/u\[f\] !== undefined/.test(block), 'reading the payload would miss a rollup-driven change');
});

test('a failed recalc does not fail the booking save', () => {
  const block = BOOKING.split('if (scheduleMoved.length)')[1].split('// Fire automation')[0];
  assert.match(block, /catch \(e\)/);
  assert.match(block, /console\.error/);
});

test('the recalc is written to the booking history', () => {
  assert.match(BOOKING, /'Staff times recalculated'/);
});

// The ambiguity that caused the bug: a drive time persisted by a previous run
// looked identical to one a person typed, so nothing dared recompute it.
test('a human-set time is marked, and never thrown away', () => {
  assert.match(SA, /ADD COLUMN IF NOT EXISTS times_manual BOOLEAN DEFAULT FALSE/);
  assert.match(SA, /times_manual=TRUE/, 'the admin edit must set the flag');
  const fn = SA.split('async function invalidateDerivedTimes')[1].split('\n}')[0];
  assert.match(fn, /COALESCE\(times_manual, FALSE\) = FALSE/, 'manual rows must be skipped');
});

test('invalidation nulls exactly the derived columns, then recomputes', () => {
  const fn = SA.split('async function invalidateDerivedTimes')[1].split('\n}')[0];
  for (const col of ['total_minutes', 'schedule_start', 'drive_minutes_each_way']) {
    assert.ok(fn.includes(col + ' = NULL') || fn.includes(col + ' = NULL,'), col + ' must be cleared');
  }
  assert.ok(!/load_minutes|unload_minutes|pack_out_minutes/.test(fn),
    'per-assignment component overrides are not derived and must survive');
  assert.match(fn, /await autoCalcTimes\(client, r\.id, bookingId\)/, 'and then recompute');
});

// Nulling total_minutes is precisely what makes autoCalcTimes willing to run —
// its skip is the reason the stale value survived.
test('clearing total_minutes is what unblocks the recalculation', () => {
  assert.match(SA, /if \(!forceRecalc && sa\.total_minutes != null\) return;/,
    'the skip still exists, so invalidation must clear the field it checks');
});
