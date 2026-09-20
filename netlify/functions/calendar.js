// calendar.js — an iCalendar feed of the schedule, with staff on every event.
//
// GET /api/calendar.ics?token=...   the feed itself (token in the URL, because
//                                   calendar clients cannot send auth headers)
// GET /api/calendar                 admin-only; returns the subscribe URL,
//                                   minting the token on first call
//
// Why a subscribed feed rather than the Google Calendar API: a feed needs no
// OAuth, stores no refresh token, and can never write to or delete from the
// real calendar. The whole integration is one read-only URL. If a token leaks,
// rotating it is one admin call — there is no third-party grant to revoke.
//
// One-way by design. The CRM is the system of record for bookings; a calendar
// that could write back would create a second source of truth for event times,
// which is the problem the PPM cutover just finished solving.
const crypto = require('crypto');
const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { getDriveMins, loadZipCoords, homeBase } = require('./_schedule');
const { collectFromClient } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
const TZ = 'America/Chicago';

// Statuses worth putting on a calendar. 'review' and 'draft' are not commitments
// and would clutter the month with enquiries that never happen; 'cancelled' is
// deliberately excluded so a cancelled gig disappears from the phone.
const CALENDAR_STATUSES = ['quoted', 'accepted', 'confirmed', 'completed'];

// ── iCalendar plumbing ───────────────────────────────────────────────────────
// RFC 5545 is unforgiving: a malformed feed is usually rejected in silence, so
// the escaping and folding below are not decoration.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Content lines must be folded at 75 octets, continuation lines starting with a
// single space. Folded on characters rather than octets — near enough for the
// ASCII this feed emits, and a multi-byte name simply folds a little early.
function fold(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { out.push(' ' + rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest) out.push(' ' + rest);
  return out.join('\r\n');
}

const pad = (n) => String(n).padStart(2, '0');
const stampUTC = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

// "18:00" -> {h,m}; tolerates "6:00 PM", "18:00:00" and junk.
function parseTime(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

const addMinutes = (dateStr, { h, m }, mins) => {
  const [Y, Mo, D] = dateStr.split('-').map(Number);
  // Deliberately built in UTC and formatted as a wall-clock string. The event
  // carries TZID=America/Chicago, so these digits are local time and must not
  // be shifted by the server's own zone — Netlify runs UTC, a laptop does not.
  const d = new Date(Date.UTC(Y, Mo - 1, D, h, m));
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
};

// Minimal but valid US Central definition, so clients that insist on resolving
// TZID against a VTIMEZONE have one.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZ}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// ── Call time ───────────────────────────────────────────────────────────────
// The one thing this feed could not answer on a Saturday morning: what time
// does anybody have to be at the house. It is NOT derived here. schedule_start
// is the persisted "leave home" time on the assignment — event_time minus load,
// drive and setup — and it is the exact figure the crew were texted and the
// staff portal shows as "Load up". Deriving a second one would put a different
// number on Joe's phone from the one in a crew member's hand.
//
// The EARLIEST across the assignments: a per-role override can move one
// person's start, and the call time is when the first of them turns up. Rows
// with no schedule_start are skipped rather than counted as midnight — it is
// only computed once somebody is actually assigned, so an "interested" row
// legitimately has none.
//
// total_minutes and the drive come off that same row, not off a max across all
// of them, so "home by" is that call time plus that shift — two figures from
// two different assignments would add up to a time nobody is ever home.
function callFor(staff) {
  let best = null;
  for (const s of staff) {
    const mins = hhmmToMins(s.schedule_start);
    if (mins == null) continue;
    if (!best || mins < best.mins) best = { mins, row: s };
  }
  if (!best) return null;
  const total = Number(best.row.total_minutes);
  const drive = Number(best.row.drive_minutes_each_way);
  return {
    mins: best.mins,
    homeMins: isFinite(total) && total > 0 ? best.mins + total : null,
    driveMinutes: isFinite(drive) && drive > 0 ? drive : null,
  };
}

// pg hands a TIME column back as a string ("13:45:00"), never a Date — there is
// no type-1083 parser registered. Same treatment as automations-scheduled.js.
function hhmmToMins(t) {
  const m = String(t == null ? '' : t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

// Minutes-of-day to "1:45 PM". Wraps rather than overflowing: a call time that
// lands before midnight on a 12:30am gig is the previous evening, and printing
// "25:45" would be worse than printing "11:45 PM".
function fmt12(mins) {
  if (mins == null) return '';
  const m = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(m % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// What the crew collect on the day comes from _items.js collectFromClient, not
// from a rule spelled out here: the staff portal prints the same figure, and
// the calendar quietly disagreeing with the phone in a crew member's hand is
// the whole failure this feature is meant to prevent.

// The calendar title uses the service's internal short_name ("Foam 45min
// Single Cannon") in place of the customer-facing name ("Foam Party — Single
// Cannon"), which says nothing about length.
//
// One catch: service_name is a ' + ' join of EVERY service on the booking
// (_items.js rollupItems), while short_name names only the first. Dropping to
// short_name alone would silently hide the extras, so the count comes along.
// A booking with no service_id — a custom quote — has no short_name and keeps
// the stored service_name.
function summaryName(b) {
  if (!b.short_name) return b.service_name || 'Event';
  const extra = String(b.service_name || '').split(' + ').length - 1;
  return extra > 0 ? `${b.short_name} +${extra}` : b.short_name;
}

function buildEvent(b, staff, now) {
  const uid = `booking-${b.id}@funkymonkeyadmin`;
  const time = parseTime(b.event_time);
  const mins = Number(b.duration_minutes) || 90;

  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stampUTC(now)}`];

  if (time) {
    lines.push(`DTSTART;TZID=${TZ}:${addMinutes(b.event_date, time, 0)}`);
    lines.push(`DTEND;TZID=${TZ}:${addMinutes(b.event_date, time, mins)}`);
  } else {
    // No time recorded — an all-day entry is honest; inventing 9am is not.
    const d = b.event_date.replace(/-/g, '');
    const [Y, Mo, D] = b.event_date.split('-').map(Number);
    const next = new Date(Date.UTC(Y, Mo - 1, D + 1));
    lines.push(`DTSTART;VALUE=DATE:${d}`);
    lines.push(`DTEND;VALUE=DATE:${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`);
  }

  const who = b.client_name || 'Unnamed';
  lines.push(`SUMMARY:${esc(`${summaryName(b)} — ${who}`)}`);

  const loc = [b.event_location, b.event_zip].filter(Boolean).join(', ');
  if (loc) lines.push(`LOCATION:${esc(loc)}`);

  // The description is what makes this useful on a phone at 8am.
  const crew = staff.length
    ? staff.map((s) => `  • ${s.name}${s.role ? ` — ${s.role}` : ''}${s.status && s.status !== 'assigned' ? ` (${s.status})` : ''}`).join('\n')
    : '  • nobody assigned yet';

  // total_price EXCLUDES travel, so showing it raw next to balance_due
  // produces lines like "Total $1250.00 · Balance $1401.20" — a balance larger
  // than the total, which reads as a bug on a phone at 8am. Show the gross the
  // client actually owes, which is what balance_due is derived from.
  const gross = Number(b.total_price || 0) + Number(b.mileage_cost || 0);
  const money = [];
  if (gross) money.push(`Total $${gross.toFixed(2)}${Number(b.mileage_cost) ? ' (incl. travel)' : ''}`);
  // The old "Balance $745.00 due" line is gone, not lost: collectLine() below
  // says the same number as an instruction to whoever reads it at 8am.
  if (b.deposit_paid) money.push('deposit paid');

  // When the crew meet at the house, and when they are home again. Blank for a
  // booking nobody is staffed to — which is most 'quoted' rows on this feed —
  // and that absence is stated rather than left as a gap, because "no call
  // time" and "nobody is going" are the same fact and both need doing something
  // about.
  const call = callFor(staff);
  const when = [];
  if (call) {
    when.push(`Call time: ${fmt12(call.mins)} at the house`);
    const tail = [];
    if (call.homeMins != null) tail.push(`Home by ~${fmt12(call.homeMins)}`);
    if (call.driveMinutes != null) tail.push(`${call.driveMinutes} min drive each way`);
    if (tail.length) when.push(tail.join(' · '));
  } else if (b.status !== 'completed') {
    when.push('Call time: not set — nobody staffed yet');
  }
  // A completed gig gets no such line: the feed carries 90 days of history, and
  // "nobody staffed yet" on a gig that already happened is a nag about a
  // decision that can no longer be made.
  // An unknown ZIP silently becomes a 30-minute drive (_schedule.js getDriveMins),
  // which makes the call time above fiction rather than merely imprecise. Say so
  // here, where it is read, in the same words the staff portal uses. zip_known is
  // set on the row by buildFeed, exactly as bookings.js sets it for the list.
  if (call && b.zip_known === false) {
    // No ZIP at all and an unrecognised ZIP are different jobs: one is a field
    // to fill in, the other is a drive time to set by hand. "no drive time for
    // ZIP (none)" told Joe neither — measured on FM-BF5XDJVB, 2026-09-20.
    when.push(String(b.event_zip || '').trim()
      ? `⚠ Times are a guess — no drive time for ZIP ${b.event_zip}`
      : '⚠ Times are a guess — this booking has no ZIP');
  }

  // What to load and where to stand. Both are client-editable on the
  // finalisation page, so they are the fields most likely to have changed since
  // the booking was taken.
  const place = [b.venue ? `Venue: ${b.venue}` : '', b.surface_type ? `Surface: ${b.surface_type}` : '']
    .filter(Boolean).join(' · ');

  // null means "leave this out"; '' is a deliberate blank line between the
  // sections. Those two were the same value until the notes grew sections, and
  // the filter dropped every separator along with the empty fields — which is
  // why this was one unbroken wall of text on a phone.
  lines.push(`DESCRIPTION:${esc([
    // The reference rides on the status line: it is what gets pasted into
    // admin, and it was already being fetched and thrown away.
    `Status: ${b.status}${b.reference ? ` · ${b.reference}` : ''}`,
    '',
    ...when,
    '',
    'Staff:',
    crew,
    '',
    place || null,
    b.client_phone ? `Client: ${who} · ${b.client_phone}` : `Client: ${who}`,
    collectFromClient(b).note,
    money.length ? money.join(' · ') : null,
    b.guest_count ? `${b.guest_count} guests` : null,
    b.notes ? `\nNotes: ${b.notes}` : null,
    `\n${SITE}/admin.html`,
  ].filter((x) => x !== null).join('\n'))}`);

  // Every booking that reaches this feed is a real commitment — cancelled and
  // review rows are filtered out upstream — so they are all CONFIRMED to the
  // calendar. (This was briefly a ternary with the same value on both sides.)
  lines.push('STATUS:CONFIRMED');
  lines.push(`URL:${SITE}/admin.html`);
  lines.push('END:VEVENT');
  return lines;
}

async function buildFeed(client) {
  const { rows: bookings } = await client.query(
    `SELECT b.id, b.reference, b.status, b.service_name, b.client_name, b.client_phone,
            b.event_date::text AS event_date, b.event_time, b.event_location, b.event_zip,
            b.guest_count, b.notes, b.deposit_paid, b.venue, b.surface_type,
            -- source decides whether anyone collects at all: a GigSalad client
            -- already paid the platform (_source.js).
            b.source,
            b.total_price::float8 AS total_price, b.balance_due::float8 AS balance_due,
            b.mileage_cost::float8 AS mileage_cost,
            s.duration_minutes, s.short_name
       FROM bookings b
       LEFT JOIN services s ON s.service_id = b.service_id
      WHERE b.event_date IS NOT NULL
        AND b.status = ANY($1)
        AND b.event_date >= CURRENT_DATE - INTERVAL '90 days'
        AND b.event_date <= CURRENT_DATE + INTERVAL '2 years'
      ORDER BY b.event_date`,
    [CALENDAR_STATUSES]
  );

  // One query for every assignment, not one per booking.
  const ids = bookings.map((b) => b.id);
  const byBooking = new Map();
  if (ids.length) {
    const { rows: crew } = await client.query(
      // schedule_start / total_minutes / drive_minutes_each_way come along for
      // the call time. They live on the assignment, so this join — already here
      // for the crew list — is the whole cost of the feature: no second query.
      `SELECT sa.booking_id, sa.tag_filled AS role, sa.status,
              sa.schedule_start, sa.total_minutes, sa.drive_minutes_each_way,
              COALESCE(NULLIF(st.preferred_name,''), st.name) AS name
         FROM staff_assignments sa
         JOIN staff st ON st.id = sa.staff_id
        WHERE sa.booking_id = ANY($1)
        ORDER BY sa.tag_filled, name`,
      [ids]
    );
    for (const c of crew) {
      if (!byBooking.has(c.booking_id)) byBooking.set(c.booking_id, []);
      byBooking.get(c.booking_id).push(c);
    }
  }

  // Is the call time real or a 30-minute guess? One bulk read of the ZIP table
  // answers it for every booking at once — loadZipCoords never reaches the
  // network, so a feed poll cannot be slowed down by a geocoder having a bad
  // day. Same two calls, same reason, as the admin list (bookings.js:295).
  const zipCoords = await loadZipCoords(client, bookings.map((b) => b.event_zip));
  const home = await homeBase(client);
  for (const b of bookings) {
    b.zip_known = getDriveMins(b.event_zip, { coords: zipCoords, home }).zipKnown;
  }

  const now = new Date();
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Funky Monkey Events//CRM Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Funky Monkey — Schedule',
    `X-WR-TIMEZONE:${TZ}`,
    // Hint to clients that poll: check hourly rather than daily.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    ...VTIMEZONE,
  ];
  for (const b of bookings) out.push(...buildEvent(b, byBooking.get(b.id) || [], now));
  out.push('END:VCALENDAR');

  return out.map(fold).join('\r\n') + '\r\n';
}

async function getOrCreateToken(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS admin_settings (
    key VARCHAR(64) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  const { rows } = await client.query("SELECT value FROM admin_settings WHERE key='calendar_feed_token'");
  if (rows.length && rows[0].value) return rows[0].value;
  const token = crypto.randomBytes(24).toString('base64url');
  await client.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ('calendar_feed_token', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [token]
  );
  return token;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const qs = event.queryStringParameters || {};

  // ── the feed ──────────────────────────────────────────────────────────────
  if (qs.token) {
    return withClient(async (client) => {
      const expected = await getOrCreateToken(client);
      // Constant-time compare: this token is the only thing standing between
      // the open internet and every client's name, phone and address.
      const a = Buffer.from(String(qs.token));
      const b = Buffer.from(String(expected));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { statusCode: 403, headers: CORS, body: 'Forbidden' };
      }
      const body = await buildFeed(client);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="funky-monkey.ics"',
          'Cache-Control': 'public, max-age=900',
        },
        body,
      };
    });
  }

  // ── admin: fetch or rotate the subscribe URL ──────────────────────────────
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'rotate') {
        const token = crypto.randomBytes(24).toString('base64url');
        await client.query(
          `INSERT INTO admin_settings (key, value, updated_at) VALUES ('calendar_feed_token', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [token]
        );
        return json(200, { ok: true, rotated: true, url: `${SITE}/api/calendar.ics?token=${token}` });
      }
      return json(400, { error: 'unknown action' });
    }
    const token = await getOrCreateToken(client);
    return json(200, { url: `${SITE}/api/calendar.ics?token=${token}`, statuses: CALENDAR_STATUSES });
  });
};

// Exported for test/calendar.test.js
module.exports.esc = esc;
module.exports.fold = fold;
module.exports.parseTime = parseTime;
module.exports.buildEvent = buildEvent;
module.exports.CALENDAR_STATUSES = CALENDAR_STATUSES;
module.exports.buildFeed = buildFeed;   // exported so the feed can be built against a real client in tests
