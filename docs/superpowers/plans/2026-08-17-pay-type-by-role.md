# Pay Type By Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a role decide whether it pays hourly or flat, keep the rate on the person, pay one gig once at the higher of two roles, and refuse an assignment whose pay cannot be computed.

**Architecture:** A small `role_pay` table maps a role name to a pay type; a role with no row keeps today's behaviour of using the staff member's own setting. A new pure module `netlify/functions/_pay.js` owns the resolution rules so they can be tested without a database, and is consumed by `payroll.js` (which pays) and `staff-assignments.js` (which refuses an unpayable assignment). Payroll groups a staff member's assignments per booking and pays the highest resolution once, with a per-assignment override that wins outright.

**Tech Stack:** Node 18 CommonJS Netlify Functions, `pg` against Neon, `node --test` with `node:assert`, a static `admin.html` whose pure helpers are extracted into a `vm` context by tests.

## Global Constraints

- **A role with no `role_pay` row changes nothing.** Resolution falls through to `staff.pay_type`, which is today's behaviour. Every existing assignment must pay exactly what it pays now until a role is deliberately given a type.
- **The rate always comes from the person** — `staff.hourly_rate` or `staff.flat_rate`. Joe, 2026-08-17: *"the flat rate is dependent on who works it more than what it is."* There is no per-role and no per-person-per-role rate.
- **One person, one booking, one payment, at the higher resolution.** Joe: *"whichever is higher pay, once not doubled."* The hourly branch currently pays `hours × rate` per assignment row, so a person filling two roles is paid the full span twice — that is a live defect this plan fixes.
- **The per-gig override is the escape hatch** for cases the higher-of rule gets wrong, so it must be reachable in one click from the assignment card, not nested. Every override is written to `booking_changes` via `logChange` with both sides — it is a manual change to a wage.
- **An assignment whose pay cannot be computed is refused at assignment time**, naming the person and the missing rate. Nothing validates this today: `staff-assignments.js` contains no reference to `pay_type`, `hourly_rate` or `flat_rate`.
- **Hours come from the time clock and are not touched here.** `payableHours` in `_timeclock.js` still decides hours, and `Math.max(5, …)` still floors them.
- Tests run with `npm test` (`node --test 'test/**/*.test.js'`). Baseline on `main`: **454 passing, 0 failing**. That total may only go up.
- The design is `docs/superpowers/specs/2026-08-17-pay-type-by-role.md`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `netlify/functions/_pay.js` | Create | Pay-type resolution, amount resolution, the higher-of rule — pure, no DB |
| `netlify/functions/staff-assignments.js` | Modify | `role_pay` table; a `save_role_pay` admin action; refuse an unpayable assignment |
| `netlify/functions/payroll.js` | Modify: query `212-232`, loop `302-400`, insert `~490` | Join `role_pay`, group per (staff, booking), honour the override |
| `admin.html` | Modify: slot editor `~4532`, assignment card `~2206` | Role pay-type editor; override input |
| `test/pay-resolution.test.js` | Create | Resolution, the higher-of rule, the refusal predicate |

---

### Task 1: The resolution rules, in one pure module

**Files:**
- Create: `netlify/functions/_pay.js`
- Test: `test/pay-resolution.test.js` (create)

**Interfaces:**
- Produces:
  - `resolvePayType(roleName, rolePayByRole, staff) -> 'hourly' | 'flat'`
  - `resolveAmount({ payType, hours, staff, override }) -> { amount: number, basis: string }`
  - `bestPayment(candidates) -> candidate` — the higher-of rule
  - `payabilityError(payType, staff) -> string | null`
  Tasks 2-5 consume these.

- [ ] **Step 1: Write the failing test**

Create `test/pay-resolution.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pay-resolution.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_pay.js'`.

- [ ] **Step 3: Implement**

Create `netlify/functions/_pay.js`:

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, total above 454.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_pay.js test/pay-resolution.test.js
git commit -m "feat(pay): resolve pay type from the role and the rate from the person"
```

---

### Task 2: The `role_pay` table and its admin action

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (schema block near `193`; a new action beside `save_service_slots` at `670`)
- Test: `test/pay-resolution.test.js` (extend)

**Interfaces:**
- Consumes: `PAY_TYPES` from Task 1.
- Produces: table `role_pay (role_name PK, pay_type, updated_at)`; `GET /api/staff-assignments?role_pay=true` returning `{ role_pay: { [role_name]: pay_type } }`; `POST` with `action: 'save_role_pay'`, body `{ role_name, pay_type }` where `pay_type` is `'hourly'`, `'flat'` or `null` to clear. Admin only.

- [ ] **Step 1: Write the failing test**

Append to `test/pay-resolution.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pay-resolution.test.js`
Expected: FAIL — `isValidPayType is not a function`.

- [ ] **Step 3: Add the predicate**

In `_pay.js`, beside `PAY_TYPES`:

```js
// A stored pay type must be one of exactly two strings. Written as an array
// membership test, not an object lookup: a bare lookup on an object literal
// resolves prototype keys like 'constructor' as truthy, which is how a stage
// guard on this codebase was bypassed in August 2026.
const isValidPayType = (v) => typeof v === 'string' && PAY_TYPES.includes(v);
```

Export it.

- [ ] **Step 4: Create the table**

In `staff-assignments.js`'s schema block, beside `staff_slots` (~`193`):

```js
  // Pay type belongs to the role, not to the person and not to the service:
  // Foam Crew is hourly wherever it appears, Story Doodles is flat. Roles are not
  // stored anywhere else — skillTags() in admin.html derives the list at runtime
  // from SKILL_PRESETS plus whatever tags are in use — so this table carries the
  // pay decision only and deliberately does NOT try to become a role registry.
  // A role with no row here has no opinion, and resolution falls through to the
  // staff member's own pay_type, which is what every assignment did before this.
  await client.query(`
    CREATE TABLE IF NOT EXISTS role_pay (
      role_name  VARCHAR(100) PRIMARY KEY,
      pay_type   VARCHAR(20) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
```

- [ ] **Step 5: Add the read and the write**

Beside the `service_slots` GET branch (~`378`), add a `role_pay` branch returning the map:

```js
        if (params.role_pay) {
          const { rows } = await client.query('SELECT role_name, pay_type FROM role_pay');
          const map = {};
          for (const r of rows) map[r.role_name] = r.pay_type;
          return json(200, { role_pay: map });
        }
```

And beside `save_service_slots` (~`670`):

```js
        // Admin-only: set or clear a role's pay type. This decides whether every
        // future assignment to that role is paid by the hour or by the event, so
        // it is not a staff-editable field.
        if (action === 'save_role_pay') {
          const adminAuth = await requireAuth(event, ['admin']);
          if (!adminAuth) return unauthorized();

          const roleName = String(body.role_name || '').trim();
          if (!roleName || roleName.length > 100) return json(400, { error: 'role_name required' });

          // null clears the row; anything else must be one of the two real types.
          // An unrecognised value must be refused rather than stored, or
          // resolvePayType would silently fall through and the UI would show a
          // setting that does nothing.
          if (body.pay_type === null || body.pay_type === '') {
            await client.query('DELETE FROM role_pay WHERE role_name=$1', [roleName]);
            return json(200, { role_name: roleName, pay_type: null });
          }
          if (!isValidPayType(body.pay_type)) return json(400, { error: 'pay_type must be "hourly" or "flat"' });

          await client.query(
            `INSERT INTO role_pay (role_name, pay_type, updated_at) VALUES ($1,$2,NOW())
             ON CONFLICT (role_name) DO UPDATE SET pay_type=EXCLUDED.pay_type, updated_at=NOW()`,
            [roleName, body.pay_type]
          );
          return json(200, { role_name: roleName, pay_type: body.pay_type });
        }
```

Import `isValidPayType` from `./_pay` at the top of the file.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, total above Task 1's.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/staff-assignments.js netlify/functions/_pay.js test/pay-resolution.test.js
git commit -m "feat(pay): store a pay type per role, admin-only"
```

---

### Task 3: Payroll resolves by role, pays once, honours the override

**Files:**
- Modify: `netlify/functions/payroll.js` (schema `~50`, query `212-232`, loop `302-400`)
- Test: `test/pay-resolution.test.js` (extend)

**Interfaces:**
- Consumes: `resolvePayType`, `resolveAmount`, `bestPayment` from Task 1.
- Produces: `staff_assignments.pay_amount_override` column; each `paymentsToCreate` entry gains `pay_basis` and `roles_filled` (array of tag names).

**The behaviour that must not change:** an assignment whose role has no `role_pay` row, whose staff member has one assignment on that booking, and which has no override, must produce byte-identical output to today.

- [ ] **Step 1: Write the failing test**

Append to `test/pay-resolution.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pay-resolution.test.js`
Expected: FAIL — `paymentForBooking is not a function`.

- [ ] **Step 3: Add the grouping function to `_pay.js`**

```js
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
    return { amount, basis, payType, tag: a.tag_filled };
  });
  const best = bestPayment(candidates) || { amount: 0, basis: 'no assignment', payType: 'flat', tag: null };
  return {
    amount: best.amount, basis: best.basis, payType: best.payType,
    rolesFilled: list.map((a) => a.tag_filled).filter(Boolean),
  };
}
```

Export it.

- [ ] **Step 4: Add the override column and the join**

In `payroll.js`'s `ensureTables`, beside the columns it already guarantees:

```js
    // The escape hatch for a gig the higher-of rule prices wrong. Guaranteed here
    // because this is the function that reads it — a reader depending on another
    // module's migrations is a deploy-order bug, which this file already hit once.
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pay_amount_override NUMERIC(10,2)",
```

In the assignments query, add `sa.pay_amount_override` to the SELECT list. Load the role map once before the loop:

```js
          const { rows: rolePayRows } = await client.query('SELECT role_name, pay_type FROM role_pay');
          const rolePayByRole = {};
          for (const r of rolePayRows) rolePayByRole[r.role_name] = r.pay_type;
```

- [ ] **Step 5: Group the loop by (staff, booking)**

The loop currently iterates assignments one at a time and computes `amount` per row. Group first:

```js
          // One person on one booking is one payment, however many roles they
          // filled. Iterating raw assignment rows paid an hourly staff member the
          // whole span once per role.
          const byStaffBooking = new Map();
          for (const a of assignments) {
            const key = `${a.staff_id}:${a.booking_id}`;
            if (!byStaffBooking.has(key)) byStaffBooking.set(key, []);
            byStaffBooking.get(key).push(a);
          }
```

Then iterate `byStaffBooking.values()`, using the first row for the booking and staff fields (they are identical across the group), computing `totalHours` exactly as now, and replacing the `payType`/`amount` block with:

```js
            const paid = paymentForBooking(group, rolePayByRole, a, totalHours);
            const payType = paid.payType;
            const amount = existingPayment.length > 0 && payType === 'flat' && paid.basis === 'flat rate'
              ? null : paid.amount;
```

Keep the existing `$0` warning, and add `pay_basis: paid.basis` and `roles_filled: paid.rolesFilled` to the pushed object.

**Read the surrounding loop carefully before editing** — `existingPayment`, the `dryRun` branch and the `staff_assignments` update all sit inside it and must keep working per group rather than per row.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, total above Task 2's.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/payroll.js netlify/functions/_pay.js test/pay-resolution.test.js
git commit -m "fix(payroll): pay one gig once at the higher role, never the same hours twice"
```

---

### Task 4: Refuse an assignment that cannot be paid

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (the assign action at `~715`)
- Test: `test/pay-resolution.test.js` (extend)

**Interfaces:**
- Consumes: `resolvePayType`, `payabilityError` from Task 1.

- [ ] **Step 1: Write the failing test**

The assign action needs a database, so test the message builder:

```js
const { assignmentRefusal } = require('../netlify/functions/_pay.js');

test('the refusal names the person and what is missing', () => {
  const m = assignmentRefusal({ name: 'Noah Drews', preferred_name: 'Noah', hourly_rate: 0 }, 'hourly', 'Foam Crew');
  assert.match(m, /Noah/);
  assert.match(m, /Foam Crew/);
  assert.match(m, /hourly rate/i);
});

test('a payable assignment produces no refusal', () => {
  assert.strictEqual(assignmentRefusal({ name: 'A', hourly_rate: 12 }, 'hourly', 'Foam Crew'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pay-resolution.test.js`
Expected: FAIL — `assignmentRefusal is not a function`.

- [ ] **Step 3: Implement and wire it**

In `_pay.js`:

```js
function assignmentRefusal(staff, payType, roleName) {
  const why = payabilityError(payType, staff);
  if (!why) return null;
  const who = (staff && (staff.preferred_name || staff.name)) || 'This staff member';
  return `${who} ${why} (${roleName}). Set their rate on the staff record, then assign again.`;
}
```

In the assign action, after the booking and staff rows are loaded and before the INSERT: resolve the pay type for `tag_filled` from `role_pay`, call `assignmentRefusal`, and `return json(400, { error })` when it is non-null. Comment that this is deliberately at assignment time — the previous signal was a `$0` line item discovered after the week was over.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test`
Expected: PASS, total above Task 3's.

```bash
git add netlify/functions/staff-assignments.js netlify/functions/_pay.js test/pay-resolution.test.js
git commit -m "feat(staff): refuse an assignment whose pay cannot be computed"
```

---

### Task 5: The admin controls

**Files:**
- Modify: `admin.html` (slot editor row `~4532`; assignment card `~2206`)
- Test: `test/admin-link-buttons.test.js` (extend)

**Interfaces:**
- Consumes: the `role_pay` GET and `save_role_pay` action from Task 2; `pay_amount_override` from Task 3.

- [ ] **Step 1: Add the role pay-type editor**

The slot editor renders a row per (service, role) with a tag select and a count (`slotRowHtml`, `~4532`). The pay type belongs to the **role**, not the row, so it does not go there — a per-role setting edited in five slot rows would let one role hold five contradictory values.

Put it where roles are managed: the skill-tag panel (`~4650`, which already splits exclusive and stackable tags). Each tag chip gains a small three-way select — *hourly*, *flat*, *(use staff setting)* — calling `saveRolePay(roleName, payType)`.

```js
async function saveRolePay(roleName, payType) {
  try {
    const res = await apiFetch('/api/staff-assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_role_pay', role_name: roleName,
                             pay_type: payType === '' ? null : payType })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
    allRolePay = { ...allRolePay, [roleName]: payType || undefined };
  } catch (e) { alert('Could not save pay type: ' + e.message); }
}
```

Load `allRolePay` alongside `allServiceSlots` from `/api/staff-assignments?role_pay=true`.

- [ ] **Step 2: Add the per-gig override**

On the assignment card, beside the clock block, a single number input bound to `pay_amount_override`, blank by default with the resolved amount as placeholder, saved through the existing assignment PATCH path. It is the designated escape hatch for the higher-of rule, so it must be visible on the card itself, not behind a disclosure.

Log every change to `booking_changes` via `logChange` with both sides, the same as a clock adjustment — it is a manual change to a wage.

- [ ] **Step 3: Test the label logic**

Add a pure helper for what the card displays — `payLabel(assignment, rolePay, staff)` returning e.g. `hourly · $12.00/hr` or `flat · $80.00` or `override · $150.00` — put it in the pure-helper block, add it to `loadHelpers()`'s `out`, and test the three cases plus the fall-through.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test`
Expected: PASS, total above Task 4's.

```bash
git add admin.html test/admin-link-buttons.test.js
git commit -m "feat(admin): set a role's pay type, and override one gig's pay"
```

---

## What no test here can cover, and what must happen before anyone is paid

Every test in this plan is pure arithmetic. Nothing exercises a database, the payroll query, or the admin page.

- [ ] **Before seeding any role:** run a payroll preflight over a recent week and save the output. It writes nothing.
- [ ] Seed the roles Joe confirmed — **flat** for performance shows, professor buckets, story doodles, balloon twisting and magic shows; **hourly** for foam parties — reading the real service and role names from the live database, not from `DEFAULT_SERVICES` in `services.js`, which has drifted before.
- [ ] **Run the preflight again and diff it line by line.** Every difference must be one Joe recognises as the correction he asked for. This is the step that catches a role name typo, which would otherwise silently fall through to the staff member's setting and look like nothing happened.
- [ ] Find a booking where one person holds two roles and confirm they now appear once, at the higher figure. If no such booking exists in the range, make one on a test booking.
- [ ] Try to assign someone with no hourly rate to an hourly role and confirm the refusal names them and the missing rate.
- [ ] Set a per-gig override, re-run the preflight, and confirm the override figure survives and the change is in that booking's activity log.
