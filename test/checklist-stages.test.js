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
