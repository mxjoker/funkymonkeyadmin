// Who gets paid what, and why.
//
// Pay TYPE is a property of the role: Foam Crew is hourly, Story Doodles is flat,
// and the same person is both depending on which they filled that day. Pay RATE
// stays a property of the person — Joe, 2026-08-17: "the flat rate is dependent
// on who works it more than what it is." So there is no rate matrix, and this
// module never reads a rate from anywhere but the staff row.
//
// Pure, no database: payroll.js pays from it and staff-assignments.js refuses an
// unpayable assignment from it, so the rules exist once.

const PAY_TYPES = ['hourly', 'flat'];

const round2 = (n) => Math.round(n * 100) / 100;

// A role with no row, or a stored value we do not recognise, falls through to the
// staff member's own setting — which is what every assignment did before role_pay
// existed. `|| 'flat'` mirrors payroll.js's own long-standing default.
function resolvePayType(roleName, rolePayByRole, staff) {
  const fromRole = roleName && rolePayByRole ? rolePayByRole[roleName] : null;
  if (PAY_TYPES.includes(fromRole)) return fromRole;
  const fromStaff = staff && staff.pay_type;
  return PAY_TYPES.includes(fromStaff) ? fromStaff : 'flat';
}

// An override is a deliberate figure for one gig and wins over everything. 0 is a
// legitimate override (an unpaid favour, a correction) so absence is tested as
// null/undefined/'' rather than falsiness — treating 0 as absent would silently
// pay the standard rate on a gig someone decided was free.
function resolveAmount({ payType, hours, staff, override }) {
  if (override !== null && override !== undefined && override !== '' && isFinite(Number(override))) {
    return { amount: round2(Number(override)), basis: 'per-gig override' };
  }
  const s = staff || {};
  if (payType === 'hourly') {
    const rate = Number(s.hourly_rate) || 0;
    return { amount: round2((Number(hours) || 0) * rate), basis: `${hours}h × $${rate.toFixed(2)}/hr` };
  }
  return { amount: round2(Number(s.flat_rate) || 0), basis: 'flat rate' };
}

// One person on one booking is paid once, at whichever role resolves higher.
// Before this, the hourly branch computed hours × rate per assignment row, so
// someone filling two roles was paid the whole span twice. The flat branch was
// already protected by the existing-payment check, which is why this only ever
// showed up on hourly staff.
function bestPayment(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return candidates.reduce((best, c) => (Number(c.amount) > Number(best.amount) ? c : best));
}

// Why an assignment cannot be paid, or null when it can. Returned at assignment
// time so the gap is visible while Joe is still choosing who works, rather than
// as a $0 line item after the week is over.
function payabilityError(payType, staff) {
  const s = staff || {};
  if (payType === 'hourly' && !(Number(s.hourly_rate) > 0)) {
    return 'has no hourly rate set, and this role pays hourly';
  }
  if (payType === 'flat' && !(Number(s.flat_rate) > 0)) {
    return 'has no flat rate set, and this role pays a flat fee';
  }
  return null;
}

module.exports = { PAY_TYPES, resolvePayType, resolveAmount, bestPayment, payabilityError };
