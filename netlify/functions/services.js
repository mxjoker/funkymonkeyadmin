const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const DEFAULT_SERVICES = [
  { service_id:'deluxe_magic',   category:'shows',       name:'Deluxe Birthday Magic Show',           price:385,  icon:'🎩', duration_minutes:45,  guest_suggestion:'Best for kids parties',        sort_order:1  },
  { service_id:'basic_magic',    category:'shows',       name:'Basic Birthday Magic Show',             price:345,  icon:'🎩', duration_minutes:30,  guest_suggestion:'Perfect for shorter slots',    sort_order:2  },
  { service_id:'corporate_magic',category:'shows',       name:'Corporate Magic Show',                  price:875,  icon:'✨', duration_minutes:45,  guest_suggestion:'Up to 300 guests',             sort_order:3  },
  { service_id:'game_show',      category:'shows',       name:'Game Show Champions',                   price:3500, icon:'🏆', duration_minutes:90,  guest_suggestion:'Great for 15-80 guests',       sort_order:4  },
  { service_id:'school_asm',     category:'shows',       name:'Magic School Assembly',                 price:385,  icon:'🏫', duration_minutes:45,  guest_suggestion:'Up to 500 students',           sort_order:5  },
  // $3,500, confirmed against the live catalogue 2026-08-12. This seed said
  // $385 — an order of magnitude out — which only ever showed up on a fresh
  // database, since the seed skips a table that already has rows. Fundraiser
  // bookings price differently again; $3,500 is the closest single number.
  { service_id:'dj_pinata',      category:'shows',       name:'DJ Piñata',                            price:3500, icon:'🎵', duration_minutes:120, guest_suggestion:'Perfect for 20-150 guests',    sort_order:6  },
  { service_id:'wedding_magic',  category:'shows',       name:'Walk-Around Cocktail Hour Magic',       price:900,  icon:'🪄', duration_minutes:90,  guest_suggestion:'Cocktail hour & receptions',   sort_order:7  },
  { service_id:'balloon_40',     category:'performers',  name:'Balloon Workshop — Up to 40 Kids',     price:345,  icon:'🎈', duration_minutes:30,  guest_suggestion:'Up to 40 kids',                sort_order:8  },
  { service_id:'balloon_60',     category:'performers',  name:'Balloon Workshop — 40–60 Kids',        price:385,  icon:'🎈', duration_minutes:30,  guest_suggestion:'40–60 kids',                   sort_order:9  },
  { service_id:'face_paint',     category:'performers',  name:'Face Painting',                         price:200,  icon:'🎨', duration_minutes:60,  guest_suggestion:'Approx. 30 guests per hour',   sort_order:10 },
  { service_id:'airbrush',       category:'performers',  name:'Airbrush Tattoos',                      price:200,  icon:'💨', duration_minutes:60,  guest_suggestion:'Approx. 30 tattoos per hour',  sort_order:11 },
  { service_id:'glitter',        category:'performers',  name:'Glitter Tattoos',                       price:200,  icon:'💫', duration_minutes:60,  guest_suggestion:'20–25 per hour',               sort_order:12 },
  { service_id:'foam_single',    category:'experiences', name:'Foam Party — Single Cannon',            price:385,  icon:'🫧', duration_minutes:45,  guest_suggestion:'Up to 30 kids',                sort_order:13 },
  { service_id:'foam_double',    category:'experiences', name:'Foam Party — Double Cannon',            price:730,  icon:'🫧', duration_minutes:45,  guest_suggestion:'30+ kids',                     sort_order:14 },
  { service_id:'snow_45',        category:'experiences', name:'Snow Party — 45 Minutes',               price:385,  icon:'❄️', duration_minutes:45,  guest_suggestion:'Any size party',               sort_order:15 },
  { service_id:'snow_90',        category:'experiences', name:'Snow Party — 90 Minutes',               price:525,  icon:'❄️', duration_minutes:90,  guest_suggestion:'Any size party',               sort_order:16 },
  { service_id:'cotton_candy',   category:'experiences', name:'Live Spun Cotton Candy',                price:385,  icon:'🍭', duration_minutes:120, guest_suggestion:'Any party size',               sort_order:17 },
  { service_id:'mini_donuts',    category:'experiences', name:'Hot & Fresh Mini Donuts',               price:385,  icon:'🍩', duration_minutes:120, guest_suggestion:'Any party size',               sort_order:18 },
  { service_id:'bubble_show',    category:'experiences', name:"Prof. Bucket's Bubble Show",            price:385,  icon:'🫧', duration_minutes:45,  guest_suggestion:'Any party size',               sort_order:19 },
  { service_id:'pb_kiosk_svc',   category:'experiences', name:'Digital Kiosk Photo Booth',             price:385,  icon:'📸', duration_minutes:120, guest_suggestion:'Any party size',               sort_order:20 },
  { service_id:'pb_360_svc',     category:'experiences', name:'360 Video Booth',                       price:385,  icon:'🎥', duration_minutes:120, guest_suggestion:'Any party size',               sort_order:21 },
  { service_id:'lib_magic',      category:'library',     name:'Library — Magic Show',                  price:345,  icon:'🎩', duration_minutes:45,  guest_suggestion:'Summer reading programs',       sort_order:22 },
  { service_id:'lib_balloon',    category:'library',     name:'Library — Balloon Workshop',            price:345,  icon:'🎈', duration_minutes:30,  guest_suggestion:'Summer reading programs',       sort_order:23 },
  { service_id:'lib_bubble',     category:'library',     name:"Library — Prof. Bucket's Bubble Show",  price:345,  icon:'🫧', duration_minutes:45,  guest_suggestion:'Summer reading programs',       sort_order:24 },
  { service_id:'lib_doodles',    category:'library',     name:'Library — Story-Doodles',               price:345,  icon:'✏️', duration_minutes:45,  guest_suggestion:'Summer reading programs',       sort_order:25 },
  { service_id:'lib_foam',       category:'library',     name:'Library — Foam Party',                  price:385,  icon:'🫧', duration_minutes:45,  guest_suggestion:'Summer reading programs',       sort_order:26 },
  { service_id:'lib_workshop',   category:'library',     name:'Library — Magic Workshop',              price:345,  icon:'🪄', duration_minutes:45,  guest_suggestion:'Summer reading programs',       sort_order:27 },
];

// Internal names for the calendar, staff sheets and admin lists — never shown
// to a customer, who keeps seeing `name`. The pattern is
// <thing> <duration> <variant>, so a phone at 8am says "Foam 45min Double
// Cannon" instead of "Foam Party — Double Cannon" with the length nowhere in
// sight. Backfilled below only where an admin has not already set one.
const SHORT_NAMES = {
  deluxe_magic:   'Magic 45min Deluxe',
  basic_magic:    'Magic 30min Basic',
  corporate_magic:'Magic 45min Corporate',
  game_show:      'Game Show 90min',
  school_asm:     'Magic 45min School Assembly',
  dj_pinata:      'DJ Piñata 2hr',
  wedding_magic:  'Magic 90min Walk-Around',
  balloon_40:     'Balloons 30min up to 40',
  balloon_60:     'Balloons 30min 40-60',
  face_paint:     'Face Paint 1hr',
  airbrush:       'Airbrush 1hr',
  glitter:        'Glitter Tattoos 1hr',
  foam_single:    'Foam 45min Single Cannon',
  foam_double:    'Foam 45min Double Cannon',
  snow_45:        'Snow 45min',
  snow_90:        'Snow 90min',
  cotton_candy:   'Cotton Candy 2hr',
  mini_donuts:    'Mini Donuts 2hr',
  bubble_show:    'Bubble Show 45min',
  pb_kiosk_svc:   'Photo Booth 2hr Kiosk',
  pb_360_svc:     'Photo Booth 2hr 360',
  lib_magic:      'Library Magic 45min',
  lib_balloon:    'Library Balloons 30min',
  lib_bubble:     'Library Bubble Show 45min',
  lib_doodles:    'Library Story-Doodles 45min',
  lib_foam:       'Library Foam 45min',
  lib_workshop:   'Library Magic Workshop 45min',
};

// Labels for the four category ids that existed before categories became
// editable records. The seed below derives its rows from whatever categories
// the services table actually uses, so a live database keeps rendering exactly
// as it did; these just supply a human label for the ids we already know.
// Anything unrecognised seeds under its own id as the label.
const KNOWN_CATEGORY_LABELS = {
  shows:       { label: 'Main Shows',          icon: '🎩', sort_order: 1 },
  performers:  { label: 'Add-On Entertainers', icon: '🎨', sort_order: 2 },
  experiences: { label: 'Party Experiences',   icon: '🎊', sort_order: 3 },
  library:     { label: 'Library Programs',    icon: '📚', sort_order: 4 },
};

const DEFAULT_ADDONS = [
  { addon_id:'extra_hour',       name:'Extra Hour',        price:85,  sort_order:1 },
  { addon_id:'glitter_addon',    name:'Glitter Tattoos',   price:75,  sort_order:2 },
  { addon_id:'balloon_addon',    name:'Balloon Animals',   price:75,  sort_order:3 },
  { addon_id:'photo_booth',      name:'Photo Booth',       price:150, sort_order:4 },
  { addon_id:'second_performer', name:'Second Performer',  price:175, sort_order:5 }
];

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS service_addons (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) NOT NULL,
      addon_id VARCHAR(64) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(service_id, addon_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS service_event_types (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) NOT NULL,
      event_type_id VARCHAR(64) NOT NULL,
      UNIQUE(service_id, event_type_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) UNIQUE NOT NULL,
      category VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      short_name VARCHAR(120) DEFAULT '',
      price NUMERIC(10,2) NOT NULL,
      icon VARCHAR(32) DEFAULT '🎪',
      duration_minutes INTEGER DEFAULT 120,
      guest_suggestion VARCHAR(255) DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS addons (
      id SERIAL PRIMARY KEY,
      addon_id VARCHAR(64) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // CREATE TABLE only fires on an empty database; a live one needs the column
  // added explicitly.
  await client.query("ALTER TABLE services ADD COLUMN IF NOT EXISTS short_name VARCHAR(120) DEFAULT ''");

  await client.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      category_id VARCHAR(64) UNIQUE NOT NULL,
      label VARCHAR(255) NOT NULL,
      icon VARCHAR(32) DEFAULT '✨',
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0
    )
  `);

  const { rows: svcCount } = await client.query('SELECT COUNT(*) FROM services');
  if (parseInt(svcCount[0].count) === 0) {
    for (const s of DEFAULT_SERVICES) {
      await client.query(
        `INSERT INTO services (service_id, category, name, price, icon, duration_minutes, guest_suggestion, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (service_id) DO NOTHING`,
        [s.service_id, s.category, s.name, s.price, s.icon, s.duration_minutes, s.guest_suggestion, s.sort_order]
      );
    }
  }

  // Backfill internal short names, but never overwrite one an admin has set —
  // hence the COALESCE guard in the WHERE. One statement rather than 27, and
  // skipped entirely once every row has a name, because ensureTables runs on
  // every request.
  const { rows: shortGap } = await client.query(
    "SELECT COUNT(*) FROM services WHERE COALESCE(short_name,'') = ''"
  );
  if (parseInt(shortGap[0].count) > 0) {
    const entries = Object.entries(SHORT_NAMES);
    const values = entries.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',');
    await client.query(
      `UPDATE services s SET short_name = v.short_name
         FROM (VALUES ${values}) AS v(service_id, short_name)
        WHERE s.service_id = v.service_id AND COALESCE(s.short_name,'') = ''`,
      entries.flat()
    );
  }

  // Seed categories from the categories the services table is ALREADY using,
  // rather than from a hardcoded list. A live database whose services sit in
  // 'shows'/'performers'/'experiences'/'library' gets exactly those four rows
  // back, so switching the UI over to this table changes nothing on screen —
  // renaming and re-sorting is then done in the admin UI, not in a deploy.
  const { rows: catCount } = await client.query('SELECT COUNT(*) FROM categories');
  if (parseInt(catCount[0].count) === 0) {
    const { rows: used } = await client.query(
      `SELECT DISTINCT category FROM services WHERE COALESCE(category,'') <> '' ORDER BY category`
    );
    let fallbackOrder = 100;
    for (const { category } of used) {
      const known = KNOWN_CATEGORY_LABELS[category];
      await client.query(
        `INSERT INTO categories (category_id, label, icon, sort_order)
         VALUES ($1,$2,$3,$4) ON CONFLICT (category_id) DO NOTHING`,
        [category, known ? known.label : category, known ? known.icon : '✨',
         known ? known.sort_order : fallbackOrder++]
      );
    }
  }

  const { rows: addonCount } = await client.query('SELECT COUNT(*) FROM addons');
  if (parseInt(addonCount[0].count) === 0) {
    for (const a of DEFAULT_ADDONS) {
      await client.query(
        `INSERT INTO addons (addon_id, name, price, sort_order)
         VALUES ($1,$2,$3,$4) ON CONFLICT (addon_id) DO NOTHING`,
        [a.addon_id, a.name, a.price, a.sort_order]
      );
    }
  }
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // GET is public (booking form needs the catalogue)
  // POST/writes are admin-only
  if (event.httpMethod !== 'GET') {
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();
  }

  return withClient(async (client) => {
    try {
      await ensureTables(client);

      if (event.httpMethod === 'GET') {
        const [svcResult, addonResult, svcAddonResult, svcEtResult, catResult] = await Promise.all([
          client.query('SELECT * FROM services WHERE active = TRUE ORDER BY sort_order, id'),
          client.query('SELECT * FROM addons WHERE active = TRUE ORDER BY sort_order, id'),
          client.query('SELECT * FROM service_addons ORDER BY service_id, sort_order'),
          client.query('SELECT * FROM service_event_types ORDER BY service_id'),
          // Inactive categories are returned too: the admin needs to see one to
          // switch it back on, and the booking form filters them out itself.
          client.query('SELECT * FROM categories ORDER BY sort_order, id')
        ]);

        const svcAddonMap = {};
        svcAddonResult.rows.forEach(r => {
          if (!svcAddonMap[r.service_id]) svcAddonMap[r.service_id] = [];
          svcAddonMap[r.service_id].push(r.addon_id);
        });

        const svcEtMap = {};
        svcEtResult.rows.forEach(r => {
          if (!svcEtMap[r.service_id]) svcEtMap[r.service_id] = [];
          svcEtMap[r.service_id].push(r.event_type_id);
        });

        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            services: svcResult.rows,
            addons: addonResult.rows,
            categories: catResult.rows,
            service_addons: svcAddonMap,
            service_event_types: svcEtMap
          })
        };
      }

      if (event.httpMethod === 'POST') {
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
        }

        if (body.type === 'service_event_types') {
          const { service_id, event_type_ids } = body;
          if (!service_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'service_id required' }) };
          await client.query('DELETE FROM service_event_types WHERE service_id=$1', [service_id]);
          for (const et_id of (event_type_ids || [])) {
            await client.query(
              'INSERT INTO service_event_types (service_id, event_type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
              [service_id, et_id]
            );
          }
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
        } else if (body.type === 'service_addons') {
          const { service_id, addon_ids } = body;
          if (!service_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'service_id required' }) };
          await client.query('DELETE FROM service_addons WHERE service_id=$1', [service_id]);
          let order = 0;
          for (const addon_id of (addon_ids || [])) {
            await client.query(
              'INSERT INTO service_addons (service_id, addon_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
              [service_id, addon_id, order++]
            );
          }
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
        } else if (body.type === 'category') {
          const categoryId = String(body.category_id || '').trim();
          const label = String(body.label || '').trim();
          // A blank id would upsert a row nothing can ever point at; a blank
          // label renders as an empty section heading on the booking form.
          if (!categoryId || !label) {
            return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'category_id and label are required' }) };
          }
          await client.query(
            `INSERT INTO categories (category_id, label, icon, active, sort_order)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (category_id) DO UPDATE SET
               label = EXCLUDED.label, icon = EXCLUDED.icon,
               active = EXCLUDED.active, sort_order = EXCLUDED.sort_order`,
            [categoryId, label, body.icon || '✨', body.active !== false, Number(body.sort_order) || 0]
          );
        } else if (body.type === 'addon') {
          await client.query(
            `INSERT INTO addons (addon_id, name, price, active, sort_order)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (addon_id) DO UPDATE SET
               name = EXCLUDED.name, price = EXCLUDED.price,
               active = EXCLUDED.active, sort_order = EXCLUDED.sort_order`,
            [body.addon_id, body.name, Number(body.price), body.active !== false, body.sort_order || 0]
          );
        } else {
          // category was absent from this DO UPDATE list until 2026-08-12, so
          // moving a service between categories returned {success:true} and
          // saved nothing. Now that it writes, an omitted category must not
          // blank an existing service's — hence NULLIF/COALESCE — and a brand
          // new service has to carry one, since the column is NOT NULL and the
          // booking form groups on it.
          const category = String(body.category || '').trim();
          if (!category) {
            const { rows: existing } = await client.query(
              'SELECT 1 FROM services WHERE service_id = $1', [body.service_id]
            );
            if (!existing.length) {
              return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'category is required for a new service' }) };
            }
          }
          await client.query(
            `INSERT INTO services (service_id, category, name, short_name, price, icon, duration_minutes, guest_suggestion, active, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (service_id) DO UPDATE SET
               category = COALESCE(NULLIF(EXCLUDED.category, ''), services.category),
               name = EXCLUDED.name, short_name = EXCLUDED.short_name,
               price = EXCLUDED.price, icon = EXCLUDED.icon,
               duration_minutes = EXCLUDED.duration_minutes, guest_suggestion = EXCLUDED.guest_suggestion,
               active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = NOW()`,
            [
              body.service_id, category, body.name, String(body.short_name || '').slice(0, 120),
              Number(body.price),
              body.icon || '🎪', Number(body.duration_minutes) || 120,
              body.guest_suggestion || '', body.active !== false, Number(body.sort_order) || 0
            ]
          );
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
      }

      return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

    } catch (err) {
      console.error('Services error:', err.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  });
};
