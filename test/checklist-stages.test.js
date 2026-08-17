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
