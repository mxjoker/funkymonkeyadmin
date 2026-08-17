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
  vm.runInContext(HTML.slice(a, b) + '\nout = { depositLinkAmount, balanceLinkAmounts, balanceLinkEligible, clockRowLabel, clockAdjustAllowed };', ctx);
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
// This asserts no four-entry copy of either shape remains, and any checklist
// array or label map admin.html does contain includes both new stages —
// so the next person who adds a stage cannot add it to only one copy.
test('admin.html has no stale four-stage checklist array or label map', () => {
  const arrays = HTML.match(/\[\s*'upcoming'\s*,[^\]]*\]/g) || [];
  assert.ok(arrays.length > 0, 'expected at least one checklist array in admin.html');
  for (const m of arrays) {
    assert.ok(!/^\[\s*'upcoming'\s*,\s*'on_my_way'\s*,\s*'arrived'\s*,\s*'completed'\s*\]$/.test(m),
      `stale four-stage checklist array still present: ${m}`);
    assert.ok(m.includes("'clocked_in'"), `checklist array missing clocked_in: ${m}`);
    assert.ok(m.includes("'clocked_out'"), `checklist array missing clocked_out: ${m}`);
  }

  const labelMaps = HTML.match(/\{\s*upcoming:\s*'[^']*'[\s\S]*?\}/g) || [];
  assert.ok(labelMaps.length > 0, 'expected at least one checklist label map in admin.html');
  for (const m of labelMaps) {
    assert.ok(m.includes('clocked_in:'), `checklist label map missing clocked_in: ${m}`);
    assert.ok(m.includes('clocked_out:'), `checklist label map missing clocked_out: ${m}`);
  }
});
