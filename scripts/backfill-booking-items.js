#!/usr/bin/env node
/**
 * One-off: give every existing booking a booking_items representation.
 *
 * Context: docs/superpowers/specs/2026-07-31-crm-takeover-design.md Phase 3.
 *
 * Per booking this writes:
 *   - one 'service' item from service_name / service_price / service_id
 *   - one 'addon'   item per entry in the addons JSONB
 *   - one 'travel'  item when mileage_cost > 0
 *
 * That is more than "one item each" deliberately: generate-invoice.js reads
 * items in preference to the legacy columns once this ships, so a booking with
 * addons would lose those lines from its invoice if only the service row were
 * written.
 *
 * The legacy columns are NOT touched. This is additive and reversible.
 *
 * Dry run (default) prints a summary and writes nothing:
 *   node scripts/backfill-booking-items.js
 *
 * Apply, after reading the dry run:
 *   node scripts/backfill-booking-items.js --apply
 *
 * Rollback — deletes only the rows this script created. Past its shelf life
 * now that replaceItems() (Task 3) has shipped: it deletes by booking_id
 * membership in the snapshot, with no way to tell a backfilled row from one
 * a since-edited quote replaced. Refuses by default; requires an explicit
 * override once a quote edit could have happened:
 *   node scripts/backfill-booking-items.js --rollback --accept-clobber-risk
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
const { ensureBookingItems, normaliseItems, rollupItems } = require('../netlify/functions/_items');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
// replaceItems() (Task 3) has shipped, so booking_items rows can now be
// legitimate quote edits made since --apply, not just this script's own
// output. The rollback below can't tell those apart — it deletes by
// booking_id membership in the snapshot only — so it refuses by default
// and requires the operator to assert, explicitly, that they accept the
// risk of deleting a since-edited quote. Same shape as
// migrate-pending-to-accepted.js's --accept-without-link.
const ACCEPT_CLOBBER_RISK = process.argv.includes('--accept-clobber-risk');
const SNAPSHOT = path.join(__dirname, '..', '.superpowers', 'sdd',
  '2026-08-01-crm-takeover-phase-3', 'booking-items-rollback.json');

// Build the item list for one booking row from its legacy columns.
function itemsFor(b) {
  const items = [];

  // COALESCE(col,'') <> '' rather than IS NOT NULL — every text column in this
  // schema is DEFAULT '', so IS NOT NULL is a dead test. See the silent-failure
  // memory, instance 6.
  const name = String(b.service_name || '').trim();
  if (name !== '') {
    items.push({ service_id: b.service_id || '', name, price: Number(b.service_price || 0), quantity: 1, kind: 'service' });
  }

  const addons = Array.isArray(b.addons) ? b.addons : [];
  for (const a of addons) {
    const an = String((a && a.name) || '').trim();
    if (an !== '') items.push({ name: an, price: Number((a && a.price) || 0), quantity: 1, kind: 'addon' });
  }

  if (Number(b.mileage_cost || 0) > 0) {
    const miles = Number(b.mileage_miles || 0);
    items.push({ name: miles > 0 ? `Travel (${miles} miles)` : 'Travel', price: Number(b.mileage_cost), quantity: 1, kind: 'travel' });
  }

  // ── Balancing line ────────────────────────────────────────────────────────
  // Measured against production on 2026-08-01: of 667 bookings, only 481 have
  // total_price == service_price + addon_total. 164 carry MORE — $32,339.42 in
  // total — because the legacy schema had exactly one service slot, so
  // multi-service packages were folded into total_price with no line-item
  // trail. That unexplained money is the whole reason this phase exists.
  //
  // Without this line the backfilled items would under-explain the total, and
  // the first quote edit after Phase 3 ships would recompute total_price from
  // the items and silently delete the difference. Booking 24-329 would fall
  // from $3,000 to $875 because someone corrected a typo.
  //
  // Travel is excluded from the comparison because total_price excludes travel,
  // per the same rule rollupItems() follows.
  const billable = items
    .filter(i => i.kind !== 'travel')
    .reduce((s, i) => s + Number(i.price || 0) * Math.max(1, Number(i.quantity) || 1), 0);
  const gap = +(Number(b.total_price || 0) - billable).toFixed(2);
  if (gap > 0.005) {
    items.push({ name: 'Unitemised balance (pre-Phase-3 import)', price: gap, quantity: 1, kind: 'custom' });
  }
  // A negative gap cannot be represented — normaliseItems clamps price to >= 0,
  // and inventing a discount would be a guess about money. 22 bookings are in
  // that state (service_price exceeds total_price, mostly completed events
  // recorded with total_price = 0). They are reported by the dry run and left
  // alone deliberately: the data was already wrong before this script existed.

  return normaliseItems(items);
}

async function main() {
  const client = await pool.connect();
  try {
    if (ROLLBACK) {
      if (!fs.existsSync(SNAPSHOT)) {
        console.error('No snapshot at ' + SNAPSHOT + ' — nothing to roll back.');
        process.exit(1);
      }
      // This deletes by booking_id membership in the snapshot, not by any mark
      // on the rows themselves — there is no provenance column distinguishing
      // "this script wrote it" from "something else wrote it since". _items.js's
      // replaceItems() is delete-all-then-reinsert per booking, and Task 3's
      // quote-edit endpoint (booking.js) now calls it. Provenance tracking on
      // every row would exist only to serve a one-off script, which is not
      // worth a schema column — so the guard below is a flag, not a fix.
      // Task 3 shipped — replaceItems() has real call sites now, so any of
      // these booking_id's items could be a since-edited quote, not the
      // backfill's own output. Refuse by default; the flag is the operator
      // asserting, having checked, that nothing here has been hand-edited.
      if (!ACCEPT_CLOBBER_RISK) {
        console.error(
          'Refusing to roll back: Task 3\'s quote-edit endpoint has shipped, so ' +
          'booking_items rows for these booking ids may be legitimate quote edits ' +
          'made since --apply, not this script\'s own output. This rollback deletes ' +
          'by booking_id membership in the snapshot only — it cannot tell the two ' +
          'apart — so it would silently destroy any edited quote among them.\n' +
          'If you have checked that none of these bookings have been edited since ' +
          '--apply, re-run with --accept-clobber-risk to proceed:\n' +
          '  node scripts/backfill-booking-items.js --rollback --accept-clobber-risk'
        );
        process.exit(1);
      }
      console.log(
        'Proceeding on the operator\'s explicit --accept-clobber-risk ruling: ' +
        'rollback deletes booking_items by booking_id only — it cannot tell a ' +
        'backfilled row from one written later by a quote edit.'
      );
      const ids = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).ids;
      const r = await client.query('DELETE FROM booking_items WHERE booking_id = ANY($1)', [ids]);
      console.log(`Deleted ${r.rowCount} booking_items rows across ${ids.length} bookings.`);
      return;
    }

    await ensureBookingItems(client);

    // Only bookings with no items yet — the script is safe to re-run.
    const { rows } = await client.query(`
      SELECT b.id, b.reference, b.service_id, b.service_name, b.service_price,
             b.addons, b.addon_total, b.mileage_cost, b.mileage_miles, b.total_price
      FROM bookings b
      WHERE NOT EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = b.id)
      ORDER BY b.id
    `);

    if (!rows.length) {
      console.log('Every booking already has items. Nothing to do.');
      return;
    }

    // Report, before writing anything, every booking whose rolled-up total
    // would disagree with its stored total_price. These are the rows a human
    // needs to look at — a mismatch means the legacy columns were already
    // internally inconsistent, and the backfill will not invent agreement.
    const drift = [];
    let noService = 0, itemCount = 0;
    for (const b of rows) {
      const items = itemsFor(b);
      itemCount += items.length;
      if (!items.some(i => i.kind === 'service')) noService++;
      const rolled = rollupItems(items);
      const stored = Number(b.total_price || 0);
      if (Math.abs(rolled.total_price - stored) > 0.005) {
        drift.push({
          reference: b.reference, stored_total: stored,
          rolled_total: rolled.total_price, delta: +(rolled.total_price - stored).toFixed(2),
        });
      }
    }

    console.log(`\n${rows.length} bookings without items → ${itemCount} item rows would be written.`);
    console.log(`${noService} booking(s) have no service_name and will get no 'service' item.`);
    if (drift.length) {
      console.log(`\n${drift.length} booking(s) whose rolled-up total disagrees with stored total_price:`);
      console.table(drift.slice(0, 40));
      if (drift.length > 40) console.log(`… and ${drift.length - 40} more.`);
      console.log(
        '\nThis does NOT block the backfill — total_price is left untouched and remains\n' +
        'authoritative. It means those bookings carry a custom or negotiated price that\n' +
        'the line items do not explain. Review before clearing the deprecation window.'
      );
    }

    if (!APPLY) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply.');
      return;
    }

    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ written_at: new Date().toISOString(), ids: rows.map(r => r.id) }, null, 2));
    console.log(`\nSnapshot written to ${SNAPSHOT}`);

    await client.query('BEGIN');
    let written = 0;
    for (const b of rows) {
      for (const i of itemsFor(b)) {
        await client.query(
          `INSERT INTO booking_items (booking_id, service_id, name, price, quantity, kind, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [b.id, i.service_id, i.name, i.price, i.quantity, i.kind, i.sort_order]
        );
        written++;
      }
    }
    await client.query('COMMIT');
    console.log(`Wrote ${written} booking_items rows across ${rows.length} bookings.`);

    const { rows: check } = await client.query(
      'SELECT COUNT(DISTINCT booking_id)::int AS bookings, COUNT(*)::int AS items FROM booking_items'
    );
    console.log(`Verified: ${check[0].items} items across ${check[0].bookings} bookings.`);
  } finally {
    client.release();
  }
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
