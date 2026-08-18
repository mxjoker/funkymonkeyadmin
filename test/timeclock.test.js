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

const { payableHours } = require('../netlify/functions/_timeclock.js');

const at2 = (h, m = 0) => new Date(Date.UTC(2026, 7, 15, h, m)).toISOString();

test('a sane measured span is what gets paid', () => {
  const r = payableHours({ clocked_in_at: at2(9), clocked_out_at: at2(15, 30) }, 7.25);
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.hours, 6.5);
  assert.strictEqual(r.warning, null);
});

test('the 5-hour minimum still applies to a measured span', () => {
  const r = payableHours({ clocked_in_at: at2(9), clocked_out_at: at2(11) }, 5.5);
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.hours, 5, 'the 5-hour floor was lost');
});

test('the 5-hour minimum still applies to an estimate', () => {
  const r = payableHours({}, 1.5);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 5);
});

test('an unusable record pays the estimate and explains itself', () => {
  const r = payableHours({ clocked_in_at: at2(9) }, 7.25);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 7.25);
  assert.match(r.warning, /clock-out/i);
});

test('a forgotten clock-out pays the estimate, never the 25-hour span', () => {
  const r = payableHours(
    { clocked_in_at: at2(8), clocked_out_at: new Date(Date.UTC(2026, 7, 16, 9)).toISOString() }, 7.25);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 7.25);
  assert.match(r.warning, /16h maximum/);
});

// Every gig_logs row that exists today has neither column.
test('a booking with no clock record at all pays exactly what it pays now', () => {
  for (const log of [null, undefined, {}]) {
    const r = payableHours(log, 7.25);
    assert.strictEqual(r.hours, 7.25);
    assert.strictEqual(r.source, 'estimated');
  }
});

// A normal week is 20-40 assignments, none of which have touched the clock
// yet — warning on every one of them would bury the two warnings that matter
// (a $0 line item, a genuine forgotten clock-out) under a wall of expected
// noise. Only warn when there is clock data to be suspicious of.
test('a clock-in with no clock-out still warns', () => {
  const r = payableHours({ clocked_in_at: at2(9) }, 7.25);
  assert.strictEqual(r.hours, 7.25);
  assert.ok(r.warning, 'partial clock data should still warn');
});

test('no clock data at all does not warn, and still pays the estimate', () => {
  for (const log of [null, undefined, {}]) {
    const r = payableHours(log, 7.25);
    assert.strictEqual(r.hours, 7.25);
    assert.strictEqual(r.source, 'estimated');
    assert.strictEqual(r.warning, null, 'a booking that never touched the clock should not warn');
  }
});

const { mergeClockSpan } = require('../netlify/functions/_timeclock.js');

test('a single log degrades to exactly that log\'s own stamps', () => {
  const m = mergeClockSpan([{ clocked_in_at: at2(9), clocked_out_at: at2(15) }]);
  assert.strictEqual(m.clocked_in_at.getTime(), new Date(at2(9)).getTime());
  assert.strictEqual(m.clocked_out_at.getTime(), new Date(at2(15)).getTime());
});

test('two roles merge to the earliest in and the latest out, not either row alone', () => {
  const m = mergeClockSpan([
    { clocked_in_at: at2(10), clocked_out_at: at2(14) },
    { clocked_in_at: at2(9),  clocked_out_at: at2(15) },
  ]);
  assert.strictEqual(m.clocked_in_at.getTime(), new Date(at2(9)).getTime(), 'should take the earliest clock-in');
  assert.strictEqual(m.clocked_out_at.getTime(), new Date(at2(15)).getTime(), 'should take the latest clock-out');
});

test('a role with no clock data does not blank out a role that has one', () => {
  const m = mergeClockSpan([
    { clocked_in_at: null, clocked_out_at: null },
    { clocked_in_at: at2(9), clocked_out_at: at2(15) },
  ]);
  assert.strictEqual(m.clocked_in_at.getTime(), new Date(at2(9)).getTime());
  assert.strictEqual(m.clocked_out_at.getTime(), new Date(at2(15)).getTime());
});

test('no logs at all merges to nothing, not a crash', () => {
  assert.deepStrictEqual(mergeClockSpan([]), { clocked_in_at: null, clocked_out_at: null, clock_adjusted: false });
  assert.deepStrictEqual(mergeClockSpan(null), { clocked_in_at: null, clocked_out_at: null, clock_adjusted: false });
});

// The returned flag is `clock_adjusted` (boolean), not `clock_adjusted_at` —
// that suffix belongs to the gig_logs timestamp column being read here, not
// to this derived boolean. A reader that expects a timestamp must not find
// one under this name.
test('an adjustment on any row in the group carries through, under the boolean-shaped name', () => {
  const m = mergeClockSpan([
    { clocked_in_at: at2(9), clocked_out_at: at2(12), clock_adjusted_at: null },
    { clocked_in_at: at2(12), clocked_out_at: at2(15), clock_adjusted_at: at2(16) },
  ]);
  assert.strictEqual(m.clock_adjusted, true);
  assert.strictEqual(m.clock_adjusted_at, undefined, 'the old timestamp-shaped key must not linger');
});

// The merged span feeds straight into payableHours, exactly like a single
// log did before grouping existed.
test('a merged span is usable by payableHours like any other log', () => {
  const m = mergeClockSpan([
    { clocked_in_at: at2(10), clocked_out_at: at2(14) },
    { clocked_in_at: at2(9),  clocked_out_at: at2(15) },
  ]);
  const r = payableHours(m, 6);
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.hours, 6);
});
