const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { password } = JSON.parse(event.body || '{}');
    if (!password) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Password required' }) };

    // ── Check admin password first ──────────────────────────────────────────
    const adminPassword = process.env.ADMIN_PASSWORD || 'funkymonkey2024';
    if (password === adminPassword) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, role: 'admin' })
      };
    }

    // ── Check staff PINs ────────────────────────────────────────────────────
    // Try to connect to DB — if it fails (e.g. no DB yet), just fail auth
    let client;
    try {
      client = await pool.connect();
    } catch (dbErr) {
      console.error('DB connect failed during auth:', dbErr.message);
      return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ success: false }) };
    }

    try {
      // Ensure staff table exists before querying
      await client.query(`CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        staff_id VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        preferred_name VARCHAR(255) DEFAULT '',
        pin VARCHAR(10) DEFAULT '0000',
        active BOOLEAN DEFAULT TRUE
      )`);

      const { rows } = await client.query(
        'SELECT id, name, preferred_name, role, color FROM staff WHERE pin=$1 AND active=TRUE LIMIT 1',
        [String(password)]
      );

      if (rows.length) {
        const staff = rows[0];
        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify({
            success: true,
            role: 'staff',
            staffId: staff.id,
            staffName: staff.preferred_name || staff.name,
            staffColor: staff.color || '#7c3aed',
          })
        };
      }
    } finally {
      client.release();
    }

    // ── No match ─────────────────────────────────────────────────────────────
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ success: false }) };

  } catch(e) {
    console.error('auth.js error:', e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
