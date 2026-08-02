#!/usr/bin/env node
/**
 * One-off: correct the bookings whose total_price double-counts mileage.
 *
 * Context: docs/superpowers/specs/2026-07-31-crm-takeover-design.md Phase 3,
 * Task 7b. Surfaced by scripts/backfill-booking-items.js's own dry run: 83 of
 * 667 bookings store total_price INCLUDING mileage_cost, when every formula
 * in the codebase (bookings.js:329, booking.js:196-197) assumes total_price
 * EXCLUDES it — `balance_due = max(0, total_price + mileage_cost - deposit)`.
 * The backfill faithfully copied that defect into a balancing booking_items
 * line (kind='custom', name='Unitemised balance (pre-Phase-3 import)'), so
 * travel is now double-recorded: once as a 'travel' item, once folded into
 * that line. Fixing bookings alone would leave the items still wrong.
 *
 * Nobody has been overcharged today — balance_due was computed correctly at
 * the time it was stored and is left untouched here. The exposure is that
 * Task 3 makes total_price recompute on every quote edit, and the very first
 * edit of one of these bookings would inflate its balance by the mileage
 * amount. This script closes that before Task 3 ships, by making total_price
 * agree with the invariant total_price = service_price + addon_total, same
 * as the other 481/564 bookings that already reconcile.
 *
 * Per qualifying booking:
 *   - total_price := total_price - mileage_cost
 *   - the balancing item's price := new_total_price - (billable items excl.
 *     travel and excl. the balancing line itself); deleted if that is <= 1c
 *
 * Nothing else moves. mileage_cost, service_price, addon_total,
 * deposit_amount, balance_due, and every service/travel item are read-only
 * here — see the REQUIREMENT 7 comment below for why balance_due in
 * particular must not be touched, and how that fact is used as a check
 * rather than an assumption.
 *
 * Dry run (default) prints a report and writes nothing:
 *   node scripts/normalise-mileage-totals.js
 *
 * Apply, only after a human has reviewed the dry-run numbers:
 *   node scripts/normalise-mileage-totals.js --apply
 *
 * Rollback — restores exactly the rows this script's own snapshot covers:
 *   node scripts/normalise-mileage-totals.js --rollback
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
const { getItems } = require('../netlify/functions/_items');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd',
  '2026-08-01-crm-takeover-phase-3', 'mileage-normalise-rollback.json');

const BALANCING_NAME = 'Unitemised balance (pre-Phase-3 import)';
const TOLERANCE = 0.005;

const round2 = (n) => +(Number(n) || 0).toFixed(2);
// Mirrors _items.js's private lineTotal() — not exported, so reproduced here
// rather than reaching into the module's internals for one multiplication.
const lineTotal = (i) => round2(i.price) * Math.max(1, Number(i.quantity) || 1);

// A booking known to be a designated test fixture the final Phase 3 gate
// depends on. It must never be touched by this script. It is not expected
// to match the candidate query (its total_price already excludes mileage),
// but that is verified below rather than assumed — see the hard-abort after
// candidate selection.
const PROTECTED_ID = 717;
const PROTECTED_REF = 'FM-E5EFPPQX';

async function main() {
  const client = await pool.connect();
  try {
    if (ROLLBACK) return rollback(client);

    // ── REQUIREMENT 1: select only the simple case ──────────────────────────
    // A booking qualifies only when its stored total_price already equals
    // service_price + addon_total + mileage_cost to the cent, i.e. the ONLY
    // thing wrong with it is that mileage got folded in. Anything else — a
    // multi-service package, a manual discount, a genuinely inconsistent
    // legacy row — is left alone; guessing at those would be exactly the
    // mistake this task exists to avoid repeating.
    //
    // status is compared with COALESCE(status,'') rather than relying on
    // "status IS NOT NULL" — on this schema that is a dead test (every text
    // column defaults to a non-null value), so a genuinely blank status would
    // silently pass an IS NOT NULL check and just as silently vanish from a
    // NOT IN (...) filter, since NULL NOT IN (...) is NULL, not TRUE.
    const { rows: candidates } = await client.query(`
      SELECT id, reference, COALESCE(status,'') AS status, COALESCE(client_name,'') AS client_name,
             service_price::float8 AS service_price, addon_total::float8 AS addon_total,
             mileage_cost::float8 AS mileage_cost, total_price::float8 AS total_price,
             deposit_amount::float8 AS deposit_amount, balance_due::float8 AS balance_due
      FROM bookings
      WHERE mileage_cost > 0
        AND ABS((service_price + addon_total + mileage_cost) - total_price) <= ${TOLERANCE}
      ORDER BY id
    `);

    // ── context requirement 6: never touch the protected fixture ───────────
    const hit = candidates.find(c => c.id === PROTECTED_ID || c.reference === PROTECTED_REF);
    if (hit) {
      console.error(
        `SAFETY ABORT: booking ${PROTECTED_ID} / ${PROTECTED_REF} matched the candidate ` +
        'query. That booking is a protected test fixture and must never be written by ' +
        'this script. Aborting before any further work.'
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Selection excludes booking ${PROTECTED_ID} / ${PROTECTED_REF} — confirmed: ` +
      `not present among ${candidates.length} candidates.`
    );

    if (!candidates.length) {
      console.log('No candidates match. Nothing to do.');
      return;
    }

    // For each candidate, load its items and locate the one balancing line.
    // anomalies are shapes the brief didn't anticipate (no line, or more than
    // one) — refused for the same reason as a balance_due mismatch: this
    // script fixes the documented simple case only, never "most of" a batch.
    const plans = [];
    const anomalies = [];
    const refusals = [];

    for (const b of candidates) {
      const items = await getItems(client, b.id);
      const balancingLines = items.filter(i => i.kind === 'custom' && i.name === BALANCING_NAME);

      if (balancingLines.length !== 1) {
        anomalies.push({
          reference: b.reference, id: b.id,
          balancing_lines_found: balancingLines.length,
        });
        continue;
      }
      const line = balancingLines[0];

      const mileage = round2(b.mileage_cost);
      const newTotalPrice = round2(b.total_price - mileage);

      // ── REQUIREMENT: recompute the balancing line ───────────────────────
      const nonTravelNonBalancing = items
        .filter(i => i.kind !== 'travel' && i.id !== line.id)
        .reduce((s, i) => s + lineTotal(i), 0);
      const newLinePrice = round2(newTotalPrice - nonTravelNonBalancing);
      const deleteLine = newLinePrice <= TOLERANCE;

      // ── REQUIREMENT 2: refuse rather than guess ─────────────────────────
      // balance_due is never written by this script. It was computed
      // correctly at the time it was stored — total_price + mileage_cost -
      // deposit, where the *effective* total_price already excluded mileage
      // even though the stored column didn't. Substituting the new stored
      // total_price back into that same formula must reproduce the exact
      // number already on the row:
      //   new_total + mileage - deposit
      //     = (old_total - mileage) + mileage - deposit
      //     = old_total - deposit
      // which is what the correct total already implied. If it does not
      // reproduce, this row is not the simple case this script understands,
      // and the whole batch is refused rather than applying to "most" of it.
      const expectedBalanceDue = round2(Math.max(0, newTotalPrice + mileage - b.deposit_amount));
      const storedBalanceDue = round2(b.balance_due);
      const balanceDrift = round2(expectedBalanceDue - storedBalanceDue);

      const plan = {
        id: b.id, reference: b.reference, status: b.status, client_name: b.client_name,
        mileage_cost: mileage, deposit_amount: round2(b.deposit_amount),
        total_price_before: round2(b.total_price), total_price_after: newTotalPrice,
        balance_due: storedBalanceDue, balance_due_expected: expectedBalanceDue,
        line_id: line.id, line_price_before: round2(line.price),
        line_price_after: deleteLine ? 0 : newLinePrice, deleteLine,
      };

      if (Math.abs(balanceDrift) > TOLERANCE) {
        refusals.push({ ...plan, balance_drift: balanceDrift });
        continue;
      }
      plans.push(plan);
    }

    if (anomalies.length) {
      console.log(`\n${anomalies.length} booking(s) had an unexpected balancing-line shape (refused):`);
      console.table(anomalies);
    }
    if (refusals.length) {
      console.log(`\n${refusals.length} booking(s) would change balance_due (refused):`);
      console.table(refusals);
    }
    if (anomalies.length || refusals.length) {
      console.error(
        `\nABORTED: ${anomalies.length + refusals.length} row(s) failed a safety check. ` +
        'Fix the data or narrow the query, then re-run. Nothing was written for any row ' +
        'in this batch, including the ones that looked fine.'
      );
      process.exitCode = 1;
      return;
    }

    // ── REQUIREMENT 5: dry-run report ───────────────────────────────────────
    const aggregateReduction = round2(plans.reduce((s, p) => s + (p.total_price_before - p.total_price_after), 0));
    const reducedCount = plans.filter(p => !p.deleteLine).length;
    const deletedCount = plans.filter(p => p.deleteLine).length;

    console.log(`\n${plans.length} candidate booking(s).`);
    console.log(`Aggregate total_price reduction: $${aggregateReduction.toFixed(2)}`);
    console.log(`Balancing lines: ${reducedCount} reduced, ${deletedCount} deleted.`);

    // "At-risk open bookings": still owed money, and not closed out, so the
    // very next quote edit — which Task 3 makes recompute total_price from
    // items — would have inflated balance_due by the mileage amount had this
    // script not run first. Shown as before (today) / after (what it would
    // have become) to make the exposure legible, not because "after" is ever
    // written anywhere.
    const atRisk = plans
      .filter(p => p.balance_due > TOLERANCE && !['completed', 'cancelled'].includes(p.status))
      .map(p => ({
        reference: p.reference, client_name: p.client_name, status: p.status,
        mileage_cost: p.mileage_cost,
        balance_due_before: p.balance_due,
        balance_due_if_unfixed_edit: round2(p.balance_due + p.mileage_cost),
      }))
      .sort((a, b) => b.mileage_cost - a.mileage_cost);

    console.log(`\n${atRisk.length} at-risk open booking(s) — unpaid and not completed/cancelled:`);
    console.table(atRisk);

    if (!APPLY) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply after review.');
      return;
    }

    // ── REQUIREMENT 3: snapshot before BEGIN ────────────────────────────────
    // Written before the transaction opens, so the only failure state
    // reachable between here and COMMIT is "snapshot exists, nothing in the
    // database changed yet" — a failed write rolls back to a state the
    // snapshot already describes, harmlessly.
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify({
      written_at: new Date().toISOString(),
      bookings: plans.map(p => ({
        id: p.id, total_price: p.total_price_before, balance_due: p.balance_due,
        line: { id: p.line_id, price: p.line_price_before },
      })),
    }, null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    // ── REQUIREMENT 4: one transaction for the whole batch ──────────────────
    await client.query('BEGIN');
    let deleted = 0, updated = 0;
    for (const p of plans) {
      // REQUIREMENT 7: only total_price on bookings, only the balancing line
      // on booking_items. mileage_cost/service_price/addon_total/
      // deposit_amount/balance_due and every service/travel item are never
      // referenced in a write below.
      await client.query('UPDATE bookings SET total_price = $1, updated_at = NOW() WHERE id = $2',
        [p.total_price_after, p.id]);
      if (p.deleteLine) {
        await client.query('DELETE FROM booking_items WHERE id = $1', [p.line_id]);
        deleted++;
      } else {
        await client.query('UPDATE booking_items SET price = $1 WHERE id = $2',
          [p.line_price_after, p.line_id]);
        updated++;
      }
    }
    await client.query('COMMIT');
    console.log(`\nApplied: ${plans.length} booking(s) updated, ${deleted} balancing line(s) deleted, ${updated} reduced.`);
    console.log('Verify independently before trusting this — see task-7b-brief.md Step 4.');
  } finally {
    client.release();
  }
}

async function rollback(client) {
  if (!fs.existsSync(SNAPSHOT)) {
    console.error('No snapshot at ' + SNAPSHOT + ' — nothing to roll back.');
    process.exitCode = 1;
    return;
  }
  // Restores by the ids captured in the snapshot, not by any provenance mark
  // on the rows — same limitation scripts/backfill-booking-items.js accepts
  // for the same reason. Safe as long as nothing else has touched these
  // bookings' total_price or this specific balancing line since --apply. If
  // the line was deleted, it is re-inserted with a new id (SERIAL — the old
  // id cannot be reused) but identical booking_id/name/price/kind/sort_order,
  // which is all any caller keys off.
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  await client.query('BEGIN');
  let restoredTotals = 0, restoredLines = 0, reinsertedLines = 0;
  for (const b of snap.bookings) {
    await client.query('UPDATE bookings SET total_price = $1, updated_at = NOW() WHERE id = $2',
      [b.total_price, b.id]);
    restoredTotals++;

    const { rows: existing } = await client.query('SELECT id FROM booking_items WHERE id = $1', [b.line.id]);
    if (existing.length) {
      await client.query('UPDATE booking_items SET price = $1 WHERE id = $2', [b.line.price, b.line.id]);
      restoredLines++;
    } else {
      await client.query(
        `INSERT INTO booking_items (booking_id, service_id, name, price, quantity, kind, sort_order)
         VALUES ($1, '', $2, $3, 1, 'custom', 999)`,
        [b.id, BALANCING_NAME, b.line.price]
      );
      reinsertedLines++;
    }
  }
  await client.query('COMMIT');
  console.log(
    `Rolled back ${restoredTotals} booking(s): ${restoredLines} balancing line(s) price-restored, ` +
    `${reinsertedLines} re-inserted (had been deleted).`
  );
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
