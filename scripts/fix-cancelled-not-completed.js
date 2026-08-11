#!/usr/bin/env node
/**
 * One-off: restore `cancelled` on bookings the CRM wrongly marked `completed`.
 *
 * Found by the cutover reconciliation on 2026-08-10. 126 bookings that PPM
 * records as Cancelled / Dropped-Cancelled are `completed` in the CRM, carrying
 * $42,315.90 — 18.6% of reported completed revenue.
 *
 * The CRM is the wrong one, and the evidence is that it was not a judgement at
 * all but a sweep:
 *   - 114 of the 126 have updated_at inside the same two minutes, 2026-06-16
 *     23:38-23:39. Nobody completes 114 gigs in two minutes.
 *   - Zero have a Stripe session. One has deposit_paid.
 *   - Every one has an event date in the past, consistent with a blanket
 *     "past event => completed" pass that never asked whether it happened.
 *   - 44 carry a $0 total.
 *
 * PPM owned booking status until the website links moved on 2026-08-10, so for
 * a cancellation it is the authority. (The CRM leads on PAYMENT state — money
 * arrives by routes PPM never sees — which is why any row with payment evidence
 * is refused below rather than flipped.)
 *
 * Dry run (default) prints what would change and writes nothing:
 *   node scripts/fix-cancelled-not-completed.js
 *
 * Apply:
 *   node scripts/fix-cancelled-not-completed.js --apply
 *
 * Rollback, from the snapshot --apply writes:
 *   node scripts/fix-cancelled-not-completed.js --rollback
 */
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
const { parseCSV } = require('../netlify/functions/_csv');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd',
  'cancelled-not-completed-rollback.json');
const CSV = path.join(__dirname, '..', 'import-data.csv');

const CANCELLED_IN_PPM = new Set(['Cancelled', 'Dropped / Cancelled']);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    if (ROLLBACK) {
      if (!fs.existsSync(SNAPSHOT)) {
        console.error(`No snapshot at ${SNAPSHOT} — nothing to roll back.`);
        process.exit(1);
      }
      const refs = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).map((r) => r.reference);
      const r = await pool.query(
        "UPDATE bookings SET status='completed', updated_at=NOW() WHERE reference = ANY($1) AND status='cancelled'",
        [refs]
      );
      console.log(`Rolled back ${r.rowCount} of ${refs.length} bookings to 'completed'.`);
      return;
    }

    if (!fs.existsSync(CSV)) {
      console.error(`No export at ${CSV}. This script decides from PPM's own record, not from a hardcoded list.`);
      process.exit(1);
    }

    const { rows: csvRows } = parseCSV(fs.readFileSync(CSV, 'utf8'));
    const cancelledRefs = csvRows
      .filter((r) => CANCELLED_IN_PPM.has(r['Event status']))
      .map((r) => String(r['Ref.'] || '').trim().toUpperCase())
      .filter(Boolean);

    if (!cancelledRefs.length) {
      console.error('No cancelled rows found in the export — refusing to guess.');
      process.exit(1);
    }

    const { rows: targets } = await pool.query(
      `SELECT reference, client_name, event_date::text AS event_date,
              total_price::float8 AS total_price, deposit_paid,
              COALESCE(stripe_session_id,'') AS sess,
              COALESCE(stripe_payment_intent_id,'') AS pi
       FROM bookings
       WHERE upper(reference) = ANY($1) AND status = 'completed'
       ORDER BY event_date`,
      [cancelledRefs]
    );

    // A cancelled gig that took money is not a sweep artefact — it is a refund
    // question, and no flag overrides that. Excluded, listed, left alone.
    const paid = targets.filter((t) => t.deposit_paid || t.sess || t.pi);
    const safe = targets.filter((t) => !(t.deposit_paid || t.sess || t.pi));

    const money = safe.reduce((s, t) => s + Number(t.total_price || 0), 0);

    console.log(`PPM records ${cancelledRefs.length} bookings as cancelled.`);
    console.log(`Of those, ${targets.length} are 'completed' in the CRM.\n`);

    console.log(`── WOULD FLIP to cancelled: ${safe.length}  ($${money.toFixed(2)} leaves completed revenue)`);
    for (const t of safe.slice(0, 12)) {
      console.log(`   ${t.reference.padEnd(9)} ${t.event_date}  $${Number(t.total_price).toFixed(2).padStart(9)}  ${t.client_name || ''}`);
    }
    if (safe.length > 12) console.log(`   … and ${safe.length - 12} more`);

    console.log(`\n── REFUSED, payment evidence present: ${paid.length}`);
    for (const t of paid) {
      console.log(`   ${t.reference.padEnd(9)} ${t.event_date}  $${Number(t.total_price).toFixed(2)}  ${t.client_name || ''}`
        + `  [${[t.deposit_paid && 'deposit_paid', t.sess && 'stripe session', t.pi && 'payment intent'].filter(Boolean).join(', ')}]`);
    }
    if (paid.length) console.log('   Decide these by hand — a cancelled gig that took money is a refund question.');

    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to write.');
      return;
    }

    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(
      safe.map((t) => ({ reference: t.reference, status: 'completed', total_price: t.total_price })), null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of safe) {
        await client.query(
          "UPDATE bookings SET status='cancelled', updated_at=NOW() WHERE reference=$1 AND status='completed'",
          [t.reference]
        );
        await client.query(
          `INSERT INTO booking_changes (booking_id, action, detail, field_name, old_value, new_value, changed_by)
           SELECT id, 'status_change', $2, 'status', 'completed', 'cancelled', 'admin (cutover reconciliation)'
           FROM bookings WHERE reference = $1`,
          [t.reference, 'PPM records this booking as cancelled. The CRM marked it completed in a bulk sweep on 2026-06-16 with no payment evidence.']
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`Flipped ${safe.length} bookings to 'cancelled'.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
