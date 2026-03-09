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

// ── Notification helper (SMS-ready: add Twilio branch here later) ──────────────
const notify = async ({ to_email, to_name, subject, html }) => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY || !to_email) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Funky Monkey Events <bookings@funkymonkeyevents.com>',
        to: to_email,
        subject,
        html
      })
    });
    const data = await res.json();
    if (data.error) console.error('Resend error:', JSON.stringify(data.error));
    else console.log('Notified:', to_email, 'id:', data.id);
  } catch(e) { console.error('notify error:', e.message); }
};

const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

const wrap = (body) => `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px">
      <div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div>
    </div>
    <div style="padding:24px">${body}</div>
  </div>`;

async function ensureTables(client) {
  // Staff slots — requirements per service
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_slots (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) NOT NULL,
      tag_required VARCHAR(100) NOT NULL,
      slot_count INTEGER DEFAULT 1,
      exclusive BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // Assignments — who's interested/assigned per booking
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_assignments (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      slot_id INTEGER REFERENCES staff_slots(id) ON DELETE SET NULL,
      staff_id INTEGER NOT NULL,
      tag_filled VARCHAR(100) NOT NULL,
      status VARCHAR(32) DEFAULT 'interested',
      notified_at TIMESTAMPTZ,
      assigned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(booking_id, staff_id, tag_filled)
    )
  `);

  // Gig checklist + survey per assignment
  await client.query(`
    CREATE TABLE IF NOT EXISTS gig_logs (
      id SERIAL PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES staff_assignments(id) ON DELETE CASCADE,
      booking_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      status VARCHAR(32) DEFAULT 'upcoming',
      on_my_way_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      guest_count_actual INTEGER,
      balance_collected BOOLEAN,
      balance_amount NUMERIC(10,2),
      gas_level VARCHAR(50),
      foam_fluid_needed BOOLEAN,
      empty_jugs_refilled BOOLEAN,
      event_rating INTEGER CHECK(event_rating BETWEEN 1 AND 5),
      notes TEXT DEFAULT '',
      issues TEXT DEFAULT '',
      survey_submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrations
  const migrations = [
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS foam_fluid_needed BOOLEAN",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS empty_jugs_refilled BOOLEAN",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS gas_level VARCHAR(50)",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS survey_submitted_at TIMESTAMPTZ",
  ];
  for (const sql of migrations) {
    try { await client.query(sql); } catch (_) {}
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTables(client);

    const path = event.path.replace(/\/api\/staff-assignments\/?/, '');
    const body = event.body ? JSON.parse(event.body) : {};

    // ── GET /api/staff-assignments?booking_id=X ──────────────────────────────
    // Returns all assignments + slots for a booking
    if (event.httpMethod === 'GET') {
      const bookingId = event.queryStringParameters?.booking_id;
      const staffId   = event.queryStringParameters?.staff_id;

      if (bookingId) {
        const { rows: assignments } = await client.query(
          `SELECT sa.*, s.name as staff_name, s.preferred_name, s.color, s.skills,
                  gl.status as checklist_status, gl.id as log_id
           FROM staff_assignments sa
           JOIN staff s ON s.id = sa.staff_id
           LEFT JOIN gig_logs gl ON gl.assignment_id = sa.id
           WHERE sa.booking_id = $1
           ORDER BY sa.created_at`,
          [parseInt(bookingId)]
        );
        const { rows: slots } = await client.query(
          `SELECT ss.*, b.service_id
           FROM staff_slots ss
           JOIN bookings b ON b.service_id = ss.service_id
           WHERE b.id = $1
           ORDER BY ss.sort_order`,
          [parseInt(bookingId)]
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ assignments, slots }) };
      }

      if (staffId) {
        // Staff portal: upcoming gigs where this staff is assigned or interested
        // Plus open gigs where their tags match and they haven't responded
        const { rows: myGigs } = await client.query(
          `SELECT sa.*, b.reference, b.service_name, b.event_date, b.event_time,
                  b.event_type, b.guest_count, b.event_zip, b.event_location,
                  b.client_name, b.client_phone, b.client_email,
                  b.total_price, b.deposit_paid, b.balance_due,
                  b.notes as client_notes, b.status as booking_status,
                  gl.status as checklist_status, gl.id as log_id
           FROM staff_assignments sa
           JOIN bookings b ON b.id = sa.booking_id
           LEFT JOIN gig_logs gl ON gl.assignment_id = sa.id
           WHERE sa.staff_id = $1
             AND b.event_date >= CURRENT_DATE
             AND b.status NOT IN ('cancelled')
           ORDER BY b.event_date ASC`,
          [parseInt(staffId)]
        );

        // Open gigs: confirmed bookings where this staff's tags match a needed slot
        // and they haven't already responded
        const { rows: staffRow } = await client.query('SELECT skills FROM staff WHERE id=$1', [parseInt(staffId)]);
        const skills = staffRow[0]?.skills || [];
        const tags = (Array.isArray(skills) ? skills : JSON.parse(skills || '[]')).map(s => s.name);

        let openGigs = [];
        if (tags.length) {
          const { rows } = await client.query(
            `SELECT DISTINCT b.id, b.reference, b.service_name, b.event_date, b.event_time,
                    b.event_type, b.guest_count, b.event_zip, b.status as booking_status,
                    ss.tag_required
             FROM bookings b
             JOIN staff_slots ss ON ss.service_id = b.service_id
             WHERE b.status = 'confirmed'
               AND b.event_date >= CURRENT_DATE + INTERVAL '7 days'
               AND ss.tag_required = ANY($1::text[])
               AND b.id NOT IN (
                 SELECT booking_id FROM staff_assignments WHERE staff_id = $2
               )
             ORDER BY b.event_date ASC`,
            [tags, parseInt(staffId)]
          );
          openGigs = rows;
        }

        // Only assigned staff get client contact details
        const safeGigs = myGigs.map(g => {
          if (g.status !== 'assigned') {
            const { client_name, client_phone, client_email, total_price, deposit_paid, balance_due, ...safe } = g;
            return safe;
          }
          return g;
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ myGigs: safeGigs, openGigs }) };
      }

      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'booking_id or staff_id required' }) };
    }

    // ── POST /api/staff-assignments ──────────────────────────────────────────
    const action = body.action;

    // action: notify_staff — triggered when Joe confirms a booking
    // Finds all staff with matching tags and emails them the portal link
    if (action === 'notify_staff') {
      const { booking_id } = body;
      if (!booking_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'booking_id required' }) };

      const { rows: bookings } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
      const booking = bookings[0];
      if (!booking) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Booking not found' }) };

      // Get required slots for this service
      const { rows: slots } = await client.query(
        'SELECT * FROM staff_slots WHERE service_id=$1 ORDER BY sort_order',
        [booking.service_id]
      );

      if (!slots.length) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ notified: 0, message: 'No slots defined for this service' }) };
      }

      const tags = [...new Set(slots.map(s => s.tag_required))];

      // Find all active staff with any matching tag
      const { rows: allStaff } = await client.query('SELECT * FROM staff WHERE active=TRUE');
      const eligible = allStaff.filter(s => {
        const skills = Array.isArray(s.skills) ? s.skills : JSON.parse(s.skills || '[]');
        return skills.some(sk => tags.includes(sk.name));
      });

      const dateStr = booking.event_date
        ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
        : 'TBD';
      const timeStr = booking.event_time || '';

      let notified = 0;
      for (const staff of eligible) {
        const skills = Array.isArray(staff.skills) ? staff.skills : JSON.parse(staff.skills || '[]');
        const matchedTags = skills.filter(sk => tags.includes(sk.name)).map(sk => sk.name);

        await notify({
          to_email: staff.email,
          to_name: staff.preferred_name || staff.name,
          subject: `🎪 Gig Available — ${booking.service_name} on ${dateStr}`,
          html: wrap(`
            <p style="font-size:16px;margin-bottom:16px">Hi <strong>${staff.preferred_name || staff.name}</strong>! 👋</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">A new gig is available and your skills match what's needed. Log in to the staff portal to express your interest!</p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${booking.service_name}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date & Time</span><br><span style="font-weight:600">${dateStr}${timeStr?' at '+timeStr:''}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">${booking.event_zip || 'OKC area'}</span></div>
              <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Matching Skills</span><br><span style="color:#FFD600;font-weight:700">${matchedTags.join(', ')}</span></div>
            </div>
            <div style="text-align:center;margin-bottom:20px">
              <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">Log In to Express Interest →</a>
            </div>
            <p style="font-size:12px;color:#A78BCA;text-align:center">Log in with your PIN · ${SITE}/admin.html</p>
          `)
        });
        notified++;
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ notified, tags, eligible: eligible.length }) };
    }

    // action: express_interest — staff clicks "I'm Available" or "I'm a Backup"
    if (action === 'express_interest') {
      const { booking_id, staff_id, tag_filled, status } = body; // status = 'interested' | 'backup'
      if (!booking_id || !staff_id || !tag_filled) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'booking_id, staff_id, tag_filled required' }) };
      }

      const { rows } = await client.query(
        `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE SET status=$4, updated_at=NOW()
         RETURNING *`,
        [parseInt(booking_id), parseInt(staff_id), tag_filled, status || 'interested']
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows[0]) };
    }

    // action: assign — Joe assigns a staff member to a booking slot
    if (action === 'assign') {
      const { booking_id, staff_id, tag_filled, slot_id } = body;
      if (!booking_id || !staff_id || !tag_filled) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'booking_id, staff_id, tag_filled required' }) };
      }

      // Upsert the assignment as 'assigned'
      const { rows } = await client.query(
        `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status, slot_id, assigned_at)
         VALUES ($1,$2,$3,'assigned',$4,NOW())
         ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE
           SET status='assigned', slot_id=$4, assigned_at=NOW(), updated_at=NOW()
         RETURNING *`,
        [parseInt(booking_id), parseInt(staff_id), tag_filled, slot_id || null]
      );

      const assignment = rows[0];

      // Create a gig_log entry for this assignment so checklist is ready
      await client.query(
        `INSERT INTO gig_logs (assignment_id, booking_id, staff_id, status)
         VALUES ($1,$2,$3,'upcoming')
         ON CONFLICT DO NOTHING`,
        [assignment.id, parseInt(booking_id), parseInt(staff_id)]
      ).catch(() => {}); // ignore if already exists

      // Notify the assigned staff member
      const { rows: staffRows } = await client.query('SELECT * FROM staff WHERE id=$1', [parseInt(staff_id)]);
      const { rows: bookingRows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
      const s = staffRows[0];
      const b = bookingRows[0];

      if (s && b) {
        const dateStr = b.event_date
          ? new Date(b.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
          : 'TBD';

        await notify({
          to_email: s.email,
          to_name: s.preferred_name || s.name,
          subject: `✅ You're booked! ${b.service_name} on ${dateStr}`,
          html: wrap(`
            <p style="font-size:16px;margin-bottom:16px">Hi <strong>${s.preferred_name || s.name}</strong>! 🎉</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">You've been assigned to a gig! Log into your portal to see the full details.</p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${b.service_name}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date & Time</span><br><span style="font-weight:600">${dateStr}${b.event_time?' at '+b.event_time:''}</span></div>
              <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">${b.event_zip || 'OKC'}${b.event_location?' — '+b.event_location:''}</span></div>
              <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Role</span><br><span style="color:#FFD600;font-weight:700">${tag_filled}</span></div>
            </div>
            <div style="text-align:center;margin-bottom:20px">
              <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">View Gig Details →</a>
            </div>
            <p style="font-size:12px;color:#A78BCA;text-align:center">Questions? Contact Joe at <a href="tel:4054316625" style="color:#06B6D4">(405) 431-6625</a></p>
          `)
        });
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(assignment) };
    }

    // action: unassign
    if (action === 'unassign') {
      const { booking_id, staff_id, tag_filled } = body;
      await client.query(
        `UPDATE staff_assignments SET status='interested', assigned_at=NULL, updated_at=NOW()
         WHERE booking_id=$1 AND staff_id=$2 AND tag_filled=$3`,
        [parseInt(booking_id), parseInt(staff_id), tag_filled]
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    // action: update_checklist — staff updates their gig status
    if (action === 'update_checklist') {
      const { log_id, assignment_id, booking_id, staff_id, status } = body;
      const validStatuses = ['upcoming','on_my_way','arrived','completed'];
      if (!validStatuses.includes(status)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid status' }) };
      }

      const tsMap = {
        on_my_way: 'on_my_way_at',
        arrived:   'arrived_at',
        completed: 'completed_at',
      };
      const tsCol = tsMap[status];
      const tsClause = tsCol ? `, ${tsCol}=NOW()` : '';

      let rows;
      if (log_id) {
        ({ rows } = await client.query(
          `UPDATE gig_logs SET status=$1${tsClause}, updated_at=NOW() WHERE id=$2 RETURNING *`,
          [status, parseInt(log_id)]
        ));
      } else {
        // Create if doesn't exist
        ({ rows } = await client.query(
          `INSERT INTO gig_logs (assignment_id, booking_id, staff_id, status)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [parseInt(assignment_id), parseInt(booking_id), parseInt(staff_id), status]
        ));
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows[0] || { success: true }) };
    }

    // action: submit_survey — staff submits post-gig survey
    if (action === 'submit_survey') {
      const { log_id } = body;
      if (!log_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'log_id required' }) };

      const fields = [
        'guest_count_actual','balance_collected','balance_amount',
        'gas_level','foam_fluid_needed','empty_jugs_refilled',
        'event_rating','notes','issues'
      ];

      const sets = [], vals = [];
      let idx = 1;
      fields.forEach(f => {
        if (body[f] !== undefined) {
          sets.push(`${f}=$${idx}`);
          vals.push(body[f]);
          idx++;
        }
      });

      if (!sets.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No survey fields provided' }) };

      sets.push(`survey_submitted_at=NOW()`);
      sets.push(`updated_at=NOW()`);
      vals.push(parseInt(log_id));

      const { rows } = await client.query(
        `UPDATE gig_logs SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`,
        vals
      );

      // Notify Joe that a survey was submitted
      const log = rows[0];
      if (log) {
        const { rows: staffRows } = await client.query('SELECT name, preferred_name FROM staff WHERE id=$1', [log.staff_id]);
        const { rows: bRows } = await client.query('SELECT reference, service_name, event_date FROM bookings WHERE id=$1', [log.booking_id]);
        const sName = staffRows[0]?.preferred_name || staffRows[0]?.name || 'Staff';
        const bRef  = bRows[0]?.reference || '';
        const svc   = bRows[0]?.service_name || '';

        const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
        await notify({
          to_email: NOTIFY,
          to_name: 'Joe',
          subject: `📋 Post-Gig Survey Submitted — ${sName} · ${bRef}`,
          html: wrap(`
            <p style="font-weight:700;font-size:15px;margin-bottom:16px">📋 ${sName} submitted a post-gig report for <span style="color:#FFD600">${svc}</span></p>
            <table style="width:100%;border-collapse:collapse">
              ${log.guest_count_actual!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:180px">Actual Guests</td><td style="padding:6px 0;font-weight:600">${log.guest_count_actual}</td></tr>`:''}
              ${log.balance_collected!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Collected</td><td style="padding:6px 0;font-weight:600">${log.balance_collected?'✅ Yes — $'+(log.balance_amount||0):'❌ No'}</td></tr>`:''}
              ${log.gas_level?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Gas Level</td><td style="padding:6px 0;font-weight:600">${log.gas_level}</td></tr>`:''}
              ${log.foam_fluid_needed!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Foam Fluid Needed</td><td style="padding:6px 0;font-weight:600">${log.foam_fluid_needed?'⚠️ Yes':'✅ No'}</td></tr>`:''}
              ${log.empty_jugs_refilled!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Jugs Refilled</td><td style="padding:6px 0;font-weight:600">${log.empty_jugs_refilled?'✅ Yes':'❌ No'}</td></tr>`:''}
              ${log.event_rating?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Event Rating</td><td style="padding:6px 0;font-weight:600">${'⭐'.repeat(log.event_rating)} (${log.event_rating}/5)</td></tr>`:''}
              ${log.notes?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;vertical-align:top">Notes</td><td style="padding:6px 0">${log.notes}</td></tr>`:''}
              ${log.issues?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;vertical-align:top">Issues</td><td style="padding:6px 0;color:#FCA5A5">${log.issues}</td></tr>`:''}
            </table>
            <div style="margin-top:20px;text-align:center">
              <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">View in Dashboard →</a>
            </div>
          `)
        });
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows[0]) };
    }

    // action: update_staff_notes — staff updates their own notes to admin
    if (action === 'update_staff_notes') {
      const { staff_id, staff_notes } = body;
      if (!staff_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'staff_id required' }) };
      await client.query(
        'UPDATE staff SET staff_notes=$1, updated_at=NOW() WHERE id=$2',
        [staff_notes || '', parseInt(staff_id)]
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('staff-assignments.js error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
