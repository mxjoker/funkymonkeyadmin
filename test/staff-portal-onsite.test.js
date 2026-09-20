const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');

// Same bare-context extraction staff-portal-times.test.js uses: a reach for
// `document` must throw rather than quietly pass against a stub.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE TIME HELPERS');
  const b = HTML.indexOf('// ══ END PURE TIME HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure time-helper sentinels missing from staff-portal.html');
  const ctx = {};
  vm.createContext(ctx);
  const fmtTime = HTML.slice(HTML.indexOf('function fmtTime(t)'), HTML.indexOf('// ══ PURE TIME HELPERS'));
  vm.runInContext(fmtTime + HTML.slice(a, b) + '\nout = { onSiteTime, departTime, addMinutes };', ctx);
  return ctx.out;
}

const { onSiteTime } = loadHelpers();

test('on site is the leave time plus load plus one drive leg', () => {
  // Booking 801 as it actually stands: leave 15:20, 30m load, 25m drive,
  // party at 17:00 — so the crew is at the venue at 16:15 with 45m to set up.
  assert.strictEqual(onSiteTime('15:20:00', 30, 25), '16:15');
  assert.strictEqual(onSiteTime('10:15', 30, 30), '11:15');
});

test('a missing drive time yields no on-site time rather than a plausible wrong one', () => {
  // null + 30 is 30 in JS, which would render an on-site time that is only the
  // load allowance — a specific, believable, wrong hour to be standing outside
  // a venue. Showing nothing is the honest answer.
  assert.strictEqual(onSiteTime('15:20', 30, null), '');
  assert.strictEqual(onSiteTime('15:20', null, 25), '');
  assert.strictEqual(onSiteTime('15:20', undefined, undefined), '');
  assert.strictEqual(onSiteTime('15:20', 30, ''), '');
  assert.strictEqual(onSiteTime('15:20', 30, 'soon'), '');
});

test('an unassigned gig has no leave time, so it has no on-site time', () => {
  // schedule_start is only computed on the assign path, so a gig somebody has
  // merely expressed interest in legitimately has none.
  for (const t of ['', null, undefined]) {
    assert.strictEqual(onSiteTime(t, 30, 25), '', `${JSON.stringify(t)} must not produce a time`);
  }
});

test('zero-minute stages are real and still produce a time', () => {
  // Unlike a duration, zero load or zero drive is meaningful: an on-site gig
  // with nothing to carry. It must not be treated as "unknown".
  assert.strictEqual(onSiteTime('15:20', 0, 0), '15:20');
  assert.strictEqual(onSiteTime('15:20', 0, 25), '15:45');
});

test('an on-site time after midnight wraps rather than reading 25:00', () => {
  assert.strictEqual(onSiteTime('23:30', 30, 30), '00:30');
});

test('the card shows every stage, in order, and never hard-codes a stage time', () => {
  const card = HTML.slice(HTML.indexOf('function gigCard('), HTML.indexOf('function openGigCard('));
  // Five now: 'Depart by' was added between loading and arriving, because when
  // you start loading and when the loading must be done are two instructions.
  const stages = ['Load up', 'Depart by', 'On site', 'Party', 'Home by'];
  for (const label of stages) {
    assert.ok(card.includes(label), `the gig card must show "${label}"`);
  }
  // A stage out of order reads as a different day's plan, so the order is
  // pinned as well as the presence.
  const positions = stages.map((l) => card.indexOf(l));
  assert.deepStrictEqual(positions, [...positions].sort((x, y) => x - y),
    'the stages are rendered out of chronological order');
  assert.ok(card.includes('onSiteTime('), 'the card must derive on-site through the tested helper');
  assert.ok(card.includes('departTime('), 'the card must derive the departure through the tested helper');
  assert.ok(card.includes('addMinutes(g.schedule_start, g.total_minutes)'),
    'home-by must be derived from the persisted total, not re-added stage by stage');
});

test('an estimated drive time is labelled as an estimate', () => {
  const card = HTML.slice(HTML.indexOf('function gigCard('), HTML.indexOf('function openGigCard('));
  assert.ok(/zip_known/.test(card),
    'an unknown ZIP falls back to a 30-minute guess; the on-site time must say so');
});

// ── Depart by ───────────────────────────────────────────────────────────────
// "Load up" is when you turn up to start loading; "Depart by" is when the
// loading has to be finished. Two instructions that were sharing one row.
const { departTime, addMinutes } = loadHelpers();

test('depart is the call time plus the load allowance', () => {
  assert.strictEqual(departTime('13:45:00', 30), '14:15');
  assert.strictEqual(departTime('15:20', 30), '15:50');
});

test('depart and on site stay one drive leg apart, by construction', () => {
  // departTime IS onSiteTime with no drive, so these cannot drift apart. If
  // this ever fails, one of the two grew its own arithmetic.
  for (const [start, load, drive] of [['13:45', 30, 45], ['15:20', 30, 25], ['06:00', 45, 90]]) {
    const depart = departTime(start, load);
    assert.strictEqual(onSiteTime(start, load, drive), addMinutes(depart, drive),
      `${start} +${load} +${drive}`);
  }
});

test('an unknown load allowance yields no departure, not the call time', () => {
  // Rendering the call time as the departure would tell a crew member to leave
  // the moment they arrive — a specific, plausible, wrong instruction.
  for (const v of [null, undefined, '', 'abc', NaN]) {
    assert.strictEqual(departTime('13:45', v), '', String(v));
  }
  assert.strictEqual(departTime('', 30), '', 'no call time, no departure');
});

test('nothing to load means you leave when you arrive', () => {
  // Zero is a real answer and is not the same as unknown: a walkaround gig
  // with no kit departs at the call time.
  assert.strictEqual(departTime('13:45', 0), '13:45');
});

// ── Setup time survives the round trip between two files ───────────────────
// Joe, 2026-09-20: "the on site time and the party start time are both 3pm but
// that should include a setup time as well." It does, and this is what keeps it
// true. The two halves live apart: autoCalcTimes in staff-assignments.js writes
// schedule_start as event_time - load - drive - setup, and this page re-derives
// on-site as schedule_start + load + drive. Setup is the only stage that
// survives as the GAP between the two, so it is the one that vanishes silently
// if either half is changed alone — and a crew arriving with no time to set up
// is a wrong answer nobody notices until they are standing there.
test('on site always lands a full setup before the party', () => {
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  // Measured on every upcoming assigned gig, 2026-09-20: load 30, setup 45,
  // drives from 25 to 198 minutes, and all of them 45 minutes of setup.
  for (const [party, load, drive, setup] of [
    [13 * 60,      30,  30, 45],
    [18 * 60 + 30, 30,  57, 45],
    [21 * 60 + 45, 30, 198, 45],
    [14 * 60,      30, 153, 45],
    [19 * 60,      30,  25, 45],
    // A service whose template says something else must work the same way.
    [15 * 60,      45,  20, 90],
    // Nothing to set up is legitimate — a walkaround act. On site IS the party.
    [15 * 60,      30,  30,  0],
  ]) {
    // autoCalcTimes' own formula, spelled out rather than imported: if it ever
    // changes, this test should fail rather than quietly follow it.
    const scheduleStart = clock(party - load - drive - setup);
    const onsite = onSiteTime(scheduleStart, load, drive);
    assert.strictEqual(onsite, clock(party - setup),
      `party ${clock(party)} with ${setup}m setup: on site should be ${clock(party - setup)}, got ${onsite}`);
    // And the departure is still one drive leg short of it.
    assert.strictEqual(departTime(scheduleStart, load), clock(party - setup - drive));
  }
});
