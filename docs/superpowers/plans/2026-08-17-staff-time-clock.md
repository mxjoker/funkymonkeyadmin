# Staff Time Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the day-of checklist double as a time clock — two new stages bracketing the three that exist — and let payroll pay measured hours instead of estimated ones when the record is complete and sane.

**Architecture:** `gig_logs` already stamps a timestamp per checklist stage. Add `clocked_in_at` and `clocked_out_at` at the ends of the same ordered array, so the existing walk-backwards clearing logic covers them for free. A new pure module `netlify/functions/_timeclock.js` owns the arithmetic and the usability rules; `payroll.js` and the admin UI both consume it. Payroll prefers a measured span, falls back to today's estimate whenever the record is incomplete or implausible, and warns every time it falls back.

**Tech Stack:** Node 18 CommonJS Netlify Functions, `pg` against Neon, `node --test` with `node:assert`, static HTML portal and admin pages whose pure helpers are extracted into a `vm` context by tests.

## Global Constraints

- **The 5-hour minimum is untouched.** `Math.max(5, hours)` in `payroll.js:319` still wraps whatever number comes out, measured or estimated.
- **A measured span is used only when it is complete and sane:** `clocked_in_at` and `clocked_out_at` both present, out after in, and the span at most **16 hours** (`MAX_SHIFT_HOURS`). Anything else falls back to the estimate **and** appends a line to payroll's existing `warnings` array naming the staff member and the booking reference.
- **Never pay a measured span that fails those rules.** A forgotten clock-out produces an enormous believable number; paying it silently overpays. Falling back is wrong in the safe direction and it is loud. See the `silent-failure-bug-class` memory.
- **Flat-rate staff:** hours are recorded and displayed, but `amount` stays `flat_rate`. Do not make a flat-rate payment depend on hours.
- **Staff never edit a timestamp.** They tap stages in real time. Adjustments are admin-only and every one is written to `booking_changes` via `logChange`.
- **Stage order is the single source of truth:** `CHECKLIST_STATUSES` in `staff-assignments.js`. Column names come from the fixed `CHECKLIST_TS_COLS` map and never from a request — that rule already exists at `staff-assignments.js:891` and must survive.
- Existing `gig_logs` rows have neither new column. Every one of them must keep paying exactly what it pays today.
- Tests run with `npm test` (`node --test 'test/**/*.test.js'`). Baseline on `main`: **385 passing, 0 failing**. That total may only go up.
- The design this implements is `docs/superpowers/specs/2026-08-17-staff-time-clock.md`, whose open questions are unanswered — do not invent answers beyond what this plan states.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `netlify/functions/_timeclock.js` | Create | The clock's arithmetic and usability rules — pure, no DB |
| `netlify/functions/staff-assignments.js` | Modify: `220-241` schema, `265-272` migrations, `891-902` stage machine, new action near `490` | Two columns, five stages, the admin `adjust_clock` action |
| `netlify/functions/payroll.js` | Modify: `212-232` query, `299-360` computation | Prefer measured hours, warn on fallback |
| `staff-portal.html` | Modify: `447-486` | Two more checklist buttons |
| `admin.html` | Modify: `renderAssignmentCard` (~`2206`) | Editable timestamps, measured vs estimated |
| `test/timeclock.test.js` | Create | Clock arithmetic and fallback rules |
| `test/checklist-stages.test.js` | Create | Five-stage ordering and backwards clearing |

---

### Task 1: Five stages, two columns

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (`gig_logs` CREATE at `220-241`; the `migrations` array at `265-272`; `CHECKLIST_STATUSES` / `CHECKLIST_TS_COLS` at `892-893`)
- Test: `test/checklist-stages.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `CHECKLIST_STATUSES = ['clocked_in','on_my_way','arrived','completed','clocked_out']` and `CHECKLIST_TS_COLS` mapping each to its column, both exported from `staff-assignments.js` alongside `buildChecklistTimestampClause`. Tasks 2-6 depend on this order.

**The `upcoming` problem — read before writing code.** Today the array starts with `upcoming`, whose timestamp column is `null` (it is the "not started" state, not an event). The new first stage `clocked_in` must sit *after* `upcoming`, not replace it: a gig nobody has started is still `upcoming`, and `gig_logs.status` defaults to it. So the array becomes six entries, five of which stamp:

```js
const CHECKLIST_STATUSES = ['upcoming', 'clocked_in', 'on_my_way', 'arrived', 'completed', 'clocked_out'];
const CHECKLIST_TS_COLS = {
  upcoming: null,
  clocked_in: 'clocked_in_at',
  on_my_way: 'on_my_way_at',
  arrived: 'arrived_at',
  completed: 'completed_at',
  clocked_out: 'clocked_out_at',
};
```

- [ ] **Step 1: Write the failing test**

Create `test/checklist-stages.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { CHECKLIST_STATUSES, CHECKLIST_TS_COLS, buildChecklistTimestampClause } =
  require('../netlify/functions/staff-assignments.js');

test('the clock brackets the three stages that already existed', () => {
  assert.deepStrictEqual(CHECKLIST_STATUSES,
    ['upcoming', 'clocked_in', 'on_my_way', 'arrived', 'completed', 'clocked_out']);
});

// 'upcoming' is the not-started state, not an event. It must keep stamping nothing.
test('upcoming stamps no column', () => {
  assert.strictEqual(CHECKLIST_TS_COLS.upcoming, null);
  const clause = buildChecklistTimestampClause('upcoming');
  assert.ok(!clause.includes('=NOW()'), 'upcoming set a timestamp');
});

test('every other stage stamps its own column', () => {
  assert.match(buildChecklistTimestampClause('clocked_in'), /clocked_in_at=NOW\(\)/);
  assert.match(buildChecklistTimestampClause('clocked_out'), /clocked_out_at=NOW\(\)/);
});

// The walk-backwards rule the file already documents: stepping back must clear
// every later stamp, or the timestamps contradict the status they describe.
test('stepping back to arrived clears everything after it', () => {
  const clause = buildChecklistTimestampClause('arrived');
  assert.match(clause, /arrived_at=NOW\(\)/);
  assert.match(clause, /completed_at=NULL/);
  assert.match(clause, /clocked_out_at=NULL/);
  assert.ok(!/clocked_in_at=NULL/.test(clause), 'cleared a stamp that came earlier');
  assert.ok(!/on_my_way_at=NULL/.test(clause), 'cleared a stamp that came earlier');
});

test('clocking out clears nothing — it is the last stage', () => {
  const clause = buildChecklistTimestampClause('clocked_out');
  assert.ok(!clause.includes('NULL'), 'the final stage cleared something');
});

test('stepping all the way back to upcoming clears all five stamps', () => {
  const clause = buildChecklistTimestampClause('upcoming');
  for (const col of ['clocked_in_at','on_my_way_at','arrived_at','completed_at','clocked_out_at']) {
    assert.match(clause, new RegExp(`${col}=NULL`), `${col} not cleared`);
  }
});

// Column names must never come from a caller.
test('an unknown status produces no SQL at all', () => {
  assert.strictEqual(buildChecklistTimestampClause('drop table'), '');
  assert.strictEqual(buildChecklistTimestampClause(''), '');
  assert.strictEqual(buildChecklistTimestampClause(undefined), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/checklist-stages.test.js`
Expected: FAIL — the exports do not exist, and the array is the old four.

- [ ] **Step 3: Extend the stage machine**

In `staff-assignments.js`, replace the two constants at `892-893` with the six-entry versions shown above. Leave `buildChecklistTimestampClause` itself unchanged — it derives everything from the array and needs no edit.

Add to the bottom of the file, beside any existing exports:

```js
// Exported for tests. The stage order is the contract payroll.js and both
// front ends read; a change here changes what "worked" means.
module.exports.CHECKLIST_STATUSES = CHECKLIST_STATUSES;
module.exports.CHECKLIST_TS_COLS = CHECKLIST_TS_COLS;
module.exports.buildChecklistTimestampClause = buildChecklistTimestampClause;
```

**Check before writing:** if the file already has a `module.exports = { ... }` block, add these to it rather than creating a second assignment that would overwrite the handler export. Read the end of the file first.

- [ ] **Step 4: Add the columns**

In the `gig_logs` CREATE TABLE (`220-241`), add beside the other timestamps:

```sql
      clocked_in_at TIMESTAMPTZ,
      clocked_out_at TIMESTAMPTZ,
      clock_adjusted_at TIMESTAMPTZ,
```

And to the `migrations` array (`265-272`), so existing databases get them:

```js
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_in_at TIMESTAMPTZ",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_out_at TIMESTAMPTZ",
    // Set whenever an admin edits a stamp, so a payroll run can show that the
    // hours it paid were corrected by hand rather than tapped by the worker.
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clock_adjusted_at TIMESTAMPTZ",
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, total above 385. Existing `staff-assignments` tests must be unaffected — if any assert the old four-stage array, that is a real signal: read them and report before changing them.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/staff-assignments.js test/checklist-stages.test.js
git commit -m "feat(timeclock): bracket the day-of checklist with clock-in and clock-out"
```

---

### Task 2: The clock's arithmetic

**Files:**
- Create: `netlify/functions/_timeclock.js`
- Test: `test/timeclock.test.js` (create)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `MAX_SHIFT_HOURS` (number, `16`)
  - `workedHours(log) -> { usable: boolean, hours: number|null, reason: string|null }`
  - `clockSegments(log) -> { loading, driveOut, onSite, driveBackAndUnload }` — each minutes or `null`
  Both take a `gig_logs` row. Tasks 3 and 6 consume them.

- [ ] **Step 1: Write the failing test**

Create `test/timeclock.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { workedHours, clockSegments, MAX_SHIFT_HOURS } = require('../netlify/functions/_timeclock.js');

const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 15, h, m)).toISOString();

test('a complete record measures the span from clock-in to clock-out', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(15, 30) });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, 6.5);
  assert.strictEqual(r.reason, null);
});

test('hours are rounded to two places, like the estimate they replace', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(14, 20) });
  assert.strictEqual(r.hours, 5.33);
});

// Each of these must fall back to the estimate rather than pay a number.
test('an incomplete record is not usable, and says why', () => {
  for (const [log, expect] of [
    [{ clocked_in_at: at(9), clocked_out_at: null }, /clock-out/i],
    [{ clocked_in_at: null, clocked_out_at: at(15) }, /clock-in/i],
    [{}, /clock-in/i],
    [null, /clock-in/i],
  ]) {
    const r = workedHours(log);
    assert.strictEqual(r.usable, false, `${JSON.stringify(log)} was treated as usable`);
    assert.strictEqual(r.hours, null);
    assert.match(r.reason, expect);
  }
});

test('a backwards pair is not usable', () => {
  const r = workedHours({ clocked_in_at: at(15), clocked_out_at: at(9) });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, /before/i);
});

test('a zero-length span is not usable', () => {
  const r = workedHours({ clocked_in_at: at(9), clocked_out_at: at(9) });
  assert.strictEqual(r.usable, false);
});

// The forgotten clock-out. Paying this silently overpays by hundreds.
test('a span beyond the cap is not usable and names the cap', () => {
  const r = workedHours({ clocked_in_at: at(8), clocked_out_at: new Date(Date.UTC(2026, 7, 16, 9)).toISOString() });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, new RegExp(String(MAX_SHIFT_HOURS)));
});

test('exactly the cap is still usable — the boundary is inclusive', () => {
  const r = workedHours({ clocked_in_at: at(0), clocked_out_at: new Date(Date.UTC(2026, 7, 15, MAX_SHIFT_HOURS)).toISOString() });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, MAX_SHIFT_HOURS);
});

test('garbage timestamps are not usable', () => {
  const r = workedHours({ clocked_in_at: 'not a date', clocked_out_at: at(15) });
  assert.strictEqual(r.usable, false);
});

// pg returns TIMESTAMPTZ as a Date object, not a string.
test('Date objects work as well as ISO strings', () => {
  const r = workedHours({ clocked_in_at: new Date(at(9)), clocked_out_at: new Date(at(12)) });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.hours, 3);
});

test('segments decompose the day into the estimate\'s four parts', () => {
  const s = clockSegments({
    clocked_in_at: at(9), on_my_way_at: at(9, 30), arrived_at: at(10),
    completed_at: at(14), clocked_out_at: at(15),
  });
  assert.deepStrictEqual(s, { loading: 30, driveOut: 30, onSite: 240, driveBackAndUnload: 60 });
});

test('a missing stamp makes only its own segment null', () => {
  const s = clockSegments({ clocked_in_at: at(9), on_my_way_at: null, arrived_at: at(10), completed_at: at(14), clocked_out_at: at(15) });
  assert.strictEqual(s.loading, null);
  assert.strictEqual(s.driveOut, null);
  assert.strictEqual(s.onSite, 240);
  assert.strictEqual(s.driveBackAndUnload, 60);
});

test('a backwards segment reads null rather than negative minutes', () => {
  const s = clockSegments({ clocked_in_at: at(10), on_my_way_at: at(9) });
  assert.strictEqual(s.loading, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/timeclock.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_timeclock.js'`.

- [ ] **Step 3: Implement**

Create `netlify/functions/_timeclock.js`:

```js
// The day-of checklist doubles as a time clock: gig_logs stamps a timestamp per
// stage, and clocked_in_at → clocked_out_at is the worked span.
//
// This module is pure and has no database. payroll.js pays from it and the admin
// page displays from it, so the rules about what counts as a usable record live
// in exactly one place.

// A span longer than this is a forgotten clock-out, not a shift. Paying it would
// silently overpay by hundreds of dollars, and a wrong-but-believable number in
// a money path is this codebase's documented recurring failure — so an
// over-long span is refused and payroll falls back to its estimate, loudly.
//
// ponytail: a constant, not a per-staff setting. If a legitimate gig ever runs
// longer, raise it here rather than inventing a policy table.
const MAX_SHIFT_HOURS = 16;

// pg hands back TIMESTAMPTZ as a Date; the admin page and tests hand back ISO
// strings. Both must work, and anything unparseable must read as absent rather
// than as NaN, which compares false against everything and would slip through.
function ms(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

function workedHours(log) {
  const inMs  = ms(log && log.clocked_in_at);
  const outMs = ms(log && log.clocked_out_at);
  if (inMs === null)  return { usable: false, hours: null, reason: 'no clock-in recorded' };
  if (outMs === null) return { usable: false, hours: null, reason: 'no clock-out recorded' };
  if (outMs <= inMs)  return { usable: false, hours: null, reason: 'clock-out is not after clock-in' };
  const hours = round2((outMs - inMs) / 3600000);
  if (hours > MAX_SHIFT_HOURS) {
    return { usable: false, hours: null, reason: `${hours}h exceeds the ${MAX_SHIFT_HOURS}h maximum — likely a missed clock-out` };
  }
  return { usable: true, hours, reason: null };
}

// The same four segments payroll estimates, measured. A segment whose ends are
// not both present, or which runs backwards, reads null — never a negative or a
// guess, so a partial record degrades one row at a time instead of poisoning the
// whole comparison.
function clockSegments(log) {
  const gap = (a, b) => {
    const from = ms(log && log[a]);
    const to   = ms(log && log[b]);
    if (from === null || to === null || to < from) return null;
    return Math.round((to - from) / 60000);
  };
  return {
    loading:            gap('clocked_in_at', 'on_my_way_at'),
    driveOut:           gap('on_my_way_at', 'arrived_at'),
    onSite:             gap('arrived_at', 'completed_at'),
    driveBackAndUnload: gap('completed_at', 'clocked_out_at'),
  };
}

module.exports = { MAX_SHIFT_HOURS, workedHours, clockSegments };
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, total above Task 1's.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_timeclock.js test/timeclock.test.js
git commit -m "feat(timeclock): the worked-span rules, in one pure module"
```

---

### Task 3: Payroll pays measured hours when it can

**Files:**
- Modify: `netlify/functions/payroll.js` (the assignments query at `212-232`; the computation loop at `302-360`)
- Test: `test/timeclock.test.js` (extend)

**Interfaces:**
- Consumes: `workedHours` from Task 2.
- Produces: each element of `paymentsToCreate` gains `hours_source` (`'measured'` or `'estimated'`) and `measured_hours` (number or `null`). The preflight payload's per-staff objects gain the same two fields, which Task 6 displays.

- [ ] **Step 1: Write the failing test**

The computation loop is not extractable without a database, so extract the decision instead. Append to `test/timeclock.test.js`:

```js
const { payableHours } = require('../netlify/functions/_timeclock.js');

const at2 = (h, m = 0) => new Date(Date.UTC(2026, 7, 15, h, m)).toISOString();

test('a sane measured span is what gets paid', () => {
  const r = payableHours({ clocked_in_at: at2(9), clocked_out_at: at2(15, 30) }, 7.25);
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.hours, 6.5);
  assert.strictEqual(r.warning, null);
});

test('the 5-hour minimum still applies to a measured span', () => {
  const r = payableHours({ clocked_in_at: at2(9), clocked_out_at: at2(11) }, 5.5);
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.hours, 5, 'the 5-hour floor was lost');
});

test('the 5-hour minimum still applies to an estimate', () => {
  const r = payableHours({}, 1.5);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 5);
});

test('an unusable record pays the estimate and explains itself', () => {
  const r = payableHours({ clocked_in_at: at2(9) }, 7.25);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 7.25);
  assert.match(r.warning, /clock-out/i);
});

test('a forgotten clock-out pays the estimate, never the 25-hour span', () => {
  const r = payableHours(
    { clocked_in_at: at2(8), clocked_out_at: new Date(Date.UTC(2026, 7, 16, 9)).toISOString() }, 7.25);
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.hours, 7.25);
  assert.match(r.warning, /16h maximum/);
});

// Every gig_logs row that exists today has neither column.
test('a booking with no clock record at all pays exactly what it pays now', () => {
  for (const log of [null, undefined, {}]) {
    const r = payableHours(log, 7.25);
    assert.strictEqual(r.hours, 7.25);
    assert.strictEqual(r.source, 'estimated');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/timeclock.test.js`
Expected: FAIL — `payableHours is not a function`.

- [ ] **Step 3: Add `payableHours` to `_timeclock.js`**

```js
// What payroll should pay, and why. Keeping the choice here rather than inline
// in payroll.js means the fallback rule is testable without a database — the
// computation loop it lives in cannot be run without one.
//
// The 5-hour minimum wraps BOTH branches: it is a floor on what a gig pays, not
// a property of how the hours were arrived at.
const MIN_PAID_HOURS = 5;

function payableHours(log, estimatedHours) {
  const est = Math.round((Number(estimatedHours) || 0) * 100) / 100;
  const measured = workedHours(log);
  if (measured.usable) {
    return { source: 'measured', hours: Math.max(MIN_PAID_HOURS, measured.hours),
             measured: measured.hours, warning: null };
  }
  return { source: 'estimated', hours: Math.max(MIN_PAID_HOURS, est),
           measured: null, warning: measured.reason };
}
```

Export `payableHours` and `MIN_PAID_HOURS` alongside the rest.

- [ ] **Step 4: Run the tests**

Run: `node --test test/timeclock.test.js`
Expected: PASS.

- [ ] **Step 5: Join the clock into the payroll query**

In `payroll.js`, the assignments query at `212-232` selects from `staff_assignments`, `bookings` and `staff`. Add the log:

```sql
                   gl.clocked_in_at, gl.clocked_out_at, gl.clock_adjusted_at,
```

to the SELECT list, and this join after the `staff` join:

```sql
            LEFT JOIN gig_logs gl ON gl.assignment_id = sa.id
```

`gig_logs` has `UNIQUE(assignment_id)` (it is the ON CONFLICT target at `staff-assignments.js:518`), so this cannot multiply rows. A LEFT join because most historic assignments have no log at all.

- [ ] **Step 6: Use it in the computation**

In the loop at `302-360`, replace:

```js
            const totalMins = load + drive + unload + party + pack + drive + homeUn;
            const rawHours = totalMins / 60;
            const totalHours = Math.max(5, Math.round(rawHours * 100) / 100);
```

with:

```js
            const totalMins = load + drive + unload + party + pack + drive + homeUn;
            const rawHours = totalMins / 60;

            // Pay the clock when the record is complete and plausible; otherwise
            // pay the estimate and say so. The 5-hour minimum applies either way.
            const paid = payableHours(a, Math.round(rawHours * 100) / 100);
            const totalHours = paid.hours;
            if (paid.warning) {
              warnings.push(`${a.preferred_name || a.staff_name} on booking ${a.reference}: ${paid.warning} — paid the estimate (${totalHours}h)`);
            }
```

`a` is the joined assignment row, which now carries `clocked_in_at`/`clocked_out_at`, so it is the log as far as `payableHours` is concerned.

Add `hours_source: paid.source` and `measured_hours: paid.measured` to the object pushed into `paymentsToCreate`, and add the same two to the per-staff object built for the preflight payload at `~380`.

Import at the top of `payroll.js`:

```js
const { payableHours } = require('./_timeclock');
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, total above Task 2's.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/payroll.js netlify/functions/_timeclock.js test/timeclock.test.js
git commit -m "feat(payroll): pay the clock when it is trustworthy, the estimate when it is not"
```

---

### Task 4: The admin adjustment endpoint

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (new action beside `update_checklist` at `490`; import `logChange`)
- Test: `test/checklist-stages.test.js` (extend)

**Interfaces:**
- Consumes: `CHECKLIST_TS_COLS` from Task 1.
- Produces: `POST /api/staff-assignments` with `action: 'adjust_clock'`, body `{ log_id, stage, value }` where `stage` is a key of `CHECKLIST_TS_COLS` other than `upcoming` and `value` is an ISO timestamp or `null`. Admin only. Also produces the pure `clockAdjustmentLog(stage, before, after)` used for the audit line, exported for tests.

- [ ] **Step 1: Write the failing test**

Append to `test/checklist-stages.test.js`:

```js
const { clockAdjustmentLog } = require('../netlify/functions/staff-assignments.js');

test('an adjustment records both sides of the change', () => {
  const e = clockAdjustmentLog('clocked_out', '2026-08-15T15:00:00.000Z', '2026-08-15T16:30:00.000Z');
  assert.match(e.action, /clock/i);
  assert.match(e.detail, /clocked_out|clock-out/i);
  assert.ok(e.detail.includes('15:00') || e.detail.includes('3:00'), 'the old value is missing');
  assert.ok(e.detail.includes('16:30') || e.detail.includes('4:30'), 'the new value is missing');
});

// An unset stamp being filled in is the common case: someone forgot to tap.
test('filling in a stamp that was never set says so rather than printing null', () => {
  const e = clockAdjustmentLog('clocked_out', null, '2026-08-15T16:30:00.000Z');
  assert.ok(!/null|undefined/i.test(e.detail), `detail leaked a null: ${e.detail}`);
  assert.match(e.detail, /not (set|recorded)|—/i);
});

test('clearing a stamp is logged as cleared, not as a change to nothing', () => {
  const e = clockAdjustmentLog('arrived', '2026-08-15T10:00:00.000Z', null);
  assert.match(e.detail, /clear|remov/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/checklist-stages.test.js`
Expected: FAIL — `clockAdjustmentLog is not a function`.

- [ ] **Step 3: Write the log builder**

In `staff-assignments.js`, beside `buildChecklistTimestampClause`:

```js
// The audit line for an admin's clock edit. Pure, so the wording is testable
// without a database — a wage record that can be silently rewritten is worth
// less than no record, so this must never print "null" at someone.
const STAGE_LABELS = {
  clocked_in: 'clock-in', on_my_way: 'on my way', arrived: 'arrived',
  completed: 'completed', clocked_out: 'clock-out',
};

function clockAdjustmentLog(stage, before, after) {
  const fmt = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(11, 16) + ' UTC';
  };
  const label = STAGE_LABELS[stage] || stage;
  const from = fmt(before), to = fmt(after);
  let detail;
  if (from && to)       detail = `${label}: ${from} → ${to}`;
  else if (!from && to) detail = `${label}: not recorded → ${to}`;
  else if (from && !to) detail = `${label}: ${from} → cleared`;
  else                  detail = `${label}: nothing to change`;
  return { action: 'Clock adjusted', detail };
}
```

Export it with the Task 1 exports.

- [ ] **Step 4: Add the endpoint action**

Import `logChange` at the top of `staff-assignments.js` — the file already imports `sendEmail, wrap` from `./_email`, so extend that line to `const { sendEmail, wrap, logChange, ensureBookingChanges } = require('./_email');`.

Add beside `update_checklist`, before the `submit_survey` block:

```js
        // ── Admin clock adjustment ───────────────────────────────────────
        // Staff tap stages in real time; only an admin corrects one. This is a
        // wage record, so every edit is written to booking_changes with both
        // sides of the change, and the log is flagged as adjusted so a payroll
        // run can show that the hours it paid were corrected by hand.
        if (action === 'adjust_clock') {
          const adminAuth = await requireAuth(event, ['admin']);
          if (!adminAuth) return unauthorized();

          const { log_id, stage, value } = body;
          const col = CHECKLIST_TS_COLS[stage];
          if (!col) return json(400, { error: 'Unknown stage' });

          // null clears; anything else must parse as a date. A string that does
          // not parse must be refused, not written as NULL — silently clearing
          // a wage timestamp because of a typo is the worst outcome here.
          let next = null;
          if (value !== null && value !== undefined && value !== '') {
            const d = new Date(value);
            if (isNaN(d.getTime())) return json(400, { error: 'Invalid timestamp' });
            next = d.toISOString();
          }

          const { rows: before } = await client.query('SELECT * FROM gig_logs WHERE id=$1', [parseInt(log_id)]);
          if (!before.length) return json(404, { error: 'Not found' });

          const { rows } = await client.query(
            `UPDATE gig_logs SET ${col}=$1, clock_adjusted_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
            [next, parseInt(log_id)]
          );

          const entry = clockAdjustmentLog(stage, before[0][col], next);
          try {
            await ensureBookingChanges(client);
            await logChange(client, before[0].booking_id, entry.action, entry.detail);
          } catch (logErr) {
            console.error('adjust_clock: failed to write the audit line —', logErr.message);
          }
          return json(200, rows[0]);
        }
```

`col` comes from the fixed map, never from the request — the same rule the file already documents at `891`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, total above Task 3's.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/staff-assignments.js test/checklist-stages.test.js
git commit -m "feat(timeclock): admin clock adjustments, audited both sides"
```

---

### Task 5: Two more buttons in the portal

**Files:**
- Modify: `staff-portal.html` (`gigCard`, `447-486`)
- Test: none — this is markup over the Task 1 array, and the portal has no helper block to extract. Verify by reading.

**Interfaces:**
- Consumes: the stage order from Task 1. The portal's local `checklistStatuses` array must match it exactly.

- [ ] **Step 1: Extend the local arrays**

In `staff-portal.html:448-449`:

```js
  const checklistStatuses = ['upcoming','clocked_in','on_my_way','arrived','completed','clocked_out'];
  const checklistLabels   = { upcoming:'📅 Upcoming', clocked_in:'🕐 Clocked In', on_my_way:'🚗 On My Way',
                              arrived:'📍 Arrived', completed:'✅ Done', clocked_out:'🏠 Clocked Out' };
```

Add a comment above them:

```js
  // Must match CHECKLIST_STATUSES in staff-assignments.js — the server rejects
  // any status not in its own list, and these stamps are what pay is computed
  // from. Change one, change both in the same commit.
```

- [ ] **Step 2: Show the elapsed time once both ends exist**

Under the button row, inside the same `checklist` block, after the buttons `.join('')`:

```js
      ${g.clocked_in_at && g.clocked_out_at ? `
      <div style="margin-top:10px;font-size:.75rem;color:#a78bca">
        ⏱ Worked <strong style="color:#c084fc">${clockedHoursLabel(g)}</strong>
      </div>` : ''}
```

And a helper beside `fmtDate`:

```js
// Display only — payroll recomputes this server-side and the 5-hour minimum is
// applied there, not here. Showing a bare span keeps the portal honest about
// what was worked rather than what will be paid.
function clockedHoursLabel(g) {
  const a = new Date(g.clocked_in_at).getTime();
  const b = new Date(g.clocked_out_at).getTime();
  if (!isFinite(a) || !isFinite(b) || b <= a) return '—';
  const mins = Math.round((b - a) / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
```

- [ ] **Step 3: Make sure the portal receives the new columns**

The portal's gig list comes from `staff-assignments.js` around `345` and `397`, which select named `gl.` columns. Add `gl.clocked_in_at, gl.clocked_out_at` to both SELECT lists — without this the label above never renders, and the failure is silent.

- [ ] **Step 4: Verify by reading, then run the suite**

Run: `npm test`
Expected: PASS, unchanged total (no new tests).

Read the finished `gigCard` and confirm: six buttons in order, the current one disabled, past ones still clickable (the walk-back rule the file's comment describes), and the report button still appears at `completed`.

- [ ] **Step 5: Commit**

```bash
git add staff-portal.html netlify/functions/staff-assignments.js
git commit -m "feat(portal): clock in and clock out from the day-of checklist"
```

---

### Task 6: The admin's view and the adjustment UI

**Files:**
- Modify: `admin.html` (`renderAssignmentCard`, ~`2206`; a pure helper in the `// ══ PURE HELPERS` block before `1489`)
- Test: `test/admin-link-buttons.test.js` (extend — it already extracts that block)

**Interfaces:**
- Consumes: `clockSegments`/`workedHours` semantics from Task 2 (duplicated client-side — see below), and the `adjust_clock` action from Task 4.
- Produces: `clockRowLabel(log)` in `admin.html`'s pure-helper block.

**On duplication:** `admin.html` is static and cannot `require` server modules, exactly as with `balanceLinkAmounts` and `finaliseLinkClient`. Keep the client-side helper to *display* only — never a number that is paid — and comment it as mirroring `_timeclock.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/admin-link-buttons.test.js`, and add `clockRowLabel` to the `out = {...}` line in `loadHelpers()`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin-link-buttons.test.js`
Expected: FAIL — `clockRowLabel is not defined`.

- [ ] **Step 3: Add the helper**

In `admin.html`'s pure-helper block:

```js
// Mirrors workedHours() in netlify/functions/_timeclock.js — admin.html is a
// static page with no build step and cannot require server modules, the same
// reason balanceLinkAmounts() and finaliseLinkClient() are duplicated. DISPLAY
// ONLY: payroll computes what it pays from the server module, and the 16-hour
// rule and the 5-hour minimum live there. If those rules change, change this
// label with them.
function clockRowLabel(log) {
  const t = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? d.getTime() : null; };
  const a = t(log && log.clocked_in_at), b = t(log && log.clocked_out_at);
  if (a === null) return 'Not clocked in';
  if (b === null) return 'No clock-out yet';
  if (b <= a) return '⚠️ Clock-out is before clock-in — check';
  const mins = Math.round((b - a) / 60000);
  if (mins > 16 * 60) return `⚠️ ${Math.floor(mins / 60)}h — check, likely a missed clock-out`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
```

- [ ] **Step 4: Show it on the assignment card**

In `renderAssignmentCard`, add a row showing `clockRowLabel(a)`, and — when the payroll preflight has supplied them — `hours_source` and `measured_hours`, so Joe can see at a glance whether a gig will pay measured or estimated hours.

Add five `datetime-local` inputs, one per stage, each calling:

```js
async function adjustClock(logId, stage, value) {
  try {
    const res = await apiFetch('/api/staff-assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'adjust_clock', log_id: logId, stage,
                             value: value ? new Date(value).toISOString() : null })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Adjust failed');
    flash('assign-flash-' + logId);
  } catch (e) { alert('Could not adjust: ' + e.message); }
}
```

Follow the card's existing markup style. A `datetime-local` value is local time with no zone, which is why the ISO conversion happens here rather than being sent raw.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, total above Task 5's.

- [ ] **Step 6: Commit**

```bash
git add admin.html test/admin-link-buttons.test.js
git commit -m "feat(admin): see and correct a staff member's clock"
```

---

## What no test here can cover

Every test in this plan is pure arithmetic and string building. Nothing exercises a database, the payroll query's join, or either front end. Before this pays anyone:

- [ ] Run a payroll **preflight** (it writes nothing) over a past week and confirm every line matches what the current code would have paid — no clock records exist yet, so every line must read `estimated` and the amounts must be identical to today's.
- [ ] Tap all six stages on a test gig in the portal and confirm each stamp lands, that stepping back clears the later ones, and that the report button still appears at `completed`.
- [ ] Adjust one stamp in admin and confirm the change appears in that booking's activity log with both sides.
- [ ] Run a preflight again and confirm that gig now reads `measured`, with the 5-hour minimum still applied if the span was short.
- [ ] Confirm a gig with a clock-in and no clock-out still pays the estimate, and produces a warning.
