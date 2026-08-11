#!/usr/bin/env node
/**
 * One-off: bring stale CRM rows into line with the final PPM export.
 *
 * Found 2026-08-11 because a foam party did not appear on the calendar. Eight
 * bookings had drifted: PPM had a newer contact, date, service or price and the
 * CRM never got the update.
 *
 * Nothing was missing. Three of the eight looked missing because the CONTACT
 * had changed — Wilkins Truck Chrome swapped Cody Vaverka for Kimber Wilkins,
 * KinderCare swapped Chloe Shelton for Taylor Hulsey — same company, same
 * venue, same date, same price. Creating them would have produced duplicate
 * gigs on the calendar.
 *
 * PPM is authoritative here: it owned booking data until the links moved on
 * 2026-08-10, and every one of these edits was made in PPM after the CRM's
 * 2026-05-07 import. The CRM leads on PAYMENT state only, so deposit_paid,
 * balance and stripe fields are never touched below.
 *
 *   node scripts/sync-stale-from-ppm.js            # dry run
 *   node scripts/sync-stale-from-ppm.js --apply
 *   node scripts/sync-stale-from-ppm.js --rollback
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
const { resolveServiceId } = require('../netlify/functions/_service-map');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd', 'stale-from-ppm-rollback.json');
const CSV = path.join(__dirname, '..', 'import-data.csv');

// The eight, named explicitly rather than discovered by a rule. A rule broad
// enough to catch a changed client name would also "correct" every deliberate
// CRM edit, and the CRM has been the system of record since 2026-08-10.
const REFS = ['26-163', '26-151', '26-143', '26-192', '26-230', '26-282', '26-241', '26-148'];

// Fields PPM may update. deposit_paid, balance_due, stripe_* and status are
// absent on purpose — the CRM leads on payment state and on its own workflow.
const FIELDS = ['client_name', 'client_phone', 'client_email', 'event_date', 'event_time',
                'event_location', 'event_zip', 'service_name', 'service_id', 'total_price'];

const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
const ppmDate = (s) => {
  const [d, m, y] = String(s || '').trim().split(/\s+/);
  return (d && MONTHS[m] && y) ? `${y}-${MONTHS[m]}-${String(d).padStart(2, '0')}` : null;
};
const money = (s) => Number(String(s || '0').replace(/[^0-9.-]/g, '')) || 0;
const phone = (s) => String(s || '').replace(/^'/, '').trim();

const SERVICE_MAP = {
  'Deluxe Birthday Package': 'Deluxe Magic Birthday Show',
  'Basic Birthday Show': 'Magic Birthday Show',
  'Stage Show': 'Stage Magic Show',
  '45 Minute Foam Party': 'Foam Party Experience',
  '90 Minute Foam Party': 'Foam Party Experience',
  '90 minute Foam Party': 'Foam Party Experience',
};

function desired(p) {
  const serviceName = SERVICE_MAP[p['Package']] || p['Package'] || 'Custom Event';
  return {
    client_name: p['Client name'] || p['Organisation'] || '',
    client_phone: phone(p['Phone number']),
    client_email: p['Email'] || '',
    event_date: ppmDate(p['Event date']),
    event_time: p['Event time'] || '',
    event_location: p['Venue'] || p['Addr. line 1'] || '',
    event_zip: p['Postcode'] || '',
    service_name: serviceName,
    service_id: resolveServiceId(serviceName),
    total_price: money(p['Tot. price']),
  };
}

const same = (a, b) => {
  if (a == null && b == null) return true;
  if (typeof b === 'number') return Math.abs(Number(a || 0) - b) < 0.01;
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
};

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    if (ROLLBACK) {
      if (!fs.existsSync(SNAPSHOT)) { console.error(`No snapshot at ${SNAPSHOT}`); process.exit(1); }
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      let n = 0;
      for (const row of snap) {
        const sets = FIELDS.map((f, i) => `${f}=$${i + 1}`).join(', ');
        const vals = FIELDS.map((f) => row.before[f]);
        vals.push(row.reference);
        const r = await pool.query(`UPDATE bookings SET ${sets}, updated_at=NOW() WHERE reference=$${FIELDS.length + 1}`, vals);
        n += r.rowCount;
      }
      console.log(`Restored ${n} of ${snap.length} bookings.`);
      return;
    }

    if (!fs.existsSync(CSV)) { console.error(`No export at ${CSV}`); process.exit(1); }
    const { rows: ppm } = parseCSV(fs.readFileSync(CSV, 'utf8'));

    const plan = [];
    for (const ref of REFS) {
      const p = ppm.find((x) => String(x['Ref.'] || '').trim() === ref);
      if (!p) { console.error(`${ref} is not in the export — refusing to guess.`); process.exit(1); }
      const { rows: [b] } = await pool.query(
        `SELECT id, reference, ${FIELDS.join(', ')} FROM bookings WHERE reference=$1`, [ref]
      );
      if (!b) { console.error(`${ref} is not in the CRM — this script only updates, never creates.`); process.exit(1); }

      const want = desired(p);

      // Only touch the service when the CATALOGUE ENTRY actually changed.
      // PPM's package name and the CRM's catalogue name differ harmlessly for
      // the same service ("Basic Birthday Magic Show" vs "Magic Birthday
      // Show"), and the CRM's is the better one — syncing it would be a
      // regression dressed up as a correction. A real change, like 26-282
      // moving from lib_magic to lib_foam at a different price, still syncs.
      const serviceChanged = want.service_id && b.service_id && want.service_id !== b.service_id;
      if (!serviceChanged) {
        want.service_name = b.service_name;
        want.service_id = b.service_id;
        want.total_price = Number(b.total_price);
      }

      const diffs = FIELDS.filter((f) => {
        const cur = f === 'event_date' && b[f] ? new Date(b[f]).toISOString().slice(0, 10) : b[f];
        return !same(cur, want[f]);
      });
      if (diffs.length) {
        const before = {};
        for (const f of FIELDS) before[f] = f === 'event_date' && b[f] ? new Date(b[f]).toISOString().slice(0, 10) : b[f];
        plan.push({ id: b.id, reference: ref, diffs, before, after: want });
      }
    }

    console.log(`${plan.length} of ${REFS.length} bookings differ from the export.\n`);
    for (const r of plan) {
      console.log(`── ${r.reference}`);
      for (const f of r.diffs) console.log(`   ${f.padEnd(15)} ${JSON.stringify(r.before[f])}  →  ${JSON.stringify(r.after[f])}`);
    }

    if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return; }

    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(plan.map((p) => ({ reference: p.reference, before: p.before })), null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of plan) {
        const sets = FIELDS.map((f, i) => `${f}=$${i + 1}`).join(', ');
        const vals = FIELDS.map((f) => r.after[f]);
        vals.push(r.id);
        await client.query(`UPDATE bookings SET ${sets}, updated_at=NOW() WHERE id=$${FIELDS.length + 1}`, vals);
        for (const f of r.diffs) {
          await client.query(
            `INSERT INTO booking_changes (booking_id, action, detail, field_name, old_value, new_value, changed_by)
             VALUES ($1,'ppm_sync',$2,$3,$4,$5,'admin (post-cutover PPM sync)')`,
            [r.id, 'PPM held newer data than the CRM at cutover. Found 2026-08-11 when a booking did not appear on the calendar feed.',
             f, String(r.before[f] ?? ''), String(r.after[f] ?? '')]
          );
        }
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
