// netlify/functions/sms-webhook.js — inbound SMS from Twilio.
//
// Routing, in order:
//   1. Signature check. Reject anything that fails — without it anyone with the
//      URL can register interest as somebody else or opt a client out.
//   2. STOP / START / HELP, before any gig logic touches the message.
//   3. A staff member with a recent offer → letter parsing → expressInterest.
//   4. Everything else → logged and forwarded to Joe.
//
// Always returns 200 on anything it handled. Twilio retries non-200s, and the
// unique provider SID plus the ON CONFLICT in expressInterest make a replay
// harmless — but a retry storm is still noise.

const { withClient } = require('./_db');
const { ensureSmsTables, sendSms, logSms, normalisePhone, parseLetters } = require('./_sms');
const { verifyTwilio, parseForm } = require('./_twilio-sig');
const { expressInterest, ensureTables: ensureStaffTables } = require('./staff-assignments');

// Twilio handles these at carrier level too, but a message that arrives here
// must never reach gig logic. Keyword-only, so "can't stop thinking about it"
// is a message, not an opt-out.
const STOP_WORDS  = ['stop', 'stopall', 'unsubscribe', 'cancel', 'quit', 'end', 'revoke', 'optout'];
const START_WORDS = ['start', 'yes', 'unstop'];
const HELP_WORDS  = ['help', 'info'];

function classifyInbound(text) {
  const w = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP_WORDS.includes(w))  return 'stop';
  if (START_WORDS.includes(w)) return 'start';
  if (HELP_WORDS.includes(w))  return 'help';
  return 'message';
}

function replyForLetters(picked, unknown, offerMap) {
  const parts = [];
  if (picked.length) {
    parts.push(`Got it — you're down as interested in ${picked.map(l => offerMap[l].tag_filled).join(' and ')}. Joe will confirm.`);
  }
  if (unknown.length) {
    parts.push(`Didn't recognise ${unknown.map(l => `'${l}'`).join(', ')} — that offer had ${Object.keys(offerMap).join(', ')}.`);
  }
  return parts.join(' ');
}

// The most recent offer this number was sent. Resolving against this rather
// than the live open-gig list is the whole point: slots change, so "b" would
// otherwise mean something different two hours after the offer went out.
async function latestOffer(client, e164) {
  const { rows } = await client.query(
    `SELECT staff_id, booking_id, offer_map FROM sms_log
     WHERE phone=$1 AND direction='out' AND offer_map IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [e164]
  );
  return rows[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!verifyTwilio(event, '/api/sms-webhook')) {
    console.error('sms-webhook: signature verification FAILED — request rejected');
    return { statusCode: 403, body: 'Forbidden' };
  }

  const p = parseForm(event.body);
  const from = normalisePhone(p.From);
  const text = p.Body || '';
  const sid  = p.MessageSid || p.SmsSid || null;

  if (!from) {
    console.error('sms-webhook: unparseable sender', JSON.stringify(p.From));
    return { statusCode: 200, body: 'ok' };
  }

  try {
    const reply = await withClient(async (client) => {
      await ensureSmsTables(client);

      // Log the inbound message first, whatever it turns out to be. ON CONFLICT
      // on the unique SID means a Twilio retry does not double-log.
      const logged = await logSms(client, { direction: 'in', phone: from, body: text, provider_sid: sid, status: 'received' });
      if (!logged && sid) {
        console.log('sms-webhook: replayed SID', sid, '— already handled');
        return null;
      }

      const kind = classifyInbound(text);

      if (kind === 'stop') {
        await client.query(
          `INSERT INTO sms_optout (phone, reason) VALUES ($1,'STOP') ON CONFLICT (phone) DO NOTHING`, [from]
        );
        console.log('sms-webhook: opted out', from);
        return null; // Twilio sends its own STOP confirmation. A second one is spam.
      }

      if (kind === 'start') {
        await client.query('DELETE FROM sms_optout WHERE phone=$1', [from]);
        return "You're back on the list. Reply STOP any time to opt out.";
      }

      if (kind === 'help') {
        return 'Funky Monkey Events. Reply with the letters from a gig offer to register interest, or STOP to opt out. Questions: (405) 431-6625.';
      }

      const offer = await latestOffer(client, from);
      if (offer && offer.offer_map) {
        const map = typeof offer.offer_map === 'string' ? JSON.parse(offer.offer_map) : offer.offer_map;
        const { picked, unknown, freeform } = parseLetters(text, map);
        if (!freeform) {
          await ensureStaffTables(client);
          for (const letter of picked) {
            await expressInterest(client, {
              booking_id: map[letter].booking_id,
              staff_id: offer.staff_id,
              tag_filled: map[letter].tag_filled
            });
          }
          return replyForLetters(picked, unknown, map);
        }
      }

      // Freeform, or from someone with no open offer. Forwarded, because a text
      // that lands somewhere nobody watches is worse than no texting at all —
      // the sender reasonably assumes it was received.
      const notify = process.env.NOTIFY_SMS;
      if (notify) {
        await sendSms(client, notify, `SMS from ${from}: ${text}`.slice(0, 300), { trigger_label: 'Forwarded reply' });
      } else {
        console.error('sms-webhook: NOTIFY_SMS unset — inbound message NOT forwarded:', from, '|', text);
      }
      return null;
    });

    if (reply) {
      await withClient(c => sendSms(c, from, reply, { trigger_label: 'Reply' }));
    }
  } catch (e) {
    console.error('sms-webhook error:', e.message);
    return { statusCode: 500, body: 'error' };
  }

  return { statusCode: 200, body: 'ok' };
};

module.exports.classifyInbound = classifyInbound;
module.exports.replyForLetters = replyForLetters;
