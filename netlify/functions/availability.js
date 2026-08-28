// GET /api/availability?date=&time=&zip=&service_id=&exclude=&booking_id=
// Admin only. The computation lives in _availability.js so it can be imported
// by the Instant Booking gate without dragging an HTTP handler along.
//
// booking_id (not in the original plan text): the booking modal has no
// service_id field of its own — service is derived from item rows, so a bare
// service_id query param is always empty for a real booking, and every gig
// would silently be checked against spanFor's 60-minute fallback duration.
// When booking_id is present, that booking's own service_id, event_date,
// event_time and event_zip are loaded server-side and used as the basis; any
// of date/time/zip/service_id given explicitly on the query string override
// the loaded value. It also defaults `exclude` to booking_id, since a booking
// is never a conflict with itself. With no booking_id (a brand-new, unsaved
// booking) there is no service_id to load — spanFor falls back to 60 minutes
// and records that in `unknowns`, which the admin UI renders rather than the
// default being applied silently.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { conflictsFor } = require('./_availability');
const { ensureCalendarTables } = require('./calendar-feeds');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  const auth = await requireAuth(event, ['admin']); if (!auth) return unauthorized();

  const q = event.queryStringParameters || {};

  try {
    return await withClient(async (client) => {
      // calendar-feeds.js and calendar-sync.js both call this before touching
      // calendar_feeds/external_busy; this endpoint queries both (via
      // conflictsFor) but called neither, so on a fresh deploy — before the
      // cron has run or anyone has visited the Catalogue page — the tables
      // don't exist and every booking modal 500s.
      await ensureCalendarTables(client);

      let loaded = null;
      if (q.booking_id) {
        const { rows } = await client.query(
          'SELECT id, service_id, event_date, event_time, event_zip FROM bookings WHERE id=$1',
          [q.booking_id]);
        if (!rows.length) return json(404, { error: 'Booking not found.' });
        loaded = rows[0];
      }

      const booking = {
        service_id: q.service_id || loaded?.service_id || null,
        event_date: q.date || loaded?.event_date || null,
        event_time: q.time || loaded?.event_time || null,
        event_zip: q.zip || loaded?.event_zip || null,
      };
      if (!booking.event_date) return json(400, { error: 'A date is required.' });

      const excludeBookingId = q.exclude || (loaded ? loaded.id : null);
      const result = await conflictsFor(client, booking, { excludeBookingId });
      return json(200, result);
    });
  } catch (e) {
    console.error('availability error:', e.message);
    // Never 200 with an empty result on failure: the caller must be able to
    // tell "nothing found" from "could not look". The modal turns this into
    // "this date has NOT been cleared".
    return json(500, { error: 'Availability could not be checked.' });
  }
};
