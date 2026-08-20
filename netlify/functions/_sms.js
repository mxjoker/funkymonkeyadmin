// netlify/functions/_sms.js — the one door to Twilio.
//
// Mirrors _email.js on purpose: a single sender means opt-out and quiet hours
// are enforced in one place rather than at nine call sites, and the log is
// complete because nothing else can send.
//
// A previous _sms.js was deleted in 90e3dc7 as an unused sender. It is not
// being resurrected — it returned null on every error path, so a caller could
// not tell a delivered message from a missing API key. This one returns a
// status for every outcome and writes a row for every one of them.

const { fmtEventDate, reviewLinkFor, finaliseLinkFor, rowTokens, stripTags, applyExtra } = require('./_email');
const { balanceCharge, SERVICE_FEE_RATE } = require('./_items');

const TZ = 'America/Chicago';

// ── Phone normalisation ──────────────────────────────────────────────────────
// Load-bearing: applied on send AND on inbound lookup. If the two ever disagree
// a reply stops matching the person who sent it, and nothing errors.
//
// Deliberately strict. The old version did `if (digits.length >= 11) return
// '+' + digits`, which turned a mistyped 14-digit string into a valid-looking
// E.164 number — texting a stranger a client's address rather than failing.
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// ── Quiet hours ──────────────────────────────────────────────────────────────
// 8am–9pm Central. Intl rather than a fixed offset: Oklahoma is UTC-5 in summer
// and UTC-6 in winter, so a hardcoded offset is an hour wrong for four months
// of the year — in the direction of texting people at 7am.
// hourCycle 'h23' rather than hour12:false, which yields "24" for midnight on
// some ICU builds.
function centralHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hourCycle: 'h23'
  }).format(date));
}

function isQuietHours(date = new Date()) {
  const h = centralHour(date);
  return h < 8 || h >= 21;
}

// ── Plain-text template renderer ─────────────────────────────────────────────
// Same token names as _email.js render(), but NOT the same function: render()
// runs every value through esc(), so "O'Brien" would arrive as "O&#39;Brien",
// and its {{deposit_link}} is a whole <div>. Same vocabulary, different medium.
function renderSms(template, booking = {}, link, extra) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  const derived = rowTokens(booking);
  return applyExtra(String(template || '')
    .replace(/{{client_first_name}}/g, firstName)
    .replace(/{{client_name}}/g,       booking.client_name || '')
    .replace(/{{guests_of_honour}}/g,  booking.guests_of_honour || booking.child_name || 'everyone')
    .replace(/{{child_name}}/g,        booking.child_name || '')
    .replace(/{{review_link}}/g,       reviewLinkFor(booking))
    .replace(/{{service_name}}/g,      booking.service_name || '')
    .replace(/{{event_date}}/g,        fmtEventDate(booking.event_date, { weekday: 'short', month: 'numeric', day: 'numeric' }) || 'TBD')
    .replace(/{{event_time}}/g,        booking.event_time || '')
    .replace(/{{event_zip}}/g,         booking.event_zip  || '')
    .replace(/{{total_price}}/g,       Number(booking.total_price   || 0).toFixed(2))
    // NOT `|| 100`. Schools and libraries book with deposit_amount = 0 and must
    // never be texted a demand for money the booking does not want.
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount || 0).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due    || 0).toFixed(2))
    // Same three tokens render() resolves: the rule editor shows both bodies
    // side by side and copy moves between them.
    .replace(/{{service_fee}}/g,       balanceCharge(booking).fee.toFixed(2))
    .replace(/{{balance_total}}/g,     balanceCharge(booking).total.toFixed(2))
    .replace(/{{service_fee_pct}}/g,   String(Math.round(SERVICE_FEE_RATE * 100)))
    .replace(/{{reference}}/g,         booking.reference || '')
    // For the admin's own alerts: which status the booking is in, and whether
    // any money has actually arrived. An unstaffed gig that is merely
    // 'accepted' with no deposit is a different problem from a paid, confirmed
    // one with nobody on it, and the text should say which.
    .replace(/{{status}}/g,            booking.status || '')
    .replace(/{{deposit_state}}/g,     booking.deposit_paid === true ? 'deposit paid' : 'no deposit yet')
    // Falls back to the booking's own deposit link. The three scheduled loops
    // in automations.js call sendAutomationMessage(..., booking, null), so on a
    // days_before/days_after rule `link` is null and this token used to render
    // as an empty string — a text reading "pay here:" with nothing after it,
    // and no error anywhere. The link is already on the row; read it.
    .replace(/{{payment_link}}/g,      link || booking.stripe_payment_link || '')
    // NOT the same link. stripe_payment_link is the DEPOSIT; a deposit link
    // stays live and re-payable after the balance is settled, so texting it to
    // someone 7 days out — who has almost certainly already paid their deposit
    // — bills them a second time. A balance-due message must use this token.
    .replace(/{{balance_link}}/g,      booking.stripe_balance_link || '')
    // {{deposit_link}} is render()'s token, not this one's — but the rule
    // editor shows both bodies side by side, so a body written for email can
    // get pasted into the SMS box. An HTML button is meaningless in a text
    // message, so resolve it to the same raw URL rather than leaving a
    // literal "{{deposit_link}}" in the text.
    .replace(/{{deposit_link}}/g,      link || booking.stripe_payment_link || '')
    // The same row tokens render() resolves. The two list-shaped ones arrive
    // as HTML there and as plain text here — an <li> in a text message is
    // gibberish, and leaving the literal token would be worse than either.
    .replace(/{{client_email}}/g,      booking.client_email    || '')
    .replace(/{{client_phone}}/g,      booking.client_phone    || '')
    .replace(/{{event_location}}/g,    booking.event_location  || '')
    .replace(/{{event_type}}/g,        booking.event_type      || '')
    .replace(/{{guest_count}}/g,       String(booking.guest_count ?? ''))
    .replace(/{{service_price}}/g,     Number(booking.service_price || 0).toFixed(2))
    .replace(/{{mileage_cost}}/g,      Number(booking.mileage_cost  || 0).toFixed(2))
    .replace(/{{notes}}/g,             booking.notes           || '')
    .replace(/{{referral_source}}/g,   booking.referral_source || '')
    .replace(/{{location_label}}/g,    derived.location_label)
    .replace(/{{event_datetime}}/g,    derived.event_datetime)
    .replace(/{{addon_list}}/g,        stripTags(derived.addon_list))
    .replace(/{{mileage_line}}/g,      stripTags(derived.mileage_line))
    .replace(/{{admin_link}}/g,        'https://funkymonkeyadmin.netlify.app/admin.html')
    .replace(/{{finalise_link}}/g,     finaliseLinkFor(booking)), extra);
}

// ── GSM-7 encoding ──────────────────────────────────────────────────────────
// SMS segment size depends on the alphabet, not the character count: GSM-7 is
// 153 chars per concatenated segment, but ONE character outside it pushes the
// whole message to UCS-2 at 67. A single "·" or "—" therefore doubles the
// segment count of an otherwise short message — invisibly, because nothing
// about the string looks wrong.
//
// Applied inside sendSms so every template is covered, including ones later
// tasks add. Transliteration changes glyphs, never meaning: an em dash reads
// as a hyphen and nobody notices. Anything not on this list is left alone and
// simply sends as UCS-2 — we do not mangle text we do not understand.
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';  // each of these costs two GSM-7 characters

const SMART_PUNCTUATION = [
  [/[–—]/g, '-'],    // en dash, em dash
  [/['']/g, "'"],    // curly single quotes
  [/[""]/g, '"'],    // curly double quotes
  [/…/g, '...'],          // ellipsis
  [/·/g, '-'],            // middle dot
  [/ /g, ' '],            // non-breaking space
];

function toGsm7(text) {
  return SMART_PUNCTUATION.reduce((s, [re, to]) => s.replace(re, to), String(text ?? ''));
}

// Segments the message will actually cost. Exported so tests can assert the
// real budget rather than a character count that does not imply it.
function smsSegments(text) {
  const s = String(text ?? '');
  let units = 0, gsm = true;
  for (const ch of s) {
    if (GSM7_BASIC.includes(ch)) units += 1;
    else if (GSM7_EXTENDED.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    const u16 = s.length;                       // UCS-2 counts UTF-16 code units
    return u16 <= 70 ? 1 : Math.ceil(u16 / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

// ── Letter reply parsing ─────────────────────────────────────────────────────
// An offer lists roles as lettered options; a reply may combine them ("ac").
// Resolved against the offer_map stored on THAT outbound message, never against
// the live open-gig list — otherwise "b" means something different two hours
// later, because slots change.
//
// ponytail: a reply of more than MAX_PICK letters is treated as prose and
// forwarded to Joe rather than parsed. Offers never carry more than a handful
// of roles, and "sorry can't make it" must not come back as
// "Didn't recognise 's','o','r','y'". Raise MAX_PICK if offers ever get longer.
const MAX_PICK = 6;

function parseLetters(reply, offerMap) {
  const valid = Object.keys(offerMap || {});
  const letters = String(reply || '').toLowerCase().replace(/[^a-z]/g, '');
  const picked = [], unknown = [], seen = new Set();

  if (!letters || letters.length > MAX_PICK) return { picked, unknown, freeform: true };

  for (const ch of letters) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    (valid.includes(ch) ? picked : unknown).push(ch);
  }
  // Nothing recognised at all — this is prose, not a mistyped selection.
  if (!picked.length) return { picked: [], unknown: [], freeform: true };
  return { picked, unknown, freeform: false };
}

// ── Tables ───────────────────────────────────────────────────────────────────
// Both mirror email_log. provider_sid is UNIQUE, which is what makes a replayed
// webhook idempotent; it is nullable because held / skipped rows never got one,
// and Postgres permits many NULLs under a UNIQUE constraint.
let smsSchemaReady;
async function ensureSmsTables(client) {
  if (!smsSchemaReady) {
    smsSchemaReady = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS sms_log (
          id SERIAL PRIMARY KEY,
          direction VARCHAR(8) NOT NULL DEFAULT 'out',
          phone VARCHAR(32) NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          booking_id INTEGER,
          staff_id INTEGER,
          rule_id INTEGER,
          trigger_label VARCHAR(255) DEFAULT '',
          provider_sid VARCHAR(64) UNIQUE,
          status VARCHAR(32) NOT NULL DEFAULT 'queued',
          error_detail TEXT DEFAULT '',
          offer_map JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS sms_log_phone_idx ON sms_log (phone, created_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS sms_log_rule_idx  ON sms_log (rule_id, booking_id)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS sms_optout (
          phone VARCHAR(32) PRIMARY KEY,
          reason VARCHAR(64) DEFAULT 'STOP',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    })().catch(e => { smsSchemaReady = null; throw e; });
  }
  return smsSchemaReady;
}

async function isOptedOut(client, e164) {
  const { rows } = await client.query('SELECT phone FROM sms_optout WHERE phone=$1', [e164]);
  return rows.length > 0;
}

async function logSms(client, row) {
  try {
    const { rows } = await client.query(
      `INSERT INTO sms_log (direction, phone, body, booking_id, staff_id, rule_id, trigger_label, provider_sid, status, error_detail, offer_map)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider_sid) DO NOTHING
       RETURNING id`,
      [row.direction || 'out', row.phone, row.body || '', row.booking_id || null, row.staff_id || null,
       row.rule_id || null, row.trigger_label || '', row.provider_sid || null, row.status,
       row.error_detail || '', row.offer_map ? JSON.stringify(row.offer_map) : null]
    );
    return rows[0] ? rows[0].id : null;
  } catch (e) {
    console.error('logSms error:', e.message);
    return null;
  }
}

// ── The one sender ───────────────────────────────────────────────────────────
// Never throws. Every outcome is a status AND a logged row, so there is no path
// where a message quietly did not happen. Callers read `.status`; none of the
// five non-send outcomes resembles success.
//
// `meta.now` exists only so quiet hours are testable without faking the clock.
async function sendSms(client, to, body, meta = {}) {
  body = toGsm7(body);
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  const site  = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const base  = { direction: 'out', body, booking_id: meta.booking_id, staff_id: meta.staff_id,
                  rule_id: meta.rule_id, trigger_label: meta.trigger_label, offer_map: meta.offer_map };

  if (!sid || !token || !from) {
    console.error('sendSms: Twilio credentials are not configured');
    const logged = await logSms(client, { ...base, phone: String(to || ''), status: 'failed', error_detail: 'no_credentials' });
    return { status: 'no_credentials', logged: !!logged };
  }

  const e164 = normalisePhone(to);
  if (!e164) {
    // The raw value goes in the phone column deliberately: "which record has a
    // broken number" is the question this row exists to answer.
    console.error('sendSms: unparseable number:', JSON.stringify(to));
    const logged = await logSms(client, { ...base, phone: String(to || ''), status: 'invalid_number', error_detail: `raw: ${JSON.stringify(to)}` });
    if (!logged) console.error('sendSms: INVALID_NUMBER NOT LOGGED —', to);
    return { status: 'invalid_number', logged: !!logged };
  }

  // Cheap after the first call — ensureSmsTables memoises on smsSchemaReady.
  // Self-healing here rather than trusting every caller to remember: an
  // unlogged send is invisible, and the log row is the ONLY evidence an SMS
  // existed. Deliberately stricter than logEmail's convention in _email.js.
  await ensureSmsTables(client).catch(e => console.error('sendSms: ensureSmsTables failed:', e.message));

  if (await isOptedOut(client, e164)) {
    const logged = await logSms(client, { ...base, phone: e164, status: 'opted_out' });
    if (!logged) console.error('sendSms: OPTED_OUT NOT LOGGED —', e164);
    return { status: 'opted_out', logged: !!logged };
  }

  // Held, not dropped. flushHeldSms() in Task 8 sends these at 9am Central.
  if (isQuietHours(meta.now || new Date())) {
    const logged = await logSms(client, { ...base, phone: e164, status: 'held' });
    if (!logged) console.error('sendSms: HELD NOT LOGGED —', e164);
    return { status: 'held', logged: !!logged };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: e164, From: from, Body: body,
        // Delivery truth arrives here, seconds later. The response below only
        // ever means "Twilio accepted it".
        StatusCallback: `${site}/api/sms-status`
      }).toString()
    });
    const data = await res.json();

    if (!res.ok || data.code) {
      const reason = `${data.code || res.status}: ${data.message || 'Twilio send failed'}`;
      console.error('Twilio error:', e164, '|', reason);
      const logged = await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: reason });
      if (!logged) console.error('sendSms: TWILIO_ERROR NOT LOGGED —', e164, '|', reason);
      return { status: 'failed', reason, logged: !!logged };
    }

    // 'queued', not 'sent'. See the module header.
    const logged = await logSms(client, { ...base, phone: e164, status: 'queued', provider_sid: data.sid });
    if (!logged) console.error('sendSms: MESSAGE SENT BUT NOT LOGGED —', e164, '| SID:', data.sid);
    console.log('SMS queued to:', e164, '| SID:', data.sid);
    return { status: 'queued', sid: data.sid, logged: !!logged };
  } catch (e) {
    console.error('sendSms error:', e164, '|', e.message);
    const logged = await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: e.message });
    if (!logged) console.error('sendSms: EXCEPTION NOT LOGGED —', e164, '|', e.message);
    return { status: 'failed', reason: e.message, logged: !!logged };
  }
}

// ── The morning flush ────────────────────────────────────────────────────────
// Quiet hours hold a message rather than dropping it, and this is where held
// messages go out. There is no queue and no per-message scheduler in this
// system — the 9am Central cron is the only recurring thing — so "held" is a
// status on the row and this is the flush.
//
// Sends directly rather than via sendSms() so the held row is updated in place:
// routing it back through sendSms would write a second log row for the same
// message and leave the first stuck at 'held' forever. Body is NOT re-run
// through toGsm7 — sendSms already normalised it before the row was written.
const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function flushHeldSms(client, now = new Date()) {
  // Never flush inside quiet hours: it would re-hold everything it just picked
  // up and make no progress.
  if (isQuietHours(now)) return { sent: 0, expired: 0, optedOut: 0, blocked: 0 };

  const { rows } = await client.query(
    `SELECT * FROM sms_log WHERE status='held' ORDER BY created_at LIMIT 200`
  );
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const site = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

  // Hoisted out of the loop: credentials cannot change between rows, and a
  // per-row `if (!sid...) continue` silently produces the same
  // {sent:0, expired:0, optedOut:0} as "there was nothing to hold" — this
  // codebase's signature bug class (a check that reports a believable value
  // instead of an error). sendSms's equivalent path logs and marks the row
  // 'no_credentials'; this must be at least as loud.
  if (rows.length && (!sid || !token || !from)) {
    console.error(`flushHeldSms: ${rows.length} message(s) held and Twilio is not configured — NONE were sent`);
    return { sent: 0, expired: 0, optedOut: 0, blocked: rows.length };
  }

  let sent = 0, expired = 0, optedOut = 0;

  for (const row of rows) {
    // A day-before reminder that surfaces three days late is misinformation.
    if (now - new Date(row.created_at) > HELD_MAX_AGE_MS) {
      await client.query("UPDATE sms_log SET status=$1, error_detail=$2, updated_at=NOW() WHERE id=$3",
        ['expired', 'held longer than 24h', row.id]);
      console.error('flushHeldSms: expired held message', row.id, '→', row.phone);
      expired++;
      continue;
    }
    // The recipient may have texted STOP after the message was held (e.g. held
    // at 11pm, opted out at 2am). sendSms enforces this on every other path;
    // flushHeldSms bypasses sendSms for the in-place-update reason above, so
    // this is the one place it has to check for itself.
    if (await isOptedOut(client, row.phone)) {
      await client.query("UPDATE sms_log SET status=$1, updated_at=NOW() WHERE id=$2", ['opted_out', row.id]);
      console.error('flushHeldSms: recipient opted out since held', row.id, '→', row.phone);
      optedOut++;
      continue;
    }
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: row.phone, From: from, Body: row.body, StatusCallback: `${site}/api/sms-status` }).toString()
      });
      const data = await res.json();
      if (!res.ok || data.code) {
        const reason = `${data.code || res.status}: ${data.message || 'Twilio send failed'}`;
        await client.query("UPDATE sms_log SET status='failed', error_detail=$1, updated_at=NOW() WHERE id=$2", [reason, row.id]);
        console.error('flushHeldSms failed:', row.phone, '|', reason);
        continue;
      }
      await client.query("UPDATE sms_log SET status=$1, provider_sid=$2, updated_at=NOW() WHERE id=$3",
        ['queued', data.sid, row.id]);
      sent++;
    } catch (e) {
      await client.query("UPDATE sms_log SET status='failed', error_detail=$1, updated_at=NOW() WHERE id=$2", [e.message, row.id]);
      console.error('flushHeldSms error:', row.phone, '|', e.message);
    }
  }
  return { sent, expired, optedOut, blocked: 0 };
}

module.exports = { normalisePhone, isQuietHours, renderSms, parseLetters, ensureSmsTables, isOptedOut, logSms, sendSms, toGsm7, smsSegments, flushHeldSms };
