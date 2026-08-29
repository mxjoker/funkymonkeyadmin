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

// IMPORTANT 2: an overridden gig used to store "Auto-generated: 480 min raw
// (30 min drive ea.) → 8h paid" beside an amount that has nothing to do with
// those hours -- the note described time that was never used to pay anyone.
// A deliberate override describes itself: the figure and which roles earned it.
test('an override describes the override, not hours that were never used to pay it', () => {
  const note = paymentNote({
    isOverride: true, amount: 200, roles_filled: ['Foam Crew', 'Story Doodles'],
    hours_source: 'estimated', measured_hours: null, hours: 8,
    raw_hours: 8, total_minutes: 480, drive_minutes: 30,
  });
  assert.strictEqual(note, 'Override: $200.00 for Foam Crew, Story Doodles');
  assert.doesNotMatch(note, /min raw|min drive|paid \(/);
});

test('an override with no roles recorded still describes the figure', () => {
  const note = paymentNote({ isOverride: true, amount: 0, roles_filled: [] });
  assert.strictEqual(note, 'Override: $0.00');
});

test('a non-override payment is completely unaffected by the isOverride field existing and being false', () => {
  const note = paymentNote({
    isOverride: false, amount: 72, roles_filled: ['Foam Crew'],
    hours_source: 'measured', measured_hours: 6.5, hours: 6.5,
    raw_hours: 6, total_minutes: 360, drive_minutes: 30,
  });
  assert.strictEqual(note, 'Measured 6.5h clocked → 6.5h paid');
});

// Task step 3 (unify-drive-time): the drive figure inside total_minutes
// doesn't change based on drive_is_guess — 30 stays 30 — only the note gets
// to say it was fabricated, not measured or looked up in the ZIP table.
test('an estimated payment built on a guessed drive time says so', () => {
  const note = paymentNote({
    hours_source: 'estimated', measured_hours: null, hours: 6.5,
    raw_hours: 6.5, total_minutes: 390, drive_minutes: 30,
    drive_is_guess: true,
  });
  assert.strictEqual(
    note,
    'Auto-generated: 390 min raw (30 min drive ea.) [drive time estimated — ZIP not in table] → 6.5h paid'
  );
});

test('an estimated payment on a known ZIP says nothing about a guess', () => {
  const note = paymentNote({
    hours_source: 'estimated', measured_hours: null, hours: 6.5,
    raw_hours: 6.5, total_minutes: 390, drive_minutes: 45,
    drive_is_guess: false,
  });
  assert.doesNotMatch(note, /estimated — ZIP/);
});

// A measured payment ignores drive_is_guess entirely — the clock paid this
// one, not the estimate, so what the drive guess would have been is moot.
test('a measured payment never mentions drive_is_guess even when set', () => {
  const note = paymentNote({
    hours_source: 'measured', measured_hours: 6.5, hours: 6.5,
    drive_is_guess: true,
  });
  assert.doesNotMatch(note, /drive time estimated/);
});
