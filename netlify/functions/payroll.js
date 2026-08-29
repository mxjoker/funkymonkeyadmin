const { withClient } = require('./_db');
const {
  CORS, preflight, requireAuth, unauthorized, forbidden,
} = require('./_auth');
const { payableHours, mergeClockSpan } = require('./_timeclock');
const { paymentForBooking } = require('./_pay');
const { getDriveMins, DEFAULT_MINUTES } = require('./_schedule');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Task step 2 (unify): payroll used to carry its own HOME_ZIP, zipCoords and
// getDriveMins — a byte-for-byte second copy of _schedule.js's, agreeing on
// every ZIP but NOT on the unload default (payroll said 15, _schedule.js and
// admin.html's Gig Time Templates UI both said 45). Both the ZIP table and
// the defaults now come from _schedule.js, so 45 is the value everywhere —
// see test/payroll-span.test.js for the pin proving this is the only number
// that moved.
function computeAssignmentSpan(a, tmpl, party) {
  const load    = a.load_minutes          ?? tmpl.load_minutes          ?? DEFAULT_MINUTES.load;
  const unload  = a.unload_minutes         ?? tmpl.unload_minutes         ?? DEFAULT_MINUTES.unload;
  const pack    = a.pack_out_minutes       ?? tmpl.pack_out_minutes       ?? DEFAULT_MINUTES.packOut;
  const homeUn  = a.home_unload_minutes    ?? tmpl.home_unload_minutes    ?? DEFAULT_MINUTES.homeUnload;
  const driveInfo = getDriveMins(a.event_zip);
  const drive   = a.drive_minutes_each_way ?? driveInfo.minutes;
  // A guess only when nothing pins the number down: no per-assignment
  // override AND the ZIP isn't in the table. An override is a deliberate
  // figure regardless of the ZIP; drive_minutes_each_way persisted from a
  // PRIOR run (staff-assignments.js's IS NULL guard) counts the same way —
  // it is no longer being computed live, so it isn't a guess either.
  const driveIsGuess = a.drive_minutes_each_way == null && !driveInfo.zipKnown;

  const totalMins = load + drive + unload + party + pack + drive + homeUn;
  const rawHours = totalMins / 60;

  return { load, unload, pack, homeUn, drive, party, totalMins, rawHours, driveIsGuess };
}

// Exported so payroll-scheduled.js can reuse the same table definitions.
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

  try {
    await client.query(`
      ALTER TABLE staff_payments
      ADD COLUMN IF NOT EXISTS payroll_run_id INTEGER REFERENCES payroll_runs(id)
    `);
  } catch (_) {}

  // Which side of payableHours() paid this row — the DB otherwise keeps no
  // record of whether a wage was the measured clock or the estimate, which is
  // the first thing anyone asks when a wage is questioned. paymentNote()
  // above is a human-readable echo of the same fact; these columns are the
  // queryable one.
  try {
    await client.query(`ALTER TABLE staff_payments ADD COLUMN IF NOT EXISTS hours_source VARCHAR(16)`);
  } catch (_) {}
  try {
    await client.query(`ALTER TABLE staff_payments ADD COLUMN IF NOT EXISTS measured_hours NUMERIC(5,2)`);
  } catch (_) {}

  // The escape hatch for a gig the higher-of rule prices wrong. Guaranteed here
  // because this is the function that reads it — a reader depending on another
  // module's migrations is a deploy-order bug, which this file already hit once.
  try {
    await client.query('ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pay_amount_override NUMERIC(10,2)');
  } catch (_) {}

  // Same reasoning, same guarantee: this function reads role_pay directly
  // (below), so it cannot rely on staff-assignments.js having run first.
  // Definition mirrors staff-assignments.js:212-217 exactly.
  await client.query(`
    CREATE TABLE IF NOT EXISTS role_pay (
      role_name  VARCHAR(100) PRIMARY KEY,
      pay_type   VARCHAR(20) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // The assignments query below reads gl.clocked_in_at / clocked_out_at /
  // clock_adjusted_at, but those columns — and the unique index that stops the
  // LEFT JOIN from doubling a line item — are otherwise only guaranteed by
  // staff-assignments.js's own migrations. A payroll run invoked before that
  // function has ever run (a fresh database, or just deploy order) would 500
  // the whole Pay Review on "column gl.clocked_in_at does not exist". A reader
  // that depends on another module's migrations is a deploy-order bug waiting
  // to happen, so this function guarantees what it reads. Full column list
  // mirrors staff-assignments.js:220-245 exactly (IF NOT EXISTS makes it a
  // no-op there in the normal case) so a fresh database doesn't end up with
  // two different ideas of what gig_logs looks like depending on which
  // function happens to touch it first.
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
  for (const sql of [
    'ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_in_at TIMESTAMPTZ',
    'ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clocked_out_at TIMESTAMPTZ',
    'ALTER TABLE gig_logs ADD COLUMN IF NOT EXISTS clock_adjusted_at TIMESTAMPTZ',
  ]) {
    try { await client.query(sql); } catch (_) {}
  }
  // Same guarantee staff-assignments.js:307 relies on for its own ON CONFLICT
  // target — required here too, since it's what stops this file's LEFT JOIN
  // gig_logs from multiplying a staff_assignments row into two payments.
  try {
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS gig_logs_assignment_id_key ON gig_logs (assignment_id)'
    );
  } catch (_) {}
}

// The only record of how an approved payment's amount was derived — the DB
// row itself doesn't say clock vs. estimate vs. override (see hours_source
// below), so this text is what a wage question gets answered from. An
// overridden gig's amount has nothing to do with its hours, so describing
// the hours ("480 min raw → 8h paid") beside a $200 override is a note about
// time that was never used to pay anyone. p.hours may be MEASURED while
// raw_hours/total_minutes are still the estimate; comparing p.hours against
// p.raw_hours regardless of source let a gig where the clock beat the
// estimate get stamped "(5h min applied)" when no floor applied at all.
//
// p.drive_is_guess (task step 3): the estimate path's total_minutes already
// includes a fabricated 30-minute drive when the ZIP is blank or unknown —
// that NUMBER doesn't change here, only whether the note admits it. A
// measured or overridden payment never reads this field: the clock doesn't
// care how the drive was guessed, and an override's amount has nothing to do
// with the estimate at all.
function paymentNote(p) {
  if (p.isOverride) {
    const roles = (p.roles_filled || []).join(', ');
    return `Override: $${Number(p.amount || 0).toFixed(2)}${roles ? ` for ${roles}` : ''}`;
  }
  if (p.hours_source === 'measured') {
    const floorApplied = p.hours > p.measured_hours;
    return `Measured ${p.measured_hours}h clocked → ${p.hours}h paid${floorApplied ? ' (5h min applied)' : ''}`;
  }
  const driveNote = p.drive_is_guess ? ' [drive time estimated — ZIP not in table]' : '';
  return `Auto-generated: ${p.total_minutes} min raw (${p.drive_minutes} min drive ea.)${driveNote} → ${p.hours}h paid${p.hours > p.raw_hours ? ' (5h min applied)' : ''}`;
}

// A consequence of the warning rule in _timeclock.js: it only warns when
// there IS clock data to be suspicious of, so a team that quietly stops
// clocking in entirely produces zero warnings and pays estimates forever,
// silently. One line, not one per row — the whole point of the warning rule
// is that per-row noise buries the signals that matter.
function noClockDataSummary(count, total) {
  if (!count) return null;
  return `${count} of ${total} payment${total === 1 ? '' : 's'} had no clock data; ` +
    `${count === 1 ? 'that was' : 'those were'} paid the estimate`;
}

module.exports.ensureTables = ensureTables;
module.exports.paymentNote = paymentNote;
module.exports.noClockDataSummary = noClockDataSummary;
module.exports.computeAssignmentSpan = computeAssignmentSpan;

// Get the Sunday for a given date (week ending).
// If the date IS a Sunday (day=0), returns that same date;
// otherwise advances to the NEXT Sunday.
function getSunday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
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
  const pre = preflight(event);
  if (pre) return pre;

  try {
    return await withClient(async (client) => {
      await ensureTables(client);

      const path = event.path;
      const runId = path.match(/\/api\/payroll\/(\d+)/)?.[1];

      // ── GET /api/payroll ────────────────────────────────────────────────────
      if (event.httpMethod === 'GET' && !runId) {
        const auth = await requireAuth(event);
        if (!auth) return unauthorized();

        const staffId = event.queryStringParameters?.staff_id;

        if (auth.role === 'staff') {
          // Staff: must include staff_id and it must match their own
          const requestedId = staffId ? parseInt(staffId) : null;
          if (!requestedId || requestedId !== auth.staffId) return forbidden();
        }

        if (staffId) {
          const resolvedId = auth.role === 'staff' ? auth.staffId : parseInt(staffId);

          const { rows: runs } = await client.query(`
            SELECT DISTINCT pr.*
            FROM payroll_runs pr
            JOIN payroll_line_items pli ON pli.payroll_run_id = pr.id
            WHERE pli.staff_id = $1
            ORDER BY pr.week_ending DESC
            LIMIT 12
          `, [resolvedId]);

          for (const run of runs) {
            const { rows: items } = await client.query(`
              SELECT pli.*, sp.booking_id, b.reference, b.service_name, b.event_date
              FROM payroll_line_items pli
              JOIN staff_payments sp ON sp.id = pli.staff_payment_id
              JOIN bookings b ON b.id = sp.booking_id
              WHERE pli.payroll_run_id = $1 AND pli.staff_id = $2
              ORDER BY b.event_date
            `, [run.id, resolvedId]);
            run.line_items = items;
            run.staff_total = items.reduce((sum, i) => sum + Number(i.amount) + Number(i.adjustment_amount || 0), 0);
          }

          return json(200, { runs });
        }

        // Admin-only: list all payroll runs
        const { rows: runs } = await client.query(`
          SELECT pr.*,
                 COUNT(DISTINCT pli.staff_id) as staff_count
          FROM payroll_runs pr
          LEFT JOIN payroll_line_items pli ON pli.payroll_run_id = pr.id
          GROUP BY pr.id
          ORDER BY pr.week_ending DESC
          LIMIT 20
        `);

        return json(200, { runs });
      }

      // ── GET /api/payroll/:id ────────────────────────────────────────────────
      if (event.httpMethod === 'GET' && runId) {
        const auth = await requireAuth(event, ['admin']);
        if (!auth) return unauthorized();

        const { rows: [run] } = await client.query('SELECT * FROM payroll_runs WHERE id = $1', [parseInt(runId)]);
        if (!run) return json(404, { error: 'Run not found' });

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
        return json(200, run);
      }

      // ── POST /api/payroll ───────────────────────────────────────────────────
      if (event.httpMethod === 'POST') {
        const auth = await requireAuth(event, ['admin']);
        if (!auth) return unauthorized();

        let body;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
        const action = body.action;

        // action: generate — or 'preflight', which runs the exact same
        // computation as a dry run and returns per-event pay for review
        // (plus bookings in range with no staff assigned) without writing.
        if (action === 'generate' || action === 'preflight') {
          const dryRun = action === 'preflight';
          const { week_ending, date_from, date_to, label } = body;

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
            return json(400, { error: 'date_from + date_to or week_ending required' });
          }

          if (!dryRun) {
            const { rows: existing } = await client.query(
              'SELECT * FROM payroll_runs WHERE week_ending = $1', [rangeEnd]
            );
            if (existing.length > 0) {
              return json(400, { error: 'A payroll run already exists ending on this date', run: existing[0] });
            }
          }

          const { rows: assignments } = await client.query(`
            SELECT sa.id as assignment_id, sa.staff_id, sa.tag_filled, sa.pay_amount_override,
                   sa.load_minutes, sa.unload_minutes, sa.pack_out_minutes,
                   sa.home_unload_minutes, sa.drive_minutes_each_way, sa.total_minutes,
                   b.id as booking_id, b.reference, b.service_name, b.service_id,
                   b.event_date, b.event_time, b.event_zip,
                   s.name as staff_name, s.preferred_name,
                   s.pay_type, s.flat_rate, s.hourly_rate,
                   gl.clocked_in_at, gl.clocked_out_at, gl.clock_adjusted_at
            FROM staff_assignments sa
            JOIN bookings b ON b.id = sa.booking_id
            JOIN staff s ON s.id = sa.staff_id
            LEFT JOIN gig_logs gl ON gl.assignment_id = sa.id
            LEFT JOIN staff_payments sp_paid
              ON sp_paid.booking_id = sa.booking_id
              AND sp_paid.staff_id  = sa.staff_id
              AND sp_paid.paid = true
            WHERE sa.status = 'assigned'
              AND b.event_date >= $1
              AND b.event_date <= $2
              AND b.status IN ('confirmed','completed')
              AND sp_paid.id IS NULL
            ORDER BY s.id, b.event_date, sa.id
          `, [rangeStart, rangeEnd]);

          if (assignments.length === 0 && !dryRun) {
            return json(200, {
              message: 'No unpaid assigned staff found for this date range',
              date_from: rangeStart, date_to: rangeEnd, count: 0
            });
          }

          const { rows: templates } = await client.query('SELECT * FROM service_time_templates');
          const templateMap = {};
          templates.forEach(t => { templateMap[t.service_id] = t; });

          const { rows: services } = await client.query('SELECT service_id, duration_minutes FROM services');
          const durationMap = {};
          services.forEach(s => { durationMap[s.service_id] = s.duration_minutes || 60; });

          const { rows: rolePayRows } = await client.query('SELECT role_name, pay_type FROM role_pay');
          const rolePayByRole = {};
          for (const r of rolePayRows) rolePayByRole[r.role_name] = r.pay_type;

          const paymentsToCreate = [];
          const warnings = [];

          // One person on one booking is one payment, however many roles they
          // filled. Iterating raw assignment rows paid an hourly staff member the
          // whole span once per role.
          const byStaffBooking = new Map();
          for (const a of assignments) {
            const key = `${a.staff_id}:${a.booking_id}`;
            if (!byStaffBooking.has(key)) byStaffBooking.set(key, []);
            byStaffBooking.get(key).push(a);
          }

          let noClockCount = 0;
          for (const group of byStaffBooking.values()) {
            // group[0] is now deterministic — ORDER BY s.id, b.event_date, sa.id
            // above means "first in the group" always means "lowest assignment
            // id" — but it is still an arbitrary pick among per-assignment
            // fields that are NOT guaranteed identical across roles: an admin
            // can hand-set load/unload/drive minutes on one role's row and not
            // the other. The choice is deliberate, not incidental: a second
            // role for the same person on the same booking is not a second
            // physical trip, so there is one load, one drive, one unload for
            // the group, and the lowest-id row's figures (or the template
            // default) are what's used. Clock timestamps are handled
            // separately below via mergeClockSpan, precisely because a
            // one-row pick is wrong for those.
            const a = group[0];
            const { rows: existingPayment } = await client.query(
              'SELECT id FROM staff_payments WHERE booking_id=$1 AND staff_id=$2',
              [a.booking_id, a.staff_id]
            );

            const tmpl = templateMap[a.service_id] || {};
            const party = durationMap[a.service_id] || 60;
            const { load, unload, pack, homeUn, drive, totalMins, rawHours, driveIsGuess } =
              computeAssignmentSpan(a, tmpl, party);

            // A person who filled two roles worked one continuous shift, and
            // each role's gig_logs row only stamps its own clock — picking one
            // row's log arbitrarily made the paid hours (measured vs. the 5h
            // estimate) depend on unrelated row order. The merged span is
            // earliest clock-in to latest clock-out across the whole group,
            // and degrades to a single row's own stamps when there is only one.
            const clockSpan = mergeClockSpan(group);

            // Pay the clock when the record is complete and plausible; otherwise
            // pay the estimate and say so. The 5-hour minimum applies either way.
            const paid = payableHours(clockSpan, Math.round(rawHours * 100) / 100);
            const totalHours = paid.hours;
            if (paid.warning) {
              // totalHours may be the 5-hour floor rather than the estimate itself —
              // say what was actually paid, not "the estimate", or a 3.2h estimate
              // reports the wrong-but-believable "paid the estimate (5h)".
              warnings.push(`${a.preferred_name || a.staff_name} on booking ${a.reference}: ${paid.warning} — paid ${totalHours}h`);
            } else if (paid.source === 'estimated') {
              // hasClockData was false in payableHours() — no warning fired
              // because there was nothing to be suspicious of, only nothing.
              noClockCount++;
            }

            const bookingPaid = paymentForBooking(group, rolePayByRole, a, totalHours);
            const payType = bookingPaid.payType;
            // `amount` here is what the preflight displays; whether an
            // existing row's `amount` column actually gets rewritten is a
            // separate decision, made below (IMPORTANT 1) using isOverride.
            // Preserves the old behaviour: a repeat run never overwrites an
            // existing flat-rate payment's amount with a freshly computed
            // default (the UPDATE below deliberately doesn't touch `amount`
            // for that case — see p.isOverride below).
            const amount = existingPayment.length > 0 && payType === 'flat' && bookingPaid.basis === 'flat rate'
              ? null : bookingPaid.amount;

            // Warn about $0 line items (flat_rate=0 staff) — but not a
            // deliberate $0 override, which is a real decision with nothing
            // to check on the staff record.
            const resolvedAmount = amount !== null ? amount : 0;
            if (resolvedAmount === 0 && !bookingPaid.isOverride) {
              warnings.push(`${a.preferred_name || a.staff_name} (staff_id ${a.staff_id}) has $0 for booking ${a.reference} — check flat_rate/hourly_rate setting`);
            }

            paymentsToCreate.push({
              existingId: existingPayment[0]?.id || null,
              staff_id:   a.staff_id,
              booking_id: a.booking_id,
              assignment_id: a.assignment_id,
              reference:  a.reference,
              service_name: a.service_name,
              event_date: a.event_date,
              pay_type:   payType,
              pay_basis:  bookingPaid.basis,
              isOverride: bookingPaid.isOverride,
              roles_filled: bookingPaid.rolesFilled,
              raw_hours:  Math.round(rawHours * 100) / 100,
              hours:      totalHours,
              hours_source: paid.source,
              measured_hours: paid.measured,
              // IMPORTANT 8: written by adjust_clock, selected here, never
              // surfaced anywhere — the spec asked that an adjusted log stay
              // flagged so a payroll run can show it. Carried alongside
              // hours_source so the preflight staff line can render both.
              // True if any role's log in the group was hand-corrected, not
              // just the row that happened to be group[0].
              clock_adjusted: clockSpan.clock_adjusted,
              amount,
              drive_minutes: drive,
              // Read by paymentNote() to label an estimate built on a
              // guessed drive — see computeAssignmentSpan's comment for what
              // counts as a guess. The 30-minute number itself is unchanged.
              drive_is_guess: driveIsGuess,
              total_minutes: totalMins,
            });

            if (!dryRun) {
              for (const row of group) {
                await client.query(`
                  UPDATE staff_assignments SET
                    drive_minutes_each_way = $1,
                    total_minutes = $2,
                    updated_at = NOW()
                  WHERE id = $3
                    AND (drive_minutes_each_way IS NULL OR total_minutes IS NULL)
                `, [drive, totalMins, row.assignment_id]);
              }
            }
          }

          const noClockSummary = noClockDataSummary(noClockCount, byStaffBooking.size);
          if (noClockSummary) warnings.push(noClockSummary);

          // ── preflight: return the review payload, write nothing ──────────
          if (dryRun) {
            const { rows: rangeBookings } = await client.query(`
              SELECT b.id, b.reference, b.service_name, b.event_date, b.event_time,
                     b.status, COALESCE(cnt.n, 0)::int AS assigned_count
              FROM bookings b
              LEFT JOIN (
                SELECT booking_id, COUNT(*) AS n FROM staff_assignments
                WHERE status='assigned' GROUP BY booking_id
              ) cnt ON cnt.booking_id = b.id
              WHERE b.event_date >= $1 AND b.event_date <= $2
                AND b.status IN ('confirmed','completed')
              ORDER BY b.event_date, b.event_time
            `, [rangeStart, rangeEnd]);

            const byBooking = {};
            for (const p of paymentsToCreate) {
              const a = assignments.find(x => x.assignment_id === p.assignment_id);
              (byBooking[p.booking_id] = byBooking[p.booking_id] || []).push({
                staff_id: p.staff_id,
                staff_name: a ? (a.preferred_name || a.staff_name) : String(p.staff_id),
                pay_type: p.pay_type,
                hours: p.hours,
                hours_source: p.hours_source,
                measured_hours: p.measured_hours,
                clock_adjusted: p.clock_adjusted,
                amount: p.amount !== null ? p.amount : 0,
                already_recorded: !!p.existingId,
                // So a reviewer sees the guess BEFORE approving the run, not
                // only afterward in paymentNote()'s text on the saved row.
                drive_is_guess: p.drive_is_guess,
              });
            }

            const events = rangeBookings.map(b => ({
              booking_id: b.id,
              reference: b.reference,
              service_name: b.service_name,
              event_date: b.event_date,
              event_time: b.event_time,
              status: b.status,
              staff: byBooking[b.id] || [],
              unassigned: b.assigned_count === 0,
            }));

            return json(200, {
              date_from: rangeStart,
              date_to: rangeEnd,
              events,
              unassigned_count: events.filter(e => e.unassigned).length,
              total: Math.round(paymentsToCreate.reduce((s, p) => s + (p.amount !== null ? p.amount : 0), 0) * 100) / 100,
              warnings: warnings.length ? warnings : [],
            });
          }

          const paymentIds = [];
          for (const p of paymentsToCreate) {
            if (p.existingId) {
              // IMPORTANT 1: a repeat run must not overwrite an existing
              // row's amount with a freshly computed default (a flat rate
              // that changed, an hourly recompute) — that would silently
              // disagree with whatever total was already approved. But a
              // deliberate per-gig override is the one figure Joe would
              // come back to insist on after seeing a payroll number he
              // disagreed with, so it does overwrite, $0 included.
              // The note travels with the amount. Writing one without the
              // other leaves an override's figure beside a stale
              // "480 min raw -> 8h paid" line describing a calculation that
              // was not used — and that note is what a wage question gets
              // answered from.
              if (p.isOverride) {
                await client.query(
                  'UPDATE staff_payments SET amount=$1, hours=$2, hours_source=$3, measured_hours=$4, note=$5, updated_at=NOW() WHERE id=$6',
                  [p.amount, p.hours, p.hours_source, p.measured_hours, paymentNote(p), p.existingId]
                );
              } else {
                await client.query(
                  'UPDATE staff_payments SET hours=$1, hours_source=$2, measured_hours=$3, updated_at=NOW() WHERE id=$4',
                  [p.hours, p.hours_source, p.measured_hours, p.existingId]
                );
              }
              paymentIds.push({ id: p.existingId, ...p });
            } else {
              const { rows: ins } = await client.query(`
                INSERT INTO staff_payments
                  (staff_id, booking_id, amount, pay_type, hours, hours_source, measured_hours, note)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING *
              `, [
                p.staff_id, p.booking_id,
                p.amount !== null ? p.amount : 0,
                p.pay_type, p.hours, p.hours_source, p.measured_hours,
                paymentNote(p)
              ]);
              paymentIds.push({ id: ins[0].id, ...p });
            }
          }

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
            await client.query(`
              INSERT INTO payroll_line_items (payroll_run_id, staff_payment_id, staff_id, amount)
              VALUES ($1, $2, $3, $4)
            `, [run.id, payment.id, payment.staff_id, payment.amount]);
          }

          console.log(`Created payroll run ${run.id} for ${rangeStart}–${rangeEnd} with ${finalPayments.length} payments totaling $${totalAmount}`);

          return json(200, {
            run,
            count: finalPayments.length,
            assignments_found: assignments.length,
            date_from: rangeStart,
            date_to: rangeEnd,
            warnings: warnings.length ? warnings : undefined,
          });
        }

        // action: add_adjustment
        if (action === 'add_adjustment') {
          const { line_item_id, adjustment_amount, adjustment_note } = body;
          await client.query(`
            UPDATE payroll_line_items
            SET adjustment_amount = $1, adjustment_note = $2
            WHERE id = $3
          `, [adjustment_amount || 0, adjustment_note || '', parseInt(line_item_id)]);

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

          return json(200, { success: true });
        }

        return json(400, { error: 'Unknown action: ' + action });
      }

      // ── PATCH /api/payroll/:id ──────────────────────────────────────────────
      if (event.httpMethod === 'PATCH' && runId) {
        const auth = await requireAuth(event, ['admin']);
        if (!auth) return unauthorized();

        let body;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

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
          return json(400, { error: 'No fields to update' });
        }

        values.push(parseInt(runId));
        const { rows: [updated] } = await client.query(
          `UPDATE payroll_runs SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
          values
        );

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

        return json(200, updated);
      }

      return json(405, { error: 'Method not allowed' });
    });
  } catch (err) {
    console.error('payroll.js error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};
