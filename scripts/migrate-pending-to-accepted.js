#!/usr/bin/env node
/**
 * One-off: move the legacy `pending` status onto the new `accepted` rung.
 *
 * Context: spec docs/superpowers/specs/2026-08-01-admin-direct-entry-design.md
 * replaces the five-status model with seven — draft, review, quoted, accepted,
 * confirmed, completed, cancelled. `pending` is not among them.
 *
 * As of 2026-08-01 nine live bookings hold `pending`. Every one has a Stripe
 * deposit link already sent and no deposit paid, which is exactly what the new
 * `accepted` rung means: the client said yes, the money has not landed.
 *
 * Dry run (default) prints what would change and writes nothing:
 *   node scripts/migrate-pending-to-accepted.js
 *
 * Apply, after reading the dry run:
 *   node scripts/migrate-pending-to-accepted.js --apply
 *
 * Rollback — the snapshot written by --apply lists every reference touched:
 *   node scripts/migrate-pending-to-accepted.js --rollback
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
// The guard below refuses any booking with no deposit link sent, because
// 'accepted' asserts the client said yes and an unsent link is no evidence of
// that. On 2026-08-01 the owner reviewed all nine rows and confirmed from
// memory that these clients did verbally agree — the link simply never went
// out. This flag records that ruling explicitly rather than deleting the
// guard, so a future run of this script still refuses by default.
const ACCEPT_WITHOUT_LINK = process.argv.includes('--accept-without-link');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd',
  '2026-08-01-admin-direct-entry', 'pending-rollback.json');

async function main() {
  if (ROLLBACK) {
    if (!fs.existsSync(SNAPSHOT)) {
      console.error('No snapshot at ' + SNAPSHOT + ' — nothing to roll back.');
      process.exit(1);
    }
    const refs = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).map(r => r.reference);
    const r = await pool.query(
      "UPDATE bookings SET status='pending', updated_at=NOW() WHERE reference = ANY($1) AND status='accepted'",
      [refs]
    );
    console.log(`Rolled back ${r.rowCount} of ${refs.length} bookings to 'pending'.`);
    return;
  }

  const { rows } = await pool.query(
    `SELECT reference, client_name, event_date::text AS event_date, total_price,
            deposit_paid, (COALESCE(stripe_payment_link,'') <> '') AS has_link
     FROM bookings WHERE status='pending' ORDER BY event_date`
  );

  if (!rows.length) {
    console.log("No bookings hold status 'pending'. Nothing to do.");
    return;
  }

  console.table(rows);

  // Safety: the mapping to `accepted` is only honest for bookings that were
  // actually sent a deposit request and have not paid. Anything else needs a
  // human decision, so refuse the whole batch rather than guess per row.
  // An already-paid booking is never 'accepted' — that is a fact in the data,
  // not a judgement call, so no flag overrides it.
  const paid = rows.filter(r => r.deposit_paid);
  if (paid.length) {
    console.error(
      `\nRefusing to migrate: ${paid.length} of ${rows.length} bookings already have ` +
      `a paid deposit, so 'accepted' would misdescribe them. Resolve those by hand ` +
      `(${paid.map(r => r.reference).join(', ')}).`
    );
    process.exit(1);
  }

  // A missing deposit link is weaker evidence — it means no payment request was
  // ever sent, which does not prove the client declined. Refuse by default, but
  // let the owner override with an explicit flag after reviewing the rows above.
  const noLink = rows.filter(r => !r.has_link);
  if (noLink.length && !ACCEPT_WITHOUT_LINK) {
    console.error(
      `\nRefusing to migrate: ${noLink.length} of ${rows.length} bookings have no ` +
      `deposit link sent, so 'accepted' asserts something the data does not show.\n` +
      `If you know these clients did verbally agree, re-run with ` +
      `--accept-without-link to record that ruling explicitly:\n` +
      `  node scripts/migrate-pending-to-accepted.js --apply --accept-without-link`
    );
    process.exit(1);
  }
  if (noLink.length) {
    console.log(
      `\nNote: ${noLink.length} booking(s) have no deposit link sent. Proceeding on ` +
      `the owner's explicit --accept-without-link ruling. They will surface in the ` +
      `dashboard's Deposit queue, which lists accepted bookings with no link.`
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — would move ${rows.length} bookings from 'pending' to 'accepted'.`);
    console.log('Re-run with --apply to write.');
    return;
  }

  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(rows.map(r => ({ reference: r.reference, status: 'pending' })), null, 2));
  console.log(`\nSnapshot written to ${SNAPSHOT}`);

  const r = await pool.query(
    "UPDATE bookings SET status='accepted', updated_at=NOW() WHERE status='pending' RETURNING reference"
  );
  console.log(`Migrated ${r.rowCount} bookings to 'accepted': ${r.rows.map(x => x.reference).join(', ')}`);
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
