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
  vm.runInContext(fmtTime + HTML.slice(a, b) + '\nout = { onSiteTime, addMinutes };', ctx);
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

test('the card shows all four stages and never hard-codes a stage time', () => {
  const card = HTML.slice(HTML.indexOf('function gigCard('), HTML.indexOf('function openGigCard('));
  for (const label of ['Load up', 'On site', 'Party', 'Home by']) {
    assert.ok(card.includes(label), `the gig card must show "${label}"`);
  }
  assert.ok(card.includes('onSiteTime('), 'the card must derive on-site through the tested helper');
  assert.ok(card.includes('addMinutes(g.schedule_start, g.total_minutes)'),
    'home-by must be derived from the persisted total, not re-added stage by stage');
});

test('an estimated drive time is labelled as an estimate', () => {
  const card = HTML.slice(HTML.indexOf('function gigCard('), HTML.indexOf('function openGigCard('));
  assert.ok(/zip_known/.test(card),
    'an unknown ZIP falls back to a 30-minute guess; the on-site time must say so');
});
