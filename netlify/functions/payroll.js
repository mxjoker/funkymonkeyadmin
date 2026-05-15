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

      // action: generate - Create new payroll run for a date range
      if (action === 'generate') {
        const { week_ending, date_from, date_to, label } = body;

        // Support both legacy week_ending and new date_from/date_to range
        let rangeStart, rangeEnd, runLabel;
        if (date_from && date_to) {
          rangeStart = date_from;
          rangeEnd   = date_to;
          runLabel   = label || `${date_from} – ${date_to}`;
        } else if (week_ending) {
          rangeEnd   = getSunday(week_ending);
          rangeStart = getMonday(rangeEnd);
          runLabel   = `Week ending ${rangeEnd}`;
        } else {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'date_from + date_to or week_ending required' }) };
        }

        // Check if run already exists for this exact range
        const { rows: existing } = await client.query(
          'SELECT * FROM payroll_runs WHERE week_ending = $1', [rangeEnd]
        );
        if (existing.length > 0) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'A payroll run already exists ending on this date', run: existing[0] }) };
        }

        // ── Step 1: Find all assigned staff on bookings in range, NOT already paid ──
        const { rows: assignments } = await client.query(`
          SELECT sa.id as assignment_id, sa.staff_id, sa.tag_filled,
                 sa.load_minutes, sa.unload_minutes, sa.pack_out_minutes,
                 sa.home_unload_minutes, sa.drive_minutes_each_way, sa.total_minutes,
                 b.id as booking_id, b.reference, b.service_name, b.service_id,
                 b.event_date, b.event_time, b.event_zip,
                 s.name as staff_name, s.preferred_name,
                 s.pay_type, s.flat_rate, s.hourly_rate
          FROM staff_assignments sa
          JOIN bookings b ON b.id = sa.booking_id
          JOIN staff s ON s.id = sa.staff_id
          -- Exclude gigs where this staff member is already paid
          LEFT JOIN staff_payments sp_paid
            ON sp_paid.booking_id = sa.booking_id
            AND sp_paid.staff_id  = sa.staff_id
            AND sp_paid.paid = true
          WHERE sa.status = 'assigned'
            AND b.event_date >= $1
            AND b.event_date <= $2
            AND b.status IN ('confirmed','completed')
            AND sp_paid.id IS NULL
          ORDER BY s.id, b.event_date
        `, [rangeStart, rangeEnd]);

        if (assignments.length === 0) {
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
            message: 'No unpaid assigned staff found for this date range',
            date_from: rangeStart, date_to: rangeEnd, count: 0
          }) };
        }

        // ── Step 2: Load service time templates ──────────────────────────────
        const { rows: templates } = await client.query(
          'SELECT * FROM service_time_templates'
        );
        const templateMap = {};
        templates.forEach(t => { templateMap[t.service_id] = t; });

        // ── Step 3: Load service durations (party_minutes) ───────────────────
        const { rows: services } = await client.query(
          'SELECT service_id, duration_minutes FROM services'
        );
        const durationMap = {};
        services.forEach(s => { durationMap[s.service_id] = s.duration_minutes || 60; });

        // ── Step 4: Estimate drive time via straight-line ZIP distance ────────
        // Uses a simple OKC-area ZIP→coords map for offline estimation.
        // Falls back to 30 min if ZIP unknown.
        const HOME_ZIP = '73118';
        const zipCoords = {
          '73099':{ lat:35.5176, lng:-97.7618 }, '73101':{ lat:35.4676, lng:-97.5164 },
          '73102':{ lat:35.4714, lng:-97.5169 }, '73103':{ lat:35.4869, lng:-97.5245 },
          '73104':{ lat:35.4781, lng:-97.5058 }, '73105':{ lat:35.4947, lng:-97.5112 },
          '73106':{ lat:35.4875, lng:-97.5411 }, '73107':{ lat:35.4786, lng:-97.5631 },
          '73108':{ lat:35.4531, lng:-97.5604 }, '73109':{ lat:35.4397, lng:-97.5245 },
          '73110':{ lat:35.4631, lng:-97.4203 }, '73111':{ lat:35.5061, lng:-97.4913 },
          '73112':{ lat:35.5008, lng:-97.5631 }, '73114':{ lat:35.5675, lng:-97.5245 },
          '73115':{ lat:35.4275, lng:-97.4581 }, '73116':{ lat:35.5397, lng:-97.5631 },
          '73117':{ lat:35.4841, lng:-97.4913 }, '73118':{ lat:35.5161, lng:-97.5411 },
          '73119':{ lat:35.4231, lng:-97.5631 }, '73120':{ lat:35.5675, lng:-97.5831 },
          '73121':{ lat:35.5008, lng:-97.4581 }, '73122':{ lat:35.5008, lng:-97.6031 },
          '73127':{ lat:35.4786, lng:-97.6431 }, '73128':{ lat:35.4397, lng:-97.6431 },
          '73129':{ lat:35.4231, lng:-97.4913 }, '73130':{ lat:35.4631, lng:-97.3803 },
          '73131':{ lat:35.5397, lng:-97.4581 }, '73132':{ lat:35.5397, lng:-97.6231 },
          '73134':{ lat:35.6097, lng:-97.5831 }, '73135':{ lat:35.3875, lng:-97.4581 },
          '73139':{ lat:35.3875, lng:-97.5245 }, '73142':{ lat:35.6097, lng:-97.6231 },
          '73149':{ lat:35.3875, lng:-97.4203 }, '73150':{ lat:35.4231, lng:-97.3803 },
          '73159':{ lat:35.3875, lng:-97.6031 }, '73160':{ lat:35.3275, lng:-97.5245 },
          '73162':{ lat:35.5675, lng:-97.6431 }, '73165':{ lat:35.3275, lng:-97.4203 },
          '73169':{ lat:35.3875, lng:-97.6431 }, '73170':{ lat:35.3275, lng:-97.6031 },
          '73179':{ lat:35.4397, lng:-97.6831 },
          // Surrounding cities
          '73003':{ lat:35.6597, lng:-97.4781 }, '73007':{ lat:35.6097, lng:-97.4203 },
          '73008':{ lat:35.5397, lng:-97.6831 }, '73013':{ lat:35.6397, lng:-97.5631 },
          '73020':{ lat:35.4631, lng:-97.2803 }, '73025':{ lat:35.6597, lng:-97.7418 },
          '73026':{ lat:35.2275, lng:-97.4413 }, '73034':{ lat:35.6597, lng:-97.3803 },
          '73044':{ lat:35.8597, lng:-97.4581 }, '73049':{ lat:35.4631, lng:-97.1803 },
          '73051':{ lat:35.1275, lng:-97.3803 }, '73054':{ lat:35.6097, lng:-97.2803 },
          '73059':{ lat:35.3275, lng:-97.8031 }, '73064':{ lat:35.4097, lng:-97.7618 },
          '73066':{ lat:35.5397, lng:-97.2803 }, '73069':{ lat:35.2275, lng:-97.2803 },
          '73071':{ lat:35.2275, lng:-97.4413 }, '73072':{ lat:35.2275, lng:-97.4413 },
          '73073':{ lat:36.1597, lng:-97.5831 }, '73074':{ lat:34.9275, lng:-97.4413 },
          '73078':{ lat:35.5675, lng:-97.7818 }, '73080':{ lat:35.2275, lng:-97.6031 },
          '73084':{ lat:35.5397, lng:-97.3803 }, '73089':{ lat:35.3275, lng:-97.7218 },
          '73093':{ lat:35.2275, lng:-97.5631 }, '73097':{ lat:35.3875, lng:-97.7218 },
        };

        function getDriveMins(destZip) {
          const home = zipCoords[HOME_ZIP];
          const dest = zipCoords[(destZip||'').toString().substring(0,5)];
          if (!home || !dest) return 30; // fallback
          // Haversine distance → assume 35 mph average → minutes
          const R = 3958.8; // miles
          const dLat = (dest.lat - home.lat) * Math.PI / 180;
          const dLng = (dest.lng - home.lng) * Math.PI / 180;
          const a = Math.sin(dLat/2)**2 + Math.cos(home.lat*Math.PI/180)*Math.cos(dest.lat*Math.PI/180)*Math.sin(dLng/2)**2;
          const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          return Math.max(10, Math.round((miles / 35) * 60)) + 15; // min 10 min + 15 min gas stop buffer
        }

        // ── Step 5: Build payment records ────────────────────────────────────
        const paymentsToCreate = [];

        for (const a of assignments) {
          // Check if a staff_payment already exists for this assignment
          const { rows: existing } = await client.query(
            'SELECT id FROM staff_payments WHERE booking_id=$1 AND staff_id=$2',
            [a.booking_id, a.staff_id]
          );

          // Get time values — prefer assignment overrides, fall back to template
          const tmpl = templateMap[a.service_id] || {};
          const load    = a.load_minutes          ?? tmpl.load_minutes          ?? 30;
          const unload  = a.unload_minutes         ?? tmpl.unload_minutes         ?? 15;
          const pack    = a.pack_out_minutes       ?? tmpl.pack_out_minutes       ?? 20;
          const homeUn  = a.home_unload_minutes    ?? tmpl.home_unload_minutes    ?? 15;
          const drive   = a.drive_minutes_each_way ?? getDriveMins(a.event_zip);
          const party   = durationMap[a.service_id] || 60;

          // Total hours = load + drive_to + unload + party + pack_out + drive_home + home_unload
          const totalMins = load + drive + unload + party + pack + drive + homeUn;
          const rawHours = totalMins / 60;
          const totalHours = Math.max(5, Math.round(rawHours * 100) / 100); // 5-hour minimum

          // Calculate pay
          const payType = a.pay_type || 'flat';
          let amount;
          if (payType === 'hourly') {
            amount = Math.round(totalHours * (Number(a.hourly_rate) || 0) * 100) / 100;
          } else {
            // flat — use existing staff_payment amount if already set, else flat_rate default
            amount = existing.length > 0 ? null : (Number(a.flat_rate) || 0);
          }

          paymentsToCreate.push({
            existingId: existing[0]?.id || null,
            staff_id:   a.staff_id,
            booking_id: a.booking_id,
            assignment_id: a.assignment_id,
            reference:  a.reference,
            service_name: a.service_name,
            event_date: a.event_date,
            pay_type:   payType,
            raw_hours:  Math.round(rawHours * 100) / 100,
            hours:      totalHours,
            amount,
            drive_minutes: drive,
            total_minutes: totalMins,
          });

          // Auto-save calculated drive + total back to assignment
          await client.query(`
            UPDATE staff_assignments SET
              drive_minutes_each_way = $1,
              total_minutes = $2,
              updated_at = NOW()
            WHERE id = $3
              AND (drive_minutes_each_way IS NULL OR total_minutes IS NULL)
          `, [drive, totalMins, a.assignment_id]);
        }

        // ── Step 6: Create/update staff_payments ─────────────────────────────
        const paymentIds = [];
        for (const p of paymentsToCreate) {
          if (p.existingId) {
            // Update hours on existing record (don't overwrite a manually-set amount)
            await client.query(
              'UPDATE staff_payments SET hours=$1, updated_at=NOW() WHERE id=$2',
              [p.hours, p.existingId]
            );
            paymentIds.push({ id: p.existingId, ...p });
          } else {
            const { rows: ins } = await client.query(`
              INSERT INTO staff_payments
                (staff_id, booking_id, amount, pay_type, hours, note)
              VALUES ($1,$2,$3,$4,$5,$6)
              RETURNING *
            `, [
              p.staff_id, p.booking_id,
              p.amount !== null ? p.amount : 0,
              p.pay_type, p.hours,
              `Auto-generated: ${p.total_minutes} min raw (${p.drive_minutes} min drive ea.) → ${p.hours}h paid${p.hours > p.raw_hours ? ' (5h min applied)' : ''}`
            ]);
            paymentIds.push({ id: ins[0].id, ...p });
          }
        }

        // ── Step 7: Calculate total and create payroll run ───────────────────
        const { rows: finalPayments } = await client.query(`
          SELECT sp.* FROM staff_payments sp
          WHERE sp.id = ANY($1::int[]) AND sp.paid = false
        `, [paymentIds.map(p => p.id)]);

        const totalAmount = finalPayments.reduce((sum, p) => sum + Number(p.amount), 0);

        const { rows: [run] } = await client.query(`
          INSERT INTO payroll_runs (week_ending, status, total_amount, notes, created_by)
          VALUES ($1, 'draft', $2, $3, 'Admin')
          RETURNING *
        `, [rangeEnd, totalAmount, runLabel]);

        for (const payment of finalPayments) {
          const pid = paymentIds.find(p => p.id === payment.id);
          await client.query(`
            INSERT INTO payroll_line_items (payroll_run_id, staff_payment_id, staff_id, amount)
            VALUES ($1, $2, $3, $4)
          `, [run.id, payment.id, payment.staff_id, payment.amount]);
        }

        console.log(`Created payroll run ${run.id} for ${rangeStart}–${rangeEnd} with ${finalPayments.length} payments totaling $${totalAmount}`);

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          run,
          count: finalPayments.length,
          assignments_found: assignments.length,
          date_from: rangeStart,
          date_to: rangeEnd
        }) };
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
