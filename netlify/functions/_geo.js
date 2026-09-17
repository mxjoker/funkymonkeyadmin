// netlify/functions/_geo.js — where things are, and how far away.
//
// One source for coordinates, because there were two and they disagreed. The
// staff scheduler measured from ZIP 73118's centroid in a 67-entry hardcoded
// table; booking-form.html measured client travel from a different pair of
// literals in browser JavaScript, 7.9 miles away, against a live API. Nobody
// chose either point. Measured 2026-09-17 against the real base: the scheduler
// was 0.50 miles out, the form — the one that charges money — was 7.43.
//
// Two things live here: the home base, and ZIP -> coordinates. The arithmetic
// that turns a distance into minutes stays in _schedule.js; the arithmetic that
// turns it into dollars is travelFor() below, so the admin and the public form
// can finally use the same rule.

// The point the vehicle actually leaves from, supplied by the owner
// 2026-09-17. Overridable in admin_settings without a deploy; this is the
// fallback so a cold or unreachable settings table cannot silently move the
// origin. NOT shipped to the browser — the server does the arithmetic now, and
// an approximate fix on someone's home does not belong in a public page.
const HOME_FALLBACK = { lat: 35.515770, lng: -97.532193 };
const HOME_SETTING_KEY = 'home_base_coords';

// Seeded from the 67 ZIPs that were hardcoded in _schedule.js, lifted verbatim.
// They stay in the code as well as the table so a cold database, or an
// unreachable lookup API, answers exactly as it does today for the metro.
const ZIP_SEED = {
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

// A ZIP is five digits. Anything else — ZIP+4, stray spaces, nulls — normalises
// to '' and is treated as unknown rather than looked up.
const normZip = (z) => {
  const s = String(z == null ? '' : z).trim().slice(0, 5);
  return /^\d{5}$/.test(s) ? s : '';
};

async function ensureZipTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zip_coords (
      zip        VARCHAR(5) PRIMARY KEY,
      lat        NUMERIC(9,6),
      lng        NUMERIC(9,6),
      source     VARCHAR(32) NOT NULL DEFAULT 'api',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

// lat/lng are NULLABLE on purpose: a row with both NULL means "we asked and the
// ZIP does not exist", which stops a typo'd ZIP re-querying the API forever. It
// is only ever written on a definitive 404 — never on a timeout or a network
// error, because caching an outage would make it permanent.

const R_MILES = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

function milesBetween(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// What we charge for travel. Lifted from booking-form.html:1155, which was the
// only place this rule existed — in client-side JavaScript, on a page the
// client can edit, computing a figure the server stored without rechecking.
//
//   round trip = one-way x 2 x 1.25   (1.25 approximates roads vs a straight line)
//   under 20 round-trip miles is free
//   otherwise $0.70 per round-trip mile, to the nearest dollar
//
// Kept byte-for-byte in behaviour so no existing quote changes its mind: the
// only thing that moves is WHERE it measures from, which was wrong by 7.43 mi.
// Beyond this, nobody drives to a gig and back — they fly, and the distance
// stops being a fact about the journey. It matters because payroll counts the
// drive TWICE in a shift (out and home): the Orlando booking measured 1,833
// minutes each way, which would have turned a 5-hour minimum call into 64 paid
// hours. So past this line we say we do not know, exactly as for a ZIP that was
// never in the table, and a human sets drive_minutes_each_way.
const MAX_DRIVEABLE_MILES = 300;

const TRAVEL = { roadFactor: 1.25, freeUnderMiles: 20, perMile: 0.70 };

function travelFor(oneWayMiles) {
  if (!isFinite(oneWayMiles) || oneWayMiles < 0) return { miles: 0, fee: 0 };
  const miles = Math.round(oneWayMiles * 2 * TRAVEL.roadFactor);
  return { miles, fee: miles > TRAVEL.freeUnderMiles ? Math.round(miles * TRAVEL.perMile) : 0 };
}

async function homeBase(client) {
  if (!client) return HOME_FALLBACK;
  try {
    const { rows } = await client.query(
      'SELECT value FROM admin_settings WHERE key = $1', [HOME_SETTING_KEY]);
    if (!rows.length) return HOME_FALLBACK;
    const parsed = JSON.parse(rows[0].value);
    const lat = Number(parsed.lat), lng = Number(parsed.lng);
    // A malformed setting must not move the origin silently.
    if (!isFinite(lat) || !isFinite(lng)) return HOME_FALLBACK;
    return { lat, lng };
  } catch {
    return HOME_FALLBACK;
  }
}

// Reads what we already know: the seed, plus whatever the table has learned.
// ONE query for many ZIPs, because the admin booking list calls this per row —
// a per-row lookup would be an N+1 on every page load.
async function loadZipCoords(client, zips) {
  const wanted = [...new Set((zips || []).map(normZip).filter(Boolean))];
  const map = new Map();
  for (const [zip, c] of Object.entries(ZIP_SEED)) map.set(zip, c);
  if (!client || !wanted.length) return map;
  try {
    const { rows } = await client.query(
      'SELECT zip, lat::float8 AS lat, lng::float8 AS lng FROM zip_coords WHERE zip = ANY($1)', [wanted]);
    // A stored NULL is the "does not exist" marker and must NOT become a
    // coordinate of (0, 0) — the Gulf of Guinea is 5,000 miles from Oklahoma
    // and would produce a confident, absurd drive time.
    for (const r of rows) if (r.lat !== null && r.lng !== null) map.set(r.zip, { lat: r.lat, lng: r.lng });
  } catch (e) {
    console.error('loadZipCoords failed, falling back to the seed:', e.message);
  }
  return map;
}

// Looks up one ZIP. Returns coordinates, null for "definitively not a ZIP", or
// undefined for "could not find out" — three outcomes, because the caller
// stores the first two and must not store the third.
async function fetchZipCoords(zip, { timeoutMs = 3000, fetchImpl } = {}) {
  const z = normZip(zip);
  if (!z) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(`https://api.zippopotam.us/us/${z}`, { signal: ac.signal });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const data = await res.json();
    const place = data && Array.isArray(data.places) ? data.places[0] : null;
    // Explicitly, because Number(null) is 0 and isFinite(0) is true: a response
    // with no places would otherwise return coordinates of (0, 0) — a point in
    // the Gulf of Guinea, 5,000 miles from Oklahoma — as a confident answer,
    // and it would be written to the table as fact. Caught by its own test.
    if (!place) return undefined;
    const lat = Number(place.latitude), lng = Number(place.longitude);
    if (!isFinite(lat) || !isFinite(lng)) return undefined;
    return { lat, lng };
  } catch {
    return undefined;   // timeout, abort, network, malformed JSON
  } finally {
    clearTimeout(timer);
  }
}

// Fills in whatever is missing and returns the complete map. This is the only
// function that reaches the network, so a read path can stay synchronous and
// cheap: callers ask for this when they are working on ONE booking, or in the
// backfill script — never inside a per-row loop.
async function ensureZipCoords(client, zips) {
  const map = await loadZipCoords(client, zips);
  const missing = [...new Set((zips || []).map(normZip).filter(Boolean))].filter((z) => !map.has(z));
  if (!missing.length || !client) return map;

  await ensureZipTable(client).catch((e) => console.error('ensureZipTable:', e.message));
  for (const zip of missing) {
    const found = await fetchZipCoords(zip);
    if (found === undefined) continue;          // could not find out — ask again next time
    try {
      await client.query(
        `INSERT INTO zip_coords (zip, lat, lng, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (zip) DO NOTHING`,
        [zip, found ? found.lat : null, found ? found.lng : null, found ? 'zippopotam' : 'not_found']);
    } catch (e) {
      console.error('zip_coords insert failed for', zip, '|', e.message);
    }
    if (found) map.set(zip, found);
  }
  return map;
}

module.exports = {
  HOME_FALLBACK, HOME_SETTING_KEY, HOME_ZIP, ZIP_SEED, TRAVEL, MAX_DRIVEABLE_MILES,
  normZip, ensureZipTable, milesBetween, travelFor,
  homeBase, loadZipCoords, fetchZipCoords, ensureZipCoords,
};
