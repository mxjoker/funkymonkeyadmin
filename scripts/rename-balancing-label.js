#!/usr/bin/env node
// Rename the Phase 3 backfill's internal balancing line to a client-safe label.
//
// backfill-booking-items.js named the gap between PPM's total and the itemised
// services 'Unitemised balance (pre-Phase-3 import)'. Invoices, the quote page
// and my-booking print item names verbatim, so a client would read that phrase
// as a charge. Name only: price, quantity, kind and every booking total are
// untouched, so nobody's balance moves.
//
//   node --env-file=.env scripts/rename-balancing-label.js            (dry run)
//   node --env-file=.env scripts/rename-balancing-label.js --apply

const { Client } = require('pg');
const OLD = 'Unitemised balance (pre-Phase-3 import)';
const NEW = 'Additional services';
const APPLY = process.argv.includes('--apply');

const connect = async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
};
const tally = async (db, name) =>
  (await db.query('SELECT count(*)::int AS rows, coalesce(sum(price), 0)::float8 AS total FROM booking_items WHERE name = $1', [name])).rows[0];

(async () => {
  const c = await connect();
  console.log('carrying the old label:', await tally(c, OLD));
  if (!APPLY) { console.log('dry run. Re-run with --apply to rename.'); return c.end(); }
  const r = await c.query("UPDATE booking_items SET name = $2 WHERE kind = 'custom' AND name = $1", [OLD, NEW]);
  console.log('renamed', r.rowCount);
  await c.end();

  // Verify on a fresh connection: the old label is gone and the money is the same.
  const v = await connect();
  console.log('old label left:', await tally(v, OLD), '| now labelled "' + NEW + '":', await tally(v, NEW));
  await v.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
