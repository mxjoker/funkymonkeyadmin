const { test } = require('node:test');
const assert = require('node:assert');
const { workedHours, clockSegments, MAX_SHIFT_HOURS } = require('../netlify/functions/_timeclock.js');

const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 15, h, m)).toISOString();

test('a complete record measures the span from clock-in to clock-out', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(15, 30) });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, 6.5);
  assert.strictEqual(r.reason, null);
});

test('hours are rounded to two places, like the estimate they replace', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(14, 20) });
  assert.strictEqual(r.hours, 5.33);
});

// Each of these must fall back to the estimate rather than pay a number.
test('an incomplete record is not usable, and says why', () => {
  for (const [log, expect] of [
    [{ clocked_in_at: at(9), clocked_out_at: null }, /clock-out/i],
    [{ clocked_in_at: null, clocked_out_at: at(15) }, /clock-in/i],
    [{}, /clock-in/i],
    [null, /clock-in/i],
  ]) {
    const r = workedHours(log);
    assert.strictEqual(r.usable, false, `${JSON.stringify(log)} was treated as usable`);
    assert.strictEqual(r.hours, null);
    assert.match(r.reason, expect);
  }
});

test('a backwards pair is not usable', () => {
  const r = workedHours({ clocked_in_at: at(15), clocked_out_at: at(9) });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, /before/i);
});

test('a zero-length span is not usable', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(9) });
  assert.strictEqual(r.usable, false);
});

// The forgotten clock-out. Paying this silently overpays by hundreds.
test('a span beyond the cap is not usable and names the cap', () => {
  const r = workedHours({ clocked_in_at: at(8), clocked_out_at: new Date(Date.UTC(2026, 7, 16, 9)).toISOString() });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, new RegExp(String(MAX_SHIFT_HOURS)));
});

test('exactly the cap is still usable — the boundary is inclusive', () => {
  const r = workedHours({ clocked_in_at: at(0), clocked_out_at: new Date(Date.UTC(2026, 7, 15, MAX_SHIFT_HOURS)).toISOString() });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, MAX_SHIFT_HOURS);
});

test('garbage timestamps are not usable', () => {
  const r = workedHours({ clocked_in_at: 'not a date', clocked_out_at: at(15) });
  assert.strictEqual(r.usable, false);
});

// pg returns TIMESTAMPTZ as a Date object, not a string.
test('Date objects work as well as ISO strings', () => {
  const r = workedHours({ clocked_in_at: new Date(at(9)), clocked_out_at: new Date(at(12)) });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, 3);
});

test('segments decompose the day into the estimate\'s four parts', () => {
  const s = clockSegments({
    clocked_in_at: at(9), on_my_way_at: at(9, 30), arrived_at: at(10),
    completed_at: at(14), clocked_out_at: at(15),
  });
  assert.deepStrictEqual(s, { loading: 30, driveOut: 30, onSite: 240, driveBackAndUnload: 60 });
});

test('a missing stamp makes only its own segment null', () => {
  const s = clockSegments({ clocked_in_at: at(9), on_my_way_at: null, arrived_at: at(10), completed_at: at(14), clocked_out_at: at(15) });
  assert.strictEqual(s.loading, null);
  assert.strictEqual(s.driveOut, null);
  assert.strictEqual(s.onSite, 240);
  assert.strictEqual(s.driveBackAndUnload, 60);
});

test('a backwards segment reads null rather than negative minutes', () => {
  const s = clockSegments({ clocked_in_at: at(10), on_my_way_at: at(9) });
  assert.strictEqual(s.loading, null);
});

// The cap is enforced against raw milliseconds, not after rounding. A span that
// rounds to 16.00 but is slightly over must still be rejected, or rounding can
// make an over-cap span usable.
test('exactly MAX_SHIFT_HOURS in milliseconds is usable', () => {
  const inMs = new Date(at(0)).getTime();
  const outMs = inMs + (MAX_SHIFT_HOURS * 3600000);
  const r = workedHours({
    clocked_in_at: new Date(inMs).toISOString(),
    clocked_out_at: new Date(outMs).toISOString(),
  });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, MAX_SHIFT_HOURS);
});

test('one second over MAX_SHIFT_HOURS is not usable, even if it rounds to 16.00', () => {
  const inMs = new Date(at(0)).getTime();
  const outMs = inMs + (MAX_SHIFT_HOURS * 3600000) + 1000;
  const r = workedHours({
    clocked_in_at: new Date(inMs).toISOString(),
    clocked_out_at: new Date(outMs).toISOString(),
  });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, new RegExp(String(MAX_SHIFT_HOURS)));
});
