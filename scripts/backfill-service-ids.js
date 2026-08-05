#!/usr/bin/env node
/**
 * Link legacy bookings to their catalogue service.
 *
 * Why: staff_slots is keyed on services.service_id, and the admin's staff panel
 * finds a booking's roles with `JOIN bookings b ON b.service_id = ss.service_id`
 * (staff-assignments.js). The PPM importer never wrote service_id — it only
 * wrote the free-text service_name — so 664 of 668 bookings join to zero slots
 * and the panel reports "No Staff Requirements Configured" for services whose
 * roles are configured perfectly well. Same NULL also stops
 * notifyStaffForBooking() from emailing anyone about the gig.
 *
 * Both columns are written, deliberately:
 *   booking_items.service_id — rollupItems() derives bookings.service_id from
 *     the first 'service' item on every quote save, so writing only the
 *     bookings column would be silently reverted by the next edit.
 *   bookings.service_id      — what the slot join actually reads.
 *
 * Only the link is touched. No price, name, status or item is modified.
 *
 * Dry run (default) prints what would change and writes nothing:
 *   node scripts/backfill-service-ids.js
 *
 * Apply, after reading the dry run:
 *   node scripts/backfill-service-ids.js --apply
 *
 * Re-runnable: it only fills blanks, so run it again after each PPM import.
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
// Shared with import-bookings.js so intake and backfill can never disagree
// about which catalogue entry a legacy name means.
const { NAME_TO_SERVICE, resolveServiceId } = require('../netlify/functions/_service-map');

const APPLY = process.argv.includes('--apply');


async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    // A typo in the map would link bookings to a service_id that owns no slots,
    // reproducing the exact bug this fixes but with no clue why. Fail first.
    const { rows: catalogue } = await client.query('SELECT service_id FROM services');
    const known = new Set(catalogue.map((s) => s.service_id));
    const bogus = [...new Set(Object.values(NAME_TO_SERVICE))].filter((id) => !known.has(id));
    if (bogus.length) throw new Error(`map points at service_ids not in the catalogue: ${bogus.join(', ')}`);

    const { rows: bookings } = await client.query(
      `SELECT id, service_name, status FROM bookings
       WHERE COALESCE(service_id, '') = '' ORDER BY id`
    );

    const matched = [];
    const unmapped = new Map();
    for (const b of bookings) {
      const serviceId = resolveServiceId(b.service_name);
      if (serviceId) matched.push({ ...b, serviceId });
      else unmapped.set(b.service_name, (unmapped.get(b.service_name) || 0) + 1);
    }

    const byService = {};
    for (const m of matched) byService[m.serviceId] = (byService[m.serviceId] || 0) + 1;

    console.log(`${bookings.length} bookings with no catalogue link`);
    console.log(`  ${matched.length} resolvable by name:`);
    for (const [id, n] of Object.entries(byService).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  → ${id}`);
    }
    console.log(`  ${bookings.length - matched.length} need a human (decide in Quote Breakdown):`);
    for (const [name, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${name}`);
    }

    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to write.');
      return;
    }

    await client.query('BEGIN');
    for (const m of matched) {
      // Lowest sort_order service line is the one rollupItems() reads back.
      await client.query(
        `UPDATE booking_items SET service_id = $1
         WHERE id = (
           SELECT id FROM booking_items
           WHERE booking_id = $2 AND kind = 'service' AND COALESCE(service_id, '') = ''
           ORDER BY sort_order, id LIMIT 1
         )`,
        [m.serviceId, m.id]
      );
      await client.query('UPDATE bookings SET service_id = $1 WHERE id = $2', [m.serviceId, m.id]);
    }
    await client.query('COMMIT');
    console.log(`\nLinked ${matched.length} bookings.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// The name matcher itself is covered by test/service-map.test.js, since it now
// backs import-bookings.js at intake as well as this one-off.
main().catch((e) => { console.error(e.message); process.exit(1); });
