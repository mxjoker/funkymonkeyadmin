const { test } = require('node:test');
const assert = require('node:assert');
const { noClockDataSummary } = require('../netlify/functions/payroll.js');

// "Make non-adoption visible": if the whole team quietly stops clocking in,
// payroll pays estimates forever and says nothing, because no gig has clock
// data to be suspicious of (payableHours only warns when there IS clock data
// to be suspicious of). One aggregate line, not one per row — per-row noise
// would bury the two warnings that actually matter.

test('no line when every assignment had clock data', () => {
  assert.strictEqual(noClockDataSummary(0, 22), null);
});

// The denominator is byStaffBooking.size — one (staff, booking) group, i.e.
// one payment, not one raw staff_assignments row. Two roles for the same
// person on the same booking are one payment, so "assignments" overstated
// the count "assignments" implies; "payments" names what's actually counted.
test('one aggregate line naming both counts', () => {
  assert.strictEqual(
    noClockDataSummary(18, 22),
    '18 of 22 payments had no clock data; those were paid the estimate'
  );
});

test('singular payment reads grammatically', () => {
  assert.strictEqual(
    noClockDataSummary(1, 1),
    '1 of 1 payment had no clock data; that was paid the estimate'
  );
});
