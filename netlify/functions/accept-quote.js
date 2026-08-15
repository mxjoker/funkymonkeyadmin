// netlify/functions/accept-quote.js
// Client-facing quote acceptance. Authenticated the same way my-booking.html
// already authenticates everything else: booking reference + the client email
// stored on that booking. No admin token, no session.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const {
  wrap, esc, sendEmail, logEmail, logStatus, logChange,
  ensureEmailLog, ensureBookingChanges,
} = require('./_email');
const { triggerStatusChange } = require('./automations');
const { ensureBookingItems, getItems } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

/**
 * Decide what a conditional `UPDATE … WHERE status='quoted'` means.
 *
 * Pure so it can be tested without a database, and separate so the "did it
 * actually change anything" question has one answer. rowCount 0 means the WHERE
 * did not match — it must never read as a successful transition.
 *
 * @param {{rowCount: number, current: string}} r
 */
function acceptOutcome(r) {
  if (r.rowCount === 1) return { statusCode: 200, body: { success: true, status: 'accepted' } };
  if (r.current === 'accepted') return { statusCode: 200, body: { success: true, status: 'accepted', already: true } };
  return {
    statusCode: 409,
    body: {
      error: `This booking is '${r.current}' and cannot be accepted. Only a quoted booking can be.`,
      status: r.current,
    },
  };
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const reference = String(body.reference || '').trim().toUpperCase();
  const email = String(body.client_email || '').trim().toLowerCase();
  if (!reference || !email) return json(400, { error: 'reference and client_email are required' });

  return withClient(async (c) => {
    try {
      await ensureEmailLog(c);
      await ensureBookingChanges(c);
      await ensureBookingItems(c);

      // Authenticate: reference AND matching email, or 404 without revealing
      // whether the reference exists. Same shape as bookings.js:194.
      const { rows: found } = await c.query(
        'SELECT id, reference, status, client_name, client_email, event_date, total_price, balance_due, deposit_amount FROM bookings WHERE reference = $1',
        [reference]
      );
      if (!found.length) return json(404, { error: 'Booking not found' });
      if ((found[0].client_email || '').toLowerCase() !== email) return json(404, { error: 'Booking not found' });

      const booking = found[0];

      // Conditional update — the WHERE is the guard. A read-then-write would
      // race two clicks into two acceptances and two notification emails.
      const upd = await c.query(
        `UPDATE bookings SET status='accepted', updated_at=NOW()
         WHERE id=$1 AND status='quoted' RETURNING *`,
        [booking.id]
      );

      const outcome = acceptOutcome({ rowCount: upd.rowCount, current: booking.status });
      if (outcome.statusCode !== 200) return json(409, outcome.body);
      if (outcome.body.already) return json(200, { ...outcome.body, reference: booking.reference });

      const updated = upd.rows[0];
      await logChange(c, booking.id, 'Status changed', `quoted → accepted`);
      await logChange(c, booking.id, 'Quote accepted by client', `via my-booking.html by ${email}`);

      const items = await getItems(c, booking.id);
      const lines = items.length
        ? items.map(i => `<li>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''} — $${(Number(i.price) * Math.max(1, i.quantity)).toFixed(2)}</li>`).join('')
        : `<li>${esc(updated.service_name || 'Service')} — $${Number(updated.service_price || 0).toFixed(2)}</li>`;

      const dateStr = updated.event_date
        ? new Date(String(updated.event_date).split('T')[0] + 'T00:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : 'TBD';

      // Owner notification. Plain background colour, never a gradient — Gmail
      // strips linear-gradient and test/_email.test.js scans for it.
      const subject = `✅ Quote ACCEPTED — ${updated.reference} — ${updated.client_name || 'client'}`;
      const html = wrap(`
        <h2>Quote accepted</h2>
        <p><strong>${esc(updated.client_name || 'A client')}</strong> just accepted their quote from the booking page.</p>
        <p><strong>Ref:</strong> ${esc(updated.reference)}</p>
        <p><strong>Date:</strong> ${dateStr}</p>
        <ul>${lines}</ul>
        <p><strong>Total:</strong> $${Number(updated.total_price || 0).toFixed(2)}</p>
        <p><strong>Deposit to collect:</strong> $${Number(updated.deposit_amount || 0).toFixed(2)}</p>
        <p>Next step: send the deposit link.</p>
        <br/>
        <a href="${SITE}/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>
      `);

      // sendEmail throws on failure. The status change has already committed
      // and is the thing that matters — a failed notification must not undo it
      // or 500 the client. Log the real outcome either way.
      try {
        const res = await sendEmail(NOTIFY, subject, html);
        await logEmail(c, booking.id, null, 'Quote accepted', subject, NOTIFY, 'admin', logStatus(res));
      } catch (e) {
        console.error('accept-quote notify failed:', e.message);
        await logEmail(c, booking.id, null, 'Quote accepted', subject, NOTIFY, 'admin', 'failed', e.message);
      }

      // Any admin-configured rules for the 'accepted' rung fire too. This is
      // additive — there are none today, and it costs one indexed query.
      await triggerStatusChange(c, updated, 'accepted', updated.stripe_payment_link || null);

      return json(200, { success: true, status: 'accepted', reference: updated.reference });
    } catch (e) {
      console.error('accept-quote error:', e.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

exports.acceptOutcome = acceptOutcome;
