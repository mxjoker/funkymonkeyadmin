// netlify/functions/refund.js
// Handle Stripe refunds for bookings

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { esc, sendEmail, wrap, logChange } = require('./_email');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Ensure refunds table exists
async function ensureRefundsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS refunds (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      stripe_refund_id VARCHAR(255),
      amount NUMERIC(10,2) NOT NULL,
      reason VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      refunded_by VARCHAR(100) DEFAULT 'admin',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_refunds_booking_id
    ON refunds(booking_id)
  `);
}

/**
 * Process a refund through Stripe
 * @param {string} paymentIntentId - Stripe Payment Intent ID
 * @param {number} amount - Amount to refund in cents
 * @param {string} reason - Refund reason
 */
async function processStripeRefund(paymentIntentId, amount, reason) {
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) {
    throw new Error('Stripe not configured');
  }

  const params = new URLSearchParams({
    payment_intent: paymentIntentId,
    amount: String(Math.round(amount)), // Amount in cents
    reason: reason || 'requested_by_customer'
  });

  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Stripe refund error:', data.error);
    throw new Error(data.error?.message || 'Stripe refund failed');
  }

  return data;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Admin token required
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { booking_id, amount, reason, refund_type } = body;

  if (!booking_id || !amount) {
    return json(400, { error: 'booking_id and amount are required' });
  }

  return withClient(async (client) => {
    try {
      await ensureRefundsTable(client);

      // Get booking details
      const bookingRes = await client.query(
        'SELECT * FROM bookings WHERE id = $1',
        [booking_id]
      );

      if (bookingRes.rows.length === 0) {
        return json(404, { error: 'Booking not found' });
      }

      const booking = bookingRes.rows[0];
      const amountCents = Math.round(Number(amount) * 100);

      // Determine refund type and limits
      let maxRefundAmount;
      let refundDescription;

      if (refund_type === 'deposit') {
        maxRefundAmount = Number(booking.deposit_amount || 0);
        refundDescription = 'Deposit refund';
      } else if (refund_type === 'partial') {
        maxRefundAmount = Number(booking.total_price || 0);
        refundDescription = 'Partial refund';
      } else {
        // Full refund
        maxRefundAmount = Number(booking.total_price || 0);
        refundDescription = 'Full refund';
      }

      // Validate refund amount
      if (Number(amount) > maxRefundAmount) {
        return json(400, {
          error: `Refund amount ($${amount}) exceeds maximum allowed ($${maxRefundAmount})`
        });
      }

      // Check if we have a Stripe payment intent to refund
      if (!booking.stripe_payment_intent_id) {
        // Manual payment — log the refund without Stripe
        const result = await client.query(
          `INSERT INTO refunds (booking_id, amount, reason, status, refunded_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [booking_id, amount, reason || refundDescription, 'manual', 'admin']
        );

        await logChange(
          client,
          booking_id,
          'Refund processed (manual)',
          `$${Number(amount).toFixed(2)} - ${reason || refundDescription}`
        );

        return json(200, {
          success: true,
          refund: result.rows[0],
          path: 'manual',
          message: 'Manual refund logged (no Stripe payment intent on record). Process refund outside of system (check, Venmo, etc.)'
        });
      }

      // Process Stripe refund (stripe_payment_intent_id is set — from webhook)
      try {
        const stripeRefund = await processStripeRefund(
          booking.stripe_payment_intent_id,
          amountCents,
          reason || refundDescription
        );

        // Record refund in database
        const result = await client.query(
          `INSERT INTO refunds (booking_id, stripe_refund_id, amount, reason, status, refunded_by, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           RETURNING *`,
          [
            booking_id,
            stripeRefund.id,
            amount,
            reason || refundDescription,
            stripeRefund.status, // 'succeeded', 'pending', 'failed'
            'admin'
          ]
        );

        await logChange(
          client,
          booking_id,
          'Refund processed',
          `$${Number(amount).toFixed(2)} via Stripe - ${reason || refundDescription}`
        );

        // Send confirmation email — failure must not fail the refund response
        try {
          const emailHTML = `
            <h2>Refund Processed</h2>
            <p>Hi ${esc(booking.client_name || 'there')},</p>
            <p>Your refund has been processed:</p>
            <ul>
              <li><strong>Amount:</strong> $${Number(amount).toFixed(2)}</li>
              <li><strong>Booking:</strong> ${esc(booking.service_name)} on ${booking.event_date}</li>
              <li><strong>Reference:</strong> ${esc(booking.reference)}</li>
            </ul>
            <p>The refund should appear in your account within 5-10 business days.</p>
            <p>If you have any questions, please don't hesitate to contact us.</p>
            <p>Thank you,<br>Funky Monkey Events</p>
          `;

          await sendEmail(
            booking.client_email,
            `Refund Processed - ${booking.reference}`,
            wrap(emailHTML)
          );
        } catch(emailError) {
          console.error('Refund confirmation email failed:', emailError.message);
        }

        return json(200, {
          success: true,
          refund: result.rows[0],
          stripe_refund: stripeRefund,
          path: 'stripe',
          message: `Refund of $${Number(amount).toFixed(2)} processed successfully via Stripe`
        });

      } catch(stripeError) {
        // Stripe refund failed — log as failed
        await client.query(
          `INSERT INTO refunds (booking_id, amount, reason, status, refunded_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [booking_id, amount, reason || refundDescription, 'failed', 'admin']
        );

        console.error('Stripe refund failed:', stripeError.message);
        return json(500, {
          error: 'Stripe refund failed',
          path: 'stripe'
        });
      }

    } catch(err) {
      console.error('Refund error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};
