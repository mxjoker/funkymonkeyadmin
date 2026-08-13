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
  if (Number(b.balance_due)) money.push(`Balance $${Number(b.balance_due).toFixed(2)} due`);
  if (b.deposit_paid) money.push('deposit paid');

  lines.push(`DESCRIPTION:${esc([
    `Status: ${b.status}`,
    '',
    'Staff:',
    crew,
    '',
    b.client_phone ? `Client: ${who} · ${b.client_phone}` : `Client: ${who}`,
    money.length ? money.join(' · ') : '',
    b.guest_count ? `${b.guest_count} guests` : '',
    b.notes ? `\nNotes: ${b.notes}` : '',
    `\n${SITE}/admin.html`,
  ].filter((x) => x !== '').join('\n'))}`);

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
            b.guest_count, b.notes, b.deposit_paid,
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
      `SELECT sa.booking_id, sa.tag_filled AS role, sa.status,
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
