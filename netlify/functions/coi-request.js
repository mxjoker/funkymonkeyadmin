// netlify/functions/coi-request.js
// Handles Certificate of Insurance requests from clients

const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { esc, logEmail, ensureEmailLog } = require('./_email');
const { sendTemplate } = require('./automations');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Ensure coi_requests table exists
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS coi_requests (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      requested_by_email TEXT NOT NULL,
      requested_from TEXT,
      fulfilled BOOLEAN NOT NULL DEFAULT FALSE,
      fulfilled_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

exports.handler = async (event, context) => {
  const pre = preflight(event);
  if (pre) return pre;

  return withClient(async (client) => {
    try {
      await ensureTable(client);
      // logEmail INSERTs error_detail, which the ALTER inside ensureEmailLog
      // creates. Without this, a first deploy loses the COI log row silently.
      await ensureEmailLog(client);

      // ──────────────────────────────────────────────────────────
      // POST /api/coi-request — Create new COI request (public)
      // Must supply matching booking reference + client email
      // ──────────────────────────────────────────────────────────
      if (event.httpMethod === 'POST') {
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          return json(400, { error: 'Invalid JSON' });
        }
        const { reference, client_email, requested_by_email, requested_from } = body;

        if (!reference || !client_email || !requested_by_email) {
          return json(400, { error: 'reference, client_email, and requested_by_email are required' });
        }

        // Look up booking by reference AND verify client email matches (case-insensitive)
        const bookingRes = await client.query(
          `SELECT id, reference, client_name, client_email, event_date, event_time,
                  event_location, venue, service_name, event_type
           FROM bookings
           WHERE reference = $1 AND LOWER(client_email) = LOWER($2)`,
          [reference, client_email]
        );

        if (bookingRes.rows.length === 0) {
          return json(404, { error: 'Booking not found' });
        }

        const booking = bookingRes.rows[0];

        // Insert COI request
        const insertRes = await client.query(
          `INSERT INTO coi_requests (booking_id, requested_by_email, requested_from)
           VALUES ($1, $2, $3)
           RETURNING id, requested_at`,
          [booking.id, requested_by_email, requested_from || 'unknown']
        );

        const coiRequest = insertRes.rows[0];

        // ──────────────────────────────────────────────────────────
        // Email notification to Joe
        // ──────────────────────────────────────────────────────────
        const notifyEmail = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';

        // The two rows the booking may not have. Everything else the alert
        // names is a plain token on the row.
        const detailRows = [
          booking.event_time ? `<tr><td style="padding:8px 0;color:#6B7280">Event Time:</td><td style="padding:8px 0">${esc(booking.event_time)}</td></tr>` : '',
          booking.venue ? `<tr><td style="padding:8px 0;color:#6B7280">Venue:</td><td style="padding:8px 0">${esc(booking.venue)}</td></tr>` : '',
          booking.event_location ? `<tr><td style="padding:8px 0;color:#6B7280">Location:</td><td style="padding:8px 0">${esc(booking.event_location)}</td></tr>` : '',
        ].join('');

        // Send email via the 'coi_request_alert' rule. The COI request row is
        // already committed, so a failed notification must not turn the whole
        // request into a 500 — report it instead.
        let emailSent = true;
        let suppressed = false;
        try {
          const r = await sendTemplate(client, booking, 'coi_request_alert', null, {
            extra: {
              detail_rows: detailRows,
              requested_by: esc(requested_by_email),
              requested_from: esc(requested_from || 'Unknown page'),
              requested_at: esc(new Date(coiRequest.requested_at).toLocaleString('en-US', {
                dateStyle: 'full', timeStyle: 'short'
              })),
            }
          });
          emailSent = r.sent;
          suppressed = !!r.suppressed;
          if (suppressed) emailSent = false;
          if (!r.sent) console.error('COI request notification not sent —', r.error);
        } catch (e) {
          emailSent = false;
          console.error('COI request notification failed:', e.message);
        }

        return json(200, {
          success: true,
          coi_request_id: coiRequest.id,
          email_sent: emailSent,
          suppressed,
          message: emailSent
            ? 'COI request logged and notification sent'
            : suppressed
              ? `COI request logged, but the admin notification was suppressed by EMAIL_ALLOWLIST — ${notifyEmail} is not on the list`
              : 'COI request logged, but the admin notification email failed'
        });
      }

      // ──────────────────────────────────────────────────────────
      // GET /api/coi-request/:booking_id — admin only
      // ──────────────────────────────────────────────────────────
      if (event.httpMethod === 'GET') {
        const auth = await requireAuth(event, ['admin']);
        if (!auth) return unauthorized();

        const bookingId = event.path.split('/').pop();

        const result = await client.query(
          `SELECT id, booking_id, requested_at, requested_by_email,
                  requested_from, fulfilled, fulfilled_at, notes
           FROM coi_requests
           WHERE booking_id = $1
           ORDER BY requested_at DESC`,
          [bookingId]
        );

        return json(200, { requests: result.rows });
      }

      // ──────────────────────────────────────────────────────────
      // PATCH /api/coi-request/:id — admin only
      // ──────────────────────────────────────────────────────────
      if (event.httpMethod === 'PATCH') {
        const auth = await requireAuth(event, ['admin']);
        if (!auth) return unauthorized();

        const requestId = event.path.split('/').pop();
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          return json(400, { error: 'Invalid JSON' });
        }
        const { fulfilled, notes } = body;

        const updates = [];
        const values = [];
        let idx = 1;

        if (typeof fulfilled === 'boolean') {
          updates.push(`fulfilled = $${idx++}`);
          values.push(fulfilled);

          if (fulfilled) {
            updates.push(`fulfilled_at = NOW()`);
          } else {
            updates.push(`fulfilled_at = NULL`);
          }
        }

        if (notes !== undefined) {
          updates.push(`notes = $${idx++}`);
          values.push(notes);
        }

        if (updates.length === 0) {
          return json(400, { error: 'No fields to update' });
        }

        values.push(requestId);

        const result = await client.query(
          `UPDATE coi_requests
           SET ${updates.join(', ')}
           WHERE id = $${idx}
           RETURNING *`,
          values
        );

        if (result.rows.length === 0) {
          return json(404, { error: 'COI request not found' });
        }

        return json(200, { success: true, request: result.rows[0] });
      }

      return json(405, { error: 'Method not allowed' });

    } catch (err) {
      console.error('COI request error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};
