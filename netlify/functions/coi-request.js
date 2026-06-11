// netlify/functions/coi-request.js
// Handles Certificate of Insurance requests from clients

const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { sendEmail, wrap, esc, logEmail } = require('./_email');

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

        const eventDateStr = booking.event_date
          ? new Date(String(booking.event_date).split('T')[0] + 'T00:00:00').toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            })
          : 'Not scheduled';

        const emailSubject = `COI Request — ${booking.reference} (${booking.client_name})`;

        const emailBody = `
          <h2 style="color: #7C3AED; margin-bottom: 20px;">Certificate of Insurance Requested</h2>

          <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #1F2937;">Booking Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6B7280; width: 40%;">Reference:</td>
                <td style="padding: 8px 0; font-weight: 600;">${esc(booking.reference)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Client:</td>
                <td style="padding: 8px 0; font-weight: 600;">${esc(booking.client_name)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Email:</td>
                <td style="padding: 8px 0;">${esc(booking.client_email)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Service:</td>
                <td style="padding: 8px 0;">${esc(booking.service_name)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Event Date:</td>
                <td style="padding: 8px 0; font-weight: 600;">${esc(eventDateStr)}</td>
              </tr>
              ${booking.event_time ? `
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Event Time:</td>
                <td style="padding: 8px 0;">${esc(booking.event_time)}</td>
              </tr>` : ''}
              ${booking.venue ? `
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Venue:</td>
                <td style="padding: 8px 0;">${esc(booking.venue)}</td>
              </tr>` : ''}
              ${booking.event_location ? `
              <tr>
                <td style="padding: 8px 0; color: #6B7280;">Location:</td>
                <td style="padding: 8px 0;">${esc(booking.event_location)}</td>
              </tr>` : ''}
            </table>
          </div>

          <div style="background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 16px; border-radius: 4px; margin-bottom: 20px;">
            <p style="margin: 0; color: #92400E;">
              <strong>Action Required:</strong> Client needs a Certificate of Insurance for this event.
            </p>
          </div>

          <div style="margin-bottom: 20px;">
            <h3 style="color: #1F2937;">Request Details</h3>
            <p><strong>Requested by:</strong> ${esc(requested_by_email)}</p>
            <p><strong>Requested from:</strong> ${esc(requested_from || 'Unknown page')}</p>
            <p><strong>Requested at:</strong> ${esc(new Date(coiRequest.requested_at).toLocaleString('en-US', {
              dateStyle: 'full',
              timeStyle: 'short'
            }))}</p>
          </div>

          <div style="background: #F3F4F6; padding: 16px; border-radius: 4px; margin-top: 24px;">
            <p style="margin: 0; color: #6B7280; font-size: 14px;">
              To mark this COI as fulfilled, go to the booking in your admin dashboard.
            </p>
          </div>
        `;

        // Send email via _email.js shared module
        await sendEmail(
          notifyEmail,
          emailSubject,
          wrap(emailBody)
        );

        // Log email to email_log table
        await logEmail(
          client,
          booking.id,
          null, // No automation rule for this
          'coi_request',
          emailSubject,
          notifyEmail,
          'Admin'
        );

        return json(200, {
          success: true,
          coi_request_id: coiRequest.id,
          message: 'COI request logged and notification sent'
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
