// "Am I free?" — answered from two sources at once: the calendars Joe
// subscribes to, and FME's own bookings.
//
// The invariant that matters: this function can return "nothing found", but it
// can never return "definitely clear" when a feed is broken or stale. Those are
// different answers and conflating them is how getDriveMins came to return 30
// for a ZIP it had never heard of. degraded is a first-class part of the result
// and every caller must render it.
//
// Pure helper over an injected client — no HTTP handler here. See
// availability.js for the endpoint; the split exists because Netlify excludes
// underscore-prefixed files from deployment, so a route to this file 404s.

const { spanFor, TZ } = require('./_schedule');

const STALE_MS = 25 * 3600 * 1000;   // a day plus an hour of slack for the hourly cron
const HARD_STATUSES = ['accepted', 'confirmed', 'completed'];
// 'review' belongs here too: bookings.js defaults status to 'review' and the
// public form inserts every inquiry as 'review', making it the most common
// status in the table. Leaving it out of both tiers made it invisible to the
// conflict check entirely. calendar.js:25 already treats 'review' and
// 'draft' as a pair (neither is a commitment worth putting on the calendar);
// this restores that same pairing here.
const SOFT_STATUSES = ['quoted', 'draft', 'review'];

// Half-open [start, end). A gig ending at 15:00 and an appointment starting at
// 15:00 do not clash — get this wrong and every back-to-back day cries wolf,
// which trains you to ignore the panel entirely.
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);

// pg hands DATE columns back as JS Date objects, not "YYYY-MM-DD" strings —
// String(aDate).slice(0,10) instead slices "Wed Sep 12" off the start of its
// toString(). A booking loaded straight off the table (as availability.js's
// booking_id path does) would silently match zero "other bookings" on the
// right day. See the matching note in _schedule.js's spanFor.
const ymd = (value) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10);

function feedHealth(feeds, now) {
  const reasons = [];
  const warnings = [];
  for (const f of feeds) {
    if (f.active === false) continue;
    if (!f.last_synced_at) { reasons.push(`"${f.label}" has never synced`); continue; }
    if (f.last_status === 'error') { reasons.push(`"${f.label}" failed to sync: ${f.last_error || 'unknown error'}`); continue; }
    const age = now - new Date(f.last_synced_at);
    if (age > STALE_MS) {
      const hours = Math.round(age / 3600000);
      reasons.push(`"${f.label}" last synced ${hours} hours ago`);
    }
    for (const w of (Array.isArray(f.last_warnings) ? f.last_warnings : [])) warnings.push(`${f.label}: ${w}`);
  }
  return { degraded: reasons.length > 0, reasons, warnings };
}

async function conflictsFor(client, booking, { excludeBookingId = null, now = new Date() } = {}) {
  const span = await spanFor(client, booking);

  const { rows: feeds } = await client.query(
    `SELECT id, label, active, last_synced_at, last_status, last_error, last_warnings
       FROM calendar_feeds WHERE active = TRUE`);
  const health = feedHealth(feeds, now);

  const base = {
    window: span.windowKnown ? { startsAt: span.startsAt, endsAt: span.endsAt } : null,
    windowKnown: span.windowKnown,
    external: [], bookings: [],
    degraded: health.degraded, degradedReasons: health.reasons,
    warnings: health.warnings, unknowns: span.unknowns,
  };

  if (!span.windowKnown) return base;

  const { rows: busy } = await client.query(
    `SELECT b.summary, b.all_day, b.starts_at, b.ends_at, f.label AS feed_label
       FROM external_busy b JOIN calendar_feeds f ON f.id = b.feed_id
      WHERE f.active = TRUE AND b.starts_at < $2 AND b.ends_at > $1
      ORDER BY b.starts_at`,
    [span.startsAt.toISOString(), span.endsAt.toISOString()]);

  base.external = busy
    .filter(e => overlaps(span.startsAt, span.endsAt, e.starts_at, e.ends_at))
    .map(e => ({ feedLabel: e.feed_label, summary: e.summary, allDay: e.all_day,
                 startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at) }));

  const { rows: others } = await client.query(
    `SELECT id, reference, client_name, status, event_date, event_time, event_zip, service_id
       FROM bookings
      WHERE event_date = $1 AND status = ANY($2)`,
    [ymd(booking.event_date), [...HARD_STATUSES, ...SOFT_STATUSES]]);

  for (const o of others) {
    if (excludeBookingId != null && String(o.id) === String(excludeBookingId)) continue;
    const s = await spanFor(client, o);
    // A same-day booking with no time cannot be ruled out, so it is reported
    // rather than dropped.
    const clash = s.windowKnown ? overlaps(span.startsAt, span.endsAt, s.startsAt, s.endsAt) : true;
    if (!clash) continue;
    base.bookings.push({
      id: o.id, reference: o.reference, clientName: o.client_name, status: o.status,
      tier: HARD_STATUSES.includes(o.status) ? 'hard' : 'soft',
      startsAt: s.startsAt, endsAt: s.endsAt, windowKnown: s.windowKnown,
    });
  }

  return base;
}

// Everything a stranger is allowed to learn. No summaries, no feed labels, no
// client names — and it fails CLOSED, because "we are not sure" must never let
// somebody instant-book a Saturday Joe is already committed to.
//
// A parser warning (e.g. a BYSETPOS recurrence whose later occurrences could
// not be expanded) means "there is a standing commitment here I cannot see" —
// the exact shape of uncertainty this function exists to refuse. conflictsFor
// deliberately keeps warnings separate from degraded, because the admin path
// has Joe reading the panel and can weigh a partial-data warning himself; the
// public path has no human on the other end, so any warning degrades it. That
// asymmetry is the point — do not fold this back into conflictsFor.
async function publicAvailability(client, booking, { now = new Date() } = {}) {
  const r = await conflictsFor(client, booking, { now });
  if (r.degraded || !r.windowKnown || r.warnings.length > 0) return { available: false, degraded: true };
  const hard = r.bookings.some(b => b.tier === 'hard');
  return { available: r.external.length === 0 && !hard, degraded: false };
}

module.exports = { overlaps, conflictsFor, publicAvailability, feedHealth, TZ };
