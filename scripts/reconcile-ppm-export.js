#!/usr/bin/env node
/**
 * Read-only: diff a PPM CSV export against the CRM's bookings table.
 *
 * This is the last gate before the Wix button moves. PPM's `Ref.` (e.g.
 * "26-250") is the established strong key and lands in bookings.reference
 * unchanged, so the diff is an exact join — no fuzzy name or date matching,
 * which would invent matches that are not there.
 *
 * Three buckets:
 *   MISSING  — in the export, not in the CRM. These are the in-flight bookings
 *              a cutover would lose. Remediate with import-bookings.js.
 *   DRIFTED  — in both, but event_date / status / total disagree. Each one is a
 *              human call. PPM leads on intake and quoting, but the CRM leads on
 *              payment state, because money arrives by routes PPM never sees:
 *              Stripe deposits taken through the CRM, and GigSalad/Bark gigs the
 *              owner marks paid by hand. "PPM wins" would revert those to unpaid.
 *              Verified on 26-286 — paid through a third-party booking site,
 *              marked paid in the CRM, still "Processing" in PPM, event the
 *              next day.
 *   CRM-ONLY — in the CRM, not the export. Expected and fine: bookings taken
 *              through the CRM form, plus every historical row PPM has since
 *              archived. Reported as a count unless --verbose.
 *
 * THIS SCRIPT NEVER WRITES. Remediation is import-bookings.js, which has its
 * own dry run. A tool that both measures and repairs can corrupt the thing it
 * is measuring, and this measurement is what the cutover decision rests on.
 *
 *   node scripts/reconcile-ppm-export.js <export.csv>
 *   node scripts/reconcile-ppm-export.js <export.csv> --verbose
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

const VERBOSE = process.argv.includes('--verbose');
const csvPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

// Mirrors import-bookings.js STATUS_MAP. Duplicated deliberately: that map is
// an import-time transform, and coupling this comparison to it would mean a
// future edit there silently changes what "drift" means here.
const STATUS_MAP = {
  'Confirmed': 'confirmed',
  'Confirmed+': 'confirmed',
  'Balance settled': 'completed',
  'Processing': 'accepted',
  'Pending': 'review',
  'Unprocessed': 'review',
  'Cancelled': 'cancelled',
  'Dropped / Cancelled': 'cancelled',
  'Completed': 'completed',
};

// "29 May 2026" -> "2026-05-29". Returns '' for anything unparseable rather
// than throwing: one malformed date must not abort a 600-row reconciliation.
const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                 Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function ppmDate(s) {
  const [d, m, y] = String(s || '').trim().split(/\s+/);
  if (!d || !MONTHS[m] || !y) return '';
  return `${y}-${MONTHS[m]}-${String(d).padStart(2, '0')}`;
}

const money = (s) => Number(String(s || '0').replace(/[^0-9.-]/g, '')) || 0;
// Names and emails are compared loosely; a phone by its digits only, since the
// two systems format them differently ("405-962-8375" vs "4059628375").
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@.]/g, '');
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

async function main() {
  if (!csvPath) {
    console.error('Usage: node scripts/reconcile-ppm-export.js <export.csv> [--verbose]');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`No such file: ${csvPath}`);
    process.exit(1);
  }

  const { headers, rows } = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (!headers.includes('Ref.')) {
    console.error(`Export has no "Ref." column — got: ${headers.slice(0, 8).join(', ')}…`);
    console.error('Without the join key this reconciliation cannot run. Re-export from PPM.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    // mileage_cost is selected because PPM's "Tot. price" INCLUDES the travel
    // fee while the CRM's total_price EXCLUDES it — see the money-path
    // invariant, balance_due = total_price + mileage_cost - deposit_amount.
    // Comparing the two columns directly reports every travelled booking as
    // drifted, which buries the real drift in noise. Verified 2026-08-05: all
    // five "price drifts" in the sample export were exactly this.
    const { rows: crmRows } = await pool.query(
      `SELECT reference, status, event_date::text AS event_date,
              client_name, client_phone, client_email,
              total_price::float8 AS total_price, mileage_cost::float8 AS mileage_cost
       FROM bookings WHERE COALESCE(reference,'') <> ''`
    );
    const crm = new Map(crmRows.map((r) => [r.reference.trim().toUpperCase(), r]));

    const missing = [];
    const drifted = [];
    const seen = new Set();

    for (const row of rows) {
      const ref = String(row['Ref.'] || '').trim().toUpperCase();
      if (!ref) continue;
      seen.add(ref);

      const found = crm.get(ref);
      if (!found) {
        missing.push({
          ref,
          client: row['Client name'] || '',
          date: ppmDate(row['Event date']),
          status: STATUS_MAP[row['Event status']] || 'review',
          total: money(row['Tot. price']),
        });
        continue;
      }

      const deltas = [];
      const ppmStatus = STATUS_MAP[row['Event status']] || 'review';
      const ppmEventDate = ppmDate(row['Event date']);
      const ppmTotal = money(row['Tot. price']);

      if (ppmEventDate && ppmEventDate !== found.event_date) {
        deltas.push(`event_date  PPM=${ppmEventDate}  CRM=${found.event_date}`);
      }
      if (ppmStatus !== found.status) {
        deltas.push(`status      PPM=${ppmStatus}  CRM=${found.status}`);
      }

      // Identity. Comparing only status/date/total meant a booking whose CONTACT
      // had changed looked identical — on 2026-08-11 three bookings read as
      // present when the CRM held an entirely different person, and one of them
      // was a foam party that never reached the calendar. A reference alone does
      // not prove two rows are the same booking.
      const ppmName = String(row['Client name'] || row['Organisation'] || '');
      if (norm(ppmName) && norm(found.client_name) && norm(ppmName) !== norm(found.client_name)) {
        deltas.push(`CONTACT     PPM="${ppmName}"  CRM="${found.client_name}"  ← different person on the same reference`);
      }
      const ppmEmail = String(row['Email'] || '');
      if (norm(ppmEmail) && norm(found.client_email) && norm(ppmEmail) !== norm(found.client_email)) {
        deltas.push(`email       PPM=${ppmEmail}  CRM=${found.client_email}`);
      }
      const ppmPhone = digits(row['Phone number']);
      if (ppmPhone && digits(found.client_phone) && ppmPhone !== digits(found.client_phone)) {
        deltas.push(`phone       PPM=${row['Phone number']}  CRM=${found.client_phone}`);
      }
      // Compare like with like: PPM's total is travel-inclusive, so add the
      // CRM's travel back before diffing. Cent-level tolerance because both
      // sides round independently.
      const crmGross = Number(found.total_price) + Number(found.mileage_cost);
      if (Math.abs(ppmTotal - crmGross) > 0.01) {
        deltas.push(`total       PPM=${ppmTotal.toFixed(2)}  CRM=${crmGross.toFixed(2)} `
          + `(${Number(found.total_price).toFixed(2)} + ${Number(found.mileage_cost).toFixed(2)} travel)`);
      }
      if (deltas.length) drifted.push({ ref, client: row['Client name'] || '', deltas });
    }

    const crmOnly = crmRows.filter((r) => !seen.has(r.reference.trim().toUpperCase()));

    console.log(`PPM export:   ${rows.length} rows`);
    console.log(`CRM bookings: ${crmRows.length} with a reference\n`);

    console.log(`── MISSING from CRM (${missing.length}) — lost if the button moves now`);
    for (const m of missing) {
      console.log(`   ${m.ref.padEnd(10)} ${(m.date || '(no date)').padEnd(12)} ${m.status.padEnd(10)} $${m.total.toFixed(2).padStart(9)}  ${m.client}`);
    }

    console.log(`\n── DRIFTED (${drifted.length}) — each needs a call; see the header note`);
    for (const d of drifted) {
      console.log(`   ${d.ref.padEnd(10)} ${d.client}`);
      for (const delta of d.deltas) console.log(`      ${delta}`);
    }

    console.log(`\n── CRM-only (${crmOnly.length}) — expected: CRM-native bookings + PPM's archived history`);
    if (VERBOSE) {
      for (const c of crmOnly) console.log(`   ${c.reference.padEnd(12)} ${c.event_date}  ${c.status}`);
    } else {
      console.log('   (re-run with --verbose to list)');
    }

    console.log('\nCutover is safe when MISSING is 0 and every DRIFTED row has been');
    console.log('reconciled by hand or accepted as known.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
