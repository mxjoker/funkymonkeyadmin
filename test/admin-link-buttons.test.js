const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { depositLinkAmount, balanceLinkAmounts, balanceLinkEligible, clockRowLabel, clockAdjustAllowed, CHECKLIST_STATUSES, CHECKLIST_LABELS, reportButtonVisible };', ctx);
  return ctx.out;
}

const { depositLinkAmount } = loadHelpers();

// The bug this file exists for: a school or library booking is deliberately
// $0 deposit, and the old `Number(b.deposit_amount) || 100` billed it $100 for
// money the booking never asked for.
test('a deliberate $0 deposit charges nothing, not $100', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 0 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '0' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: null }), 0);
  assert.strictEqual(depositLinkAmount({}), 0);
});

test('a real deposit passes through, including as a NUMERIC string from pg', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 100 }), 100);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '150.00' }), 150);
});

test('junk never becomes a charge', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: -50 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: 'abc' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: Infinity }), 0);
});

// The literal that caused it, gone for good.
test('the $100 fallback literal is not in admin.html any more', () => {
  assert.ok(!/deposit_amount\s*\)\s*\|\|\s*100/.test(HTML),
    'the `Number(b.deposit_amount) || 100` fallback is back');
});

const { balanceCharge } = require('../netlify/functions/_items.js');

const { balanceLinkAmounts } = loadHelpers();

test('the button label agrees with the server, to the cent', () => {
  for (const balance_due of [400, 385, 333.33, 1250.5, '400.00', 0]) {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(balanceLinkAmounts({ balance_due }))),
      balanceCharge({ balance_due }),
      `admin.html and _items.js disagree at balance_due=${balance_due}`
    );
  }
});

test('nothing owed offers no balance link', () => {
  assert.strictEqual(balanceLinkAmounts({ balance_due: 0 }).total, 0);
  assert.strictEqual(balanceLinkAmounts({}).total, 0);
  assert.strictEqual(balanceLinkAmounts({ balance_due: -5 }).total, 0);
});

const { balanceLinkEligible } = loadHelpers();

// The bug: a freshly quoted booking showed "Send $100.00 deposit link" and
// "Send $420.00 balance link" side by side. Pay the balance link and
// balance_due goes to 0 while the deposit link stays live; pay that too and
// the deposit branch recomputes balance_due = total + mileage - 100 = 400.
// A client who has paid $520 is then shown $400 owing.
test('a balance link is not offered while the deposit is still outstanding', () => {
  const quoted = { total_price: 500, mileage_cost: 0, deposit_amount: 100,
                   balance_due: 400, deposit_paid: false };
  assert.strictEqual(balanceLinkEligible(quoted), false);
});

test('a balance link is offered once the deposit is paid', () => {
  assert.strictEqual(balanceLinkEligible({ deposit_amount: 100, balance_due: 400,
                                           deposit_paid: true }), true);
});

// The deliberate no-deposit booking (school, library) has nothing to settle
// first, so its balance link is available immediately.
test('a deliberate $0-deposit booking may be sent its balance link straight away', () => {
  assert.strictEqual(balanceLinkEligible({ deposit_amount: 0, balance_due: 325,
                                           deposit_paid: false }), true);
});

test('nothing owed is never eligible, deposit paid or not', () => {
  assert.strictEqual(balanceLinkEligible({ deposit_amount: 0, balance_due: 0, deposit_paid: true }), false);
  assert.strictEqual(balanceLinkEligible({ deposit_amount: 100, balance_due: -5, deposit_paid: true }), false);
});

test('a row missing the fields is not eligible rather than defaulting to yes', () => {
  assert.strictEqual(balanceLinkEligible({}), false);
  assert.strictEqual(balanceLinkEligible(null), false);
  assert.strictEqual(balanceLinkEligible(undefined), false);
  // deposit_paid arriving as anything other than true (a pg 't', a null) must
  // not be read as settled.
  assert.strictEqual(balanceLinkEligible({ deposit_amount: 100, balance_due: 400, deposit_paid: 't' }), false);
});

const { clockRowLabel } = loadHelpers();

test('a complete clock reads as hours and minutes', () => {
  const s = clockRowLabel({ clocked_in_at: '2026-08-15T09:00:00Z', clocked_out_at: '2026-08-15T15:30:00Z' });
  assert.match(s, /6h 30m/);
});

test('an incomplete clock says what is missing rather than showing a number', () => {
  assert.match(clockRowLabel({ clocked_in_at: '2026-08-15T09:00:00Z' }), /no clock-out|not clocked out/i);
  assert.match(clockRowLabel({}), /not clocked in|no clock-in/i);
});

test('an implausible span is flagged, not displayed as fact', () => {
  const s = clockRowLabel({ clocked_in_at: '2026-08-15T08:00:00Z', clocked_out_at: '2026-08-16T09:00:00Z' });
  assert.match(s, /check|⚠/i);
});

// Regression: rounding to minutes before comparing against the 16h cap let a
// span of 16h00m00.001s-16h00m29.999s round DOWN to a clean "16h" and read
// as normal, while _timeclock.js's workedHours() — which compares raw
// milliseconds — refuses the same span. Same bug class fixed once already
// in _timeclock.js; the cap check here must compare raw ms too.
test('one millisecond over the 16h cap is flagged, not rounded down to a clean 16h', () => {
  const s = clockRowLabel({ clocked_in_at: '2026-08-15T00:00:00.000Z', clocked_out_at: '2026-08-15T16:00:00.001Z' });
  assert.match(s, /check|⚠/i);
});

test('exactly 16h is still a normal day, the boundary is inclusive like workedHours()', () => {
  const s = clockRowLabel({ clocked_in_at: '2026-08-15T00:00:00.000Z', clocked_out_at: '2026-08-15T16:00:00.000Z' });
  assert.doesNotMatch(s, /check|⚠/i);
  assert.match(s, /16h 00m/);
});

const { clockAdjustAllowed } = loadHelpers();

// The bug this predicate exists for: a stage this card's query never
// selected (on_my_way_at/arrived_at/completed_at before the SELECT was
// fixed to carry them) renders its input blank not because the stage was
// never stamped, but because admin.html was never given the value. Saving
// that blank must not silently NULL a real timestamp.
test('a field the card never fetched refuses to save while its input is still blank', () => {
  assert.strictEqual(clockAdjustAllowed(false, ''), false);
});

test('a field the card did fetch may be cleared deliberately', () => {
  assert.strictEqual(clockAdjustAllowed(true, ''), true);
});

test('a filled-in value always saves, fetched or not', () => {
  assert.strictEqual(clockAdjustAllowed(false, '2026-08-15T09:00'), true);
  assert.strictEqual(clockAdjustAllowed(true, '2026-08-15T09:00'), true);
});

// The bug: admin.html's page-portal view (gigCard, ~4041) and its assignment
// badge (renderAssignmentCard's clLabels, ~2341) each carried their own stale
// four-stage copy of the checklist, frozen before clocked_in/clocked_out were
// added to CHECKLIST_STATUSES in staff-assignments.js and to staff-portal.html.
// A stale array's indexOf() on a real clocked_in/clocked_out status returns
// -1, which makes isActive false and isPast (i < -1) false for every button —
// so all four render enabled, and one tap on "Done" fires the server's
// walk-back clause and destroys the clock stamps payroll needs. A stale label
// map renders the raw string 'clocked_out' in the badge instead of a label.
//
// Comparing against string literals (as an earlier version of this test did)
// only pins today's six stages — a seventh stage added to the server's
// CHECKLIST_STATUSES tomorrow and forgotten here would still pass. Compare
// against the server's actual exported array instead, so admin.html's copy
// is pinned to whatever the server currently says, not to a snapshot of it.
// Do NOT loosen this back to a literal comparison if it starts failing —
// failing is the point; go update the html file that drifted.
const { CHECKLIST_STATUSES: SERVER_CHECKLIST_STATUSES } = require('../netlify/functions/staff-assignments.js');

test('admin.html has one checklist array/label map, matching the server exactly', () => {
  const helpers = loadHelpers();
  // The vm context is a separate realm — its Array/Object are not === the
  // outer realm's, so deepStrictEqual sees even identical-looking arrays as
  // "not reference-equal" and fails. Round-trip through JSON, same as
  // balanceLinkAmounts() above, to compare values instead of realms.
  const CHECKLIST_STATUSES = JSON.parse(JSON.stringify(helpers.CHECKLIST_STATUSES));
  const CHECKLIST_LABELS = JSON.parse(JSON.stringify(helpers.CHECKLIST_LABELS));
  assert.deepStrictEqual(CHECKLIST_STATUSES, SERVER_CHECKLIST_STATUSES,
    'admin.html CHECKLIST_STATUSES has drifted from staff-assignments.js CHECKLIST_STATUSES');
  for (const stage of SERVER_CHECKLIST_STATUSES) {
    assert.ok(CHECKLIST_LABELS[stage], `admin.html CHECKLIST_LABELS is missing a label for '${stage}'`);
  }

  // No second, un-shared copy left anywhere else in the file.
  const arrays = HTML.match(/\[\s*'upcoming'\s*,[^\]]*\]/g) || [];
  assert.strictEqual(arrays.length, 1,
    `expected exactly one checklist array literal in admin.html, found ${arrays.length}: ${arrays.join(' | ')}`);
  const labelMaps = HTML.match(/\{\s*upcoming:\s*'[^']*'[\s\S]*?\}/g) || [];
  assert.strictEqual(labelMaps.length, 1,
    `expected exactly one checklist label map in admin.html, found ${labelMaps.length}: ${labelMaps.join(' | ')}`);
});

// staff-portal.html is an independent static page (no build step, cannot
// require admin.html or the server module) with its own third copy of the
// same list. It has no PURE HELPERS sentinel to lift code out of, so pull the
// array literal out of the file text directly and compare it the same way.
test('staff-portal.html checklist array matches the server exactly', () => {
  const portalHtml = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');
  const m = /const checklistStatuses\s*=\s*(\[[^\]]*\])/.exec(portalHtml);
  assert.ok(m, 'could not find checklistStatuses array in staff-portal.html');
  const stages = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepStrictEqual(stages, SERVER_CHECKLIST_STATUSES,
    'staff-portal.html checklistStatuses has drifted from staff-assignments.js CHECKLIST_STATUSES');
});

// Same rule as staff-portal.html's copy (IMPORTANT 5): clocking out must not
// take the report button away — a worker who taps Clock Out before submitting
// the report used to lose the button, and the only way back was stepping to
// `completed`, which NULLs clocked_out_at. Both end-of-gig states offer it,
// and a filed report is not asked for twice.
const { reportButtonVisible } = loadHelpers();

test('the post-gig report survives clocking out here too', () => {
  assert.strictEqual(reportButtonVisible({ checklist_status: 'completed' }), true);
  assert.strictEqual(reportButtonVisible({ checklist_status: 'clocked_out' }), true);
  assert.strictEqual(reportButtonVisible({ checklist_status: 'arrived' }), false);
  assert.strictEqual(reportButtonVisible({ checklist_status: 'clocked_out', survey_submitted_at: '2026-08-15T21:00:00Z' }), false);
});

// The spec asked that an adjusted log stay flagged as adjusted so a payroll run
// can show it. staff-assignments.js wrote clock_adjusted_at and payroll.js
// selected it, and nothing ever rendered it — a flag that existed only as a
// column. The preflight staff line is where a wage question gets asked.
test('the pay review marks hours a human corrected by hand', () => {
  const start = HTML.indexOf('const staffLines = ev.staff.map');
  assert.notStrictEqual(start, -1, 'preflight staff lines not found');
  const block = HTML.slice(start, HTML.indexOf('const evTotal', start));
  assert.match(block, /clock_adjusted/, 'the preflight line never reads the adjusted flag');
  assert.match(block, /corrected|adjusted by hand|hand-corrected/i,
    'nothing tells the reviewer the hours were corrected by hand');
});
