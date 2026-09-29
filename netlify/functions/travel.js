// GET /api/travel?zip=74653 — how far a gig is, and what travel costs.
//
// Why this exists: the travel rule lived ONLY in booking-form.html's browser
// JavaScript, so the public form quoted a fee and the server stored whatever
// number the browser sent, while an admin entering a booking by hand got no
// calculator at all. Booking 26-151 (Tonkawa, 81 miles) was charged $0 travel
// for exactly that reason — not because its ZIP was missing, but because
// nothing on the admin side has ever computed this.
//
// The arithmetic is _geo.quoteTravel, the same call bookings.js makes when a
// public booking is created, so the fee the form shows is the fee we store.
//
// Public since 2026-09-28: the booking form asks it for the quote. It reaches
// zippopotam and may store one zip_coords row per ZIP asked about, which is
// bounded by the number of five-digit ZIPs; nothing else is written.
//
// This ANSWERS a question; it never writes to a booking. The admin presses
// Save, as with any other money field — a travel fee that changed itself when
// somebody opened a record would be a quote editing itself.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const { quoteTravel, normZip } = require('./_geo');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const zip = normZip((event.queryStringParameters || {}).zip);
  if (!zip) return json(400, { error: 'A five-digit ZIP is required' });

  return withClient(async (client) => {
    const q = await quoteTravel(client, zip);
    // An unknown ZIP is a real answer, not an error: the caller must be able to
    // tell it apart from "zero miles away".
    const message = !q.known
      ? 'That ZIP could not be located, so travel has to be entered by hand.'
      : !q.driveable
        ? 'That is ' + q.one_way_miles + ' miles away — too far to drive, so travel has to be priced by hand.'
        : undefined;
    return json(200, { zip, ...q, message });
  });
};
