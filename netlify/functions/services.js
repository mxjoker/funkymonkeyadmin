const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

// First-run fixture ONLY. This array is inserted when the services table is
// EMPTY and is never read again, so it cannot be quoted from and it cannot be
// kept in sync by anyone remembering to. It had drifted badly by 2026-08-20 —
// foam_double $730 against a real $535, DJ Piñata $385 against $3,500, five
// library programs $40 light, and it predated the foam_parties/snow/bubbles/
// photo_booths/school_programs categories entirely. Regenerated wholesale from
// the live catalogue on 2026-08-20; it will drift again, and that is fine.
// Prices come from `services`, or from /api/services. Never from here.
const DEFAULT_SERVICES = [
  { service_id:'deluxe_magic',          category:'shows',           name:'Deluxe Birthday Magic Show',              price:385,   icon:'🪄',  duration_minutes:45,   guest_suggestion:'Best for kids parties',             sort_order:1 },
  { service_id:'basic_magic',           category:'shows',           name:'Basic Birthday Magic Show',               price:345,   icon:'🎩',  duration_minutes:25,   guest_suggestion:'Perfect for shorter slots',         sort_order:2 },
  { service_id:'corporate_magic',       category:'shows',           name:'Corporate Magic Show',                    price:875,   icon:'✨',   duration_minutes:45,   guest_suggestion:'Up to 300 guests',                  sort_order:3 },
  { service_id:'game_show',             category:'shows',           name:'Game Show Champions',                     price:3500,  icon:'🏆',  duration_minutes:90,   guest_suggestion:'Great for 15-80 guests',            sort_order:4 },
  { service_id:'school_asm',            category:'school_programs', name:'Magic School Assembly',                   price:385,   icon:'🏫',  duration_minutes:45,   guest_suggestion:'Up to 500 students',                sort_order:5 },
  { service_id:'dj_pinata',             category:'school_programs', name:'DJ Piñata',                               price:3500,  icon:'🎵',  duration_minutes:120,  guest_suggestion:'Perfect for 20-150 guests',         sort_order:6 },
  { service_id:'wedding_magic',         category:'shows',           name:'Walk-Around Cocktail Hour Magic',         price:900,   icon:'🕴',  duration_minutes:90,   guest_suggestion:'Cocktail hour & receptions',        sort_order:7 },
  { service_id:'balloon_40',            category:'experiences',     name:'Balloon Workshop — Up to 40 Kids',        price:385,   icon:'🎈',  duration_minutes:60,   guest_suggestion:'Up to 40 kids',                     sort_order:8 },
  { service_id:'balloon_60',            category:'performers',      name:'Balloon Workshop — 40–60 Kids',           price:405,   icon:'🎈',  duration_minutes:30,   guest_suggestion:'40–60 kids',                        sort_order:9 },
  { service_id:'face_paint',            category:'performers',      name:'Face Painting',                           price:200,   icon:'🎨',  duration_minutes:60,   guest_suggestion:'Approx. 30 guests per hour',        sort_order:10 },
  { service_id:'airbrush',              category:'performers',      name:'Airbrush Tattoos',                        price:200,   icon:'💨',  duration_minutes:60,   guest_suggestion:'Approx. 30 tattoos per hour',       sort_order:11 },
  { service_id:'glitter',               category:'performers',      name:'Glitter Tattoos',                         price:200,   icon:'💫',  duration_minutes:60,   guest_suggestion:'20–25 per hour',                    sort_order:12 },
  { service_id:'foam_single',           category:'foam_parties',    name:'Foam Party — Single Cannon',              price:385,   icon:'💨',  duration_minutes:45,   guest_suggestion:'up to 30 guests',                   sort_order:13 },
  { service_id:'foam_double',           category:'foam_parties',    name:'Foam Party — Double Cannon',              price:535,   icon:'💨',  duration_minutes:45,   guest_suggestion:'30-60 guests',                      sort_order:14 },
  { service_id:'snow_45',               category:'snow',            name:'Snow Party — 45 Minutes',                 price:385,   icon:'❄️',  duration_minutes:45,   guest_suggestion:'Any size party',                    sort_order:15 },
  { service_id:'snow_90',               category:'snow',            name:'Snow Party — 90 Minutes',                 price:525,   icon:'❄️',  duration_minutes:90,   guest_suggestion:'Any size party',                    sort_order:16 },
  { service_id:'cotton_candy',          category:'experiences',     name:'Live Spun Cotton Candy',                  price:385,   icon:'🍭',  duration_minutes:60,   guest_suggestion:'Any party size',                    sort_order:17 },
  { service_id:'mini_donuts',           category:'experiences',     name:'Hot & Fresh Mini Donuts',                 price:385,   icon:'🍩',  duration_minutes:60,   guest_suggestion:'Any party size',                    sort_order:18 },
  { service_id:'bubble_show',           category:'bubbles',         name:'Prof. Bucket\'s Bubble Show',             price:385,   icon:'🫧',  duration_minutes:45,   guest_suggestion:'Any party size',                    sort_order:19 },
  { service_id:'pb_kiosk_svc',          category:'photo_booths',    name:'Digital Kiosk Photo Booth',               price:385,   icon:'📸',  duration_minutes:120,  guest_suggestion:'Any party size',                    sort_order:20 },
  { service_id:'pb_360_svc',            category:'photo_booths',    name:'360 Video Booth',                         price:385,   icon:'🎥',  duration_minutes:120,  guest_suggestion:'Any party size',                    sort_order:21 },
  { service_id:'lib_magic',             category:'library',         name:'Library — Magic Show',                    price:385,   icon:'🎩',  duration_minutes:45,   guest_suggestion:'Summer reading programs',           sort_order:22 },
  { service_id:'lib_balloon',           category:'library',         name:'Library — Balloon Workshop',              price:385,   icon:'🎈',  duration_minutes:30,   guest_suggestion:'Summer reading programs',           sort_order:23 },
  { service_id:'lib_bubble',            category:'library',         name:'Library — Prof. Bucket\'s Bubble Show',   price:385,   icon:'🫧',  duration_minutes:45,   guest_suggestion:'Summer reading programs',           sort_order:24 },
  { service_id:'lib_doodles',           category:'library',         name:'Library — Story-Doodles',                 price:385,   icon:'✏️',  duration_minutes:45,   guest_suggestion:'Summer reading programs',           sort_order:25 },
  { service_id:'lib_foam',              category:'library',         name:'Library — Foam Party',                    price:385,   icon:'🫧',  duration_minutes:45,   guest_suggestion:'Summer reading programs',           sort_order:26 },
  { service_id:'lib_workshop',          category:'library',         name:'Library — Magic Workshop',                price:385,   icon:'🪄',  duration_minutes:45,   guest_suggestion:'Summer reading programs',           sort_order:27 },
  { service_id:'svc_1786721013523',     category:'foam_parties',    name:'Foam Party — Triple Cannon',              price:685,   icon:'💨',  duration_minutes:45,   guest_suggestion:'60-90 guests',                      sort_order:28 },
  { service_id:'svc_1786722137537',     category:'foam_parties',    name:'Foam Party — Quadruple Cannon',           price:835,   icon:'💨',  duration_minutes:45,   guest_suggestion:'90-120 guests',                     sort_order:29 },
  { service_id:'svc_1786725764593',     category:'experiences',     name:'DIY Squishy Making Party',                price:385,   icon:'🫟',  duration_minutes:60,   guest_suggestion:'2 per guest- up to 20 ',            sort_order:30 },
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

// Labels for the category ids we already know about, refreshed from the live
// catalogue 2026-08-20 (it had only the original four). The seed below derives its rows from whatever categories
// the services table actually uses, so a live database keeps rendering exactly
// as it did; these just supply a human label for the ids we already know.
// Anything unrecognised seeds under its own id as the label.
const KNOWN_CATEGORY_LABELS = {
  shows:           { label: 'Magic Shows',          icon: '🎩', sort_order: 1 },
  foam_parties:    { label: 'Foam Parties',         icon: '💨', sort_order: 2 },
  performers:      { label: 'Add-On Entertainers',  icon: '🎨', sort_order: 3 },
  experiences:     { label: 'Party Experiences',    icon: '🎊', sort_order: 4 },
  library:         { label: 'Library Programs',     icon: '📚', sort_order: 5 },
  school_programs: { label: 'School Programs',      icon: '🎓', sort_order: 6 },
  photo_booths:    { label: 'Photo Booths',         icon: '📸', sort_order: 7 },
  snow:            { label: 'Snow',                 icon: '❄️', sort_order: 8 },
  bubbles:         { label: 'Bubbles',              icon: '🫧', sort_order: 9 },
};

// The customer-facing copy that used to live in booking-form.html's own copy of
// the catalogue. It is a BACKFILL, not a source of truth: it seeds `description`,
// `extra_hour_rate` and `is_quote` once, for rows that have never had a
// description, and an admin edit always wins from then on. Nothing reads it at
// request time — the booking form reads the columns.
const SERVICE_COPY = {
  deluxe_magic:    { description:'Award-winning interactive magic with audience participation, monkey puppet, and a special magical gift for the birthday child.' },
  basic_magic:     { description:'Fun, interactive magic show packed with laughs and surprises. Perfect for shorter party slots.' },
  foam_single:     { description:'High-energy foam party with one cannon.' },
  foam_double:     { description:'Maximum foam with two cannons — the full foam experience.' },
  snow_45:         { description:'Real snow machine fun — not cold at all! Perfect for winter-themed or frozen parties any time of year.', extra_hour_rate:140 },
  snow_90:         { description:'Extended snow party experience with more time for games, photos, and memories.', extra_hour_rate:140 },
  cotton_candy:    { description:'Fresh-spun cotton candy made live at your event. A guaranteed crowd pleaser.' },
  mini_donuts:     { description:'Freshly made mini donuts served hot at your event. Everyone loves them!' },
  balloon_40:      { description:'Every child learns to make and keep three classic balloon sculptures. We bring everything needed.' },
  balloon_60:      { description:'Larger group balloon workshop — same fun, bigger crowd handled with ease.' },
  face_paint:      { description:'Professional face painting for all ages.', extra_hour_rate:150 },
  airbrush:        { description:'Custom airbrush tattoo designs.', extra_hour_rate:150 },
  glitter:         { description:'Long-lasting glitter tattoos loved by kids and adults.', extra_hour_rate:150 },
  bubble_show:     { description:'Giant bubbles, bubble science, and bubbly fun for all ages.' },
  corporate_magic: { description:'Close-up and stage magic tailored for professional events and corporate audiences.', is_quote:true },
  game_show:       { description:'Live interactive game show with prizes and high-energy audience participation.', is_quote:true },
  school_asm:      { description:'High-energy assembly for your entire school.' },
  dj_pinata:       { description:'The ultimate school fundraiser experience — interactive DJ meets piñata party.', is_quote:true },
  wedding_magic:   { description:'Elegant close-up sleight of hand performed table-to-table during cocktail hour.', is_quote:true },
  lib_magic:       { description:'Engaging magic show tailored for library audiences and summer reading programs.' },
  lib_balloon:     { description:'Hands-on balloon sculpting workshop. Every child makes and keeps their creations.' },
  lib_bubble:      { description:'The science and wonder of bubbles — a perfect library STEM program.' },
  lib_doodles:     { description:'Interactive storytelling with live drawing and imagination. Kids love participating.' },
  lib_foam:        { description:'45 minutes of foam and fun — a summer reading favorite!' },
  lib_workshop:    { description:'Interactive magic workshop where kids learn real magic tricks to take home.' },
  pb_kiosk_svc:    { description:'Automated digital photo kiosk with instant prints and digital sharing.' },
  pb_360_svc:      { description:'Immersive 360-degree slow-motion video booth — the ultimate party wow moment.' },
};

const DEFAULT_ADDONS = [
  { addon_id:'extra_hour',       name:'Extra Hour',        price:85,  sort_order:1 },
  { addon_id:'glitter_addon',    name:'Glitter Tattoos',   price:75,  sort_order:2 },
  { addon_id:'balloon_addon',    name:'Balloon Animals',   price:75,  sort_order:3 },
  { addon_id:'photo_booth',      name:'Photo Booth',       price:150, sort_order:4 },
  { addon_id:'second_performer', name:'Second Performer',  price:175, sort_order:5 }
];

// The booking form offers these two on every non-photo-booth service. They were
// the last prices it still carried in its own source, invisible to Catalogue,
// because DEFAULT_ADDONS only ever seeds an EMPTY addons table and this one has
// had rows since long before. Inserted explicitly so they exist on a live
// database too; the prices are editable from Catalogue like any other add-on.
const PHOTO_BOOTH_ADDONS = [
  { addon_id:'pb_kiosk', name:'Digital Kiosk Photo Booth', price:150, category:'Photo Booth', sort_order:90 },
  { addon_id:'pb_360',   name:'360 Video Booth',           price:150, category:'Photo Booth', sort_order:91 },
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

  // Free-text grouping for the add-on picker, which had grown to ~36 chips in
  // one undifferentiated wall. Deliberately NOT a foreign key to `categories`:
  // those are service categories ("Foam Parties", "Magic Shows") and add-ons
  // group on a different axis entirely — food, performers, equipment, seasonal.
  // Forcing one taxonomy onto both would make each worse. A plain string plus a
  // datalist of what is already in use lets the grouping settle without a second
  // CRUD screen to maintain.
  await client.query("ALTER TABLE addons ADD COLUMN IF NOT EXISTS category VARCHAR(64) DEFAULT ''");

  // CREATE TABLE only fires on an empty database; a live one needs the column
  // added explicitly.
  await client.query("ALTER TABLE services ADD COLUMN IF NOT EXISTS short_name VARCHAR(120) DEFAULT ''");

  // The three fields the booking form used to keep in its own source, which is
  // why a service added in Catalogue could never be given a blurb, an hourly
  // rate or custom-quote pricing. `description` is deliberately NULL-defaulted:
  // NULL means "never set", '' means "an admin cleared it", and only the former
  // is backfilled. extra_hour_rate NULL means the hours picker does not apply.
  await client.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT');
  await client.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS extra_hour_rate NUMERIC(10,2)');
  await client.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS is_quote BOOLEAN NOT NULL DEFAULT FALSE');

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

  // One-time copy backfill, gated on description IS NULL so it runs once per row
  // and never argues with an admin afterwards. All three columns move together:
  // a row that has never had a description is a row that predates this change,
  // and is_quote/extra_hour_rate have no "unset" value of their own to test.
  const { rows: copyGap } = await client.query('SELECT COUNT(*) FROM services WHERE description IS NULL');
  if (parseInt(copyGap[0].count) > 0) {
    for (const [service_id, c] of Object.entries(SERVICE_COPY)) {
      await client.query(
        `UPDATE services
            SET description = $2, extra_hour_rate = $3, is_quote = $4
          WHERE service_id = $1 AND description IS NULL`,
        [service_id, c.description, c.extra_hour_rate ?? null, c.is_quote === true]
      );
    }
    // Anything the copy does not name — a service added in Catalogue before this
    // shipped — gets '' rather than staying NULL, so it is not reconsidered on
    // every request. The booking form falls back to the guest note for those.
    await client.query("UPDATE services SET description = '' WHERE description IS NULL");
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

  // Unlike DEFAULT_ADDONS these have to reach a NON-empty table, so the gate is
  // "are they missing", not "is the table empty". DO NOTHING on conflict: once
  // the rows exist their prices belong to Catalogue.
  const { rows: pbCount } = await client.query(
    'SELECT COUNT(*) FROM addons WHERE addon_id = ANY($1)',
    [PHOTO_BOOTH_ADDONS.map(a => a.addon_id)]
  );
  if (parseInt(pbCount[0].count) < PHOTO_BOOTH_ADDONS.length) {
    for (const a of PHOTO_BOOTH_ADDONS) {
      await client.query(
        `INSERT INTO addons (addon_id, name, price, category, sort_order)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (addon_id) DO NOTHING`,
        [a.addon_id, a.name, a.price, a.category, a.sort_order]
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
        // Inactive services are withheld from the public form — their names and
        // prices are hidden on purpose — but an admin has to see one to switch
        // it back on. Without this, unchecking Active in Catalogue removed the
        // row from the very screen that could undo it: a one-way door.
        const isAdmin = !!(await requireAuth(event, ['admin']));
        const [svcResult, addonResult, svcAddonResult, svcEtResult, catResult] = await Promise.all([
          client.query(
            isAdmin
              ? 'SELECT * FROM services ORDER BY sort_order, id'
              : 'SELECT * FROM services WHERE active = TRUE ORDER BY sort_order, id'
          ),
          client.query(
            isAdmin
              ? 'SELECT * FROM addons ORDER BY sort_order, id'
              : 'SELECT * FROM addons WHERE active = TRUE ORDER BY sort_order, id'
          ),
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
            `INSERT INTO addons (addon_id, name, price, active, sort_order, category)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (addon_id) DO UPDATE SET
               name = EXCLUDED.name, price = EXCLUDED.price,
               active = EXCLUDED.active, sort_order = EXCLUDED.sort_order,
               category = EXCLUDED.category`,
            [body.addon_id, body.name, Number(body.price), body.active !== false, body.sort_order || 0, (body.category || '').trim()]
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
          // An empty extra-hour box means "this service has no hours picker",
          // which is NULL, not $0 — $0 would render a picker offering four
          // hours for free. Anything unparseable lands on NULL for the same
          // reason.
          const extraHourRate = body.extra_hour_rate === '' || body.extra_hour_rate == null
            ? null
            : (Number.isFinite(Number(body.extra_hour_rate)) ? Number(body.extra_hour_rate) : null);

          await client.query(
            `INSERT INTO services (service_id, category, name, short_name, price, icon, duration_minutes, guest_suggestion, active, sort_order, description, extra_hour_rate, is_quote)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (service_id) DO UPDATE SET
               category = COALESCE(NULLIF(EXCLUDED.category, ''), services.category),
               name = EXCLUDED.name, short_name = EXCLUDED.short_name,
               price = EXCLUDED.price, icon = EXCLUDED.icon,
               duration_minutes = EXCLUDED.duration_minutes, guest_suggestion = EXCLUDED.guest_suggestion,
               active = EXCLUDED.active, sort_order = EXCLUDED.sort_order,
               description = EXCLUDED.description, extra_hour_rate = EXCLUDED.extra_hour_rate,
               is_quote = EXCLUDED.is_quote, updated_at = NOW()`,
            [
              body.service_id, category, body.name, String(body.short_name || '').slice(0, 120),
              Number(body.price),
              body.icon || '🎪', Number(body.duration_minutes) || 120,
              body.guest_suggestion || '', body.active !== false, Number(body.sort_order) || 0,
              String(body.description || ''), extraHourRate, body.is_quote === true
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
