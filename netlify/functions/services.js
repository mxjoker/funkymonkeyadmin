const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_SERVICES = [
  { service_id:'magic_kids',    category:'shows',       name:"Children's Magic Show",      price:350,  icon:'🎩', duration_minutes:60,  guest_suggestion:'Best for 10-100 kids',       sort_order:1  },
  { service_id:'magic_corp',    category:'shows',       name:'Corporate Magic Show',        price:800,  icon:'✨', duration_minutes:90,  guest_suggestion:'Up to 300 guests',           sort_order:2  },
  { service_id:'balloon_wkshp', category:'shows',       name:'Balloon Sculpting Workshop',  price:275,  icon:'🎈', duration_minutes:60,  guest_suggestion:'Great for 10-50 guests',     sort_order:3  },
  { service_id:'dj_pinata',     category:'shows',       name:'DJ Pinata',                   price:500,  icon:'🎵', duration_minutes:120, guest_suggestion:'Perfect for 20-150 guests',  sort_order:4  },
  { service_id:'gameshow',      category:'shows',       name:'Game Show Champions',         price:450,  icon:'🏆', duration_minutes:75,  guest_suggestion:'Great for 15-80 guests',     sort_order:5  },
  { service_id:'school_asm',    category:'shows',       name:'Magic School Assembly',       price:600,  icon:'🏫', duration_minutes:45,  guest_suggestion:'Up to 500 students',         sort_order:6  },
  { service_id:'balloon',       category:'performers',  name:'Balloon Artist',              price:200,  icon:'🎈', duration_minutes:120, guest_suggestion:'Any party size',             sort_order:7  },
  { service_id:'face_paint',    category:'performers',  name:'Face Painting',               price:200,  icon:'🎨', duration_minutes:120, guest_suggestion:'Best for 15-60 guests',      sort_order:8  },
  { service_id:'glitter',       category:'performers',  name:'Glitter Tattoos',             price:175,  icon:'💫', duration_minutes:120, guest_suggestion:'Any party size',             sort_order:9  },
  { service_id:'juggler',       category:'performers',  name:'Juggler',                     price:225,  icon:'🤹', duration_minutes:120, guest_suggestion:'Any party size',             sort_order:10 },
  { service_id:'stilts',        category:'performers',  name:'Stilt Walker',                price:275,  icon:'🎪', duration_minutes:120, guest_suggestion:'Outdoor events recommended', sort_order:11 },
  { service_id:'acrobat',       category:'performers',  name:'Acrobat',                     price:350,  icon:'🤸', duration_minutes:120, guest_suggestion:'Any party size',             sort_order:12 },
  { service_id:'fire',          category:'performers',  name:'Fire Breather',               price:400,  icon:'🔥', duration_minutes:120, guest_suggestion:'Outdoor events only',        sort_order:13 },
  { service_id:'foam',          category:'experiences', name:'Foam Party',                  price:650,  icon:'🫧', duration_minutes:180, guest_suggestion:'Best for 20-200 guests',     sort_order:14 },
  { service_id:'snow',          category:'experiences', name:'Snow Experience',             price:550,  icon:'X',  duration_minutes:180, guest_suggestion:'Best for 20-150 guests',     sort_order:15 },
  { service_id:'camp',          category:'camps',       name:'Magic Camp',                  price:150,  icon:'🎩', duration_minutes:480, guest_suggestion:'Per day, up to 20 kids',     sort_order:16 }
];

const DEFAULT_ADDONS = [
  { addon_id:'extra_hour',       name:'Extra Hour',        price:85,  sort_order:1 },
  { addon_id:'glitter_addon',    name:'Glitter Tattoos',   price:75,  sort_order:2 },
  { addon_id:'balloon_addon',    name:'Balloon Animals',   price:75,  sort_order:3 },
  { addon_id:'photo_booth',      name:'Photo Booth',       price:150, sort_order:4 },
  { addon_id:'second_performer', name:'Second Performer',  price:175, sort_order:5 }
];

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) UNIQUE NOT NULL,
      category VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
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
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let client;
  try {
    client = await pool.connect();
    await ensureTables(client);

    if (event.httpMethod === 'GET') {
      const [svcResult, addonResult] = await Promise.all([
        client.query('SELECT * FROM services WHERE active = TRUE ORDER BY sort_order, id'),
        client.query('SELECT * FROM addons WHERE active = TRUE ORDER BY sort_order, id')
      ]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ services: svcResult.rows, addons: addonResult.rows })
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (body.type === 'addon') {
        await client.query(
          `INSERT INTO addons (addon_id, name, price, active, sort_order)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (addon_id) DO UPDATE SET
             name = EXCLUDED.name, price = EXCLUDED.price,
             active = EXCLUDED.active, sort_order = EXCLUDED.sort_order`,
          [body.addon_id, body.name, Number(body.price), body.active !== false, body.sort_order || 0]
        );
      } else {
        await client.query(
          `INSERT INTO services (service_id, category, name, price, icon, duration_minutes, guest_suggestion, active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (service_id) DO UPDATE SET
             name = EXCLUDED.name, price = EXCLUDED.price, icon = EXCLUDED.icon,
             duration_minutes = EXCLUDED.duration_minutes, guest_suggestion = EXCLUDED.guest_suggestion,
             active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = NOW()`,
          [
            body.service_id, body.category, body.name, Number(body.price),
            body.icon || '🎪', Number(body.duration_minutes) || 120,
            body.guest_suggestion || '', body.active !== false, Number(body.sort_order) || 0
          ]
        );
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Services error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    if (client) client.release();
  }
};
