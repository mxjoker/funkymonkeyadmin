#!/usr/bin/env node
// Clean up the historical booking backlog:
//   - past-dated 'review' inquiries  -> 'cancelled'  (dead leads)
//   - past-dated 'confirmed' events  -> 'completed'  (they happened)
//
// Runs as a dry-run by default. Use --apply to execute.
// Before applying, writes scripts/backlog-rollback-<date>.json with the
// id + previous status of every affected booking, and prints a one-line
// SQL recipe to undo. Direct SQL — no automation emails fire.
//
// Usage:
//   node scripts/cleanup-backlog.js            # dry run (counts only)
//   node scripts/cleanup-backlog.js --apply    # do it

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const APPLY = process.argv.includes('--apply');

(async () => {
  const client = await pool.connect();
  try {
    const { rows: targets } = await client.query(`
      SELECT id, reference, status, event_date FROM bookings
      WHERE event_date < CURRENT_DATE AND status IN ('review','confirmed')
      ORDER BY event_date
    `);
    const toCancel = targets.filter(t => t.status === 'review');
    const toComplete = targets.filter(t => t.status === 'confirmed');
    console.log(`Past-dated 'review'    -> 'cancelled': ${toCancel.length}`);
    console.log(`Past-dated 'confirmed' -> 'completed': ${toComplete.length}`);

    if (!APPLY) {
      console.log('\nDry run only. Re-run with --apply to execute.');
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const rollbackPath = path.join(__dirname, `backlog-rollback-${stamp}.json`);
    fs.writeFileSync(rollbackPath, JSON.stringify(targets, null, 2));
    console.log(`\nRollback data saved: ${rollbackPath}`);

    await client.query('BEGIN');
    const r1 = await client.query(
      "UPDATE bookings SET status='cancelled' WHERE status='review' AND event_date < CURRENT_DATE");
    const r2 = await client.query(
      "UPDATE bookings SET status='completed' WHERE status='confirmed' AND event_date < CURRENT_DATE");
    await client.query('COMMIT');

    console.log(`Updated: ${r1.rowCount} cancelled, ${r2.rowCount} completed.`);
    console.log('\nTo undo a single booking: UPDATE bookings SET status=\'<old>\' WHERE id=<id>;');
    console.log('(old statuses are in the rollback JSON)');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed (rolled back):', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
