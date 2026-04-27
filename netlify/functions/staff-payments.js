const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json'
};

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_payments (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      pay_type VARCHAR(20) DEFAULT 'flat',
      hours NUMERIC(5,2),
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMPTZ,
      payment_method VARCHAR(64) DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const params = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    // GET — list payments
    if (event.httpMethod === 'GET') {
      let sql = 'SELECT sp.*, s.name AS staff_name, s.preferred_name, s.color FROM staff_payments sp LEFT JOIN staff s ON s.id=sp.staff_id WHERE 1=1';
      const vals = [];
      let idx = 1;
      if (params.booking_id) { sql += ` AND sp.booking_id=$${idx++}`; vals.push(parseInt(params.booking_id)); }
      if (params.staff_id)   { sql += ` AND sp.staff_id=$${idx++}`; vals.push(parseInt(params.staff_id)); }
      if (params.unpaid === 'true') { sql += ` AND sp.paid=FALSE`; }
      sql += ' ORDER BY sp.created_at DESC';
      const { rows } = await client.query(sql, vals);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ payments: rows }) };
    }

    // POST — create payment record
    if (event.httpMethod === 'POST') {
      const { staff_id, booking_id, amount, pay_type, hours, payment_method, note } = body;
      if (!staff_id || !booking_id) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'staff_id and booking_id required' }) };
      }
      const { rows } = await client.query(`
        INSERT INTO staff_payments (staff_id, booking_id, amount, pay_type, hours, payment_method, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [
        parseInt(staff_id),
        parseInt(booking_id),
        Number(amount) || 0,
        pay_type || 'flat',
        hours ? Number(hours) : null,
        payment_method || '',
        note || ''
      ]);
      return { statusCode: 201, headers: HEADERS, body: JSON.stringify({ payment: rows[0] }) };
    }

    // PATCH — update (mark paid, change amount/note)
    if (event.httpMethod === 'PATCH') {
      const id = event.path.split('/').pop();
      if (!id || isNaN(parseInt(id))) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid ID' }) };
      }
      const colMap = { amount:'amount', pay_type:'pay_type', hours:'hours', payment_method:'payment_method', note:'note', paid:'paid' };
      const sets = [], vals = [];
      let idx = 1;
      for (const [k, col] of Object.entries(colMap)) {
        if (body[k] !== undefined) { sets.push(`${col}=$${idx++}`); vals.push(body[k]); }
      }
      if (body.paid === true) { sets.push(`paid_at=NOW()`); }
      if (body.paid === false) { sets.push(`paid_at=NULL`); }
      if (!sets.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Nothing to update' }) };
      sets.push(`updated_at=NOW()`);
      vals.push(parseInt(id));
      const { rows } = await client.query(`UPDATE staff_payments SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      if (!rows.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ payment: rows[0] }) };
    }

    // DELETE
    if (event.httpMethod === 'DELETE') {
      const id = event.path.split('/').pop();
      await client.query('DELETE FROM staff_payments WHERE id=$1', [parseInt(id)]);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch(err) {
    console.error('staff-payments error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
