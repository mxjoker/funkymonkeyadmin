const { withClient, getPool } = require('./_db');
const {
  CORS, preflight, requireAuth, unauthorized, forbidden,
} = require('./_auth');
const { esc, logChange, ensureBookingChanges, fmtEventDate } = require('./_email');
const { sendTemplate } = require('./automations');
const { sendSms, ensureSmsTables } = require('./_sms');
const { isValidPayType, resolvePayType, assignmentRefusal } = require('./_pay');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// wantsEmail() is the opt-out every staff send checks. The notify() wrapper it
// used to live inside is gone: all three staff emails are templates now, and
// each guards on this directly at its own call site.
// Staff SMS rides on comms_preference, the column that has been on the staff
// table — with an "SMS (coming soon)" option in both UIs — since before this
// feature existed. A second opt-in mechanism would mean two places to check and
// one of them eventually being missed.
const wantsSms = (s) => ['sms', 'both'].includes(s && s.comms_preference);

// Only an explicit SMS-only choice suppresses email. Anything else — 'email',
// 'both', the legacy 'call', null, '' — still gets one. Defaulting the unknown
// cases to "send it" is deliberate: this codebase's signature bug is the
// silent non-delivery, and a staff member who quietly stops being told about
// gigs is exactly that shape.
const wantsEmail = (s) => (s && s.comms_preference) !== 'sms';

// Fire-and-forget, same contract as notify() above: a Twilio outage must never
// fail the assignment it accompanies. sendSms does not throw, but ensureSmsTables
// can, so the whole thing is guarded.
async function notifySms(client, staff, body, meta = {}) {
  if (!wantsSms(staff) || !staff.phone) return;
  try {
    await ensureSmsTables(client);
    await sendSms(client, staff.phone, body, { ...meta, staff_id: staff.id });
  } catch (e) {
    console.error('staff notifySms failed:', staff.staff_id, '|', e.message);
  }
}

const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
const PORTAL = `${SITE}/staff-portal.html`;

// ── The emailed ⟺ visible invariant ──────────────────────────────────────────
// A "check your staff portal" email that lands on an empty page is the bug this
// list exists to prevent. Both the notifier and the portal's open-gig query read
// it, so a gig is emailed about exactly when the portal will show it.
//   review  — raw inbound lead, not vetted, no gig to staff yet
//   quoted  — client has not said yes
//   pending/accepted/confirmed — real work that needs bodies
const STAFFABLE_STATUSES = ['accepted', 'confirmed'];
const isStaffable = (booking) => STAFFABLE_STATUSES.includes(booking && booking.status);

// Slots are the only source of truth for who a gig needs. The previous fallback
// used the service name as a skill tag, but service names ("Foam Party — Single
// Cannon") are never skill names ("Foam Party"), so a service with no slots
// configured matched zero staff and reported that as a successful send.
const slotTags = (slots) => [...new Set(slots.map(s => s.tag_required))];

// Staff whose skills cover at least one required tag, with the matches attached.
function eligibleStaff(allStaff, tags) {
  const out = [];
  for (const s of allStaff) {
    const skills = Array.isArray(s.skills) ? s.skills : JSON.parse(s.skills || '[]');
    const matched = skills.filter(sk => tags.includes(sk.name)).map(sk => sk.name);
    if (matched.length) out.push({ staff: s, matched });
  }
  return out;
}

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


let schemaReady;
async function ensureTables(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
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

  // Pay type belongs to the role, not to the person and not to the service:
  // Foam Crew is hourly wherever it appears, Story Doodles is flat. Roles are not
  // stored anywhere else — skillTags() in admin.html derives the list at runtime
  // from SKILL_PRESETS plus whatever tags are in use — so this table carries the
  // pay decision only and deliberately does NOT try to become a role registry.
  // A role with no row here has no opinion, and resolution falls through to the
  // staff member's own pay_type, which is what every assignment did before this.
  await client.query(`
    CREATE TABLE IF NOT EXISTS role_pay (
      role_name  VARCHAR(100) PRIMARY KEY,
      pay_type   VARCHAR(20) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
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
      clocked_in_at TIMESTAMPTZ,
      clocked_out_at TIMESTAMPTZ,
      clock_adjusted_at TIMESTAMPTZ,
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
    // Guaranteed here too, not only by payroll.js's ensureTables — this file
    // now writes to it (set_pay_override), and a writer
    // that depends on another module's migrations having already run is the
    // same deploy-order bug payroll.js's own role_pay guard exists to avoid.
    "ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pay_amount_override NUMERIC(10,2)",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS foam_fluid_needed BOOLEAN",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS empty_jugs_refilled BOOLEAN",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS gas_level VARCHAR(50)",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS survey_submitted_at TIMESTAMPTZ",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_in_at TIMESTAMPTZ",
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_out_at TIMESTAMPTZ",
    // Set whenever an admin edits a stamp, so a payroll run can show that the
    // hours it paid were corrected by hand rather than tapped by the worker.
    "ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clock_adjusted_at TIMESTAMPTZ",
  ];
  for (const sql of migrations) {
    try { await client.query(sql); } catch (_) {}
  }

  // ── One gig_log per assignment ───────────────────────────────────────────
  // gig_logs had only a non-unique index on assignment_id, so the
  // `ON CONFLICT DO NOTHING` inserts below could never conflict: every
  // re-assign appended another log row, and the `LEFT JOIN gig_logs` in the
  // admin and portal reads then returned the same staff member once per log.
  // That is the duplicate-staff bug. Collapse the existing rows, keeping the
  // furthest-progressed log, then make the constraint real.
  //
  // Deliberately outside the swallow-everything loop above: the INSERTs below
  // name this constraint as their conflict target, so if it cannot be created
  // the workflow is broken and must say so rather than resume duplicating.
  await client.query(`
    DELETE FROM gig_logs WHERE id NOT IN (
      SELECT DISTINCT ON (assignment_id) id FROM gig_logs
      ORDER BY assignment_id,
               survey_submitted_at DESC NULLS LAST,
               completed_at        DESC NULLS LAST,
               arrived_at          DESC NULLS LAST,
               on_my_way_at        DESC NULLS LAST,
               id ASC
    )
  `);
  await client.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS gig_logs_assignment_id_key ON gig_logs (assignment_id)'
  );
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
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
                    gl.clocked_in_at, gl.on_my_way_at, gl.arrived_at,
                    gl.completed_at, gl.clocked_out_at,
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

        if (params.role_pay) {
          const { rows } = await client.query('SELECT role_name, pay_type FROM role_pay');
          const map = {};
          for (const r of rows) map[r.role_name] = r.pay_type;
          return json(200, { role_pay: map });
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
                    gl.status as checklist_status, gl.id as log_id,
                    gl.clocked_in_at, gl.clocked_out_at,
                    -- Both portals hide the post-gig report once it has been
                    -- filed. Without this column that check reads undefined on
                    -- every row and the button never hides — a rule that can
                    -- never fire, which is this codebase's documented failure
                    -- shape.
                    gl.survey_submitted_at,
                    -- The staff portal shows the party window (event_time +
                    -- duration) alongside the shift window (sa.schedule_start
                    -- + sa.total_minutes, both already computed by
                    -- autoCalcTimes). Without the duration a gig reads as a
                    -- start time with no end, which is what staff were asking
                    -- about: "when am I working", not just "what day".
                    svc.duration_minutes
             FROM staff_assignments sa
             JOIN bookings b ON b.id = sa.booking_id
             LEFT JOIN services svc ON svc.service_id = b.service_id
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
            // One row per (booking, role) the staff member can fill. Previously
            // this joined on the booking alone, so taking one role on a
            // multi-role gig hid every other role on it — Foam Party crews
            // could never pick up the Driver slot on their own event.
            const { rows } = await client.query(
              `SELECT DISTINCT b.id, b.reference, b.service_name, b.event_date, b.event_time,
                      b.event_type, b.guest_count, b.event_zip, b.status as booking_status,
                      ss.tag_required,
                      -- No assignment exists yet, so there is no schedule_start
                      -- to show. The party window still tells someone deciding
                      -- whether to take the gig how long it runs.
                      svc.duration_minutes
               FROM bookings b
               JOIN staff_slots ss ON ss.service_id = b.service_id
               LEFT JOIN services svc ON svc.service_id = b.service_id
               WHERE b.status = ANY($3::text[])
                 AND b.event_date >= CURRENT_DATE
                 AND ss.tag_required = ANY($1::text[])
                 AND NOT EXISTS (
                   SELECT 1 FROM staff_assignments sa
                   WHERE sa.booking_id = b.id
                     AND sa.staff_id   = $2
                     AND sa.tag_filled = ss.tag_required
                 )
               ORDER BY b.event_date ASC`,
              [tags, staffId, STAFFABLE_STATUSES]
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

          const row = await expressInterest(client, { booking_id, staff_id, tag_filled, status });
          return json(200, row);
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

          // …and scoping the staff_id in the BODY is not the same as scoping the
          // ROW. log_id/assignment_id name the row directly, so without this a
          // staff member could POST someone else's log_id with their own
          // staff_id and be let through. submit_survey twenty lines below has
          // always checked ownership; this never did, and before this branch the
          // blast radius was a status badge. These timestamps now decide what
          // people are paid: `status:'upcoming'` on another worker's log NULLs
          // every stamp their wage is computed from, and payroll silently falls
          // back to the estimate. Admins keep their freedom to fix anyone's log.
          if (auth.role === 'staff') {
            const { rows: owner } = log_id
              ? await client.query('SELECT staff_id FROM gig_logs WHERE id=$1', [parseInt(log_id)])
              // No log_id: the INSERT below upserts on the assignment, so it can
              // still write an existing log — the assignment is the thing that
              // has to belong to them.
              : await client.query('SELECT staff_id FROM staff_assignments WHERE id=$1', [parseInt(assignment_id)]);
            if (!owner.length || owner[0].staff_id !== auth.staffId) return forbidden();
          }

          if (!CHECKLIST_STATUSES.includes(status)) {
            return json(400, { error: 'Invalid status' });
          }

          const tsClause = buildChecklistTimestampClause(status);

          let rows;
          if (log_id) {
            ({ rows } = await client.query(
              `UPDATE gig_logs SET status=$1${tsClause}, updated_at=NOW() WHERE id=$2 RETURNING *`,
              [status, parseInt(log_id)]
            ));
          } else {
            // A staff member tapping the checklist before a log exists must not
            // mint a second one. DO UPDATE (not DO NOTHING) so the tap still
            // takes effect on the log that already exists, and RETURNING always
            // hands the portal back a log_id.
            ({ rows } = await client.query(
              `INSERT INTO gig_logs (assignment_id, booking_id, staff_id, status)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (assignment_id) DO UPDATE
                 SET status=EXCLUDED.status${tsClause}, updated_at=NOW()
               RETURNING *`,
              [parseInt(assignment_id), parseInt(booking_id), parseInt(staff_id), status]
            ));
          }
          return json(200, rows[0] || { success: true });
        }

        // ── Admin clock adjustment ───────────────────────────────────────
        // Staff tap stages in real time; only an admin corrects one. This is a
        // wage record, so every edit is written to booking_changes with both
        // sides of the change, and the log is flagged as adjusted so a payroll
        // run can show that the hours it paid were corrected by hand.
        if (action === 'adjust_clock') {
          const adminAuth = await requireAuth(event, ['admin']);
          if (!adminAuth) return unauthorized();

          const { log_id, stage, value } = body;
          // Check the array before the map: a bare `CHECKLIST_TS_COLS[stage]`
          // lookup is reachable through the prototype chain (stage:
          // 'constructor' resolves to a truthy inherited value), and this map
          // names a SQL column, so a stage that isn't a real array member must
          // never reach it.
          if (!isAdjustableStage(stage)) return json(400, { error: 'Unknown stage' });
          const col = CHECKLIST_TS_COLS[stage];

          // null clears; anything else must parse as a date. A string that does
          // not parse must be refused, not written as NULL — silently clearing
          // a wage timestamp because of a typo is the worst outcome here.
          let next = null;
          if (value !== null && value !== undefined && value !== '') {
            const d = new Date(value);
            if (isNaN(d.getTime())) return json(400, { error: 'Invalid timestamp' });
            next = d.toISOString();
          }

          const { rows: before } = await client.query('SELECT * FROM gig_logs WHERE id=$1', [parseInt(log_id)]);
          if (!before.length) return json(404, { error: 'Not found' });

          // Filling in a stamp for a stage the log has not reached must move the
          // status with it, or the correction only lives until the worker's next
          // tap: buildChecklistTimestampClause() for the earlier stage they are
          // still sitting on clears the stamp again, and an admin's audited
          // change is undone with nothing written to booking_changes. Clearing
          // never advances — that is the admin saying it never happened.
          const nextStatus = advancedStatus(before[0].status, stage, next !== null);

          const { rows } = await client.query(
            `UPDATE gig_logs SET ${col}=$1${nextStatus ? ', status=$3' : ''}, clock_adjusted_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
            nextStatus ? [next, parseInt(log_id), nextStatus] : [next, parseInt(log_id)]
          );

          const entry = clockAdjustmentLog(stage, before[0][col], next, nextStatus);
          try {
            await ensureBookingChanges(client);
            await logChange(client, before[0].booking_id, entry.action, entry.detail);
          } catch (logErr) {
            console.error('adjust_clock: failed to write the audit line —', logErr.message);
          }
          return json(200, rows[0]);
        }

        // ── Per-gig pay override ─────────────────────────────────────────
        // Admin only, and audited both sides: this is a manual change to what
        // someone is paid, the same class of edit as adjust_clock above.
        if (action === 'set_pay_override') {
          const adminAuth = await requireAuth(event, ['admin']);
          if (!adminAuth) return unauthorized();

          const { assignment_id, amount } = body;
          if (!assignment_id) return json(400, { error: 'assignment_id required' });

          const parsed = validPayOverride(amount);
          if (!parsed.ok) return json(400, { error: parsed.error });

          const { rows: before } = await client.query(
            `SELECT sa.*, s.name AS staff_name, s.preferred_name
             FROM staff_assignments sa LEFT JOIN staff s ON s.id = sa.staff_id
             WHERE sa.id=$1`, [parseInt(assignment_id)]);
          if (!before.length) return json(404, { error: 'Not found' });

          const { rows } = await client.query(
            'UPDATE staff_assignments SET pay_amount_override=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
            [parsed.value, parseInt(assignment_id)]
          );

          const who = before[0].preferred_name || before[0].staff_name;
          const entry = payOverrideLog(before[0].pay_amount_override, parsed.value, who);
          try {
            await ensureBookingChanges(client);
            await logChange(client, before[0].booking_id, entry.action, entry.detail);
          } catch (logErr) {
            console.error('set_pay_override: failed to write the audit line —', logErr.message);
          }
          return json(200, { assignment: rows[0] });
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

            const reportRows = [
              log.guest_count_actual!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:180px">Actual Guests</td><td style="padding:6px 0;font-weight:600">${esc(String(log.guest_count_actual))}</td></tr>`:'',
              log.balance_collected!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Collected</td><td style="padding:6px 0;font-weight:600">${log.balance_collected?'✅ Yes — $'+(log.balance_amount||0):'❌ No'}</td></tr>`:'',
              log.gas_level?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Gas Level</td><td style="padding:6px 0;font-weight:600">${esc(String(log.gas_level))}</td></tr>`:'',
              log.foam_fluid_needed!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Foam Fluid Needed</td><td style="padding:6px 0;font-weight:600">${log.foam_fluid_needed?'⚠️ Yes':'✅ No'}</td></tr>`:'',
              log.empty_jugs_refilled!=null?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Jugs Refilled</td><td style="padding:6px 0;font-weight:600">${log.empty_jugs_refilled?'✅ Yes':'❌ No'}</td></tr>`:'',
              log.event_rating?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Event Rating</td><td style="padding:6px 0;font-weight:600">${'⭐'.repeat(log.event_rating)} (${esc(String(log.event_rating))}/5)</td></tr>`:'',
              log.notes?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;vertical-align:top">Notes</td><td style="padding:6px 0">${esc(String(log.notes))}</td></tr>`:'',
              log.issues?`<tr><td style="padding:6px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;vertical-align:top">Issues</td><td style="padding:6px 0;color:#FCA5A5">${esc(String(log.issues))}</td></tr>`:'',
            ].join('');

            // Needs a booking to hang the log entry on. Without one the alert
            // is skipped rather than sent unlogged — a report nobody can find
            // afterwards is the shape of bug this file keeps producing.
            if (bRows[0]) {
              try {
                const r = await sendTemplate(client, bRows[0], 'post_gig_survey_alert', null,
                  { extra: { staff_name: esc(sName), report_rows: reportRows } });
                if (!r.sent) console.error('post-gig report alert not sent —', r.error);
              } catch (e) {
                console.error('post-gig report alert failed:', e.message);
              }
            } else {
              console.error('post-gig report alert skipped — no booking row for log', log.id);
            }
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

        // Admin-only: set or clear a role's pay type. This decides whether every
        // future assignment to that role is paid by the hour or by the event, so
        // it is not a staff-editable field.
        if (action === 'save_role_pay') {
          const adminAuth = await requireAuth(event, ['admin']);
          if (!adminAuth) return unauthorized();

          const roleName = String(body.role_name || '').trim();
          if (!roleName || roleName.length > 100) return json(400, { error: 'role_name required' });

          // null clears the row; anything else must be one of the two real types.
          // An unrecognised value must be refused rather than stored, or
          // resolvePayType would silently fall through and the UI would show a
          // setting that does nothing.
          if (body.pay_type === null || body.pay_type === '') {
            await client.query('DELETE FROM role_pay WHERE role_name=$1', [roleName]);
            return json(200, { role_name: roleName, pay_type: null });
          }
          if (!isValidPayType(body.pay_type)) return json(400, { error: 'pay_type must be "hourly" or "flat"' });

          await client.query(
            `INSERT INTO role_pay (role_name, pay_type, updated_at) VALUES ($1,$2,NOW())
             ON CONFLICT (role_name) DO UPDATE SET pay_type=EXCLUDED.pay_type, updated_at=NOW()`,
            [roleName, body.pay_type]
          );
          return json(200, { role_name: roleName, pay_type: body.pay_type });
        }

        if (action === 'notify_staff') {
          const { booking_id } = body;
          if (!booking_id) return json(400, { error: 'booking_id required' });

          const { rows: bookings } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
          const booking = bookings[0];
          if (!booking) return json(404, { error: 'Booking not found' });

          const result = await notifyStaffForBooking(client, booking);
          // A send that reached nobody is reported as such. "notified: 0" used
          // to come back looking like success, which is how unconfigured
          // services quietly staffed themselves with no one.
          return json(200, result);
        }

        if (action === 'assign') {
          const { booking_id, staff_id, tag_filled, slot_id } = body;
          if (!booking_id || !staff_id || !tag_filled) {
            return json(400, { error: 'booking_id, staff_id, tag_filled required' });
          }

          // Refused here, before the row exists, not discovered as a $0 line
          // item in payroll after the week is already worked. Resolved the
          // same way payroll.js resolves it -- role first, staff second --
          // so this check and the eventual payment never disagree.
          const { rows: assignStaffRows } = await client.query('SELECT * FROM staff WHERE id=$1', [parseInt(staff_id)]);
          const assignStaff = assignStaffRows[0];
          // No FK on staff_assignments.staff_id: a bad id used to fall through
          // to assignmentRefusal(), which reports the missing rate on a staff
          // record that does not exist -- send someone to fix a person, not a
          // record.
          if (!assignStaff) return json(404, { error: 'Staff not found' });
          const { rows: rolePayRows } = await client.query('SELECT role_name, pay_type FROM role_pay');
          const rolePayByRole = {};
          for (const r of rolePayRows) rolePayByRole[r.role_name] = r.pay_type;
          const payType = resolvePayType(tag_filled, rolePayByRole, assignStaff);
          const refusal = assignmentRefusal(assignStaff, payType, tag_filled);
          if (refusal) return json(400, { error: refusal });

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
             ON CONFLICT (assignment_id) DO NOTHING`,
            [assignment.id, parseInt(booking_id), parseInt(staff_id)]
          ).catch((e) => console.error('gig_logs INSERT failed:', e.message));

          await autoCalcTimes(client, assignment.id, parseInt(booking_id));

          const { rows: [freshAssignment] } = await client.query(
            'SELECT * FROM staff_assignments WHERE id=$1', [assignment.id]
          );
          const fa = freshAssignment || assignment;

          const { rows: bookingRows } = await client.query('SELECT * FROM bookings WHERE id=$1', [parseInt(booking_id)]);
          const s = assignStaff;
          const b = bookingRows[0];

          if (s && b) {
            // pg returns a DATE column as a Date object, and `dateObject +
            // 'T00:00:00'` stringifies it first — "Mon Aug 24 2026 …(Central
            // Daylight Time)T00:00:00" — which parses to Invalid Date, and
            // toLocaleDateString renders that as the literal text "Invalid
            // Date" rather than throwing. Staff were texted it. fmtEventDate
            // handles both a Date and a 'YYYY-MM-DD' string.
            const dateStr = fmtEventDate(b.event_date) || 'TBD';

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

            // Wording in the 'staff_assigned' rule. The opt-out check stays
            // here — notify() owns it for every other send in this file, and a
            // staff member who unchecked Email must not start getting mail
            // because their email moved into a template.
            if (wantsEmail(s)) {
              try {
                const r = await sendTemplate(client, b, 'staff_assigned', null, {
                  to: s.email,
                  extra: {
                    staff_name: esc(s.preferred_name || s.name || ''),
                    staff_role: esc(tag_filled || ''),
                    schedule_block: scheduleHtml,
                    portal_link: PORTAL,
                  }
                });
                if (!r.sent) console.error('staff assigned email not sent —', r.error);
              } catch (e) {
                // Fire-and-forget, same contract as notify(): a mail failure
                // must never fail the assignment it accompanies.
                console.error('staff assigned email failed:', s.email, '|', e.message);
              }
            }

            // Shift start, not just the event time: the whole point of the text
            // is the number the crew member has to set an alarm for.
            const smsTime = fa.schedule_start
              ? toStr(toMins(fa.schedule_start))
              : (b.event_time || 'TBD');
            await notifySms(client, s,
              `You're booked: ${b.service_name}, ${dateStr}. Load up ${smsTime}, ${b.event_zip || 'OKC'}. Details in the portal: ${PORTAL}`,
              { booking_id: b.id, trigger_label: "You're booked" });
          }

          return json(200, assignment);
        }

        if (action === 'unassign') {
          const { booking_id, staff_id, tag_filled } = body;
          if (!booking_id || !staff_id || !tag_filled) {
            return json(400, { error: 'booking_id, staff_id, tag_filled required' });
          }
          const r = await client.query(
            `UPDATE staff_assignments SET status='interested', assigned_at=NULL, updated_at=NOW()
             WHERE booking_id=$1 AND staff_id=$2 AND tag_filled=$3`,
            [parseInt(booking_id), parseInt(staff_id), tag_filled]
          );
          // An update that matched nothing is not a successful unassign. The
          // admin UI would otherwise redraw the person as removed while the
          // row it failed to find stayed assigned.
          if (r.rowCount === 0) return json(404, { error: 'No such assignment to unassign' });
          return json(200, { success: true, unassigned: r.rowCount });
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

// ── Letter-mapped offers ─────────────────────────────────────────────────────
// ── Day-of checklist timestamps ──────────────────────────────────────────────
// Stamps the step being entered and clears the stamps of every step after it.
// The checklist is walkable backwards — a staff member who taps Done by mistake
// steps back to Arrived — and without the clearing half, a gig would keep a
// completed_at it never actually reached, leaving the timestamps contradicting
// the status they exist to describe.
//
// Column names come from this fixed map and never from the request. Callers
// must validate `status` against CHECKLIST_STATUSES before passing it here.
const CHECKLIST_STATUSES = ['upcoming', 'clocked_in', 'on_my_way', 'arrived', 'completed', 'clocked_out'];
const CHECKLIST_TS_COLS = {
  upcoming: null,
  clocked_in: 'clocked_in_at',
  on_my_way: 'on_my_way_at',
  arrived: 'arrived_at',
  completed: 'completed_at',
  clocked_out: 'clocked_out_at',
};

function buildChecklistTimestampClause(status) {
  const idx = CHECKLIST_STATUSES.indexOf(status);
  if (idx === -1) return '';
  const setCol = CHECKLIST_TS_COLS[status];
  const clear = CHECKLIST_STATUSES.slice(idx + 1).map(s => CHECKLIST_TS_COLS[s]).filter(Boolean);
  return (setCol ? `, ${setCol}=NOW()` : '') + clear.map(c => `, ${c}=NULL`).join('');
}

// The audit line for an admin's clock edit. Pure, so the wording is testable
// without a database — a wage record that can be silently rewritten is worth
// less than no record, so this must never print "null" at someone.
const STAGE_LABELS = {
  clocked_in: 'clock-in', on_my_way: 'on my way', arrived: 'arrived',
  completed: 'completed', clocked_out: 'clock-out',
};

// A bare `CHECKLIST_TS_COLS[stage]` lookup is reachable through the prototype
// chain — 'constructor', '__proto__', 'toString' etc. all resolve to a truthy
// inherited value, so `!col` alone never rejects them. Checking the array
// first (the same trick buildChecklistTimestampClause already uses) closes
// that off before a non-column string can be interpolated as one.
function isAdjustableStage(stage) {
  return typeof stage === 'string' && stage !== 'upcoming' && CHECKLIST_STATUSES.includes(stage);
}

// Whether an adjustment has to carry the log's status forward with it. An
// admin who fills in a forgotten clocked_out_at on a log still reading
// `completed` has corrected the wage record; the worker's next tap on the
// checklist would then re-stamp `completed` and NULL that correction straight
// back out. Advancing the status keeps the same invariant the checklist itself
// maintains — the stamps never run ahead of the stage.
//
// An unknown current status has index -1, so any real stage advances past it:
// a log whose status is garbage is better described by the stamp just written
// than by the garbage.
function advancedStatus(current, stage, hasValue) {
  if (!hasValue || !isAdjustableStage(stage)) return null;
  return CHECKLIST_STATUSES.indexOf(stage) > CHECKLIST_STATUSES.indexOf(current) ? stage : null;
}

function clockAdjustmentLog(stage, before, after, nextStatus = null) {
  // Date AND time. Time alone rendered the one correction that most needs an
  // audit trail — a forgotten clock-out, which is cross-day by definition — as
  // "clock-out: 15:00 UTC → 15:00 UTC", a whole day moved and logged as no
  // change at all.
  const fmt = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  };
  const label = STAGE_LABELS[stage] || stage;
  const from = fmt(before), to = fmt(after);
  let detail;
  if (from && to)       detail = `${label}: ${from} → ${to}`;
  else if (!from && to) detail = `${label}: not recorded → ${to}`;
  else if (from && !to) detail = `${label}: ${from} → cleared`;
  else                  detail = `${label}: nothing to change`;
  if (nextStatus) detail += ` (status advanced to ${STAGE_LABELS[nextStatus] || nextStatus})`;
  return { action: 'Clock adjusted', detail };
}

// A per-gig pay override is the escape hatch for the higher-of-roles rule: when
// one person fills two roles on a booking, payroll pays the higher of the two,
// and Joe's condition for accepting that rule was that the odd case stay easy to
// correct. An override wins outright over both roles.
//
// Refused here rather than in _pay.js: that module deliberately accepts any
// finite number so a deliberate $0 (an unpaid favour, a correction) survives,
// and its comment defers sign validation to this write boundary. A negative wage
// is always a typo.
function validPayOverride(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  // Number() coerces almost anything into a storable wage: Number(' ') is 0,
  // Number([]) is 0, Number(true) is 1. Only a number or a string is a
  // legitimate shape for a wage in the first place -- everything else is
  // refused outright rather than laundered into a figure.
  if (typeof v !== 'number' && typeof v !== 'string') {
    return { ok: false, error: 'Override must be a number' };
  }
  const trimmed = typeof v === 'string' ? v.trim() : v;
  // Whitespace means "clear" to any sane reading, exactly like ''.
  if (trimmed === '') return { ok: true, value: null };
  // A trimmed string is restricted to plain decimal digits -- Number() also
  // accepts hex ('0x10') and other exotic numeric literals as valid, which a
  // wage typed into a form field never legitimately is.
  if (typeof trimmed === 'string' && !/^-?\d*\.?\d+$/.test(trimmed)) {
    return { ok: false, error: 'Override must be a number' };
  }
  const n = Number(trimmed);
  if (!isFinite(n)) return { ok: false, error: 'Override must be a number' };
  if (n < 0) return { ok: false, error: 'Override cannot be negative' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// Both sides of the change, in words. A wage that can be rewritten with no trail
// is worth less than no record, so this is what booking_changes gets.
function payOverrideLog(before, after, staffName) {
  const money = (v) => (v === null || v === undefined ? null : `$${Number(v).toFixed(2)}`);
  const from = money(before), to = money(after);
  const who = staffName || 'staff';
  let detail;
  if (from && to)       detail = `${who}: ${from} → ${to}`;
  else if (!from && to) detail = `${who}: standard rate → ${to}`;
  else if (from && !to) detail = `${who}: ${from} → back to the standard rate`;
  else                  detail = `${who}: nothing to change`;
  return { action: 'Pay override changed', detail };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// One letter per role this staff member matched on this booking. The value is
// {booking_id, tag_filled} rather than a bare booking id because the interest
// insert is keyed on (booking_id, staff_id, tag_filled) — someone who matches
// two roles on one gig is two distinct rows, not one.
function buildOfferMap(matchedTags, bookingId) {
  if (matchedTags.length > LETTERS.length) {
    console.error(`buildOfferMap: ${matchedTags.length} roles exceeds the ${LETTERS.length}-letter alphabet — booking ${bookingId}, extras dropped`);
  }
  const map = {};
  matchedTags.forEach((tag, i) => { map[LETTERS[i]] = { booking_id: bookingId, tag_filled: tag }; });
  return map;
}

// Written for the medium: two segments is the budget. GSM-7 normalization in
// sendSms converts smart punctuation, but this template avoids them anyway.
function offerText(booking, dateStr, offerMap) {
  const lines = Object.entries(offerMap).map(([ltr, v]) => `${ltr}) ${v.tag_filled}`).join('\n');
  const when = `${dateStr}${booking.event_time ? ' ' + booking.event_time : ''}`;
  return `Gig available: ${booking.service_name}\n${when} - ${booking.event_zip || 'OKC'}\n${lines}\nReply with any combination (a, ab) if you're interested. Reply STOP to opt out.`;
}

// ── The one gig-available notifier ───────────────────────────────────────────
// Both the manual "Notify Staff" button and the automatic on-booking hook run
// through here. They were two near-identical copies that had already drifted;
// one path fixed and the other missed is how half these bugs survive.
async function notifyStaffForBooking(client, booking) {
  // Never email about a gig the portal will not show. This is the whole fix for
  // "staff got the email, logged in, and saw nothing".
  if (!isStaffable(booking)) {
    console.log(`notifyStaffForBooking: skipped booking ${booking.id} — status '${booking.status}' is not staffable`);
    return { notified: 0, skipped: true, reason: `status '${booking.status}' is not open to staff yet`, tags: [] };
  }

  const { rows: slots } = await client.query(
    'SELECT * FROM staff_slots WHERE service_id=$1 ORDER BY sort_order',
    [booking.service_id]
  );

  // No slots means nobody knows what this gig needs, so nobody can be matched.
  // Say so instead of sending zero emails and calling it a success.
  if (!slots.length) {
    console.error(`notifyStaffForBooking: booking ${booking.id} — service '${booking.service_id}' has no staff requirements configured`);
    return {
      notified: 0, configured: false, tags: [],
      reason: `"${booking.service_name}" has no staff requirements set. Add them in Catalogue → Staff Requirements.`,
    };
  }

  const tags = slotTags(slots);
  const { rows: allStaff } = await client.query('SELECT * FROM staff WHERE active=TRUE');
  const eligible = eligibleStaff(allStaff, tags);

  // Same Invalid Date bug as the "You're booked" path above. The String()+
  // split('T') here looks like it guards it, but String(Date) has no 'T' to
  // split on, so the whole date string passes through and still fails.
  const dateStr = fmtEventDate(booking.event_date) || 'TBD';
  const timeStr = booking.event_time || '';

  for (const { staff, matched } of eligible) {
    if (wantsEmail(staff)) {
      try {
        const r = await sendTemplate(client, booking, 'staff_gig_available', null, {
          to: staff.email,
          extra: {
            staff_name: esc(staff.preferred_name || staff.name || ''),
            matching_skills: esc(matched.join(', ')),
            portal_link: PORTAL,
          }
        });
        if (!r.sent) console.error('gig-available email not sent —', r.error);
      } catch (e) {
        console.error('gig-available email failed:', staff.email, '|', e.message);
      }
    }
    const offerMap = buildOfferMap(matched, booking.id);
    await notifySms(client, staff, offerText(booking, dateStr, offerMap), {
      booking_id: booking.id, trigger_label: 'Gig available', offer_map: offerMap
    });
  }

  console.log(`notifyStaffForBooking: notified ${eligible.length} staff for booking ${booking.id} (tags: ${tags.join(', ')})`);
  return { notified: eligible.length, configured: true, tags, eligible: eligible.length };
}

// The one interest insert. Was inline inside the POST handler; the SMS webhook
// is a second caller, and two copies of an upsert is how they drift.
//
// Staff express interest, Joe assigns — so there is no race and no atomic claim
// here on purpose. Interest is not exclusive: two people wanting a one-slot role
// is normal and harmless. The ON CONFLICT is what makes a Twilio webhook retry
// idempotent: a replayed "ab" updates two rows rather than creating four.
async function expressInterest(client, { booking_id, staff_id, tag_filled, status }) {
  const { rows } = await client.query(
    // 'assigned' is a stronger state than interest and must never be downgraded
    // by this upsert. A staff member can text a stale offer letter (one that
    // sat on their phone since before Joe assigned them) long after the 'assign'
    // action already wrote status='assigned' for the same
    // (booking_id, staff_id, tag_filled) row — that late reply must not flip
    // them back to 'interested' and drop them off the day-of reminder / onto
    // the unstaffed-alert list. Only demotion path is the admin 'unassign'
    // action, which updates the row directly and does not go through here.
    `INSERT INTO staff_assignments (booking_id, staff_id, tag_filled, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (booking_id, staff_id, tag_filled) DO UPDATE
       SET status = CASE WHEN staff_assignments.status = 'assigned'
                         THEN staff_assignments.status
                         ELSE EXCLUDED.status END,
           updated_at = NOW()
     RETURNING *`,
    [parseInt(booking_id), parseInt(staff_id), tag_filled, status || 'interested']
  );
  return rows[0];
}

// Exported for use by bookings.js / booking.js — fires automatically on a new
// or newly-confirmed booking.
exports.notifyMatchingStaff = async function notifyMatchingStaff(booking) {
  if (!booking || !booking.id) return;
  let client;
  try {
    client = await getPool().connect();
    await ensureTables(client);
    return await notifyStaffForBooking(client, booking);
  } catch(e) {
    console.error('notifyMatchingStaff error:', e.message);
  } finally {
    if (client) client.release();
  }
};

// Exported for tests — the invariant these two share is the thing worth pinning.
exports.STAFFABLE_STATUSES = STAFFABLE_STATUSES;
exports.isStaffable = isStaffable;
exports.slotTags = slotTags;
exports.eligibleStaff = eligibleStaff;
exports.wantsSms = wantsSms;
exports.wantsEmail = wantsEmail;
exports.buildOfferMap = buildOfferMap;
exports.offerText = offerText;
exports.expressInterest = expressInterest;
exports.buildChecklistTimestampClause = buildChecklistTimestampClause;
exports.CHECKLIST_STATUSES = CHECKLIST_STATUSES;
exports.CHECKLIST_TS_COLS = CHECKLIST_TS_COLS;
exports.clockAdjustmentLog = clockAdjustmentLog;
exports.isAdjustableStage = isAdjustableStage;
exports.advancedStatus = advancedStatus;
exports.ensureTables = ensureTables;
module.exports.validPayOverride = validPayOverride;
module.exports.payOverrideLog = payOverrideLog;
