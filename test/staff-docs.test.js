const { test } = require('node:test');
const assert = require('node:assert');
const { forStaff, SEED } = require('../netlify/functions/staff-docs.js');

// A checklist is only worth having if "outstanding" is true. These pin the
// absence-means-outstanding rule, because that is the one that decides whether
// somebody gets chased for paperwork they already sent — or worse, does not get
// chased for paperwork they never did.

function fakeClient(rows) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => { queries.push({ sql, params }); return { rows }; },
  };
}

test('a document with no row reads as outstanding, not as blank', () => {
  // A new hire has no rows at all, which is exactly true on their first day —
  // this is why nothing has to be backfilled when someone is added.
  return forStaff(fakeClient([
    { id: 1, label: 'W-9', status: null, received_at: null },
    { id: 2, label: 'Photo ID', status: null, received_at: null },
  ]), 7).then(out => {
    assert.deepStrictEqual(out.map(d => d.status), ['outstanding', 'outstanding']);
  });
});

test('a received document keeps its status', async () => {
  const out = await forStaff(fakeClient([
    { id: 1, label: 'W-9', status: 'received', received_at: new Date('2026-09-10') },
    { id: 2, label: 'Photo ID', status: null, received_at: null },
  ]), 7);
  assert.strictEqual(out[0].status, 'received');
  assert.strictEqual(out[1].status, 'outstanding');
});

test('a waived document is not outstanding', async () => {
  // Waived exists so a contractor who will never file an I-9 stops showing red
  // forever. Collapsing it into "outstanding" would make the list unusable.
  const out = await forStaff(fakeClient([{ id: 1, label: 'I-9', status: 'waived' }]), 7);
  assert.strictEqual(out[0].status, 'waived');
});

test('only one person\'s documents are ever asked for', async () => {
  const c = fakeClient([]);
  await forStaff(c, 42);
  assert.deepStrictEqual(c.queries[0].params, [42], 'the staff id must be bound, not interpolated');
  assert.match(c.queries[0].sql, /d\.staff_id = \$1/,
    'the join must be scoped to one person or everyone sees everyone');
});

test('a deactivated document type stops appearing', async () => {
  const c = fakeClient([]);
  await forStaff(c, 7);
  assert.match(c.queries[0].sql, /t\.active = TRUE/,
    'retiring a document must stop it nagging, without deleting who already sent it');
});

test('the seed is a starting point, not a schema', () => {
  // Joe edits these in the UI; the seed only guarantees the list is not empty
  // on a cold database. Every entry needs a label and a sort order.
  assert.ok(SEED.length >= 3);
  for (const [label, instructions, link, order] of SEED) {
    assert.ok(label && typeof label === 'string', 'every seeded type needs a label');
    assert.ok(typeof instructions === 'string');
    assert.ok(typeof link === 'string');
    assert.ok(Number.isFinite(order), 'sort order decides the order it is chased in');
  }
  const labels = SEED.map(s => s[0]);
  assert.strictEqual(new Set(labels).size, labels.length, 'no duplicate document types');
  assert.ok(labels.some(l => /handbook/i.test(l)),
    'the handbook rides the same mechanism rather than a second one');
});

test('no file ever reaches this feature', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/staff-docs.js'), 'utf8');
  // The owner's call was that email is the transport and his inbox is the
  // storage. That is what keeps this to two tables with no upload route, no
  // 6MB payload ceiling, and no copy of somebody's licence in the database.
  for (const forbidden of ['bytea', 'multipart', 'base64', '@netlify/blobs', 'file_data']) {
    assert.ok(!src.includes(forbidden), `staff-docs must not store files (found "${forbidden}")`);
  }
});
