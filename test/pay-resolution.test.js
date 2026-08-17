const { test } = require('node:test');
const assert = require('node:assert');
const { resolvePayType, resolveAmount, bestPayment, payabilityError } =
  require('../netlify/functions/_pay.js');

const STAFF = { pay_type: 'hourly', hourly_rate: 12, flat_rate: 80 };

// A role with no row must behave exactly as the system does today.
test('a role with no pay type falls through to the staff member', () => {
  assert.strictEqual(resolvePayType('Foam Crew', {}, STAFF), 'hourly');
  assert.strictEqual(resolvePayType('Foam Crew', {}, { pay_type: 'flat' }), 'flat');
  assert.strictEqual(resolvePayType('Foam Crew', { 'Other Role': 'flat' }, STAFF), 'hourly');
});

test('a role with a pay type overrides the staff member', () => {
  assert.strictEqual(resolvePayType('Story Doodles', { 'Story Doodles': 'flat' }, STAFF), 'flat');
  assert.strictEqual(resolvePayType('Foam Crew', { 'Foam Crew': 'hourly' }, { pay_type: 'flat' }), 'hourly');
});

// Same person, two roles, two different answers — the whole point of the change.
test('one person can be hourly on one role and flat on another', () => {
  const map = { 'Foam Crew': 'hourly', 'Story Doodles': 'flat' };
  assert.strictEqual(resolvePayType('Foam Crew', map, STAFF), 'hourly');
  assert.strictEqual(resolvePayType('Story Doodles', map, STAFF), 'flat');
});

test('an unrecognised stored value falls through rather than inventing a type', () => {
  assert.strictEqual(resolvePayType('X', { X: 'weekly' }, STAFF), 'hourly');
  assert.strictEqual(resolvePayType(null, {}, STAFF), 'hourly');
  assert.strictEqual(resolvePayType('X', {}, {}), 'flat', 'no staff pay_type should default to flat, as payroll.js:388 does');
});

// A future edit that swaps the PAY_TYPES.includes allowlist for a truthiness or
// hasOwnProperty check would let a role name reach into Object.prototype and pass
// this suite silently. This codebase has been bitten by exactly that shape before.
test('prototype-chain role names fall through to the staff setting, not the prototype', () => {
  assert.strictEqual(resolvePayType('__proto__', {}, STAFF), 'hourly');
  assert.strictEqual(resolvePayType('constructor', {}, STAFF), 'hourly');
  assert.strictEqual(resolvePayType('toString', {}, STAFF), 'hourly');
});

test('hourly pays hours times the person rate; flat pays the person flat rate', () => {
  assert.deepStrictEqual(resolveAmount({ payType: 'hourly', hours: 6, staff: STAFF }),
    { amount: 72, basis: '6h × $12.00/hr' });
  assert.deepStrictEqual(resolveAmount({ payType: 'flat', hours: 6, staff: STAFF }),
    { amount: 80, basis: 'flat rate' });
});

test('money is rounded to cents', () => {
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 5.33, staff: { hourly_rate: 12.5 } }).amount, 66.63);
});

// 3.1 * 12.35 is really 38.285 (round half up -> 38.29), but the naive
// Math.round(n * 100) / 100 stores the product as 38.284999999999996 and rounds
// it down to 38.28 -- silent underpayment on an entirely ordinary rate and span.
test('a realistic hourly product does not lose a cent to floating point', () => {
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 3.1, staff: { hourly_rate: 12.35 } }).amount, 38.29);
});

// Hand-verified: 1.14h * $8.25 = 9.405 exactly, which rounds up to 9.41. The naive
// rounder gives 9.40 here too (Math.round(1.14 * 8.25 * 100) / 100 === 9.4) -- this
// is not a one-off; ordinary rate/span pairs land on a floating .xx5 boundary often
// enough to be a live payroll risk, not an edge case.
test('a spread of realistic rate/span pairs round correctly, including a second naive-rounder failure', () => {
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 1.14, staff: { hourly_rate: 8.25 } }).amount, 9.41);
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 1.1, staff: { hourly_rate: 8.55 } }).amount, 9.41);
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 6.5, staff: { hourly_rate: 14.15 } }).amount, 91.98);
});

test('an override wins outright and says so', () => {
  const r = resolveAmount({ payType: 'hourly', hours: 6, staff: STAFF, override: 150 });
  assert.strictEqual(r.amount, 150);
  assert.match(r.basis, /override/i);
});

test('a zero override is a real decision, not an absent one', () => {
  assert.strictEqual(resolveAmount({ payType: 'flat', hours: 6, staff: STAFF, override: 0 }).amount, 0);
  assert.strictEqual(resolveAmount({ payType: 'flat', hours: 6, staff: STAFF, override: null }).amount, 80);
  assert.strictEqual(resolveAmount({ payType: 'flat', hours: 6, staff: STAFF, override: '' }).amount, 80);
});

// Joe, 2026-08-17: "whichever is higher pay, once not doubled."
test('two roles on one booking pay once, at the higher figure', () => {
  const best = bestPayment([
    { amount: 72, payType: 'hourly', tag: 'Foam Crew' },
    { amount: 80, payType: 'flat',   tag: 'Story Doodles' },
  ]);
  assert.strictEqual(best.amount, 80);
  assert.strictEqual(best.tag, 'Story Doodles');
});

test('the higher-of rule is stable when both roles pay the same', () => {
  const best = bestPayment([
    { amount: 80, payType: 'flat', tag: 'A' },
    { amount: 80, payType: 'flat', tag: 'B' },
  ]);
  assert.strictEqual(best.tag, 'A', 'a tie must resolve to the first candidate, not vary');
});

test('a single role is returned unchanged', () => {
  const only = { amount: 72, payType: 'hourly', tag: 'Foam Crew' };
  assert.strictEqual(bestPayment([only]), only);
});

test('no candidates is null, not a crash', () => {
  assert.strictEqual(bestPayment([]), null);
  assert.strictEqual(bestPayment(null), null);
});

// The assignment-time refusal. Joe believed this already existed; it did not.
test('an hourly role with no hourly rate is refused, naming the rate', () => {
  const e = payabilityError('hourly', { hourly_rate: 0, flat_rate: 80 });
  assert.match(e, /hourly rate/i);
  assert.strictEqual(payabilityError('hourly', { hourly_rate: null }), payabilityError('hourly', { hourly_rate: 0 }));
});

test('a flat role with no flat rate is refused too', () => {
  assert.match(payabilityError('flat', { flat_rate: 0, hourly_rate: 12 }), /flat rate/i);
});

test('a payable combination returns null', () => {
  assert.strictEqual(payabilityError('hourly', { hourly_rate: 12 }), null);
  assert.strictEqual(payabilityError('flat', { flat_rate: 80 }), null);
});

const { isValidPayType } = require('../netlify/functions/_pay.js');

test('only the two real pay types are storable', () => {
  assert.strictEqual(isValidPayType('hourly'), true);
  assert.strictEqual(isValidPayType('flat'), true);
  for (const bad of ['weekly', 'HOURLY', '', 'constructor', '__proto__', 42, {}, [], undefined]) {
    assert.strictEqual(isValidPayType(bad), false, `${JSON.stringify(bad)} was accepted`);
  }
});

// null is how a role's opinion is removed, and must be distinguishable from junk.
test('null is a valid instruction to clear, and is not a pay type', () => {
  assert.strictEqual(isValidPayType(null), false);
});

const { paymentForBooking } = require('../netlify/functions/_pay.js');

const HOURLY = { pay_type: 'hourly', hourly_rate: 12, flat_rate: 80 };

test('one role, no role_pay row, no override — identical to the old behaviour', () => {
  const p = paymentForBooking([{ tag_filled: 'Foam Crew', pay_amount_override: null }], {}, HOURLY, 6);
  assert.strictEqual(p.amount, 72);
  assert.strictEqual(p.payType, 'hourly');
  assert.deepStrictEqual(p.rolesFilled, ['Foam Crew']);
});

// The live defect: hourly staff on two roles were paid the whole span twice.
test('two roles pay once, at the higher figure', () => {
  const p = paymentForBooking(
    [{ tag_filled: 'Foam Crew', pay_amount_override: null },
     { tag_filled: 'Story Doodles', pay_amount_override: null }],
    { 'Foam Crew': 'hourly', 'Story Doodles': 'flat' }, HOURLY, 6);
  assert.strictEqual(p.amount, 80, 'should pay the higher of $72 hourly and $80 flat, once');
  assert.deepStrictEqual(p.rolesFilled.sort(), ['Foam Crew', 'Story Doodles']);
});

test('two hourly roles are never paid twice for the same hours', () => {
  const p = paymentForBooking(
    [{ tag_filled: 'A', pay_amount_override: null }, { tag_filled: 'B', pay_amount_override: null }],
    { A: 'hourly', B: 'hourly' }, HOURLY, 6);
  assert.strictEqual(p.amount, 72, 'the span was paid twice');
});

test('an override on any role wins for the booking', () => {
  const p = paymentForBooking(
    [{ tag_filled: 'Foam Crew', pay_amount_override: null },
     { tag_filled: 'Story Doodles', pay_amount_override: 200 }],
    { 'Foam Crew': 'hourly', 'Story Doodles': 'flat' }, HOURLY, 6);
  assert.strictEqual(p.amount, 200);
  assert.match(p.basis, /override/i);
});

test('hours still come from the caller, so the time clock and the 5h floor are untouched', () => {
  const p = paymentForBooking([{ tag_filled: 'A', pay_amount_override: null }], { A: 'hourly' }, HOURLY, 5);
  assert.strictEqual(p.amount, 60);
});
