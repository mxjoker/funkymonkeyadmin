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

test('hourly pays hours times the person rate; flat pays the person flat rate', () => {
  assert.deepStrictEqual(resolveAmount({ payType: 'hourly', hours: 6, staff: STAFF }),
    { amount: 72, basis: '6h × $12.00/hr' });
  assert.deepStrictEqual(resolveAmount({ payType: 'flat', hours: 6, staff: STAFF }),
    { amount: 80, basis: 'flat rate' });
});

test('money is rounded to cents', () => {
  assert.strictEqual(resolveAmount({ payType: 'hourly', hours: 5.33, staff: { hourly_rate: 12.5 } }).amount, 66.63);
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
