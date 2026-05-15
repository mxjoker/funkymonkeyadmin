/**
 * backfill-assignment-times.js
 * One-time migration: calculate and save schedule times for all existing
 * staff_assignments that have no total_minutes yet.
 *
 * Run: node scripts/backfill-assignment-times.js
 * Requires DATABASE_URL in environment (copy from .env first).
 */

// Run: DATABASE_URL=<your_url> node scripts/backfill-assignment-times.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Same ZIP map + drive calc as staff-assignments.js ────────────────────────
const ZIP_COORDS = {
  '73099':{ lat:35.5176, lng:-97.7618 }, '73101':{ lat:35.4676, lng:-97.5164 },
  '73102':{ lat:35.4714, lng:-97.5169 }, '73103':{ lat:35.4869, lng:-97.5245 },
  '73104':{ lat:35.4781, lng:-97.5058 }, '73105':{ lat:35.4947, lng:-97.5112 },
  '73106':{ lat:35.4875, lng:-97.5411 }, '73107':{ lat:35.4786, lng:-97.5631 },
  '73108':{ lat:35.4531, lng:-97.5604 }, '73109':{ lat:35.4397, lng:-97.5245 },
  '73110':{ lat:35.4631, lng:-97.4203 }, '73111':{ lat:35.5061, lng:-97.4913 },
  '73112':{ lat:35.5008, lng:-97.5631 }, '73114':{ lat:35.5675, lng:-97.5245 },
  '73115':{ lat:35.4275, lng:-97.4581 }, '73116':{ lat:35.5397, lng:-97.5631 },
  '73117':{ lat:35.4841, lng:-97.4913 }, '73118':{ lat:35.5161, lng:-97.5411 },
  '73119':{ lat:35.4231, lng:-97.5631 }, '73120':{ lat:35.5675, lng:-97.5831 },
  '73121':{ lat:35.5008, lng:-97.4581 }, '73122':{ lat:35.5008, lng:-97.6031 },
  '73127':{ lat:35.4786, lng:-97.6431 }, '73128':{ lat:35.4397, lng:-97.6431 },
  '73129':{ lat:35.4231, lng:-97.4913 }, '73130':{ lat:35.4631, lng:-97.3803 },
  '73131':{ lat:35.5397, lng:-97.4581 }, '73132':{ lat:35.5397, lng:-97.6231 },
  '73134':{ lat:35.6097, lng:-97.5831 }, '73135':{ lat:35.3875, lng:-97.4581 },
  '73139':{ lat:35.3875, lng:-97.5245 }, '73142':{ lat:35.6097, lng:-97.6231 },
  '73149':{ lat:35.3875, lng:-97.4203 }, '73150':{ lat:35.4231, lng:-97.3803 },
  '73159':{ lat:35.3875, lng:-97.6031 }, '73160':{ lat:35.3275, lng:-97.5245 },
  '73162':{ lat:35.5675, lng:-97.6431 }, '73165':{ lat:35.3275, lng:-97.4203 },
  '73169':{ lat:35.3875, lng:-97.6431 }, '73170':{ lat:35.3275, lng:-97.6031 },
  '73179':{ lat:35.4397, lng:-97.6831 },
  '73003':{ lat:35.6597, lng:-97.4781 }, '73007':{ lat:35.6097, lng:-97.4203 },
  '73008':{ lat:35.5397, lng:-97.6831 }, '73013':{ lat:35.6397, lng:-97.5631 },
  '73020':{ lat:35.4631, lng:-97.2803 }, '73025':{ lat:35.6597, lng:-97.7418 },
  '73026':{ lat:35.2275, lng:-97.4413 }, '73034':{ lat:35.6597, lng:-97.3803 },
  '73044':{ lat:35.8597, lng:-97.4581 }, '73049':{ lat:35.4631, lng:-97.1803 },
  '73051':{ lat:35.1275, lng:-97.3803 }, '73054':{ lat:35.6097, lng:-97.2803 },
  '73059':{ lat:35.3275, lng:-97.8031 }, '73064':{ lat:35.4097, lng:-97.7618 },
  '73066':{ lat:35.5397, lng:-97.2803 }, '73069':{ lat:35.2275, lng:-97.2803 },
  '73071':{ lat:35.2275, lng:-97.4413 }, '73072':{ lat:35.2275, lng:-97.4413 },
  '73073':{ lat:36.1597, lng:-97.5831 }, '73074':{ lat:34.9275, lng:-97.4413 },
  '73078':{ lat:35.5675, lng:-97.7818 }, '73080':{ lat:35.2275, lng:-97.6031 },
  '73084':{ lat:35.5397, lng:-97.3803 }, '73089':{ lat:35.3275, lng:-97.7218 },
  '73093':{ lat:35.2275, lng:-97.5631 }, '73097':{ lat:35.3875, lng:-97.7218 },
};
const HOME_ZIP = '73118';

function getDriveMins(destZip) {
  const home = ZIP_COORDS[HOME_ZIP];
  const dest = ZIP_COORDS[(destZip || '').toString().substring(0, 5)];
  if (!home || !dest) return 30;
  const R = 3958.8;
  const dLat = (dest.lat - home.lat) * Math.PI / 180;
  const dLng = (dest.lng - home.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(home.lat*Math.PI/180)*Math.cos(dest.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.max(10, Math.round((miles / 35) * 60)) + 15;
}

async function run() {
  const client = await pool.connect();
  try {
    // Ensure migration columns exist before querying them
    const migrations = [
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS load_minutes INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS unload_minutes INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pack_out_minutes INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS home_unload_minutes INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS drive_minutes_each_way INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS total_minutes INTEGER",
      "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS schedule_start TIME",
      `CREATE TABLE IF NOT EXISTS service_time_templates (
        id SERIAL PRIMARY KEY, service_id VARCHAR(64) UNIQUE NOT NULL,
        load_minutes INTEGER DEFAULT 30, unload_minutes INTEGER DEFAULT 45,
        pack_out_minutes INTEGER DEFAULT 20, home_unload_minutes INTEGER DEFAULT 15,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
    ];
    for (const sql of migrations) {
      try { await client.query(sql); } catch(_) {}
    }
    console.log('Migrations applied.');

    const { rows: assignments } = await client.query(`
      SELECT sa.id, sa.booking_id, sa.staff_id,
             sa.load_minutes, sa.unload_minutes, sa.pack_out_minutes,
             sa.home_unload_minutes, sa.drive_minutes_each_way,
             b.service_id, b.event_time, b.event_zip
      FROM staff_assignments sa
      JOIN bookings b ON b.id = sa.booking_id
      WHERE sa.status = 'assigned'
        AND sa.total_minutes IS NULL
      ORDER BY sa.id
    `);

    console.log(`Found ${assignments.length} assignment(s) needing backfill`);
    if (!assignments.length) { console.log('Nothing to do.'); return; }

    const { rows: templates } = await client.query('SELECT * FROM service_time_templates');
    const tmplMap = {};
    templates.forEach(t => { tmplMap[t.service_id] = t; });

    const { rows: services } = await client.query('SELECT service_id, duration_minutes FROM services');
    const durMap = {};
    services.forEach(s => { durMap[s.service_id] = s.duration_minutes || 60; });

    let updated = 0, skipped = 0;

    for (const sa of assignments) {
      try {
        const tmpl  = tmplMap[sa.service_id] || {};
        const load   = sa.load_minutes          ?? tmpl.load_minutes          ?? 30;
        const setup  = sa.unload_minutes         ?? tmpl.unload_minutes         ?? 45;
        const pack   = sa.pack_out_minutes       ?? tmpl.pack_out_minutes       ?? 20;
        const homeUn = sa.home_unload_minutes    ?? tmpl.home_unload_minutes    ?? 15;
        const drive  = sa.drive_minutes_each_way ?? getDriveMins(sa.event_zip);
        const party  = durMap[sa.service_id]     ?? 60;
        const total  = load + drive + setup + party + pack + drive + homeUn;

        let scheduleStart = null;
        if (sa.event_time) {
          const [hh, mm] = sa.event_time.split(':').map(Number);
          const startMins = (hh * 60 + mm) - load - drive - setup;
          const sh = Math.floor(((startMins % 1440) + 1440) % 1440 / 60);
          const sm = ((startMins % 1440) + 1440) % 1440 % 60;
          scheduleStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
        }

        await client.query(`
          UPDATE staff_assignments SET
            load_minutes           = COALESCE(load_minutes, $1),
            unload_minutes         = COALESCE(unload_minutes, $2),
            pack_out_minutes       = COALESCE(pack_out_minutes, $3),
            home_unload_minutes    = COALESCE(home_unload_minutes, $4),
            drive_minutes_each_way = COALESCE(drive_minutes_each_way, $5),
            total_minutes          = $6,
            schedule_start         = $7,
            updated_at             = NOW()
          WHERE id = $8
        `, [load, setup, pack, homeUn, drive, total, scheduleStart, sa.id]);

        console.log(`  ✅ #${sa.id} → ${total} min total, start ${scheduleStart || 'N/A'}`);
        updated++;
      } catch(e) {
        console.error(`  ❌ #${sa.id} failed: ${e.message}`);
        skipped++;
      }
    }

    console.log(`\nDone. ${updated} updated, ${skipped} failed.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
