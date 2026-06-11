const { withClient } = require('./_db');
const {
  CORS, preflight, requireAuth, unauthorized, forbidden,
} = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_payments (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      assignment_id INTEGER,
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
  try { await client.query(`ALTER TABLE staff_payments ADD COLUMN IF NOT EXISTS assignment_id INTEGER`); } catch(_) {}
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  try {
    return await withClient(async (client) => {
      await ensureTable(client);
      const params = event.queryStringParameters || {};
      let body = {};
      if (event.body) {
        try { body = JSON.parse(event.body); } catch { return json(400, { error: 'Invalid JSON' }); }
      }

      // GET — list payments: staff self-scoped, admin unrestricted
      if (event.httpMethod === 'GET') {
        const auth = await requireAuth(event);
        if (!auth) return unauthorized();

        let sql = 'SELECT sp.*, s.name AS staff_name, s.preferred_name, s.color FROM staff_payments sp LEFT JOIN staff s ON s.id=sp.staff_id WHERE 1=1';
        const vals = [];
        let idx = 1;

        if (auth.role === 'staff') {
          // Staff may only see their own payments
          const requestedId = params.staff_id ? parseInt(params.staff_id) : null;
          if (requestedId && requestedId !== auth.staffId) return forbidden();
          sql += ` AND sp.staff_id=$${idx++}`;
          vals.push(auth.staffId);
        } else {
          // Admin: optional filters
          if (params.booking_id) { sql += ` AND sp.booking_id=$${idx++}`; vals.push(parseInt(params.booking_id)); }
          if (params.staff_id)   { sql += ` AND sp.staff_id=$${idx++}`;   vals.push(parseInt(params.staff_id)); }
        }

        if (params.unpaid === 'true') { sql += ` AND sp.paid=FALSE`; }
        sql += ' ORDER BY sp.created_at DESC';
        const { rows } = await client.query(sql, vals);
        return json(200, { payments: rows });
      }

      // All write methods — admin only
      const auth = await requireAuth(event, ['admin']);
      if (!auth) return unauthorized();

      // POST — create payment record
      if (event.httpMethod === 'POST') {
        const { staff_id, booking_id, amount, pay_type, hours, payment_method, note } = body;
        if (!staff_id || !booking_id) {
          return json(400, { error: 'staff_id and booking_id required' });
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
        return json(201, { payment: rows[0] });
      }

      // PATCH — update (mark paid, change amount/note)
      if (event.httpMethod === 'PATCH') {
        const id = event.path.split('/').pop();
        if (!id || isNaN(parseInt(id))) {
          return json(400, { error: 'Invalid ID' });
        }
        const colMap = { amount:'amount', pay_type:'pay_type', hours:'hours', payment_method:'payment_method', note:'note', paid:'paid' };
        const sets = [], vals = [];
        let idx = 1;
        for (const [k, col] of Object.entries(colMap)) {
          if (body[k] !== undefined) { sets.push(`${col}=$${idx++}`); vals.push(body[k]); }
        }
        if (body.paid === true)  { sets.push(`paid_at=NOW()`); }
        if (body.paid === false) { sets.push(`paid_at=NULL`); }
        if (!sets.length) return json(400, { error: 'Nothing to update' });
        sets.push(`updated_at=NOW()`);
        vals.push(parseInt(id));
        const { rows } = await client.query(`UPDATE staff_payments SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals);
        if (!rows.length) return json(404, { error: 'Not found' });
        return json(200, { payment: rows[0] });
      }

      // DELETE
      if (event.httpMethod === 'DELETE') {
        const id = event.path.split('/').pop();
        await client.query('DELETE FROM staff_payments WHERE id=$1', [parseInt(id)]);
        return json(200, { success: true });
      }

      return json(405, { error: 'Method not allowed' });
    });
  } catch(err) {
    console.error('staff-payments error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};
