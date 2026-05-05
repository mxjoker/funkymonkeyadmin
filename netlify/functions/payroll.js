const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Content-Type': 'application/json'
};

// Ensure tables exist
async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id SERIAL PRIMARY KEY,
      week_ending DATE NOT NULL,
      status VARCHAR(32) DEFAULT 'draft',
      total_amount NUMERIC(10,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      payment_method VARCHAR(64) DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_by VARCHAR(255) DEFAULT 'Admin'
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS payroll_line_items (
      id SERIAL PRIMARY KEY,
      payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      staff_payment_id INTEGER NOT NULL REFERENCES staff_payments(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      adjustment_amount NUMERIC(10,2) DEFAULT 0,
      adjustment_note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add payroll_run_id to staff_payments if not exists
  try {
    await client.query(`
      ALTER TABLE staff_payments 
      ADD COLUMN IF NOT EXISTS payroll_run_id INTEGER REFERENCES payroll_runs(id)
    `);
  } catch (_) {}
}

// Get the Sunday for a given date (week ending)
function getSunday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day; // days until Sunday
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// Get the Monday for the week (6 days before Sunday)
function getMonday(sundayDate) {
  const d = new Date(sundayDate);
  d.setDate(d.getDate() - 6);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTables(client);

    const path = event.path;
    const runId = path.match(/\/api\/payroll\/(\d+)/)?.[1];

    // ── GET /api/payroll ──────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && !runId) {
      const staffId = event.queryStringParameters?.staff_id;
      
      if (staffId) {
        // Staff portal view - only their own payroll history
        const { rows: runs } = await client.query(`
          SELECT DISTINCT pr.*
          FROM payroll_runs pr
          JOIN payroll_line_items pli ON pli.payroll_run_id = pr.id
          WHERE pli.staff_id = $1
          ORDER BY pr.week_ending DESC
          LIMIT 12
        `, [parseInt(staffId)]);

        // Get line items for each run (only for this staff member)
        for (const run of runs) {
          const { rows: items } = await client.query(`
            SELECT pli.*, sp.booking_id, b.reference, b.service_name, b.event_date
            FROM payroll_line_items pli
            JOIN staff_payments sp ON sp.id = pli.staff_payment_id
            JOIN bookings b ON b.id = sp.booking_id
            WHERE pli.payroll_run_id = $1 AND pli.staff_id = $2
            ORDER BY b.event_date
          `, [run.id, parseInt(staffId)]);
          run.line_items = items;
          run.staff_total = items.reduce((sum, i) => sum + Number(i.amount) + Number(i.adjustment_amount || 0), 0);
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ runs }) };
      }

      // Admin view - all payroll runs
      const { rows: runs } = await client.query(`
        SELECT pr.*, 
               COUNT(DISTINCT pli.staff_id) as staff_count
        FROM payroll_runs pr
        LEFT JOIN payroll_line_items pli ON pli.payroll_run_id = pr.id
        GROUP BY pr.id
        ORDER BY pr.week_ending DESC
        LIMIT 20
      `);

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ runs }) };
    }

    // ── GET /api/payroll/:id ──────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && runId) {
      const { rows: [run] } = await client.query('SELECT * FROM payroll_runs WHERE id = $1', [parseInt(runId)]);
      if (!run) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Run not found' }) };

      // Get line items grouped by staff
      const { rows: items } = await client.query(`
        SELECT pli.*, 
               s.name as staff_name, s.preferred_name, s.color,
               sp.booking_id, sp.pay_type,
               b.reference, b.service_name, b.event_date
        FROM payroll_line_items pli
        JOIN staff s ON s.id = pli.staff_id
        JOIN staff_payments sp ON sp.id = pli.staff_payment_id
        JOIN bookings b ON b.id = sp.booking_id
        WHERE pli.payroll_run_id = $1
        ORDER BY s.name, b.event_date
      `, [parseInt(runId)]);

      // Group by staff
      const byStaff = {};
      items.forEach(item => {
        if (!byStaff[item.staff_id]) {
          byStaff[item.staff_id] = {
            staff_id: item.staff_id,
            staff_name: item.staff_name,
            preferred_name: item.preferred_name,
            color: item.color,
            items: [],
            total: 0
          };
        }
        byStaff[item.staff_id].items.push(item);
        byStaff[item.staff_id].total += Number(item.amount) + Number(item.adjustment_amount || 0);
      });

      run.staff_groups = Object.values(byStaff);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(run) };
    }

    // ── POST /api/payroll ─────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      // action: generate - Create new payroll run for a given week
      if (action === 'generate') {
        const { week_ending } = body;
        if (!week_ending) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'week_ending required' }) };
        }

        const weekEnd = getSunday(week_ending);
        const weekStart = getMonday(weekEnd);

        // Check if run already exists for this week
        const { rows: existing } = await client.query(
          'SELECT * FROM payroll_runs WHERE week_ending = $1',
          [weekEnd]
        );
        if (existing.length > 0) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Payroll run already exists for this week', run: existing[0] }) };
        }

        // Find all unpaid staff_payments where event_date is in this week
        const { rows: unpaidPayments } = await client.query(`
          SELECT sp.*, b.event_date, s.name as staff_name, s.preferred_name
          FROM staff_payments sp
          JOIN bookings b ON b.id = sp.booking_id
          JOIN staff s ON s.id = sp.staff_id
          WHERE sp.paid = false
            AND b.event_date >= $1
            AND b.event_date <= $2
          ORDER BY s.id, b.event_date
        `, [weekStart, weekEnd]);

        if (unpaidPayments.length === 0) {
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ message: 'No unpaid payments for this week', count: 0 }) };
        }

        // Calculate total
        const totalAmount = unpaidPayments.reduce((sum, p) => sum + Number(p.amount), 0);

        // Create payroll run
        const { rows: [run] } = await client.query(`
          INSERT INTO payroll_runs (week_ending, status, total_amount, created_by)
          VALUES ($1, 'draft', $2, 'Admin')
          RETURNING *
        `, [weekEnd, totalAmount]);

        // Create line items
        for (const payment of unpaidPayments) {
          await client.query(`
            INSERT INTO payroll_line_items (payroll_run_id, staff_payment_id, staff_id, amount)
            VALUES ($1, $2, $3, $4)
          `, [run.id, payment.id, payment.staff_id, payment.amount]);
        }

        console.log(`Created payroll run ${run.id} for week ending ${weekEnd} with ${unpaidPayments.length} payments totaling $${totalAmount}`);

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ run, count: unpaidPayments.length }) };
      }

      // action: add_adjustment - Add bonus/deduction to a line item
      if (action === 'add_adjustment') {
        const { line_item_id, adjustment_amount, adjustment_note } = body;
        await client.query(`
          UPDATE payroll_line_items 
          SET adjustment_amount = $1, adjustment_note = $2
          WHERE id = $3
        `, [adjustment_amount || 0, adjustment_note || '', parseInt(line_item_id)]);

        // Recalculate run total
        const { rows: [item] } = await client.query('SELECT payroll_run_id FROM payroll_line_items WHERE id = $1', [parseInt(line_item_id)]);
        const { rows: [totals] } = await client.query(`
          SELECT SUM(amount + COALESCE(adjustment_amount, 0)) as total
          FROM payroll_line_items
          WHERE payroll_run_id = $1
        `, [item.payroll_run_id]);
        await client.query(
          'UPDATE payroll_runs SET total_amount = $1 WHERE id = $2',
          [totals.total, item.payroll_run_id]
        );

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

    // ── PATCH /api/payroll/:id ────────────────────────────────────────────────
    if (event.httpMethod === 'PATCH' && runId) {
      const body = JSON.parse(event.body || '{}');
      const updates = [];
      const values = [];
      let idx = 1;

      if (body.status) {
        updates.push(`status = $${idx}`);
        values.push(body.status);
        idx++;

        if (body.status === 'approved') {
          updates.push(`approved_at = NOW()`);
        }
        if (body.status === 'paid') {
          updates.push(`paid_at = NOW()`);
        }
      }

      if (body.notes !== undefined) {
        updates.push(`notes = $${idx}`);
        values.push(body.notes);
        idx++;
      }

      if (body.payment_method !== undefined) {
        updates.push(`payment_method = $${idx}`);
        values.push(body.payment_method);
        idx++;
      }

      if (updates.length === 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No fields to update' }) };
      }

      values.push(parseInt(runId));
      const { rows: [updated] } = await client.query(
        `UPDATE payroll_runs SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );

      // If marking as paid, also mark all linked staff_payments as paid
      if (body.status === 'paid') {
        await client.query(`
          UPDATE staff_payments sp
          SET paid = true, payroll_run_id = $1
          FROM payroll_line_items pli
          WHERE sp.id = pli.staff_payment_id
            AND pli.payroll_run_id = $1
        `, [parseInt(runId)]);
        console.log(`Marked all payments in run ${runId} as paid`);
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(updated) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('payroll.js error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
