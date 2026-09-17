#!/usr/bin/env node
// Fills zip_coords for every ZIP the bookings table uses, and sets the home
// base if it has never been set.
//
// Why run this once rather than letting each booking fill itself: measured
// 2026-09-17, 184 of 393 bookings (46.8%) sat outside the 67-ZIP table —
// including 73012 in Edmond with 20 bookings — so all of them showed a
// 30-minute drive estimate whatever the real distance. spanFor fills a ZIP the
// first time that booking is scheduled, which would leave the back catalogue
// wrong indefinitely.
//
// Read-only by default. Pass --apply to write.
//
//   node scripts/backfill-zip-coords.js            # report
//   node scripts/backfill-zip-coords.js --apply    # look up and store

const fsm = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) {
  const envPath = path.join(__dirname, '..', '.env');
  const m = fsm.existsSync(envPath) && fsm.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '');
}
const { Pool } = require('pg');
const geo = require('../netlify/functions/_geo');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await geo.ensureZipTable(client);

    const { rows } = await client.query(
      "SELECT event_zip AS zip, count(*)::int n FROM bookings " +
      "WHERE coalesce(event_zip,'') <> '' AND status NOT IN ('cancelled','draft') " +
      "GROUP BY event_zip ORDER BY n DESC");
    const zips = rows.map((r) => geo.normZip(r.zip)).filter(Boolean);
    const known = await geo.loadZipCoords(client, zips);
    const missing = [...new Set(zips)].filter((z) => !known.has(z));
    const affected = rows
      .filter((r) => missing.includes(geo.normZip(r.zip)))
      .reduce((t, r) => t + r.n, 0);

    console.log('ZIPs in use: ' + new Set(zips).size
      + ' | already known: ' + (new Set(zips).size - missing.length)
      + ' | missing: ' + missing.length);
    console.log('bookings currently falling back to a 30-minute estimate: ' + affected);
    if (!missing.length) { console.log('nothing to do'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to look up and store ' + missing.length + ' ZIPs'); return; }

    let found = 0, notFound = 0, failed = 0;
    for (const zip of missing) {
      const res = await geo.fetchZipCoords(zip);
      if (res === undefined) {
        failed++;
        console.log('  ' + zip + '  lookup failed — left unknown so it is retried');
        continue;
      }
      await client.query(
        'INSERT INTO zip_coords (zip, lat, lng, source) VALUES ($1,$2,$3,$4) ON CONFLICT (zip) DO NOTHING',
        [zip, res ? res.lat : null, res ? res.lng : null, res ? 'zippopotam' : 'not_found']);
      if (res) found++;
      else { notFound++; console.log('  ' + zip + '  not a real ZIP — cached as not_found'); }
      // Gentle on a free service doing us a favour.
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log('\nstored: ' + found + ' | not a real ZIP: ' + notFound + ' | lookup failed (will retry): ' + failed);

    const { rows: hb } = await client.query('SELECT value FROM admin_settings WHERE key=$1', [geo.HOME_SETTING_KEY]);
    if (!hb.length) {
      await client.query(
        'INSERT INTO admin_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
        [geo.HOME_SETTING_KEY, JSON.stringify(geo.HOME_FALLBACK)]);
      console.log('home base written to admin_settings: ' + JSON.stringify(geo.HOME_FALLBACK));
    } else {
      console.log('home base already set: ' + hb[0].value);
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
