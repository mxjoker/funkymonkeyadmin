const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const geo = require('../netlify/functions/_geo.js');
const { getDriveMins } = require('../netlify/functions/_schedule.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Two sources measured from two different points and neither was chosen: the
// scheduler used ZIP 73118's centroid, booking-form.html used a pair of
// literals 7.9 miles away. Against the real base, supplied 2026-09-17, the
// scheduler was 0.50 mi out and the form — the one charging money — 7.43.
test('there is one home base and the old literals are gone', () => {
  assert.deepStrictEqual(geo.HOME_FALLBACK, { lat: 35.515770, lng: -97.532193 });
  const sched = read('netlify/functions/_schedule.js');
  assert.ok(!/const ZIP_COORDS = \{/.test(sched), 'the scheduler must not keep its own table');
  assert.ok(/require\('\.\/_geo'\)/.test(sched), 'it reads the shared one');
});

test('the seed still answers for the metro with no database at all', () => {
  assert.strictEqual(Object.keys(geo.ZIP_SEED).length, 67, 'the original 67 must survive verbatim');
  const drive = getDriveMins('73120');
  assert.ok(drive.zipKnown, 'a seeded ZIP works offline');
  assert.ok(drive.minutes > 10 && drive.minutes < 60, 'and gives a sane metro figure: ' + drive.minutes);
});

// The behaviour that must NOT change: an unknown ZIP still returns 30 minutes
// and still says so. A wrong number that announces itself was already right.
test('an unknown ZIP keeps the 30-minute fallback and admits it', () => {
  assert.deepStrictEqual(getDriveMins('74653'), { minutes: 30, zipKnown: false });
  assert.deepStrictEqual(getDriveMins(''), { minutes: 30, zipKnown: false });
  assert.deepStrictEqual(getDriveMins(null), { minutes: 30, zipKnown: false });
});

test('a ZIP the table has learned gives a real distance', () => {
  const coords = new Map([['74653', { lat: 36.6806, lng: -97.3067 }]]);
  const d = getDriveMins('74653', { coords, home: geo.HOME_FALLBACK });
  assert.ok(d.zipKnown);
  assert.ok(d.minutes > 120, 'Tonkawa is ~81 miles, not 30 minutes — got ' + d.minutes);
});

test('ZIP+4 and stray whitespace normalise rather than miss', () => {
  assert.strictEqual(geo.normZip(' 73120-1234 '), '73120');
  assert.strictEqual(geo.normZip('abcde'), '');
  assert.strictEqual(geo.normZip(null), '');
});

// The travel rule, lifted from booking-form.html:1155. Behaviour must be
// identical — only the origin moves.
test('the travel rule matches the public form, including the free radius', () => {
  assert.deepStrictEqual(geo.travelFor(78.2), { miles: 196, fee: 137 });
  assert.deepStrictEqual(geo.travelFor(8), { miles: 20, fee: 0 }, 'exactly 20 is still free');
  assert.deepStrictEqual(geo.travelFor(8.5), { miles: 21, fee: 15 }, 'just over is charged');
  assert.deepStrictEqual(geo.travelFor(0), { miles: 0, fee: 0 });
  assert.deepStrictEqual(geo.travelFor(-5), { miles: 0, fee: 0 }, 'nonsense in, zero out');
});

// Three outcomes, not two: found, definitely-not-a-ZIP, and could-not-find-out.
// Conflating the last two is how an outage would poison the cache permanently.
test('a 404 is a definitive answer and an outage is not', async () => {
  const notFound = await geo.fetchZipCoords('00000', { fetchImpl: async () => ({ status: 404, ok: false }) });
  assert.strictEqual(notFound, null, '404 means the ZIP does not exist');

  const down = await geo.fetchZipCoords('73120', { fetchImpl: async () => ({ status: 503, ok: false }) });
  assert.strictEqual(down, undefined, 'a 503 must not be cached as "no such ZIP"');

  const threw = await geo.fetchZipCoords('73120', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.strictEqual(threw, undefined, 'a network error is not an answer');

  const junk = await geo.fetchZipCoords('73120', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.strictEqual(junk, undefined, 'a malformed body is not an answer either');

  const ok = await geo.fetchZipCoords('73120', { fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ places: [{ latitude: '35.5', longitude: '-97.6' }] }) }) });
  assert.deepStrictEqual(ok, { lat: 35.5, lng: -97.6 });
});

test('only a definitive answer is ever written to the table', () => {
  const src = read('netlify/functions/_geo.js');
  const fn = src.split('async function ensureZipCoords')[1];
  assert.ok(/if \(found === undefined\) continue;/.test(fn),
    'a failed lookup must write nothing, so it is retried rather than cached as missing');
});

// A stored NULL means "asked, does not exist". Read back as a coordinate it
// would become (0, 0) — the Gulf of Guinea, 5,000 miles away, and a confident
// absurd drive time.
test('a not_found row never becomes coordinates of zero', async () => {
  const client = { query: async () => ({ rows: [{ zip: '00000', lat: null, lng: null }] }) };
  const map = await geo.loadZipCoords(client, ['00000']);
  assert.ok(!map.has('00000'), 'a null row must be absent from the map, not present as 0,0');
});

test('a database failure falls back to the seed rather than throwing', async () => {
  const client = { query: async () => { throw new Error('connection terminated'); } };
  const map = await geo.loadZipCoords(client, ['73120']);
  assert.ok(map.has('73120'), 'the seed still answers when the table is unreachable');
});

test('a malformed home base setting does not silently move the origin', async () => {
  const bad = { query: async () => ({ rows: [{ value: 'not json' }] }) };
  assert.deepStrictEqual(await geo.homeBase(bad), geo.HOME_FALLBACK);
  const partial = { query: async () => ({ rows: [{ value: '{"lat":"abc","lng":-97.5}' }] }) };
  assert.deepStrictEqual(await geo.homeBase(partial), geo.HOME_FALLBACK);
  const good = { query: async () => ({ rows: [{ value: '{"lat":36,"lng":-97}' }] }) };
  assert.deepStrictEqual(await geo.homeBase(good), { lat: 36, lng: -97 });
});

// Read paths must not depend on a third-party API being up, and must not query
// per row: bookings.js calls getDriveMins once per booking when rendering the
// admin list.
test('the list path loads coordinates once and never reaches the network', () => {
  const src = read('netlify/functions/bookings.js');
  const block = src.split('const itemMap = await getItemsForBookings')[1].split('return json(200, rows)')[0];
  assert.ok(/loadZipCoords\(client, rows\.map/.test(block), 'one batch query for the whole page');
  assert.ok(!/ensureZipCoords/.test(block), 'the list must never trigger a lookup');
  const perRow = block.split('for (const r of rows)')[1];
  assert.ok(!/await/.test(perRow), 'nothing awaited inside the row loop');
});

test('payroll loads coordinates once per run, not per assignment', () => {
  const src = read('netlify/functions/payroll.js');
  assert.ok(/coords: await loadZipCoords\(client, assignments\.map/.test(src));
  assert.ok(!/ensureZipCoords/.test(src), 'a payroll run must not depend on a third-party lookup');
});

test('scheduling one booking may fill its ZIP, and survives the attempt failing', () => {
  const src = read('netlify/functions/_schedule.js');
  const fn = src.split('async function spanFor')[1];
  assert.ok(/ensureZipCoords\(client, \[booking\.event_zip\]\)/.test(fn), 'one booking is the right place to spend a lookup');
  assert.ok(/\.catch\(/.test(fn), 'a failed lookup must not break scheduling');
});

// The travel endpoint and its button.
test('the travel endpoint is admin-only and writes nothing to the booking', () => {
  const src = read('netlify/functions/travel.js');
  assert.ok(/requireAuth\(event, \['admin'\]\)/.test(src));
  assert.ok(!/UPDATE bookings|INSERT INTO bookings/.test(src), 'it answers a question, it does not edit a quote');
  assert.ok(/known: false/.test(src), 'an unlocatable ZIP is a real answer, distinct from zero miles');
});

test('pressing Calculate travel twice does not double the charge', () => {
  const src = read('admin.html');
  const fn = src.split('async function calcTravel')[1].split('\n}')[0];
  assert.ok(/kind\.value === 'travel'\) row\.remove\(\)/.test(fn),
    'existing travel rows must be replaced — rollupItems sums them all into mileage_cost');
  assert.ok(!/apiFetch\('\/api\/booking/.test(fn), 'it fills the row; the admin still presses Save');
});

// ── The flown-to gig ────────────────────────────────────────────────────────
// A shift counts the drive TWICE, out and home. Orlando measured 1,833 minutes
// each way, which turns a 5-hour minimum call into 64 paid hours. Before the
// zip_coords table existed these ZIPs were simply unknown and got 30 minutes;
// making them "known" without this cap would have been a payroll bug, not a
// scheduling improvement.
test('a gig too far to drive reports unknown rather than a huge drive', () => {
  const far = new Map([['32821', { lat: 28.3852, lng: -81.5639 }]]);   // Orlando
  const d = getDriveMins('32821', { coords: far, home: geo.HOME_FALLBACK });
  assert.strictEqual(d.zipKnown, false, 'payroll must keep treating it as an estimate');
  assert.strictEqual(d.minutes, 30, 'and keep the same figure it used before');
  assert.strictEqual(d.tooFarToDrive, true, 'while saying WHY it is unknown');
});

test('the cap does not catch a long but real drive', () => {
  const guymon = new Map([['73942', { lat: 36.6828, lng: -101.4816 }]]);  // ~250 mi, Oklahoma panhandle
  const d = getDriveMins('73942', { coords: guymon, home: geo.HOME_FALLBACK });
  assert.strictEqual(d.zipKnown, true, 'a 250-mile drive is a drive');
  assert.ok(d.minutes > 300, 'and it is a long one: ' + d.minutes);
});

test('payroll still treats a too-far gig as a guess', () => {
  const src = read('netlify/functions/payroll.js');
  assert.ok(/a\.drive_minutes_each_way == null && !driveInfo\.zipKnown/.test(src),
    'the existing guess rule keys on zipKnown, which the cap deliberately sets false');
});

test('the travel endpoint refuses to price a flight by the mile', () => {
  const src = read('netlify/functions/travel.js');
  assert.ok(/if \(oneWay > MAX_DRIVEABLE_MILES\)/.test(src));
  assert.ok(/driveable: false/.test(src), 'and says so in a way the UI can act on');
  const admin = read('admin.html');
  assert.ok(/data\.driveable === false\) return say/.test(admin), 'the button must add nothing in that case');
});

test('the scheduler explains which kind of unknown it hit', () => {
  const src = read('netlify/functions/_schedule.js');
  assert.ok(/too far to drive to; set the drive minutes by hand/.test(src));
  assert.ok(/is not in the table/.test(src), 'the original wording stays for a genuinely unknown ZIP');
});
