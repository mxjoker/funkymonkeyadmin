/**
 * _email.js — shared email helper for all Funky Monkey functions
 *
 * Single source of truth for:
 *  - Sending via Resend
 *  - Template variable rendering
 *  - Email wrapping (branded HTML shell)
 *  - Logging to email_log table
 *  - Firing automation rules on status change
 */

const FROM = 'Funky Monkey Events <bookings@funkymonkeyevents.com>';
const { ensureTable: ensureBookingChanges } = require('./booking-changelog');
const { balanceCharge, SERVICE_FEE_RATE } = require('./_items');

// Google review profiles. Magic-show bookings point clients at Joe's personal
// "Joe Coover Magic" profile; everything else goes to "Funky Monkey Events".
// Env vars override so the URLs can change without a code deploy.
const REVIEW_LINK_MAGIC   = process.env.REVIEW_LINK_MAGIC || 'https://g.page/r/CasLGRjeMqxuEAI/review';
const REVIEW_LINK_DEFAULT = process.env.REVIEW_LINK_FM    || 'https://g.page/r/CWyWrqOMWC01EAI/review';

// A booking is "magic" when its service name/id mentions magic (Deluxe/Basic/
// Corporate Birthday Magic Show, Magic School Assembly, Walk-Around Cocktail
// Hour Magic, Library Magic Show/Workshop). Game Show, DJ Piñata, balloons,
// foam, etc. fall through to the Funky Monkey Events profile.
function reviewLinkFor(booking) {
  const blob = `${booking.service_name || ''} ${booking.service || ''} ${booking.service_id || ''} ${booking.event_type || ''}`;
  return /magic/i.test(blob) ? REVIEW_LINK_MAGIC : REVIEW_LINK_DEFAULT;
}

// ── HTML escape for user-supplied values in email templates ──────────────────
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── HTML wrapper ──────────────────────────────────────────────────────────────
function wrap(body) {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
  <div style="background-color:#FF6B00;padding:20px 24px">
    <div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div>
  </div>
  <div style="padding:24px">${body}</div>
  <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,.1);font-size:11px;color:#A78BCA;text-align:center">
    Funky Monkey Events · OKC · (405) 431-6625
  </div>
</div>`;
}

// ── Template renderer ─────────────────────────────────────────────────────────
// ── Format an event_date for display ──────────────────────────────────────────
// pg hands DATE columns back as JS Date objects, and String(aDate) is
// "Mon Aug 03 2026 17:00:00 GMT-0700 (Pacific Daylight Time)" — whose FIRST "T"
// sits inside "GMT". The old `String(v).split('T')[0] + 'T00:00:00'` trick
// therefore truncated it to "Mon Aug 03 2026 17:00:00 GM" and produced
// "Invalid Date" in every email built from a database row. Emails built from a
// request body worked, because those carry a plain "YYYY-MM-DD" string — which
// is why this hid for so long.
//
// Normalise to YYYY-MM-DD first, then format in UTC so a date-only value can
// never slide to the previous day in a west-of-UTC runtime.
function fmtEventDate(value, opts) {
  if (!value) return '';
  const ymd = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
  const d = new Date(ymd + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US',
    Object.assign({ timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, opts));
}

// Tokens every message can use that are DERIVED from the row rather than being
// a column on it: a list, a conditional line, a name split. Built once here so
// the email and SMS renderers cannot disagree about what {{addon_list}} means.
//
// Each returns '' — never 'undefined', never 'null' — when the data is absent,
// because these sit in the middle of a sentence in someone's inbox.
function rowTokens(booking) {
  const addons = Array.isArray(booking.addons) ? booking.addons : [];
  const miles = Number(booking.mileage_cost || 0);
  return {
    addon_list: addons.length
      ? '<ul>' + addons.map(a => `<li>${esc(a.name)} — $${Number(a.price || 0).toFixed(2)}</li>`).join('') + '</ul>'
      : '',
    // A whole line, not a number: a booking with no travel charge must not
    // leave "Travel: $0.00" in the email.
    // "OKC" is the fallback three of the ported emails already used: an alert
    // saying the event is nowhere is worse than one saying it is in town.
    location_label: booking.event_location || booking.event_zip || 'OKC',
    // "Saturday, 12 September 2026 at 2:00 PM", or just the date. Built here
    // because six templates want the pair and none of them want "TBD at ".
    event_datetime: (fmtEventDate(booking.event_date) || 'TBD')
      + (booking.event_time ? ' at ' + booking.event_time : ''),
    mileage_line: miles > 0
      ? `<p><strong>Travel:</strong> $${miles.toFixed(2)}${booking.mileage_miles ? ` (${esc(String(booking.mileage_miles))} mi)` : ''}</p>`
      : '',
  };
}

// The plain-text side of the same tokens, for the SMS bodies.
const stripTags = (html) => String(html || '')
  .replace(/<li>/g, '- ').replace(/<\/li>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// `extra` carries values that are not on the booking row at all — an amount a
// webhook just received, a list of what a client changed, a staff member's call
// time. Substituted last, and only for keys the caller passes: a template
// naming an extra the caller does not supply keeps its literal {{token}}, which
// the manual-templates test turns into a failure rather than a blank in a bill.
function applyExtra(out, extra) {
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra)) {
    out = out.split('{{' + k + '}}').join(v == null ? '' : String(v));
  }
  return out;
}

function render(template, booking, stripeLink, extra) {
  const firstName = (booking.client_name || '').split(' ')[0] || 'there';
  const dateStr = fmtEventDate(booking.event_date) || 'TBD';
  // background-color, not linear-gradient: Gmail strips gradients from inline
  // styles, which left white text on the wrapper's near-black background — a
  // button that read as plain text. The raw URL beneath it means a client whose
  // mail renderer mangles the anchor can still pay, rather than being left with
  // no route to checkout at all.
  const depositBtn = stripeLink
    ? `<div style="text-align:center;margin:20px 0">
        <a href="${stripeLink}" style="background-color:#10B981;color:#ffffff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">
          💳 Pay Deposit — $${Number(booking.deposit_amount||0).toFixed(2)}
        </a>
        <p style="color:#A78BCA;font-size:11px;margin-top:10px;line-height:1.5">Button not working? Copy this link into your browser:<br><a href="${stripeLink}" style="color:#06B6D4;word-break:break-all">${stripeLink}</a></p>
        <p style="color:#A78BCA;font-size:11px;margin-top:8px">Secure payment via Stripe · Cards, Apple Pay & Google Pay accepted</p>
      </div>`
    : '';

  // The balance-link figures, priced by the same function that builds the
  // Stripe session (_items.js). The email and the checkout page can never
  // then quote different arithmetic — which matters most on the one document
  // a client would use to check it.
  const charge = balanceCharge(booking);
  const derived = rowTokens(booking);

  // Guests of honour falls back to the child's name, then to a friendly
  // generic so the sentence still reads if neither field is set.
  const guestsOfHonour = booking.guests_of_honour || booking.child_name || 'everyone';

  return applyExtra(template
    .replace(/{{client_first_name}}/g, esc(firstName))
    .replace(/{{client_name}}/g,       esc(booking.client_name   || ''))
    .replace(/{{guests_of_honour}}/g,  esc(guestsOfHonour))
    .replace(/{{child_name}}/g,        esc(booking.child_name    || ''))
    .replace(/{{review_link}}/g,       reviewLinkFor(booking))
    .replace(/{{service_name}}/g,      esc(booking.service_name  || ''))
    .replace(/{{event_date}}/g,        dateStr)
    .replace(/{{event_time}}/g,        esc(booking.event_time    || ''))
    .replace(/{{event_zip}}/g,         esc(booking.event_zip     || ''))
    .replace(/{{total_price}}/g,       Number(booking.total_price   ||0).toFixed(2))
    // NOT `|| 100`. A booking with the deposit deliberately set to 0 — schools,
    // libraries, anyone who cannot pay one — would otherwise be emailed a
    // demand for $100.00 that exists nowhere in the booking.
    .replace(/{{deposit_amount}}/g,    Number(booking.deposit_amount||0).toFixed(2))
    .replace(/{{balance_due}}/g,       Number(booking.balance_due   ||0).toFixed(2))
    .replace(/{{service_fee}}/g,       charge.fee.toFixed(2))
    .replace(/{{balance_total}}/g,     charge.total.toFixed(2))
    // A token, not a literal, so rewording the fee line in Automations
    // cannot leave an email saying 5% beside a Stripe page charging
    // something else. SERVICE_FEE_RATE is the only definition of the rate.
    .replace(/{{service_fee_pct}}/g,   String(Math.round(SERVICE_FEE_RATE * 100)))
    .replace(/{{reference}}/g,         booking.reference     || '')
    .replace(/{{deposit_link}}/g,      depositBtn)
    // {{payment_link}} is renderSms's token, not render()'s — but the rule
    // editor shows both bodies side by side and nothing stops a body written
    // for one channel being pasted into the other. Resolve it here too (to
    // the raw URL the button points at, not the HTML button) so that copy
    // never comes out as a literal, unreplaced "{{payment_link}}".
    .replace(/{{payment_link}}/g,      stripeLink || '')
    // Row fields the ported system emails need. Plain columns, escaped like
    // every other value here.
    .replace(/{{client_email}}/g,      esc(booking.client_email    || ''))
    .replace(/{{client_phone}}/g,      esc(booking.client_phone    || ''))
    .replace(/{{event_location}}/g,    esc(booking.event_location  || ''))
    .replace(/{{event_type}}/g,        esc(booking.event_type      || ''))
    .replace(/{{guest_count}}/g,       esc(String(booking.guest_count ?? '')))
    .replace(/{{service_price}}/g,     Number(booking.service_price || 0).toFixed(2))
    .replace(/{{mileage_cost}}/g,      Number(booking.mileage_cost  || 0).toFixed(2))
    .replace(/{{notes}}/g,             esc(booking.notes           || ''))
    .replace(/{{referral_source}}/g,   esc(booking.referral_source || ''))
    .replace(/{{status}}/g,            esc(booking.status          || ''))
    .replace(/{{deposit_state}}/g,     booking.deposit_paid === true ? 'deposit paid' : 'no deposit yet')
    .replace(/{{location_label}}/g,    esc(derived.location_label))
    .replace(/{{event_datetime}}/g,    esc(derived.event_datetime))
    .replace(/{{addon_list}}/g,        derived.addon_list)
    .replace(/{{mileage_line}}/g,      derived.mileage_line)
    .replace(/{{admin_link}}/g,        'https://funkymonkeyadmin.netlify.app/admin.html')
    .replace(/{{finalise_link}}/g,     finaliseLinkFor(booking)), extra);
}

// ── Email allowlist ───────────────────────────────────────────────────────────
// When EMAIL_ALLOWLIST is set, only those addresses actually receive mail;
// everything else is logged and dropped. This exists so that fixing the Resend
// error-detection bug does not wake every dormant send in the system at once.
// Unset (production) = no filtering.
function allowedToSend(to) {
  const list = process.env.EMAIL_ALLOWLIST;
  if (!list) return true;
  const allowed = list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(to).trim().toLowerCase());
}

// ── Core send function ────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!to) return { skipped: 'no recipient' };
  if (!key) throw new Error('RESEND_API_KEY is not set');

  if (!allowedToSend(to)) {
    console.log('Email SUPPRESSED by EMAIL_ALLOWLIST:', to, '| subject:', subject);
    return { suppressed: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html })
  });
  const data = await res.json();

  // Resend signals failure with {statusCode, message, name} — NOT {error}.
  // The old `if (data.error)` check never matched, so every failure looked
  // like a success. Do not "simplify" this back.
  if (!res.ok || data.statusCode || data.name) {
    const reason = data.message || data.name || `HTTP ${res.status}`;
    console.error('Resend error:', to, '|', reason);
    throw new Error(`Resend send failed: ${reason}`);
  }

  console.log('Email sent to:', to, '| id:', data.id, '| subject:', subject);
  return data;
}

// ── email_log status for a successful sendEmail() result ──────────────────────
// A suppressed send never left the building, so it must NOT be logged as 'sent'.
// automations.js de-dupes its scheduled batches with `status='sent'`; logging
// suppressed mail as sent would permanently skip those clients once the
// allowlist is lifted. A {skipped:'no recipient'} result never had an address
// at all — logging it 'sent' makes /api/health's last_successful_email report
// a send that never happened. Returns undefined for a real send so logEmail
// defaults to 'sent'.
function logStatus(sendResult) {
  return sendResult && (sendResult.suppressed ? 'suppressed' : sendResult.skipped ? 'skipped' : undefined);
}

// ── Log to email_log table ────────────────────────────────────────────────────
async function logEmail(client, bookingId, ruleId, triggerLabel, subject, recipientEmail, recipientLabel, status, errorDetail) {
  try {
    await client.query(
      `INSERT INTO email_log (booking_id, rule_id, trigger_label, subject, recipient_email, recipient_label, status, error_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [bookingId, ruleId||null, triggerLabel, subject, recipientEmail, recipientLabel||'client',
       status||'sent', errorDetail||'']
    );
  } catch(e) {
    console.error('logEmail error:', e.message);
  }
}

// ── Ensure email_log table exists ─────────────────────────────────────────────
async function ensureEmailLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      rule_id INTEGER,
      trigger_label VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      recipient_label VARCHAR(32) DEFAULT 'client',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(32) DEFAULT 'sent'
    )
  `);
  await client.query(
    "ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_detail TEXT DEFAULT ''"
  );
}


// The one link a client needs to complete their booking. Both the email and
// the SMS renderer will use this, so the two cannot drift into pointing at
// different pages.
//
// Returns '' when the booking has no client email: the finalisation page
// authenticates on reference + email, so a link without one 404s the instant
// it is clicked. An empty token is honest; a dead link is not.
function finaliseLinkFor(booking) {
  const site = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';
  const ref = (booking && booking.reference) || '';
  const email = (booking && booking.client_email) || '';
  if (!ref || !email) return '';
  return `${site}/my-booking.html?ref=${encodeURIComponent(ref)}&email=${encodeURIComponent(email)}`;
}

// ── Log a booking change ───────────────────────────────────────────────────────
async function logChange(client, bookingId, action, detail) {
  try {
    await client.query(
      `INSERT INTO booking_changes (booking_id, action, detail) VALUES ($1, $2, $3)`,
      [bookingId, action, detail || '']
    );
  } catch(e) {
    console.error('logChange error:', e.message);
  }
}

module.exports = {
  rowTokens, stripTags, applyExtra, wrap, render, esc, fmtEventDate, reviewLinkFor, sendEmail, logStatus, logEmail, ensureEmailLog, ensureBookingChanges, logChange, finaliseLinkFor };
