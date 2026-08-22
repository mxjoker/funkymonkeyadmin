// netlify/functions/sms-webhook.js — inbound SMS from Twilio.
//
// Routing, in order:
//   1. Signature check. Reject anything that fails — without it anyone with the
//      URL can opt a client out.
//   2. STOP / START / HELP, before anything else touches the message.
//   3. Everything else → logged and forwarded to Joe.
//
// Reply codes are gone (Joe, 2026-08-20: "too confusing. Just tell them to
// check the portal."). A staff member replying "a" now reaches a human instead
// of a parser, which is the point — the portal is where interest is registered,
// and it always was the only place that showed the whole gig.
//
// Always returns 200 on anything it handled. Twilio retries non-200s and the
// unique provider SID makes a replay harmless, but a retry storm is noise.

const { withClient } = require('./_db');
const { ensureSmsTables, sendSms, logSms, normalisePhone } = require('./_sms');
const { verifyTwilio, parseForm } = require('./_twilio-sig');

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
      const kind = classifyInbound(text);

      // logSms returns null for BOTH a suppressed duplicate (ON CONFLICT) and a
      // genuine write failure — a replay cannot be told from a database error.
      // STOP/START/HELP therefore run before that flag is consulted at all:
      // every one of them is idempotent (ON CONFLICT / DELETE / a static reply),
      // so re-running a true replay costs nothing, while skipping a real one —
      // e.g. a STOP that arrives during a DB hiccup — drops a legal obligation
      // and tells Twilio it was handled.
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
        return 'Funky Monkey Events. Staff: sign up for gigs in the staff portal. Reply STOP to opt out. Questions: (405) 431-6625.';
      }

      // Past the keywords, a replay would only produce a duplicate forward to
      // Joe, so the guard is worth having — it saves a wasted round trip.
      if (!logged && sid) {
        console.log('sms-webhook: replayed SID', sid, '— already handled');
        return null;
      }

      // Everything that is not a keyword is forwarded, because a text that
      // lands somewhere nobody watches is worse than no texting at all — the
      // sender reasonably assumes it was received.
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

exports.classifyInbound = classifyInbound;
