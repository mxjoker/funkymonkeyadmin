const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function ensureServicesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) UNIQUE NOT NULL,
      category VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      icon VARCHAR(16) DEFAULT '🎪',
      duration_minutes INTEGER DEFAULT 120,
      guest_suggestion VARCHAR(255) DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed default services if table is empty
  const { rows } = await client.query('SELECT COUNT(*) FROM services');
  if (parseInt(rows[0].count) === 0) {
    await client.query(`
      INSERT INTO services (service_id, category, name, price, icon, duration_minutes, guest_suggestion, sort_order) VALUES
      ('magic_kids',   'shows',      'Children''s Magic Show',        350,  '🎩', 60,  'Best for 10–100 kids',        1),
      ('magic_corp',   'shows',      'Corporate Magic Show',          800,  '✨', 90,  'Up to 300 guests',            2),
      ('balloon_wkshp','shows',      'Balloon Sculpting Workshop',    275,  '🎈', 60,  'Great for 10–50 guests',      3),
      ('dj_pinata',    'shows',      'DJ Piñata',                     500,  '🎵', 120, 'Perfect for 20–150 guests',   4),
      ('gameshow',     'shows',      'Game Show Champions',           450,  '🏆', 75,  'Great for 15–80 guests',      5),
      ('school_asm',   'shows',      'Magic School Assembly',         600,  '🏫', 45,  'Up to 500 students',          6),
      ('balloon',      'performers', 'Balloon Artist',                200,  '🎈', 120, 'Any party size',              7),
      ('face_paint',   'performers', 'Face Painting',                 200,  '🎨', 120, 'Best for 15–60 guests',       8),
      ('glitter',      'performers', 'Glitter Tattoos',               175,  '💫', 120, 'Any party size',              9),
      ('juggler',      'performers', 'Juggler',                       225,  '🤹', 120, 'Any party size',              10),
      ('stilts',       'performers', 'Stilt Walker',                  275,  '🎪', 120, 'Outdoor events recommended',  11),
      ('acrobat',      'performers', 'Acrobat',                       350,  '🤸', 120, 'Any party size',              12),
      ('fire',         'performers', 'Fire Breather',                 400,  '🔥', 120, 'Outdoor events only',         13),
      ('foam',         'experiences','Foam Party',                    650,  '🫧', 180, 'Best for 20–200 guests',      14),
      ('snow',         'experiences','Snow Experience',               550,  '❄️', 180, 'Best for 20–150 guests',      15),
      ('camp',         'camps',      'Magic Camp',                    150,  '🎩', 480, 'Per day, up to 20 kids',      16)
    `);

    // Seed add-ons
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
    const { rows: addonRows } = await client.query('SELECT COUNT(*) FROM addons');
    if (parseInt(addonRows[0].count) === 0) {
      await client.query(`
        INSERT INTO addons (addon_id, name, price, sort_order) VALUES
        ('extra_hour',       'Extra Hour',         85,  1),
        ('glitter_addon',    'Glitter Tattoos',    75,  2),
        ('balloon_addon',    'Balloon Animals',    75,  3),
        ('photo_booth',      'Photo Booth',        150, 4),
        ('second_performer', 'Second Performer',   175, 5)
      `);
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

  const client = await pool.connect();
  try {
    await ensureServicesTable(client);

    // Also ensure addons table exists (idempotent)
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

    // GET — return all active services + addons
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

    // POST — update a service (from admin catalogue editor)
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { type, service_id, addon_id, name, price, icon, duration_minutes, guest_suggestion, active, sort_order } = body;

      if (type === 'addon') {
        const id = addon_id;
        await client.query(`
          INSERT INTO addons (addon_id, name, price, active, sort_order)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (addon_id) DO UPDATE SET
            name = EXCLUDED.name,
            price = EXCLUDED.price,
            active = EXCLUDED.active,
            sort_order = EXCLUDED.sort_order
        `, [id, name, price, active !== false, sort_order || 0]);
      } else {
        await client.query(`
          INSERT INTO services (service_id, category, name, price, icon, duration_minutes, guest_suggestion, active, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (service_id) DO UPDATE SET
            name = EXCLUDED.name,
            price = EXCLUDED.price,
            icon = EXCLUDED.icon,
            duration_minutes = EXCLUDED.duration_minutes,
            guest_suggestion = EXCLUDED.guest_suggestion,
            active = EXCLUDED.active,
            sort_order = EXCLUDED.sort_order,
            updated_at = NOW()
        `, [
          service_id,
          body.category,
          name,
          price,
          icon || '🎪',
          duration_minutes || 120,
          guest_suggestion || '',
          active !== false,
          sort_order || 0
        ]);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Services error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
