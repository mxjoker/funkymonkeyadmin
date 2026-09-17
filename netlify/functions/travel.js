// GET /api/travel?zip=74653 — how far a gig is, and what travel costs.
//
// Why this exists: the travel rule lived ONLY in booking-form.html's browser
// JavaScript, so the public form quoted a fee and the server stored whatever
// number the browser sent, while an admin entering a booking by hand got no
// calculator at all. Booking 26-151 (Tonkawa, 81 miles) was charged $0 travel
// for exactly that reason — not because its ZIP was missing, but because
// nothing on the admin side has ever computed this.
//
// The arithmetic is _geo.travelFor, shared with everything else, measured from
// the one home base in admin_settings rather than from a pair of literals.
//
// This ANSWERS a question; it never writes to a booking. The admin presses
// Save, as with any other money field — a travel fee that changed itself when
// somebody opened a record would be a quote editing itself.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { ensureZipCoords, homeBase, milesBetween, travelFor, normZip, MAX_DRIVEABLE_MILES } = require('./_geo');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  // Admin only. It reaches a third-party API and writes to zip_coords, so it is
  // not something an anonymous caller should be able to drive.
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const zip = normZip((event.queryStringParameters || {}).zip);
  if (!zip) return json(400, { error: 'A five-digit ZIP is required' });

  return withClient(async (client) => {
    const [coords, home] = await Promise.all([
      ensureZipCoords(client, [zip]),
      homeBase(client),
    ]);
    const dest = coords.get(zip);
    if (!dest) {
      // Not an error: an unknown ZIP is a real answer, and the caller must be
      // able to tell it apart from "zero miles away".
      return json(200, { zip, known: false, miles: null, fee: null,
        message: 'That ZIP could not be located, so travel has to be entered by hand.' });
    }
    const oneWay = milesBetween(home, dest);
    // Past the driveable limit the per-mile rule stops applying: Orlando is
    // 1,100 miles, which would offer to add a $1,900 travel line to a gig
    // somebody flies to. Answer honestly and let a human price it.
    if (oneWay > MAX_DRIVEABLE_MILES) {
      return json(200, { zip, known: true, driveable: false,
        one_way_miles: Math.round(oneWay), miles: null, fee: null,
        message: 'That is ' + Math.round(oneWay) + ' miles away — too far to drive, so travel has to be priced by hand.' });
    }
    const { miles, fee } = travelFor(oneWay);
    return json(200, {
      zip, known: true, driveable: true,
      one_way_miles: Math.round(oneWay * 10) / 10,
      miles, fee,
    });
  });
};
