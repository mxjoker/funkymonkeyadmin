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

// A stored pay type must be one of exactly two strings. Written as an array
// membership test, not an object lookup: a bare lookup on an object literal
// resolves prototype keys like 'constructor' as truthy, which is how a stage
// guard on this codebase was bypassed in August 2026.
const isValidPayType = (v) => typeof v === 'string' && PAY_TYPES.includes(v);

// A naive Math.round(n * 100) / 100 mis-rounds real inputs: 3.1 * 12.35 is really
// 38.285 (round half up -> 38.29), but JS stores the product as 38.284999999999996,
// so the naive rounder lands on 38.28 instead -- silent underpayment on an entirely
// ordinary rate and span, not an edge case (1.14h * $8.25 = 9.405 hits the same wall).
// Nudging by an epsilon far bigger than that floating noise (~1e-13 here) but far
// smaller than half a cent (0.005) pushes a genuine .xx5 boundary back over the line
// without moving anything that wasn't already sitting on one.
const round2 = (n) => Math.round((n + (n >= 0 ? 1 : -1) * 1e-9) * 100) / 100;

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
  // ponytail: any finite override is accepted here, negative included -- 0 is a
  // deliberate legitimate override (see above), so a blanket "reject non-positive"
  // guard would break that case too, and this module doesn't have enough context to
  // tell a correction from a mistake. The sign is validated at the API that stores
  // the override, not here; do not assume it's covered by this module.
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

// Everything one staff member is owed for one booking, as one payment.
//
// `assignments` is every row that person holds on that booking — usually one, but
// a performer who also drives is two. Each is resolved independently and the
// highest wins (Joe, 2026-08-17: "whichever is higher pay, once not doubled").
// An override on any of them wins outright; the per-gig override is the
// designated escape hatch for cases the higher-of rule gets wrong.
function paymentForBooking(assignments, rolePayByRole, staff, hours) {
  const list = Array.isArray(assignments) ? assignments : [];
  const candidates = list.map((a) => {
    const payType = resolvePayType(a.tag_filled, rolePayByRole, staff);
    const { amount, basis } = resolveAmount({ payType, hours, staff, override: a.pay_amount_override });
    return { amount, basis, payType, tag: a.tag_filled, isOverride: basis === 'per-gig override' };
  });
  // The override is the designated escape hatch for a gig the higher-of rule
  // prices wrong -- it has to beat the rule outright, not just compete inside
  // it as one more candidate. A $0 override on one role must still win over a
  // higher-paying second role. Two overrides on the same booking is a data
  // oddity, not a policy decision here: the highest of them wins.
  const overridden = candidates.filter((c) => c.isOverride);
  const pool = overridden.length ? overridden : candidates;
  const best = bestPayment(pool) || { amount: 0, basis: 'no assignment', payType: 'flat', tag: null };
  return {
    amount: best.amount, basis: best.basis, payType: best.payType,
    rolesFilled: list.map((a) => a.tag_filled).filter(Boolean),
  };
}

// The assign-time refusal message. payabilityError supplies "what is missing";
// this adds "who" and "which role", because a message that isn't actionable
// without going and looking is no better than the $0 line item it replaces.
function assignmentRefusal(staff, payType, roleName) {
  const why = payabilityError(payType, staff);
  if (!why) return null;
  const who = (staff && (staff.preferred_name || staff.name)) || 'This staff member';
  return `${who} ${why} (${roleName}). Set their rate on the staff record, then assign again.`;
}

module.exports = {
  PAY_TYPES, isValidPayType, resolvePayType, resolveAmount, bestPayment, payabilityError,
  paymentForBooking, assignmentRefusal,
};
