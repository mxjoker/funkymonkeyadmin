// netlify/functions/_sms.js
// Shared SMS helper for Funky Monkey — Twilio integration

const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || '+14055551234'; // Joe's Twilio number
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

/**
 * Send SMS via Twilio
 * @param {string} to - Phone number in E.164 format (+14055551234)
 * @param {string} message - Plain text message (max 1600 chars)
 * @returns {Promise<object>} Twilio response
 */
async function sendSMS(to, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !to) {
    console.log('SMS skipped: missing credentials or recipient');
    return null;
  }

  // Normalize phone number to E.164 format
  const normalizedPhone = normalizePhone(to);
  if (!normalizedPhone) {
    console.error('Invalid phone number:', to);
    return null;
  }

  // Truncate message if too long (Twilio limit is 1600 chars)
  const truncated = message.length > 1600 
    ? message.substring(0, 1597) + '...' 
    : message;

  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const params = new URLSearchParams({
      To: normalizedPhone,
      From: TWILIO_PHONE,
      Body: truncated
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    const data = await res.json();
    
    if (data.error_code) {
      console.error('Twilio error:', data.error_message);
      return null;
    }

    console.log('SMS sent to:', normalizedPhone, '| SID:', data.sid);
    return data;
  } catch(e) {
    console.error('sendSMS error:', e.message);
    return null;
  }
}

/**
 * Normalize phone number to E.164 format
 * Assumes US numbers if no country code
 */
function normalizePhone(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // If already has country code (11+ digits)
  if (digits.length >= 11) {
    return '+' + digits;
  }
  
  // If 10 digits, assume US and add +1
  if (digits.length === 10) {
    return '+1' + digits;
  }
  
  // Invalid length
  return null;
}

/**
 * Render SMS template with booking variables
 * Returns plain text (no HTML)
 */
function renderSMS(template, booking, stripeLink) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  const dateStr = booking.event_date
    ? new Date(String(booking.event_date).split('T')[0] + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
    : 'TBD';

  let text = template
    .replace(/{{client_first_name}}/g, firstName)
    .replace(/{{client_name}}/g,       booking.client_name   || '')
    .replace(/{{service_name}}/g,      booking.service_name  || '')
    .replace(/{{event_date}}/g,        dateStr)
    .replace(/{{event_time}}/g,        booking.event_time    || '')
    .replace(/{{event_zip}}/g,         booking.event_zip     || '')
    .replace(/{{total_price}}/g,       Number(booking.total_price||0).toFixed(2))
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount||0).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due||0).toFixed(2))
    .replace(/{{reference}}/g,         booking.reference     || '');

  // Add payment link if provided
  if (stripeLink) {
    text += `\n\nPay deposit ($${Number(booking.deposit_amount||100).toFixed(2)}): ${stripeLink}`;
  }

  return text;
}

/**
 * Log SMS to sms_log table
 */
async function logSMS(client, bookingId, ruleId, triggerLabel, recipientPhone, recipientLabel, messagePreview) {
  try {
    await client.query(
      `INSERT INTO sms_log (booking_id, rule_id, trigger_label, recipient_phone, recipient_label, message_preview)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        bookingId, 
        ruleId || null, 
        triggerLabel, 
        recipientPhone, 
        recipientLabel || 'client',
        messagePreview || ''
      ]
    );
  } catch(e) {
    console.error('logSMS error:', e.message);
  }
}

/**
 * Ensure sms_log table exists
 */
async function ensureSMSLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sms_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
      rule_id INTEGER,
      trigger_label VARCHAR(100),
      recipient_phone VARCHAR(50),
      recipient_label VARCHAR(100),
      message_preview TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sms_log_booking_id 
    ON sms_log(booking_id)
  `);
}

/**
 * Unified notification function - sends via email AND/OR SMS based on preferences
 * @param {object} recipient - { email, phone, comms_preference }
 * @param {string} subject - Email subject / SMS context
 * @param {string} htmlBody - HTML email body
 * @param {string} textBody - Plain text for SMS
 * @param {object} options - { client, bookingId, ruleId, triggerLabel }
 */
async function notify(recipient, subject, htmlBody, textBody, options = {}) {
  const { sendEmail } = require('./_email');
  const { client, bookingId, ruleId, triggerLabel } = options;
  
  const preference = recipient.comms_preference || 'email';
  
  // Send email if preference is email or both
  if (['email', 'both'].includes(preference) && recipient.email) {
    await sendEmail(recipient.email, subject, htmlBody);
    if (client && bookingId) {
      const { logEmail } = require('./_email');
      await logEmail(client, bookingId, ruleId, triggerLabel, subject, recipient.email, recipient.label);
    }
  }
  
  // Send SMS if preference is SMS or both
  if (['sms', 'both'].includes(preference) && recipient.phone) {
    const preview = textBody.substring(0, 100);
    await sendSMS(recipient.phone, textBody);
    if (client && bookingId) {
      await logSMS(client, bookingId, ruleId, triggerLabel, recipient.phone, recipient.label, preview);
    }
  }
}

module.exports = { 
  sendSMS, 
  renderSMS, 
  logSMS, 
  ensureSMSLog, 
  notify,
  normalizePhone 
};
