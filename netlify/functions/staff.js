const { withClient } = require('./_db');
const {
  CORS, preflight, requireAuth, unauthorized, forbidden,
  generateAccessCode, hashSecret,
} = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Safe column list — never includes pin or access_code_hash.
const SAFE_COLS = `
  id, staff_id, name, preferred_name, pronouns, role, color,
  phone, email, comms_preference, skills, staff_notes, shared_notes,
  admin_notes, active, sort_order, pay_type, flat_rate, hourly_rate,
  payment_method, payment_handle, created_at, updated_at
`.trim();

// Fields a staff member may update on their own record.
const STAFF_ALLOWED_FIELDS = new Set([
  'preferred_name', 'color', 'phone', 'email', 'comms_preference',
  'skills', 'shared_notes',
]);

// Fields admin may update (anything except the credential columns).
const ADMIN_FORBIDDEN_FIELDS = new Set(['pin', 'access_code_hash']);

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
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS shared_notes TEXT DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'flat'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS flat_rate NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS payment_method VARCHAR(64) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS payment_handle VARCHAR(255) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_code_hash TEXT",
  ];
  for (const sql of migrations) {
    try { await client.query(sql); } catch (_) {}
  }

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

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Path helpers
  const pathMatch = event.path.match(/\/staff\/(\d+)$/);
  const pathId = pathMatch ? parseInt(pathMatch[1]) : null;

  // ── POST /api/staff/:id  {action:'regenerate_access_code'}  (admin only) ──
  if (event.httpMethod === 'POST' && pathId) {
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    if (body.action === 'regenerate_access_code') {
      return withClient(async (client) => {
        await ensureTable(client);
        const code = generateAccessCode();
        const hashed = hashSecret(code);
        const { rows } = await client.query(
          'UPDATE staff SET access_code_hash=$1, updated_at=NOW() WHERE id=$2 RETURNING id',
          [hashed, pathId]
        );
        if (!rows.length) return json(404, { error: 'Staff member not found' });
        return json(200, { success: true, access_code: code });
      });
    }

    // Fall through to generic POST handler for other actions (none currently)
    return json(400, { error: 'Unknown action' });
  }

  // ── GET /api/staff/:id ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && pathId) {
    const auth = await requireAuth(event);
    if (!auth) return unauthorized();

    // Staff may only fetch their own record
    if (auth.role === 'staff' && auth.staffId !== pathId) return forbidden();

    return withClient(async (client) => {
      await ensureTable(client);
      const { rows } = await client.query(
        `SELECT ${SAFE_COLS} FROM staff WHERE id=$1 AND active=TRUE`,
        [pathId]
      );
      if (!rows.length) return json(404, { error: 'Not found' });
      // Admin can see admin_notes; staff sees their own but without admin_notes
      if (auth.role === 'staff') {
        const { admin_notes, ...safe } = rows[0];
        return json(200, safe);
      }
      return json(200, rows[0]);
    });
  }

  // ── GET /api/staff  (list) ─────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const auth = await requireAuth(event);
    if (!auth) return unauthorized();

    return withClient(async (client) => {
      await ensureTable(client);
      // Staff role: return safe cols for everyone (they need it for scheduling context)
      // Admin: also safe cols (never expose pin/access_code_hash to anyone)
      const { rows } = await client.query(
        `SELECT ${SAFE_COLS} FROM staff WHERE active=TRUE ORDER BY sort_order, id`
      );
      // Strip admin_notes for staff callers
      const out = auth.role === 'staff'
        ? rows.map(({ admin_notes, ...r }) => r)
        : rows;
      return json(200, out);
    });
  }

  // ── POST /api/staff  (create) — admin only ─────────────────────────────────
  if (event.httpMethod === 'POST') {
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();

    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    if (!b.name || !b.phone || !b.email) {
      return json(400, { error: 'name, phone, and email are required' });
    }

    return withClient(async (client) => {
      await ensureTable(client);
      const staff_id = b.name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') + '_' + Date.now();
      const { rows } = await client.query(
        `INSERT INTO staff (staff_id, name, preferred_name, pronouns, role, color, pin, phone, email, comms_preference, skills, admin_notes, staff_notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${SAFE_COLS}`,
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
      return json(201, rows[0]);
    });
  }

  // ── PATCH /api/staff/:id ───────────────────────────────────────────────────
  if (event.httpMethod === 'PATCH' && pathId) {
    const auth = await requireAuth(event);
    if (!auth) return unauthorized();

    // Staff may only update their own record
    if (auth.role === 'staff' && auth.staffId !== pathId) return forbidden();

    let u;
    try { u = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    // Build allowed column map based on role
    const adminColMap = {
      name: 'name', preferred_name: 'preferred_name', pronouns: 'pronouns',
      role: 'role', color: 'color', phone: 'phone', email: 'email',
      comms_preference: 'comms_preference', skills: 'skills',
      admin_notes: 'admin_notes', staff_notes: 'staff_notes', shared_notes: 'shared_notes',
      active: 'active', sort_order: 'sort_order',
      pay_type: 'pay_type', flat_rate: 'flat_rate', hourly_rate: 'hourly_rate',
      payment_method: 'payment_method', payment_handle: 'payment_handle',
    };

    const staffColMap = {
      preferred_name: 'preferred_name', color: 'color',
      phone: 'phone', email: 'email', comms_preference: 'comms_preference',
      skills: 'skills', shared_notes: 'shared_notes',
    };

    const colMap = auth.role === 'admin' ? adminColMap : staffColMap;

    const sets = [], vals = [];
    let idx = 1;
    for (const [k, col] of Object.entries(colMap)) {
      if (u[k] !== undefined) {
        // Extra safety: admin can't directly write credential fields via this endpoint
        if (ADMIN_FORBIDDEN_FIELDS.has(k)) continue;
        sets.push(`${col}=$${idx}`);
        vals.push(k === 'skills' ? JSON.stringify(u[k]) : u[k]);
        idx++;
      }
    }

    if (!sets.length) return json(400, { error: 'No allowed fields to update' });

    sets.push(`updated_at=NOW()`);
    vals.push(pathId);

    return withClient(async (client) => {
      await ensureTable(client);
      const { rows } = await client.query(
        `UPDATE staff SET ${sets.join(',')} WHERE id=$${idx} RETURNING ${SAFE_COLS}`,
        vals
      );
      if (!rows.length) return json(404, { error: 'Staff member not found' });
      // Strip admin_notes for staff callers
      if (auth.role === 'staff') {
        const { admin_notes, ...safe } = rows[0];
        return json(200, safe);
      }
      return json(200, rows[0]);
    });
  }

  // ── DELETE /api/staff/:id — admin only ────────────────────────────────────
  if (event.httpMethod === 'DELETE' && pathId) {
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();

    return withClient(async (client) => {
      await ensureTable(client);
      await client.query('UPDATE staff SET active=FALSE WHERE id=$1', [pathId]);
      return json(200, { success: true });
    });
  }

  return json(405, { error: 'Method not allowed' });
};
