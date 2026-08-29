const { test } = require('node:test');
const assert = require('node:assert');
const { ensureTable, getTargets, upsertTargets } = require('../netlify/functions/revenue-targets');

// Hand-rolled fake client — no DB, no framework. Mirrors a `revenue_targets`
// table well enough to exercise getTargets/upsertTargets' actual SQL shape:
// year+month scoping and an upsert that keyed on the same pair.
function fakeClient() {
  const rows = []; // { year, month, amount }
  return {
    calls: [],
    async query(sql, params = []) {
      this.calls.push(sql);
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };

      if (/^\s*SELECT/i.test(sql)) {
        const [year] = params;
        return { rows: rows.filter(r => r.year === year).map(r => ({ month: r.month, amount: r.amount })) };
      }

      if (/^\s*INSERT/i.test(sql)) {
        const [year, month, amount] = params;
        const existing = rows.find(r => r.year === year && r.month === month);
        if (existing) existing.amount = amount;
        else rows.push({ year, month, amount });
        return { rows: [] };
      }

      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('ensureTable issues a CREATE TABLE IF NOT EXISTS', async () => {
  const client = fakeClient();
  await ensureTable(client);
  assert.ok(client.calls.some(sql => /CREATE TABLE IF NOT EXISTS revenue_targets/i.test(sql)));
});

test('getTargets on an empty table returns all twelve months at amount 0', async () => {
  const client = fakeClient();
  const targets = await getTargets(client, 2026);
  assert.strictEqual(targets.length, 12);
  assert.deepStrictEqual(targets.map(t => t.month), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(targets.every(t => t.amount === 0));
});

test('upsertTargets sets the given months and leaves the rest at 0', async () => {
  const client = fakeClient();
  const targets = await upsertTargets(client, 2026, [
    { month: 8, amount: 4200 },
    { month: 9, amount: 5000 },
  ]);
  assert.strictEqual(targets.find(t => t.month === 8).amount, 4200);
  assert.strictEqual(targets.find(t => t.month === 9).amount, 5000);
  assert.strictEqual(targets.find(t => t.month === 1).amount, 0);
});

test('upsertTargets on an existing month overwrites, not duplicates', async () => {
  const client = fakeClient();
  await upsertTargets(client, 2026, [{ month: 8, amount: 4200 }]);
  const second = await upsertTargets(client, 2026, [{ month: 8, amount: 6000 }]);
  assert.strictEqual(second.find(t => t.month === 8).amount, 6000);
});

test('a year is a separate row set — next year does not overwrite this year', async () => {
  const client = fakeClient();
  await upsertTargets(client, 2026, [{ month: 8, amount: 4200 }]);
  await upsertTargets(client, 2027, [{ month: 8, amount: 9000 }]);
  assert.strictEqual((await getTargets(client, 2026)).find(t => t.month === 8).amount, 4200);
  assert.strictEqual((await getTargets(client, 2027)).find(t => t.month === 8).amount, 9000);
});

test('an out-of-range month is ignored rather than corrupting the row set', async () => {
  const client = fakeClient();
  const targets = await upsertTargets(client, 2026, [{ month: 13, amount: 999 }, { month: 0, amount: 999 }]);
  assert.strictEqual(targets.length, 12);
  assert.ok(targets.every(t => t.amount === 0));
});
