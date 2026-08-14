// netlify/functions/sms-status.js — Twilio delivery status callback.
//
// This is the only writer of 'delivered'. sendSms() logs 'queued' because that
// is all a 201 from Twilio means: the carrier can still drop the message, and
// with incomplete 10DLC registration it routinely does. Without this endpoint
// the log would read "sent" for messages nobody ever received, and the first
// symptom would be a crew member not turning up.

const { withClient } = require('./_db');
const { ensureSmsTables } = require('./_sms');
const { verifyTwilio, parseForm } = require('./_twilio-sig');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!verifyTwilio(event, '/api/sms-status')) {
    console.error('sms-status: signature verification FAILED — request rejected');
    return { statusCode: 403, body: 'Forbidden' };
  }

  const p = parseForm(event.body);
  const sid = p.MessageSid || p.SmsSid;
  const status = p.MessageStatus || p.SmsStatus;
  if (!sid || !status) return { statusCode: 200, body: 'ignored' };

  // Twilio sends the whole lifecycle (accepted → queued → sent → delivered).
  // Only terminal states are worth recording; 'sent' from Twilio means "handed
  // to the carrier", which is exactly the claim this endpoint exists to avoid
  // believing.
  if (!['delivered', 'failed', 'undelivered'].includes(status)) {
    return { statusCode: 200, body: 'ok' };
  }

  try {
    await withClient(async (client) => {
      await ensureSmsTables(client);
      const { rowCount } = await client.query(
        `UPDATE sms_log SET status=$1, error_detail=$2, updated_at=NOW() WHERE provider_sid=$3`,
        [status, p.ErrorCode ? `Twilio error ${p.ErrorCode}` : '', sid]
      );
      if (!rowCount) console.error('sms-status: no sms_log row for SID', sid);
      else if (status !== 'delivered') console.error('SMS NOT DELIVERED:', sid, '|', status, '| code:', p.ErrorCode || 'none');
    });
  } catch (e) {
    // Returning 500 makes Twilio retry, which is what we want for a transient
    // DB blip: the update is idempotent (keyed on a unique SID).
    console.error('sms-status error:', e.message);
    return { statusCode: 500, body: 'error' };
  }

  return { statusCode: 200, body: 'ok' };
};
