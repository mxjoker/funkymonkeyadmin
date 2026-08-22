// netlify/functions/accept-quote.js
// Client-facing quote acceptance. Authenticated the same way my-booking.html
// already authenticates everything else: booking reference + the client email
// stored on that booking. No admin token, no session.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const {
  esc, logChange,
  ensureEmailLog, ensureBookingChanges, } = require('./_email');
const { triggerStatusChange } = require('./automations');
const { ensureBookingItems, getItems } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

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
        // A discount is stored positive and subtracted by rollupItems, so it
        // prints with its sign here or the list will not add up to the total
        // underneath it.
        ? items.map(i => `<li>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''} — ${i.kind === 'discount' ? '-' : ''}$${(Number(i.price) * Math.max(1, i.quantity)).toFixed(2)}</li>`).join('')
        : `<li>${esc(updated.service_name || 'Service')} — $${Number(updated.service_price || 0).toFixed(2)}</li>`;

      // Owner notification. Wording lives in the 'quote_accepted_alert' rule;
      // the line items do not, because they are what the client just agreed to.
      //
      // sendTemplate throws nothing on a send failure — the status change has
      // already committed and is the thing that matters, so a failed
      // notification must not undo it or 500 the client. It logs either way.
      try {
        const r = await sendTemplate(c, updated, 'quote_accepted_alert', null,
          { extra: { quote_lines: lines } });
        if (!r.sent) console.error('accept-quote notify failed:', r.error);
      } catch (e) {
        console.error('accept-quote notify failed:', e.message);
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
