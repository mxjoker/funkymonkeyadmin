// The working span of a gig: when Joe leaves home, and when he is back and
// unloaded. Extracted from autoCalcTimes in staff-assignments.js so it can be
// computed from a BOOKING ALONE, with no staff assignment.
//
// That is the whole reason this file exists. autoCalcTimes only ever ran when
// an assignment was created, so schedule_start is null on every booking nobody
// is staffed to yet — which is exactly the booking you are asking "am I free?"
// about. Reading the persisted column would have returned null and, worse,
// been easy to read as "no conflict".

const { zonedToInstant } = require('./_tz');

const TZ = 'America/Chicago';

// ── Coordinates ─────────────────────────────────────────────────────────────
// The 67-ZIP table that used to sit here now lives in _geo.js as the seed for
// the zip_coords table, because the same coordinates answer two questions —
// how long the crew drives, and what the client is charged — and two copies of
// that answer had already drifted 7.9 miles apart.
const { ZIP_SEED, HOME_FALLBACK, MAX_DRIVEABLE_MILES, milesBetween, normZip,
        ensureZipCoords, loadZipCoords, homeBase } = require('./_geo');


// The four component defaults, in one place so payroll.js can import them
// instead of carrying its own copy. It used to: unload defaulted to 15 there
// and 45 here (and in admin.html's Gig Time Templates UI) — an outlier
// nobody meant to create. 45 is the value everywhere now.
// `party` joined these on 2026-09-20. It was a bare 60 here and a bare 90 in
// calendar.js: the same unknown answered two different ways, so an unlinked
// booking got a 90-minute block on Joe's calendar and a 60-minute party inside
// the shift the crew were given. Measured that day: 9 of 30 upcoming bookings
// have no service_id and so no duration, and one of them is called "Community
// Magic Walkaround 3 hours" — the guess was wrong by two hours either way.
// Consistency does not make 60 right; estimateReasons() below is what says it
// is a guess.
const DEFAULT_MINUTES = { load: 30, unload: 45, packOut: 20, homeUnload: 15, party: 60 };

// The 30-minute fallback for an unknown ZIP is UNCHANGED and that is
// deliberate: it flows into total_minutes and from there into payroll's
// estimate path. Deciding what payroll should do with an unknown drive is
// BUG-1's job, not this refactor's. zipKnown is the only new thing — it lets a
// caller say "estimated" without altering the number.
// `coords` and `home` are injected so a caller that has already loaded the
// zip_coords table — or filled it from the lookup API — gets the real distance,
// while a caller that has not behaves exactly as before. Deliberately still
// SYNCHRONOUS: bookings.js calls this once per row when rendering the admin
// list, so a version that queried or fetched per call would be an N+1 on every
// page load. The network lives in _geo.ensureZipCoords, which callers invoke
// once for the ZIPs they care about.
//
// The 30-minute fallback for an unknown ZIP is UNCHANGED, and so is zipKnown
// reporting false for it — a wrong number that announces itself is the one
// thing here that was already right.
function getDriveMins(destZip, { coords, home } = {}) {
  const table = coords instanceof Map ? coords : new Map(Object.entries(coords || ZIP_SEED));
  const origin = home || HOME_FALLBACK;
  const dest = table.get(normZip(destZip));
  if (!origin || !dest) return { minutes: 30, zipKnown: false };
  const miles = milesBetween(origin, dest);
  // A flown-to gig has no meaningful drive time, and a computed one is
  // dangerous rather than merely wrong: the shift counts the drive twice, so
  // Orlando's 1,833 minutes each way would bill 64 hours. Report it the same
  // way as a ZIP we have never seen — 30 minutes, zipKnown false — so payroll
  // keeps treating it as an estimate and a human sets the real figure.
  if (miles > MAX_DRIVEABLE_MILES) return { minutes: 30, zipKnown: false, tooFarToDrive: true };
  return { minutes: Math.max(10, Math.round((miles / 35) * 60)) + 15, zipKnown: true };
}

// Why this gig's times are approximate, as a list of reasons a person can act
// on — empty when they are solid.
//
// Two unknowns land here, and they are different jobs. An unrecognised or
// missing ZIP makes the DRIVE a 30-minute fallback (getDriveMins above); a
// booking with no service_id has no catalogue duration, so the PARTY length is
// a fallback too. Either one moves every stage time on the screen.
//
// One function because three screens ask the same question: the staff portal,
// the calendar feed, and whatever asks next. The portal warned about the ZIP
// and said nothing about the duration, which is how a gig whose entire
// timeline was assumption looked merely imprecise.
//
// Takes a plain row, not a client: both callers already have the booking and
// the joined duration in hand, so this stays synchronous and free.
function estimateReasons(row) {
  const out = [];
  const zip = String((row && row.event_zip) || '').trim();
  if (row && row.zip_known === false) {
    // Three different situations wearing one flag, and they need three
    // different things doing about them.
    //
    // too_far_to_drive is NOT an unknown ZIP: getDriveMins measured the
    // distance, found it past MAX_DRIVEABLE_MILES, and refused to turn it into
    // a drive on purpose (payroll counts the leg twice, so Orlando's real
    // 1,833 minutes each way would bill a 5-hour minimum as 64 hours). Saying
    // "no drive time for ZIP 32821" about a gig we know is 1,061 miles away
    // sends Joe looking for a missing ZIP that is sitting right there.
    if (row.too_far_to_drive) {
      out.push(`out of town${zip ? ` (${zip})` : ''} — too far to drive, so set the travel time by hand`);
    } else {
      out.push(zip ? `no drive time for ZIP ${zip}` : 'this booking has no ZIP');
    }
  }
  // null/undefined only. A zero-minute service would be odd but it is an
  // answer, and treating it as missing would nag about a gig nobody guessed at.
  if (row && (row.duration_minutes === null || row.duration_minutes === undefined)) {
    out.push(`no service linked, so the ${DEFAULT_MINUTES.party}-minute length is a guess`);
  }
  return out;
}

async function spanFor(client, booking, overrides = {}) {
  const { rows: [tmpl] } = await client.query(
    'SELECT * FROM service_time_templates WHERE service_id=$1', [booking.service_id]);
  const { rows: [svc] } = await client.query(
    'SELECT duration_minutes FROM services WHERE service_id=$1', [booking.service_id]);

  const unknowns = [];
  // One booking, so this is the right place to spend a lookup: if the ZIP is
  // not in the table yet, ensureZipCoords fetches it once and stores it, and
  // every later read — including the per-row list path, which never fetches —
  // gets the real distance for free. A lookup that fails leaves the map
  // unchanged and getDriveMins falls back to 30 minutes exactly as before.
  const [coords, home] = await Promise.all([
    ensureZipCoords(client, [booking.event_zip]).catch((e) => {
      console.error('spanFor: zip lookup failed, using what we have —', e.message);
      return undefined;
    }),
    homeBase(client),
  ]);
  const drive = getDriveMins(booking.event_zip, { coords, home });
  if (!drive.zipKnown) {
    unknowns.push(drive.tooFarToDrive
      ? `drive time estimated — ${booking.event_zip} is too far to drive to; set the drive minutes by hand`
      : `drive time estimated — ZIP ${booking.event_zip || '(none)'} is not in the table`);
  }

  const load   = overrides.load_minutes           ?? tmpl?.load_minutes           ?? DEFAULT_MINUTES.load;
  const setup  = overrides.unload_minutes         ?? tmpl?.unload_minutes         ?? DEFAULT_MINUTES.unload;
  const pack   = overrides.pack_out_minutes       ?? tmpl?.pack_out_minutes       ?? DEFAULT_MINUTES.packOut;
  const homeUn = overrides.home_unload_minutes    ?? tmpl?.home_unload_minutes    ?? DEFAULT_MINUTES.homeUnload;
  const driveM = overrides.drive_minutes_each_way ?? drive.minutes;
  const party  = svc?.duration_minutes ?? DEFAULT_MINUTES.party;
  if (!svc) unknowns.push('service duration unknown — assumed 60 minutes');

  const totalMinutes = load + driveM + setup + party + pack + driveM + homeUn;
  const leadMinutes = load + driveM + setup;   // home -> on stage

  let startsAt = null, endsAt = null, windowKnown = false;
  const t = String(booking.event_time || '').match(/^(\d{1,2}):(\d{2})/);
  if (!booking.event_date) {
    unknowns.push('no event date on this booking');
  } else if (!t) {
    unknowns.push('no event time on this booking — the working window cannot be computed');
  } else {
    // pg hands DATE columns back as JS Date objects (see _email.js's
    // fmtEventDate for the same gotcha) — String(aDate) is
    // "Wed Sep 12 2026 00:00:00 GMT-0500 ..." whose first 10 characters are
    // NOT "2026-09-12". A row read straight from `bookings` (as conflictsFor's
    // "other bookings" loop and autoCalcTimes both do) would silently produce
    // NaN → Invalid Date → windowKnown left true, and an Invalid Date compares
    // false against everything, so overlaps() would never fire. That is a
    // "definitely clear" wearing a "nothing found" mask — exactly the bug
    // class this file exists to avoid. Normalize both shapes.
    const ymd = booking.event_date instanceof Date
      ? `${booking.event_date.getFullYear()}-${String(booking.event_date.getMonth() + 1).padStart(2, '0')}-${String(booking.event_date.getDate()).padStart(2, '0')}`
      : String(booking.event_date).slice(0, 10);
    const [Y, Mo, D] = ymd.split('-').map(Number);
    const eventAt = zonedToInstant(Y, Mo, D, Number(t[1]), Number(t[2]), TZ);
    startsAt = new Date(eventAt.getTime() - leadMinutes * 60000);
    endsAt   = new Date(startsAt.getTime() + totalMinutes * 60000);
    windowKnown = true;
  }

  return {
    startsAt, endsAt, totalMinutes, driveMinutes: driveM, zipKnown: drive.zipKnown, windowKnown, unknowns,
    // The four components total_minutes is built from. Returned so a caller that
    // must persist them as individual columns (autoCalcTimes) reads them from
    // here rather than keeping its own copy of these defaults in sync by hand.
    loadMinutes: load, unloadMinutes: setup, packOutMinutes: pack, homeUnloadMinutes: homeUn,
  };
}

module.exports = { spanFor, getDriveMins, estimateReasons, DEFAULT_MINUTES, TZ,
  // Re-exported so a caller needing a batch of ZIPs does not have to know
  // whether coordinates live here or in _geo.js.
  loadZipCoords, ensureZipCoords, homeBase };
