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

// A bare `CHECKLIST_TS_COLS[stage]` lookup is reachable through the prototype
// chain — `stage: 'constructor'` resolves to Object's constructor, which is
// truthy, so a `!col` check alone never rejects it. isAdjustableStage must
// check the array (like buildChecklistTimestampClause already does) so this
// can't reach the query with a non-column string interpolated as one.
const { isAdjustableStage } = require('../netlify/functions/staff-assignments.js');

test('every real stage but upcoming is adjustable', () => {
  for (const stage of ['clocked_in', 'on_my_way', 'arrived', 'completed', 'clocked_out']) {
    assert.strictEqual(isAdjustableStage(stage), true, stage);
  }
  assert.strictEqual(isAdjustableStage('upcoming'), false);
});

test('inherited Object.prototype keys are not adjustable stages', () => {
  for (const stage of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.strictEqual(isAdjustableStage(stage), false, stage);
  }
});

test('non-string stages are not adjustable', () => {
  for (const stage of [null, undefined, 42, {}]) {
    assert.strictEqual(isAdjustableStage(stage), false, String(stage));
  }
});

// ── The audit line has to survive being read a month later ───────────────────
// The correction that most needs an audit trail is a forgotten clock-out, which
// is cross-day by definition: the worker taps out the next morning, or not at
// all and the admin fills it in. A time-only line renders exactly that case
// invisible — "clock-out: 15:00 UTC → 15:00 UTC" for a change of a whole day.
test('a cross-day correction does not read as no change at all', () => {
  const a = clockAdjustmentLog('clocked_out', '2026-08-15T15:00:00.000Z', '2026-08-16T15:00:00.000Z');
  const [from, to] = a.detail.split('→').map(s => s.trim());
  assert.notStrictEqual(from, to, `a one-day move logged identical sides: ${a.detail}`);
  assert.match(a.detail, /2026-08-15/, 'the old date is missing');
  assert.match(a.detail, /2026-08-16/, 'the new date is missing');
});

// ── An admin's correction must not be erasable by the next tap ───────────────
// adjust_clock writes one column and used to leave `status` alone. Filling in a
// missing clocked_out_at on a log still reading `completed` left the worker's
// next checklist tap re-running buildChecklistTimestampClause('completed'),
// which NULLs clocked_out_at — an audited change undone with nothing audited.
const { advancedStatus } = require('../netlify/functions/staff-assignments.js');

test('setting a stamp later than the current status advances the status', () => {
  assert.strictEqual(advancedStatus('completed', 'clocked_out', true), 'clocked_out');
  assert.strictEqual(advancedStatus('upcoming', 'arrived', true), 'arrived');
});

test('setting a stamp for a stage already passed leaves the status alone', () => {
  assert.strictEqual(advancedStatus('clocked_out', 'arrived', true), null);
  assert.strictEqual(advancedStatus('completed', 'completed', true), null);
});

// Clearing is the admin saying "this never happened". Advancing the status on a
// clear would claim the opposite.
test('clearing a stamp never advances the status', () => {
  assert.strictEqual(advancedStatus('completed', 'clocked_out', false), null);
});

test('a stage that is not a real stage never becomes a status', () => {
  for (const stage of ['constructor', '__proto__', 'upcoming', null, 42]) {
    assert.strictEqual(advancedStatus('upcoming', stage, true), null, String(stage));
  }
});

test('the audit line says so when the status moved with the stamp', () => {
  const e = clockAdjustmentLog('clocked_out', null, '2026-08-16T16:30:00.000Z', 'clocked_out');
  assert.match(e.detail, /status/i, `the status change is not in the audit line: ${e.detail}`);
  // An adjustment that moved nothing must not claim it did.
  const plain = clockAdjustmentLog('arrived', null, '2026-08-16T10:00:00.000Z', null);
  assert.ok(!/status/i.test(plain.detail), `claimed a status change that never happened: ${plain.detail}`);
});

// ── update_checklist must be scoped to the staff member who owns the log ─────
// Source-level, because the rule lives in a handler that cannot run without a
// database. The guard is what stops one authenticated staff member POSTing
// another's log_id and wiping the timestamps their wage is computed from, so
// it must not be deletable without a test going red.
const fs = require('node:fs');
const path = require('node:path');
const SA_SRC = fs.readFileSync(path.join(__dirname, '../netlify/functions/staff-assignments.js'), 'utf8');

test('update_checklist refuses a log that belongs to someone else', () => {
  const start = SA_SRC.indexOf("if (action === 'update_checklist')");
  const end   = SA_SRC.indexOf("if (action === 'adjust_clock')");
  assert.ok(start !== -1 && end > start, 'update_checklist block not found');
  const block = SA_SRC.slice(start, end);
  assert.match(block, /SELECT[^;]*staff_id[^;]*FROM gig_logs/i,
    'update_checklist does not look the log owner up — any staff id can wipe any clock');
  assert.match(block, /return forbidden\(\)/,
    'update_checklist never refuses a mismatch');
});
