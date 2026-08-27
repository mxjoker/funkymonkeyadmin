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

// ── ZIP → coords map for OKC metro drive-time estimation ─────────────────────
// Moved verbatim from staff-assignments.js:59-95 — see task-3 report for the
// diff proving it is byte-for-byte unchanged.
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

// The 30-minute fallback for an unknown ZIP is UNCHANGED and that is
// deliberate: it flows into total_minutes and from there into payroll's
// estimate path. Deciding what payroll should do with an unknown drive is
// BUG-1's job, not this refactor's. zipKnown is the only new thing — it lets a
// caller say "estimated" without altering the number.
function getDriveMins(destZip) {
  const home = ZIP_COORDS[HOME_ZIP];
  const dest = ZIP_COORDS[String(destZip == null ? '' : destZip).substring(0, 5)];
  if (!home || !dest) return { minutes: 30, zipKnown: false };
  const R = 3958.8;
  const dLat = (dest.lat - home.lat) * Math.PI / 180;
  const dLng = (dest.lng - home.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(home.lat*Math.PI/180)*Math.cos(dest.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return { minutes: Math.max(10, Math.round((miles / 35) * 60)) + 15, zipKnown: true };
}

async function spanFor(client, booking, overrides = {}) {
  const { rows: [tmpl] } = await client.query(
    'SELECT * FROM service_time_templates WHERE service_id=$1', [booking.service_id]);
  const { rows: [svc] } = await client.query(
    'SELECT duration_minutes FROM services WHERE service_id=$1', [booking.service_id]);

  const unknowns = [];
  const drive = getDriveMins(booking.event_zip);
  if (!drive.zipKnown) unknowns.push(`drive time estimated — ZIP ${booking.event_zip || '(none)'} is not in the table`);

  const load   = overrides.load_minutes           ?? tmpl?.load_minutes           ?? 30;
  const setup  = overrides.unload_minutes         ?? tmpl?.unload_minutes         ?? 45;
  const pack   = overrides.pack_out_minutes       ?? tmpl?.pack_out_minutes       ?? 20;
  const homeUn = overrides.home_unload_minutes    ?? tmpl?.home_unload_minutes    ?? 15;
  const driveM = overrides.drive_minutes_each_way ?? drive.minutes;
  const party  = svc?.duration_minutes ?? 60;
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
    const [Y, Mo, D] = String(booking.event_date).slice(0, 10).split('-').map(Number);
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

module.exports = { spanFor, getDriveMins, TZ };
