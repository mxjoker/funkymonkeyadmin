const { test } = require('node:test');
const assert = require('node:assert');

// A pinning test, same spirit as test/schedule-span.test.js: it records what
// payroll.js computes so the unification (moving its drive-time/default
// logic into _schedule.js) can prove nothing changed except what it
// deliberately fixed. computeAssignmentSpan did not exist as a callable unit
// before this task — it was inline in payroll.js's handler loop — extracted
// and exported so it can be pinned without a live database.
//
// unload used to default to 15 here. Every other reader of this arithmetic —
// _schedule.js's spanFor and admin.html's Gig Time Templates UI — used 45.
// 15 was payroll's own stale outlier, not a deliberate choice; 45 is the
// value everywhere now (see _schedule.js's DEFAULT_MINUTES, which both
// spanFor and this file's computeAssignmentSpan read from).
const { computeAssignmentSpan } = require('../netlify/functions/payroll.js');

const assignment = (over = {}) => ({
  service_id: 'magic', event_zip: '73102',
  load_minutes: null, unload_minutes: null, pack_out_minutes: null,
  home_unload_minutes: null, drive_minutes_each_way: null,
  ...over,
});

test('computeAssignmentSpan: defaults when no template row exists', () => {
  const s = computeAssignmentSpan(assignment(), {}, 60);
  // 73102 from home 73118: haversine estimate at 35mph + 15 min stop = 25.
  assert.deepStrictEqual(
    { load: s.load, unload: s.unload, pack: s.pack, homeUn: s.homeUn, drive: s.drive },
    { load: 30, unload: 45, pack: 20, homeUn: 15, drive: 25 }
  );
  // 30 + 25 + 45 + 60 + 20 + 25 + 15
  assert.strictEqual(s.totalMins, 220);
  assert.strictEqual(s.rawHours, 220 / 60);
});

test('computeAssignmentSpan: a template row beats the hardcoded defaults', () => {
  const tmpl = { load_minutes: 5, unload_minutes: 5, pack_out_minutes: 5, home_unload_minutes: 5 };
  const s = computeAssignmentSpan(assignment(), tmpl, 60);
  // 5 + 25 + 5 + 60 + 5 + 25 + 5
  assert.strictEqual(s.totalMins, 130);
});

test('computeAssignmentSpan: an assignment override beats the template', () => {
  const s = computeAssignmentSpan(
    assignment({ drive_minutes_each_way: 90, load_minutes: 10 }),
    { load_minutes: 5 },
    60
  );
  // 10 + 90 + 45 + 60 + 20 + 90 + 15
  assert.strictEqual(s.totalMins, 330);
});

test('computeAssignmentSpan: an unknown ZIP still returns the 30-minute figure, unchanged — BUG-1, pinned deliberately (matches _schedule.js\'s getDriveMins)', () => {
  const s = computeAssignmentSpan(assignment({ event_zip: '99999' }), {}, 60);
  assert.strictEqual(s.drive, 30);
});

test('computeAssignmentSpan: a blank ZIP also falls back to 30', () => {
  const s = computeAssignmentSpan(assignment({ event_zip: '' }), {}, 60);
  assert.strictEqual(s.drive, 30);
});

// The genuinely new signal (task step 3): the NUMBER never changes — 30 is
// still 30 — but a row built on it now says so, so a guessed drive time
// stops looking identical to a known one.
test('computeAssignmentSpan: an unknown ZIP with no override is flagged as a guess', () => {
  const s = computeAssignmentSpan(assignment({ event_zip: '99999' }), {}, 60);
  assert.strictEqual(s.driveIsGuess, true);
});

test('computeAssignmentSpan: a known ZIP is not a guess', () => {
  const s = computeAssignmentSpan(assignment({ event_zip: '73102' }), {}, 60);
  assert.strictEqual(s.driveIsGuess, false);
});

test('computeAssignmentSpan: an override on an unknown ZIP is not a guess — the number is pinned, not estimated', () => {
  const s = computeAssignmentSpan(
    assignment({ event_zip: '99999', drive_minutes_each_way: 40 }),
    {},
    60
  );
  assert.strictEqual(s.drive, 40);
  assert.strictEqual(s.driveIsGuess, false);
});
