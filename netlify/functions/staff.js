const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_STAFF = [
  { staff_id:'joe_coover', name:'Joe Coover', preferred_name:'Joe',  role:'Owner / Magician', color:'#7c3aed', pin:'9632', phone:'(405) 431-6625', email:'Joe.Coover@gmail.com', pronouns:'he/him', comms_preference:'email', skills:[{name:'Magic Show',exclusive:true},{name:'Corporate Magic',exclusive:true},{name:'Childrens Magic',exclusive:true},{name:'Driver',exclusive:false}], admin_notes:'Owner', staff_notes:'', sort_order:1 },
  { staff_id:'troy_scott',  name:'Troy Scott', preferred_name:'Troy', role:'Performer',        color:'#0ea5e9', pin:'1234', phone:'',              email:'',                      pronouns:'',       comms_preference:'email', skills:[],                                                                                                                                                             admin_notes:'',      staff_notes:'', sort_order:2 },
];

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      staff_id VARCHAR(64) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      preferred_name VARCHAR(255) DEFAULT '',
      pronouns VARCHAR(64) DEFAULT '',
      role VARCHAR(255) DEFAULT 'Performer',
      color VARCHAR(16) DEFAULT '#7c3aed',
      pin VARCHAR(10) DEFAULT '0000',
      phone VARCHAR(50) NOT NULL DEFAULT '',
      email VARCHAR(255) NOT NULL DEFAULT '',
      comms_preference VARCHAR(20) DEFAULT 'email',
      skills JSONB DEFAULT '[]',
      admin_notes TEXT DEFAULT '',
      staff_notes TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrations for existing tables
  const migrations = [
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(255) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS pronouns VARCHAR(64) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS role VARCHAR(100) DEFAULT 'Performer'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#7c3aed'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS comms_preference VARCHAR(20) DEFAULT 'email'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS staff_notes TEXT DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
  ];
  for (const sql of migrations) {
    try { await client.query(sql); } catch (_) {}
  }

  // Seed / correct default staff on every startup (DO UPDATE ensures PIN fixes apply to existing rows)
  for (const s of DEFAULT_STAFF) {
    await client.query(
      `INSERT INTO staff (staff_id, name, preferred_name, pronouns, role, color, pin, phone, email, comms_preference, skills, admin_notes, staff_notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (staff_id) DO UPDATE SET
         pin          = EXCLUDED.pin,
         name         = EXCLUDED.name,
         preferred_name = EXCLUDED.preferred_name,
         role         = EXCLUDED.role,
         color        = EXCLUDED.color,
         sort_order   = EXCLUDED.sort_order`,
      [s.staff_id, s.name, s.preferred_name, s.pronouns, s.role, s.color, s.pin,
       s.phone, s.email, s.comms_preference, JSON.stringify(s.skills),
       s.admin_notes, s.staff_notes, s.sort_order]
    );
  }
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTable(client);

    // GET single staff member by ID (staff portal — own record only, no PIN or admin notes)
    if (event.httpMethod === 'GET' && event.path.match(/\/staff\/\d+$/)) {
      const id = parseInt(event.path.split('/').pop());
      const { rows } = await client.query('SELECT * FROM staff WHERE id=$1 AND active=TRUE', [id]);
      if (!rows.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
      const { pin, admin_notes, ...safe } = rows[0];
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(safe) };
    }

    // GET all active staff (admin only)
    if (event.httpMethod === 'GET') {
      const { rows } = await client.query(
        'SELECT * FROM staff WHERE active = TRUE ORDER BY sort_order, id'
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    // POST — create new staff member
    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      if (!b.name || !b.phone || !b.email) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'name, phone, and email are required' }) };
      }

      // Generate a staff_id from name
      const staff_id = b.name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') + '_' + Date.now();

      const { rows } = await client.query(
        `INSERT INTO staff (staff_id, name, preferred_name, pronouns, role, color, pin, phone, email, comms_preference, skills, admin_notes, staff_notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          staff_id,
          b.name,
          b.preferred_name || b.name,
          b.pronouns || '',
          b.role || 'Performer',
          b.color || '#7c3aed',
          b.pin || '0000',
          b.phone,
          b.email,
          b.comms_preference || 'email',
          JSON.stringify(b.skills || []),
          b.admin_notes || '',
          b.staff_notes || '',
          b.sort_order || 99,
        ]
      );
      return { statusCode: 201, headers: HEADERS, body: JSON.stringify(rows[0]) };
    }

    // PATCH — update staff member (by id in path)
    if (event.httpMethod === 'PATCH') {
      const id = event.path.split('/').pop();
      if (!id || isNaN(parseInt(id))) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid ID' }) };
      }

      const u = JSON.parse(event.body || '{}');
      const colMap = {
        name:              'name',
        preferred_name:    'preferred_name',
        pronouns:          'pronouns',
        role:              'role',
        color:             'color',
        pin:               'pin',
        phone:             'phone',
        email:             'email',
        comms_preference:  'comms_preference',
        skills:            'skills',
        admin_notes:       'admin_notes',
        staff_notes:       'staff_notes',
        active:            'active',
        sort_order:        'sort_order',
      };

      const sets = [], vals = [];
      let idx = 1;
      for (const [k, col] of Object.entries(colMap)) {
        if (u[k] !== undefined) {
          sets.push(`${col}=$${idx}`);
          // Serialize skills array to JSON string for JSONB column
          vals.push(k === 'skills' ? JSON.stringify(u[k]) : u[k]);
          idx++;
        }
      }

      if (!sets.length) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No fields to update' }) };
      }

      sets.push(`updated_at=NOW()`);
      vals.push(parseInt(id));

      const { rows } = await client.query(
        `UPDATE staff SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`,
        vals
      );

      if (!rows.length) {
        return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Staff member not found' }) };
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows[0]) };
    }

    // DELETE — soft delete (set active=false)
    if (event.httpMethod === 'DELETE') {
      const id = event.path.split('/').pop();
      await client.query('UPDATE staff SET active=FALSE WHERE id=$1', [parseInt(id)]);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('staff.js error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
