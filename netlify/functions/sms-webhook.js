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
const { expressInterest, isStaffable, ensureTables: ensureStaffTables } = require('./staff-assignments');
const { fmtEventDate } = require('./_email');

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

// Role names repeat across gigs ("Foam Operator" on three different bookings
// confirmed the same afternoon), so a reply that names only the role can read
// correctly while interest landed on the wrong one. Naming the gig — service
// + compact date — makes a mis-target visible instead of silent. `booking` is
// the row for the offer's (single) booking_id, or null when nothing in the
// offer resolved to a live booking (e.g. every letter was closed).
function gigLabel(booking) {
  if (!booking || !booking.service_name) return '';
  const when = fmtEventDate(booking.event_date, { weekday: 'short', month: 'numeric', day: 'numeric', year: undefined });
  return ` for ${booking.service_name}${when ? ' on ' + when : ''}`;
}

function replyForLetters(picked, unknown, offerMap, closed = [], alreadyAssigned = [], booking = null) {
  const parts = [];
  const label = gigLabel(booking);
  if (picked.length) {
    parts.push(`Got it — you're down as interested in ${picked.map(l => offerMap[l].tag_filled).join(' and ')}${label}. Joe will confirm.`);
  }
  // A late reply to a stale offer can resolve against a role the sender was
  // already assigned to (expressInterest refuses to downgrade 'assigned'
  // rows, but it still tells the truth about what happened). Confirming
  // "interested" here would be a lie — they are already booked.
  if (alreadyAssigned.length) {
    const roles = alreadyAssigned.map(l => offerMap[l].tag_filled).join(' and ');
    parts.push(`${roles} — you're already booked${label}, no action needed.`);
  }
  if (unknown.length) {
    parts.push(`Didn't recognise ${unknown.map(l => `'${l}'`).join(', ')} — that offer had ${Object.keys(offerMap).join(', ')}.`);
  }
  if (closed.length) {
    const roles = closed.map(l => offerMap[l].tag_filled).join(' and ');
    parts.push(`${roles} — that gig's already closed, sorry.`);
  }
  // Every branch above appends only when it has something to say. If none did
  // (e.g. every letter was closed and closed.length were somehow 0 — should
  // not happen, but an empty string would mean the handler sends nothing at
  // all, the exact silent-nothing shape this exists to avoid).
  return parts.join(' ') || "Didn't catch that — reply with the letters from your gig offer.";
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
        return 'Funky Monkey Events. Reply with the letters from a gig offer to register interest, or STOP to opt out. Questions: (405) 431-6625.';
      }

      // Past the keywords, a replay would only produce a duplicate confirmation
      // text or duplicate interest row (both already idempotent downstream), so
      // here the guard is worth having — it just saves a wasted round trip.
      if (!logged && sid) {
        console.log('sms-webhook: replayed SID', sid, '— already handled');
        return null;
      }

      const offer = await latestOffer(client, from);
      if (offer && offer.offer_map) {
        const map = typeof offer.offer_map === 'string' ? JSON.parse(offer.offer_map) : offer.offer_map;
        const { picked, unknown, freeform } = parseLetters(text, map);
        if (!freeform) {
          await ensureStaffTables(client);
          const registered = [], closed = [], alreadyAssigned = [];
          // All letters in one offer_map share the same booking_id (built by
          // buildOfferMap from a single booking), so the first row fetched is
          // the row for the whole reply — kept for gigLabel().
          let bookingInfo = null;
          for (const letter of picked) {
            const { rows: [bk] } = await client.query(
              'SELECT status, service_name, event_date FROM bookings WHERE id=$1',
              [map[letter].booking_id]
            );
            // The offer_map is a frozen snapshot on purpose — it is what makes
            // "b" mean the same thing an hour later. But frozen also means it
            // can outlive the gig, so the booking's CURRENT status decides
            // whether interest expressed now still means anything.
            if (!bk || !isStaffable(bk)) { closed.push(letter); continue; }
            bookingInfo = bookingInfo || bk;
            // expressInterest never downgrades an 'assigned' row — a stale
            // offer letter replied to after Joe already assigned this person
            // must not read as a fresh "interested". Its returned row says
            // which happened.
            const row = await expressInterest(client, {
              booking_id: map[letter].booking_id,
              staff_id: offer.staff_id,
              tag_filled: map[letter].tag_filled
            });
            if (row && row.status === 'assigned') alreadyAssigned.push(letter);
            else registered.push(letter);
          }
          return replyForLetters(registered, unknown, map, closed, alreadyAssigned, bookingInfo);
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

exports.classifyInbound = classifyInbound;
exports.replyForLetters = replyForLetters;
