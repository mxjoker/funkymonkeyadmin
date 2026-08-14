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

const { fmtEventDate, reviewLinkFor } = require('./_email');

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
function renderSms(template, booking = {}, link) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  return String(template || '')
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
    .replace(/{{reference}}/g,         booking.reference || '')
    .replace(/{{payment_link}}/g,      link || '');
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
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  const site  = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const base  = { direction: 'out', body, booking_id: meta.booking_id, staff_id: meta.staff_id,
                  rule_id: meta.rule_id, trigger_label: meta.trigger_label, offer_map: meta.offer_map };

  if (!sid || !token || !from) {
    console.error('sendSms: Twilio credentials are not configured');
    await logSms(client, { ...base, phone: String(to || ''), status: 'failed', error_detail: 'no_credentials' });
    return { status: 'no_credentials' };
  }

  const e164 = normalisePhone(to);
  if (!e164) {
    // The raw value goes in the phone column deliberately: "which record has a
    // broken number" is the question this row exists to answer.
    console.error('sendSms: unparseable number:', JSON.stringify(to));
    await logSms(client, { ...base, phone: String(to || ''), status: 'invalid_number', error_detail: `raw: ${JSON.stringify(to)}` });
    return { status: 'invalid_number' };
  }

  if (await isOptedOut(client, e164)) {
    await logSms(client, { ...base, phone: e164, status: 'opted_out' });
    return { status: 'opted_out' };
  }

  // Held, not dropped. flushHeldSms() in Task 8 sends these at 9am Central.
  if (isQuietHours(meta.now || new Date())) {
    await logSms(client, { ...base, phone: e164, status: 'held' });
    return { status: 'held' };
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
      await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: reason });
      return { status: 'failed', reason };
    }

    // 'queued', not 'sent'. See the module header.
    await logSms(client, { ...base, phone: e164, status: 'queued', provider_sid: data.sid });
    console.log('SMS queued to:', e164, '| SID:', data.sid);
    return { status: 'queued', sid: data.sid };
  } catch (e) {
    console.error('sendSms error:', e164, '|', e.message);
    await logSms(client, { ...base, phone: e164, status: 'failed', error_detail: e.message });
    return { status: 'failed', reason: e.message };
  }
}

module.exports = { normalisePhone, isQuietHours, renderSms, parseLetters, ensureSmsTables, isOptedOut, logSms, sendSms };
