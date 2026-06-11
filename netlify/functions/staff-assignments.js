const { withClient, getPool } = require('./_db');
const {
  CORS, preflight, requireAuth, unauthorized, forbidden,
} = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// ── Notification helper ───────────────────────────────────────────────────────
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

// ── ZIP → coords map for OKC metro drive-time estimation ─────────────────────
const ZIP_COORDS = {
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
const HOME_ZIP = '73118';

function getDriveMins(destZip) {
  const home = ZIP_COORDS[HOME_ZIP];
  const dest = ZIP_COORDS[(destZip || '').toString().substring(0, 5)];
  if (!home || !dest) return 30;
  const R = 3958.8;
  const dLat = (dest.lat - home.lat) * Math.PI / 180;
  const dLng = (dest.lng - home.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(home.lat*Math.PI/180)*Math.cos(dest.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.max(10, Math.round((miles / 35) * 60)) + 15;
}

// Auto-calculate and persist schedule times for an assignment.
async function autoCalcTimes(client, assignmentId, bookingId, forceRecalc = false) {
  try {
    const { rows: [sa] } = await client.query('SELECT * FROM staff_assignments WHERE id=$1', [assignmentId]);
    if (!sa) return;

    if (!forceRecalc && sa.total_minutes != null) return;

    const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id=$1', [bookingId]);
    if (!b) return;

    const { rows: [tmpl] } = await client.query(
      'SELECT * FROM service_time_templates WHERE service_id=$1', [b.service_id]
    );

    const { rows: [svc] } = await client.query(
      'SELECT duration_minutes FROM services WHERE service_id=$1', [b.service_id]
    );

    const load   = sa.load_minutes          ?? tmpl?.load_minutes          ?? 30;
    const setup  = sa.unload_minutes         ?? tmpl?.unload_minutes         ?? 45;
    const pack   = sa.pack_out_minutes       ?? tmpl?.pack_out_minutes       ?? 20;
    const homeUn = sa.home_unload_minutes    ?? tmpl?.home_unload_minutes    ?? 15;
    const drive  = sa.drive_minutes_each_way ?? getDriveMins(b.event_zip);
    const party  = svc?.duration_minutes     ?? 60;

    const total = load + drive + setup + party + pack + drive + homeUn;

    let scheduleStart = null;
    if (b.event_time) {
      const [hh, mm] = b.event_time.split(':').map(Number);
      const eventMins  = hh * 60 + mm;
      const startMins  = eventMins - load - drive - setup;
      const sh = Math.floor(((startMins % 1440) + 1440) % 1440 / 60);
      const sm = ((startMins % 1440) + 1440) % 1440 % 60;
      scheduleStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    }

    await client.query(`
      UPDATE staff_assignments SET
        load_minutes          = COALESCE(load_minutes, $1),
        unload_minutes        = COALESCE(unload_minutes, $2),
        pack_out_minutes      = COALESCE(pack_out_minutes, $3),
        home_unload_minutes   = COALESCE(home_unload_minutes, $4),
        drive_minutes_each_way= COALESCE(drive_minutes_each_way, $5),
        total_minutes         = $6,
        schedule_start        = $7,
        updated_at            = NOW()
      WHERE id = $8
    `, [load, setup, pack, homeUn, drive, total, scheduleStart, assignmentId]);

    console.log(`autoCalcTimes: assignment ${assignmentId} → ${total} min total, start ${scheduleStart}`);
  } catch(e) {
    console.error('autoCalcTimes error:', e.message);
  }
}

const wrap = (body) => `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px">
      <div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div>
    </div>
    <div style="padding:24px">${body}</div>
  </div>`;

async function ensureTables(client) {
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS service_time_templates (
      id SERIAL PRIMARY KEY,
      service_id VARCHAR(64) UNIQUE NOT NULL,
      load_minutes INTEGER DEFAULT 30,
      unload_minutes INTEGER DEFAULT 15,
      pack_out_minutes INTEGER DEFAULT 20,
      home_unload_minutes INTEGER DEFAULT 15,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrations = [
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS load_minutes INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS unload_minutes INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pack_out_minutes INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS home_unload_minutes INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS drive_minutes_each_way INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS total_minutes INTEGER",
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS schedule_start TIME",
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
  const pre = preflight(event);
  if (pre) return pre;

  try {
    return await withClient(async (client) => {
      await ensureTables(client);

      const params = event.queryStringParameters || {};
      let body = {};
      if (event.body) {
        try { body = JSON.parse(event.body); } catch { return json(400, { error: 'Invalid JSON' }); }
      }

      // ── GET /api/staff-assignments ─────────────────────────────────────────
      if (event.httpMethod === 'GET') {
        // All GET reads require at minimum a staff or admin token
        const auth = await requireAuth(event);
        if (!auth) return unauthorized();

        const bookingId = params.booking_id;
        const allFlag   = params.all === 'true';

        // ?all=true — lightweight fetch for calendar staff initials
        if (allFlag) {
          const { rows: assignments } = await client.query(
            `SELECT sa.booking_id, sa.staff_id, sa.status,
                    s.name as staff_name, s.preferred_name, s.color
             FROM staff_assignments sa
             JOIN staff s ON s.id = sa.staff_id
             WHERE sa.status = 'assigned'
             ORDER BY sa.booking_id`
          );
          return json(200, { assignments });
        }

        if (bookingId) {
          const { rows: assignments } = await client.query(
            `SELECT sa.*, s.name as staff_name, s.preferred_name, s.color, s.skills,
                    gl.id as log_id, gl.status as checklist_status,
                    gl.survey_submitted_at, gl.guest_count_actual,
                    gl.balance_collected, gl.balance_amount,
                    gl.gas_level, gl.foam_fluid_needed, gl.empty_jugs_refilled,
                    gl.event_rating, gl.notes as survey_notes, gl.issues as survey_issues
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
          return json(200, { assignments, slots });
        }

        if (params.service_slots) {
          const { rows: slots } = await client.query(
            'SELECT * FROM staff_slots ORDER BY service_id, sort_order'
          );
          return json(200, { slots });
        }

        if (params.time_templates === 'true') {
          const { rows: templates } = await client.query(
            'SELECT * FROM service_time_templates ORDER BY service_id'
          );
          return json(200, { templates });
        }

        // ?staff_id= — staff-scoped or admin
        if (params.staff_id) {
          // Determine effective staff_id under scoping rules
          let staffId = parseInt(params.staff_id);
          if (auth.role === 'staff') {
            if (auth.staffId !== staffId) return forbidden();
            staffId = auth.staffId;
          }

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
            [staffId]
          );

          const { rows: staffRow } = await client.query('SELECT skills FROM staff WHERE id=$1', [staffId]);
          const skills = staffRow[0]?.skills || [];
          const tags = (Array.isArray(skills) ? skills : JSON.parse(skills || '[]')).map(s => s.name);

          let openGigs = [];
          if (tags.length) {
            const { rows } = await client.query(
              `SELECT DISTINCT b.id, b.reference, b.service_name, b.event_date, b.event_time,
                      b.event_type, b.guest_count, b.event_zip, b.status as booking_status,
                      COALESCE(ss.tag_required, b.service_name) as tag_required
               FROM bookings b
               LEFT JOIN staff_slots ss ON ss.service_id = b.service_id
               WHERE b.status = 'confirmed'
                 AND b.event_date >= CURRENT_DATE
                 AND (
                   ss.tag_required = ANY($1::text[])
                   OR
                   (ss.id IS NULL AND b.service_name = ANY($1::text[]))
                 )
                 AND b.id NOT IN (
                   SELECT booking_id FROM staff_assignments WHERE staff_id = $2
                 )
               ORDER BY b.event_date ASC`,
              [tags, staffId]
            );
            openGigs = rows;
          }

          const safeGigs = myGigs.map(g => {
            if (g.status !== 'assigned') {
              const { client_name, client_phone, client_email, total_price, deposit_paid, balance_due, ...safe } = g;
              return safe;
            }
            return g;
          });

          return json(200, { myGigs: safeGigs, openGigs });
        }

        return json(400, { error: 'booking_id or staff_id required' });
      }

      // ── POST /api/staff-assignments ────────────────────────────────────────
      if (event.httpMethod === 'POST') {
        const action = body.action;

        // ── Staff actions (express_interest, update_checklist, submit_survey) ─
        if (action === 'express_interest') {
          const auth = await requireAuth(event);
          if (!auth) return unauthorized();

          let { booking_id, staff_id, tag_filled, status } = body;
          if (!booking_id || !staff_id || !tag_filled) {
            return json(400, { error: 'booking_id, staff_id, tag_filled required' });
          }

          // Staff scoping: force staff_id to auth.staffId
          if (auth.role === 'staff') {
            if (parseInt(staff_id) !== auth.staffId) return forbidden();
            staff_id = auth.staffId;
          }

          const { rows } = await client.query(
            `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE SET status=$4, updated_at=NOW()
             RETURNING *`,
            [parseInt(booking_id), parseInt(staff_id), tag_filled, status || 'interested']
          );
          return json(200, rows[0]);
        }

        if (action === 'update_checklist') {
          const auth = await requireAuth(event);
          if (!auth) return unauthorized();

          const { log_id, assignment_id, booking_id, status } = body;
          let { staff_id } = body;

          // Staff scoping
          if (auth.role === 'staff') {
            if (staff_id && parseInt(staff_id) !== auth.staffId) return forbidden();
            staff_id = auth.staffId;
          }

          const validStatuses = ['upcoming','on_my_way','arrived','completed'];
          if (!validStatuses.includes(status)) {
            return json(400, { error: 'Invalid status' });
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
            ({ rows } = await client.query(
              `INSERT INTO gig_logs (assignment_id, booking_id, staff_id, status)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT DO NOTHING
               RETURNING *`,
              [parseInt(assignment_id), parseInt(booking_id), parseInt(staff_id), status]
            ));
          }
          return json(200, rows[0] || { success: true });
        }

        if (action === 'submit_survey') {
          const auth = await requireAuth(event);
          if (!auth) return unauthorized();

          const { log_id } = body;
          if (!log_id) return json(400, { error: 'log_id required' });

          // For staff, verify the gig_log belongs to their staff_id
          if (auth.role === 'staff') {
            const { rows: logRows } = await client.query(
              'SELECT staff_id FROM gig_logs WHERE id=$1', [parseInt(log_id)]
            );
            if (!logRows.length || logRows[0].staff_id !== auth.staffId) return forbidden();
          }

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

          if (!sets.length) return json(400, { error: 'No survey fields provided' });

          sets.push(`survey_submitted_at=NOW()`);
          sets.push(`updated_at=NOW()`);
          vals.push(parseInt(log_id));

          const { rows } = await client.query(
            `UPDATE gig_logs SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`,
            vals
          );

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

          return json(200, rows[0]);
        }

        // ── Admin-only actions ─────────────────────────────────────────────────
        const adminAuth = await requireAuth(event, ['admin']);
        if (!adminAuth) return unauthorized();

        if (action === 'save_service_slots') {
          const { slots } = body;
          if (!Array.isArray(slots)) {
            return json(400, { error: 'slots array required' });
          }

          const serviceIds = [...new Set(slots.map(s => s.service_id))];

          if (serviceIds.length) {
            await client.query(
              `DELETE FROM staff_slots WHERE service_id = ANY($1::text[])`,
              [serviceIds]
            );
          }

          const realSlots = slots.filter(sl => sl.tag_required !== '__CLEAR__');
          let sortOrder = 0;
          for (const sl of realSlots) {
            if (!sl.service_id || !sl.tag_required) continue;
            await client.query(
              `INSERT INTO staff_slots (service_id, tag_required, slot_count, exclusive, sort_order)
               VALUES ($1, $2, $3, $4, $5)`,
              [sl.service_id, sl.tag_required, sl.slot_count || 1, !['Driver','Setup'].includes(sl.tag_required), sortOrder++]
            );
          }

          return json(200, { success: true, saved: realSlots.length });
        }

        if (action === 'notify_staff') {
          const { booking_id } = body;
          if (!booking_id) return json(400, { error: 'booking_id required' });

          const { rows: bookings } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
          const booking = bookings[0];
          if (!booking) return json(404, { error: 'Booking not found' });

          const { rows: slots } = await client.query(
            'SELECT * FROM staff_slots WHERE service_id=$1 ORDER BY sort_order',
            [booking.service_id]
          );

          const tags = slots.length
            ? [...new Set(slots.map(s => s.tag_required))]
            : [booking.service_name];

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
                <p style="font-size:12px;color:#A78BCA;text-align:center">Log in with your access code · ${SITE}/admin.html</p>
              `)
            });
            notified++;
          }

          return json(200, { notified, tags, eligible: eligible.length });
        }

        if (action === 'assign') {
          const { booking_id, staff_id, tag_filled, slot_id } = body;
          if (!booking_id || !staff_id || !tag_filled) {
            return json(400, { error: 'booking_id, staff_id, tag_filled required' });
          }

          const { rows } = await client.query(
            `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status, slot_id, assigned_at)
             VALUES ($1,$2,$3,'assigned',$4,NOW())
             ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE
               SET status='assigned', slot_id=$4, assigned_at=NOW(), updated_at=NOW()
             RETURNING *`,
            [parseInt(booking_id), parseInt(staff_id), tag_filled, slot_id || null]
          );

          const assignment = rows[0];

          await client.query(
            `INSERT INTO gig_logs (assignment_id, booking_id, staff_id, status)
             VALUES ($1,$2,$3,'upcoming')
             ON CONFLICT DO NOTHING`,
            [assignment.id, parseInt(booking_id), parseInt(staff_id)]
          ).catch((e) => console.error('gig_logs INSERT failed:', e.message));

          await autoCalcTimes(client, assignment.id, parseInt(booking_id));

          const { rows: [freshAssignment] } = await client.query(
            'SELECT * FROM staff_assignments WHERE id=$1', [assignment.id]
          );
          const fa = freshAssignment || assignment;

          const { rows: staffRows }   = await client.query('SELECT * FROM staff WHERE id=$1', [parseInt(staff_id)]);
          const { rows: bookingRows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
          const s = staffRows[0];
          const b = bookingRows[0];

          if (s && b) {
            const dateStr = b.event_date
              ? new Date(b.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
              : 'TBD';

            const toStr = m => {
              const h = Math.floor(((m % 1440) + 1440) % 1440 / 60);
              const mn = ((m % 1440) + 1440) % 1440 % 60;
              const ampm = h >= 12 ? 'PM' : 'AM';
              return `${((h % 12) || 12)}:${String(mn).padStart(2,'0')} ${ampm}`;
            };
            const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };

            let scheduleHtml = '';
            if (fa.schedule_start && fa.drive_minutes_each_way != null) {
              const load   = fa.load_minutes          || 30;
              const setup  = fa.unload_minutes         || 45;
              const drive  = fa.drive_minutes_each_way;
              const pack   = fa.pack_out_minutes       || 20;
              const homeUn = fa.home_unload_minutes    || 15;
              const total  = fa.total_minutes;
              const rawH   = total / 60;
              const paidH  = Math.max(5, rawH).toFixed(2);

              const loadTime   = toMins(fa.schedule_start);
              const departTime = loadTime + load;
              const arriveTime = departTime + drive;
              const showTime   = arriveTime + setup;

              scheduleHtml = `
                <div style="margin-top:16px;background:#0A0720;border-radius:12px;padding:16px;border:1px solid #2D1B69">
                  <div style="font-size:11px;text-transform:uppercase;font-weight:700;color:#A78BCA;letter-spacing:.08em;margin-bottom:12px">⏱ Your Schedule</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
                    <div style="background:#1A1035;border-radius:8px;padding:10px;text-align:center">
                      <div style="font-size:10px;color:#A78BCA;text-transform:uppercase;margin-bottom:3px">📦 Load Up</div>
                      <div style="font-size:15px;font-weight:900;color:#FFD600">${toStr(loadTime)}</div>
                      <div style="font-size:10px;color:#6b5b95">${load} min</div>
                    </div>
                    <div style="background:#1A1035;border-radius:8px;padding:10px;text-align:center">
                      <div style="font-size:10px;color:#A78BCA;text-transform:uppercase;margin-bottom:3px">🚗 Depart</div>
                      <div style="font-size:15px;font-weight:900;color:#60A5FA">${toStr(departTime)}</div>
                      <div style="font-size:10px;color:#6b5b95">${drive} min drive + gas</div>
                    </div>
                    <div style="background:#1A1035;border-radius:8px;padding:10px;text-align:center">
                      <div style="font-size:10px;color:#A78BCA;text-transform:uppercase;margin-bottom:3px">📍 Arrive Venue</div>
                      <div style="font-size:15px;font-weight:900;color:#F59E0B">${toStr(arriveTime)}</div>
                      <div style="font-size:10px;color:#6b5b95">${setup} min setup</div>
                    </div>
                    <div style="background:#1A1035;border-radius:8px;padding:10px;text-align:center">
                      <div style="font-size:10px;color:#A78BCA;text-transform:uppercase;margin-bottom:3px">🎪 Show Starts</div>
                      <div style="font-size:15px;font-weight:900;color:#10B981">${toStr(showTime)}</div>
                      <div style="font-size:10px;color:#6b5b95">Event time</div>
                    </div>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;background:#1A1035;border-radius:8px;padding:10px 14px">
                    <div style="font-size:11px;color:#A78BCA">Pack-out: <strong style="color:#F3E8FF">${pack} min</strong> &nbsp;·&nbsp; Home unload: <strong style="color:#F3E8FF">${homeUn} min</strong></div>
                    <div style="text-align:right">
                      <div style="font-size:10px;color:#A78BCA;text-transform:uppercase">Paid Hours</div>
                      <div style="font-size:14px;font-weight:900;color:#FFD600">${paidH}h${parseFloat(paidH) > rawH ? ' <span style="font-size:9px">(5h min)</span>' : ''}</div>
                    </div>
                  </div>
                </div>`;
            } else {
              scheduleHtml = `
                <div style="margin-top:16px;background:#1A1035;border-radius:8px;padding:12px;border:1px solid #2D1B69;font-size:12px;color:#A78BCA;text-align:center">
                  Schedule times will be available once the event ZIP is confirmed. Check your portal for updates.
                </div>`;
            }

            await notify({
              to_email: s.email,
              to_name: s.preferred_name || s.name,
              subject: `✅ You're booked! ${b.service_name} on ${dateStr}`,
              html: wrap(`
                <p style="font-size:16px;margin-bottom:16px">Hi <strong>${s.preferred_name || s.name}</strong>! 🎉</p>
                <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">You've been assigned to a gig! Here are your details and call times.</p>
                <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:4px">
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${b.service_name}</span></div>
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Event Date</span><br><span style="font-weight:600">${dateStr}${b.event_time ? ' at ' + b.event_time : ''}</span></div>
                  <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">${b.event_zip || 'OKC'}${b.event_location ? ' — ' + b.event_location : ''}</span></div>
                  <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Role</span><br><span style="color:#FFD600;font-weight:700">${tag_filled}</span></div>
                </div>
                ${scheduleHtml}
                <div style="text-align:center;margin-top:20px;margin-bottom:20px">
                  <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">View Full Gig Details →</a>
                </div>
                <p style="font-size:12px;color:#A78BCA;text-align:center">Questions? Contact Joe at <a href="tel:4054316625" style="color:#06B6D4">(405) 431-6625</a></p>
              `)
            });
          }

          return json(200, assignment);
        }

        if (action === 'unassign') {
          const { booking_id, staff_id, tag_filled } = body;
          await client.query(
            `UPDATE staff_assignments SET status='interested', assigned_at=NULL, updated_at=NOW()
             WHERE booking_id=$1 AND staff_id=$2 AND tag_filled=$3`,
            [parseInt(booking_id), parseInt(staff_id), tag_filled]
          );
          return json(200, { success: true });
        }

        if (action === 'update_staff_notes') {
          const { staff_id, staff_notes } = body;
          if (!staff_id) return json(400, { error: 'staff_id required' });
          await client.query(
            'UPDATE staff SET staff_notes=$1, updated_at=NOW() WHERE id=$2',
            [staff_notes || '', parseInt(staff_id)]
          );
          return json(200, { success: true });
        }

        if (action === 'save_time_template') {
          const { service_id, load_minutes, unload_minutes, pack_out_minutes, home_unload_minutes } = body;
          if (!service_id) return json(400, { error: 'service_id required' });
          const { rows } = await client.query(`
            INSERT INTO service_time_templates (service_id, load_minutes, unload_minutes, pack_out_minutes, home_unload_minutes, updated_at)
            VALUES ($1,$2,$3,$4,$5,NOW())
            ON CONFLICT (service_id) DO UPDATE SET
              load_minutes=$2, unload_minutes=$3, pack_out_minutes=$4, home_unload_minutes=$5, updated_at=NOW()
            RETURNING *
          `, [service_id, load_minutes||30, unload_minutes||15, pack_out_minutes||20, home_unload_minutes||15]);
          return json(200, { template: rows[0] });
        }

        if (action === 'update_assignment_times') {
          const { assignment_id, load_minutes, unload_minutes, pack_out_minutes, home_unload_minutes, drive_minutes_each_way, party_minutes, event_time } = body;
          if (!assignment_id) return json(400, { error: 'assignment_id required' });

          const load   = parseInt(load_minutes)           || 0;
          const unload = parseInt(unload_minutes)         || 0;
          const pack   = parseInt(pack_out_minutes)       || 0;
          const homeUn = parseInt(home_unload_minutes)    || 0;
          const drive  = parseInt(drive_minutes_each_way) || 0;
          const party  = parseInt(party_minutes)          || 0;

          const total = load + drive + unload + party + pack + drive + homeUn;

          let scheduleStart = null;
          if (event_time) {
            const [hh, mm] = event_time.split(':').map(Number);
            const eventMins = hh * 60 + mm;
            const startMins = eventMins - load - drive - unload;
            const sh = Math.floor(((startMins % 1440) + 1440) % 1440 / 60);
            const sm = ((startMins % 1440) + 1440) % 1440 % 60;
            scheduleStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
          }

          const { rows } = await client.query(`
            UPDATE staff_assignments SET
              load_minutes=$1, unload_minutes=$2, pack_out_minutes=$3,
              home_unload_minutes=$4, drive_minutes_each_way=$5,
              total_minutes=$6, schedule_start=$7, updated_at=NOW()
            WHERE id=$8 RETURNING *
          `, [load, unload, pack, homeUn, drive, total, scheduleStart, parseInt(assignment_id)]);

          return json(200, { assignment: rows[0] });
        }

        return json(400, { error: 'Unknown action: ' + action });
      }

      return json(405, { error: 'Method not allowed' });
    });
  } catch (err) {
    console.error('staff-assignments.js error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};

// Exported for use by bookings.js — fires automatically on new booking
exports.notifyMatchingStaff = async function notifyMatchingStaff(booking) {
  if (!booking || !booking.id) return;
  let client;
  try {
    client = await getPool().connect();
    await ensureTables(client);

    const { rows: slots } = await client.query(
      'SELECT * FROM staff_slots WHERE service_id=$1 ORDER BY sort_order',
      [booking.service_id]
    );

    const tags = slots.length
      ? [...new Set(slots.map(s => s.tag_required))]
      : [booking.service_name];

    const { rows: allStaff } = await client.query('SELECT * FROM staff WHERE active=TRUE');
    const eligible = allStaff.filter(s => {
      const skills = Array.isArray(s.skills) ? s.skills : JSON.parse(s.skills || '[]');
      return skills.some(sk => tags.includes(sk.name));
    });

    const dateStr = booking.event_date
      ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
      : 'TBD';
    const timeStr = booking.event_time || '';

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
            <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date & Time</span><br><span style="font-weight:600">${dateStr}${timeStr ? ' at ' + timeStr : ''}</span></div>
            <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">${booking.event_zip || 'OKC area'}</span></div>
            <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Matching Skills</span><br><span style="color:#FFD600;font-weight:700">${matchedTags.join(', ')}</span></div>
          </div>
          <div style="text-align:center;margin-bottom:20px">
            <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">Log In to Express Interest →</a>
          </div>
          <p style="font-size:12px;color:#A78BCA;text-align:center">Log in with your access code · ${SITE}/admin.html</p>
        `)
      });
    }
    console.log(`notifyMatchingStaff: notified ${eligible.length} staff for booking ${booking.id}`);
  } catch(e) {
    console.error('notifyMatchingStaff error:', e.message);
  } finally {
    if (client) client.release();
  }
};
