const { test } = require('node:test');
const assert = require('node:assert');
const { acceptOutcome } = require('../netlify/functions/accept-quote');

// The transition guard is the whole safety story for this endpoint, so it is a
// pure function that can be tested without a database.

test('a quoted booking accepts', () => {
  const r = acceptOutcome({ rowCount: 1, current: 'quoted' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.status, 'accepted');
});

test('an already-accepted booking is idempotent, not an error', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'accepted' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.status, 'accepted');
  assert.strictEqual(r.body.already, true);
});

test('a confirmed booking cannot be walked backwards to accepted', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'confirmed' });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.status, 'confirmed');
});

test('a cancelled booking cannot be accepted', () => {
  const r = acceptOutcome({ rowCount: 0, current: 'cancelled' });
  assert.strictEqual(r.statusCode, 409);
});

test('a draft or review booking has no quote to accept', () => {
  for (const s of ['draft', 'review']) {
    assert.strictEqual(acceptOutcome({ rowCount: 0, current: s }).statusCode, 409);
  }
});

// The guard must be capable of failing. A conditional UPDATE that matched
// nothing MUST NOT be reported as a success — that is the recurring bug class
// in this codebase (see the silent-failure memory).
test('zero rows updated is never reported as a fresh acceptance', () => {
  for (const s of ['draft', 'review', 'quoted', 'confirmed', 'completed', 'cancelled', 'pending']) {
    const r = acceptOutcome({ rowCount: 0, current: s });
    assert.notStrictEqual(
      JSON.stringify(r.body), JSON.stringify({ success: true, status: 'accepted' }),
      `status ${s} with rowCount 0 must not look like a fresh accept`
    );
  }
});
