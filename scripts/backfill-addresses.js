#!/usr/bin/env node
/**
 * Restore the street addresses the import threw away.
 *
 * import-bookings.js did this:
 *     let eventLocation = obj['Venue'] || '';
 *     if (!eventLocation) eventLocation = obj['Addr. line 1'] || '';
 *
 * Venue won over the street address, and the address was then discarded — the
 * bookings table has no column for it. So a gig at KinderCare stored
 * "KinderCare" and lost "1812 North Eastern Ave, Moore". Measured 2026-08-11:
 * of 19 upcoming bookings only TWO had a street number, while the PPM export
 * held full addresses for 392 rows.
 *
 * That is invisible in the admin — where you can look the client up — and fatal
 * on a phone, where the calendar entry is the only thing you have and it needs
 * to be tappable for directions.
 *
 * event_location becomes "Venue, Street, Town, State". The zip stays in
 * event_zip; the calendar joins the two, so putting it in both would print it
 * twice.
 *
 *   node scripts/backfill-addresses.js            # dry run
 *   node scripts/backfill-addresses.js --apply
 *   node scripts/backfill-addresses.js --rollback
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
const { fullAddress } = require('../netlify/functions/_address');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd', 'addresses-rollback.json');
const CSV = path.join(__dirname, '..', 'import-data.csv');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    if (ROLLBACK) {
      if (!fs.existsSync(SNAPSHOT)) { console.error(`No snapshot at ${SNAPSHOT}`); process.exit(1); }
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      let n = 0;
      for (const r of snap) {
        const q = await pool.query('UPDATE bookings SET event_location=$1, updated_at=NOW() WHERE reference=$2', [r.before, r.reference]);
        n += q.rowCount;
      }
      console.log(`Restored ${n} of ${snap.length}.`);
      return;
    }

    if (!fs.existsSync(CSV)) { console.error(`No export at ${CSV}`); process.exit(1); }
    const { rows: ppm } = parseCSV(fs.readFileSync(CSV, 'utf8'));

    const { rows: crm } = await pool.query(
      `SELECT id, reference, event_location, event_date::text AS event_date, status
         FROM bookings WHERE COALESCE(reference,'') <> ''`
    );
    const byRef = new Map(crm.map((r) => [r.reference.trim().toUpperCase(), r]));

    const plan = [];
    for (const p of ppm) {
      const ref = String(p['Ref.'] || '').trim().toUpperCase();
      const row = byRef.get(ref);
      if (!row) continue;

      const want = fullAddress(p);
      if (!want) continue;

      const have = String(row.event_location || '').trim();
      if (have === want) continue;

      // Only ever ADD detail. If the CRM already holds something longer — an
      // address someone typed in by hand after the import — leave it alone.
      // A backfill that overwrites a human correction is worse than the gap it
      // is filling.
      if (have && have.length >= want.length) continue;

      plan.push({ id: row.id, reference: ref, before: row.event_location || '', after: want,
                  when: row.event_date, status: row.status });
    }

    const upcoming = plan.filter((p) => p.when >= new Date().toISOString().slice(0, 10));
    console.log(`${plan.length} bookings would gain address detail (${upcoming.length} of them upcoming).\n`);
    console.log('── upcoming, which is what the calendar shows:');
    for (const p of upcoming.slice(0, 15)) {
      console.log(`   ${p.when}  ${p.reference.padEnd(9)} ${JSON.stringify(p.before)}`);
      console.log(`   ${' '.repeat(10)} ${' '.repeat(9)} → ${JSON.stringify(p.after)}`);
    }
    if (upcoming.length > 15) console.log(`   … and ${upcoming.length - 15} more`);

    if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return; }

    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(plan.map((p) => ({ reference: p.reference, before: p.before })), null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of plan) {
        await client.query('UPDATE bookings SET event_location=$1, updated_at=NOW() WHERE id=$2', [p.after, p.id]);
        await client.query(
          `INSERT INTO booking_changes (booking_id, action, detail, field_name, old_value, new_value, changed_by)
           VALUES ($1,'address_restored',$2,'event_location',$3,$4,'admin (address backfill)')`,
          [p.id, 'The 2026-05-07 import kept Venue and discarded the street address. Restored from the final PPM export so the calendar entry is navigable.', p.before, p.after]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    console.log(`Updated ${plan.length} bookings.`);
  } finally { await pool.end(); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
