// netlify/functions/finalise.js — the client's own booking, theirs to complete.
//
// Authenticated exactly as my-booking.html and accept-quote.js already are:
// booking reference plus the client email stored on that booking, 404 on any
// mismatch without revealing whether the reference exists. That is a modest
// bar, and it is the same bar that already gates accept-quote — which commits
// a client to a quote — so this adds no new exposure. It does mean anyone
// forwarded the email can edit; see the ponytail note at the bottom.

const { withClient } = require('./_db');
const { CORS, preflight } = require('./_auth');
const { esc, logChange, ensureBookingChanges, ensureEmailLog, finaliseLinkFor } = require('./_email');
const { normaliseAddress } = require('./_address');
const { sanitiseClientEdit, zipChanged, describeFieldChange } = require('./_finalise');
const { ensureBookingItems, getItems, balanceCharge } = require('./_items');
const { buildSessionParams } = require('./create-stripe-link');
const { sendTemplate } = require('./automations');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const SITE = process.env.SITE_URL || 'https://funkymonkeyadmin.netlify.app';

// Wider than bookings.js PUBLIC_FIELDS on purpose: a client's own phone number
// is not public data, but it is data they must be able to correct. Kept as its
// own list rather than widening PUBLIC_FIELDS, which is a published contract
// every other public consumer reads.
const FINALISE_FIELDS = [
  'reference', 'status', 'service_name', 'event_date', 'event_type',
  'client_name', 'client_phone', 'client_email',
  'event_time', 'event_location', 'event_zip', 'venue', 'surface_type',
  'guest_count', 'child_name', 'guests_of_honour', 'notes',
  'total_price', 'deposit_amount', 'balance_due', 'deposit_paid',
  'stripe_payment_link',
];

// Money fields must read as a number even when NULL in the DB — the old
// `row[f] ?? (typeof row[f] === 'number' ? 0 : '')` was dead code (once `??`
// falls through, row[f] is null/undefined, so typeof it is never 'number'),
// so a NULL total_price rendered as '' and a page doing `$${total_price}`
// showed a bare "$" on the one page whose job is asking for money.
const MONEY_FIELDS = ['total_price', 'deposit_amount', 'balance_due'];

function buildFinaliseResponse(row) {
  const out = {};
  for (const f of FINALISE_FIELDS) {
    if (MONEY_FIELDS.includes(f)) out[f] = Number(row[f] ?? 0);
    else if (f === 'deposit_paid') out[f] = row[f] === true;
    else out[f] = row[f] ?? '';
  }
  // An absent link must read as absent so the page can say "we'll send this
  // shortly" rather than rendering a button that goes nowhere.
  out.stripe_payment_link = row.stripe_payment_link || '';
  return out;
}

// Pure comparison — the actual security boundary, and testable without a
// database. An empty stored or supplied email must never match: bookings
// legitimately exist with no client_email (drafts — bookings.js:320 — and
// PPM-synced rows — sync-stale-from-ppm.js:76) and '' !== '' is false, which
// used to read as "not a mismatch" and authenticate anyone holding only the
// reference against any email-less booking.
function emailMatches(stored, supplied) {
  const s = String(stored || '').trim().toLowerCase();
  const q = String(supplied || '').trim().toLowerCase();
  return !!s && !!q && s === q;
}

// Shared auth. Returns the row or null; the caller 404s either way so a
// wrong reference and a wrong email are indistinguishable from outside.
async function authenticate(c, reference, email) {
  const ref = String(reference || '').trim().toUpperCase();
  if (!ref || !String(email || '').trim()) return null;
  const { rows } = await c.query('SELECT * FROM bookings WHERE reference = $1', [ref]);
  if (!rows.length) return null;
  if (!emailMatches(rows[0].client_email, email)) return null;
  return rows[0];
}

// A day inside a camp (Phase 2) shares one finalise form with its whole
// camp — its own link must hand off to the camp's, or a client who finishes
// Monday's form reasonably believes the whole week is done. Returns null
// (never throws) when the booking's camp_id doesn't resolve to a real camp —
// ON DELETE SET NULL means that shouldn't happen, but a stale value here
// must fall through to this day's own finalise view rather than 500.
async function campRedirectFor(c, campId) {
  if (!campId) return null;
  const { rows } = await c.query('SELECT reference, client_email FROM camps WHERE id = $1', [campId]);
  if (!rows.length || !rows[0].reference) return null;
  return { reference: rows[0].reference, email: rows[0].client_email };
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    return withClient(async (c) => {
      const booking = await authenticate(c, qs.reference, qs.email);
      if (!booking) return json(404, { error: 'Booking not found' });
      // This day belongs to a camp — hand off to the camp's own finalise
      // form rather than showing this day's alone. See campRedirectFor.
      if (booking.camp_id) {
        const redirect = await campRedirectFor(c, booking.camp_id);
        if (redirect) return json(200, { redirect });
      }
      // Read-only line items so the client can see what the total is made of
      // before hitting "Accept This Quote" — CLIENT_EDITABLE gains nothing here.
      await ensureBookingItems(c);
      const view = buildFinaliseResponse(booking);
      view.items = await getItems(c, booking.id);
      return json(200, { booking: view });
    });
  }

  if (event.httpMethod === 'PATCH' || event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const { reference, email, updates } = body;

    // ── Mint a fresh checkout session, on demand ─────────────────────────────
    // A Stripe Checkout Session dies 24 hours after it is created, and 24h is
    // also the longest expiry Stripe will accept — so a link emailed on Tuesday
    // is a dead page on Thursday. FM-KNNVZY8J hit exactly that on 2026-08-20:
    // the session behind her "Pay Deposit Now" button had been minted 26 hours
    // earlier by the first finalisation email, and the button went nowhere. The
    // manual deposit button worked because it always mints a new one.
    //
    // So this page no longer carries a link at all — it asks for one when the
    // client presses the button, which cannot be stale by construction.
    //
    // The amount comes from the row, never from the request: this endpoint is
    // public (reference + email is the whole key), so a browser must not be
    // able to name the price of anything.
    if (body.action === 'pay_link') {
      return withClient(async (c) => {
        const booking = await authenticate(c, reference, email);
        if (!booking) return json(404, { error: 'Booking not found' });

        // Deposit or balance, both minted here for the same reason: a stored
        // checkout URL is a dead page 24 hours later. This is the only endpoint
        // a client can reach, so both guards that keep the two links from being
        // live at once live here as well as in create-stripe-link.js.
        const kind = body.kind === 'balance' ? 'balance' : 'deposit';
        if (kind === 'deposit' && booking.deposit_paid) {
          return json(409, { error: 'This deposit is already paid — nothing further to pay here.' });
        }
        // The one place the address is MANDATORY rather than advised (Joe,
        // 2026-08-20). A paid deposit is a gig on the calendar, and a gig whose
        // address is "Edmond" is a crew with nowhere to drive. The browser asks
        // first and more kindly; this is the guard that cannot be skipped by
        // anything that talks to the endpoint directly.
        //
        // Emptiness only — the shape check is a warning everywhere, because
        // refusing a real rural address at the checkout button would cost a
        // booking to save a typo.
        if (!String(booking.event_location || '').trim()) {
          return json(400, {
            error: 'We need the event address before you can pay — please fill it in above and save.',
            field: 'event_location',
          });
        }
        // What we are about to charge. Both figures come from the row: this
        // endpoint is public — reference + email is the whole key — so a
        // browser must never be able to name the price of anything.
        //
        // NOT a fallback amount. A $0 deposit is the deliberate school/library
        // booking, and billing one $100 is a bug this codebase has shipped.
        const charge = kind === 'balance'
          ? balanceCharge(booking)
          : { balance: Number(booking.deposit_amount || 0), fee: 0, total: Number(booking.deposit_amount || 0) };

        if (!(charge.balance > 0)) {
          return json(400, { error: kind === 'balance'
            ? 'There is no balance left to pay on this booking.'
            : 'This booking has no deposit to pay.' });
        }
        if (kind === 'balance') {
          // Both links live at once is a money bug: the balance payment zeroes
          // balance_due, and a still-live deposit link's webhook then recomputes
          // it as total + mileage - deposit. Same guard as create-stripe-link.js.
          if (booking.deposit_paid !== true && Number(booking.deposit_amount) > 0) {
            return json(400, { error: 'Please pay the deposit first — we will send the balance when it is due.' });
          }
          if (charge.total > 25000) {
            console.error('finalise: balance too large to bill by link —', booking.reference, charge.total);
            return json(400, { error: 'Please call us on (405) 431-6625 to settle this one.' });
          }
        }
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error('finalise: pay_link requested but STRIPE_SECRET_KEY is not set');
          return json(500, { error: 'Payments are not configured — call us on (405) 431-6625.' });
        }
        try {
          const params = buildSessionParams({
            kind, amount: charge.balance, fee: charge.fee,
            service: booking.service_name, client: booking.client_name,
            email: booking.client_email, bookingRef: booking.reference,
            bookingId: booking.reference, dbId: booking.id,
          });
          const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          const session = await res.json();
          if (!res.ok || !session.url) {
            console.error('finalise: Stripe session failed for', booking.reference, '|', JSON.stringify(session.error || {}));
            return json(502, { error: 'Could not start checkout — call us on (405) 431-6625.' });
          }
          // Its OWN column, same as create-stripe-link.js: stripe_payment_link
          // means "the deposit link" to four other readers, and overwriting it
          // with a balance demand would point them all at the wrong thing.
          const col = kind === 'balance' ? 'stripe_balance_link' : 'stripe_payment_link';
          if (kind === 'balance') {
            await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_link TEXT DEFAULT ''")
              .catch((e) => console.error('finalise: could not ensure stripe_balance_link |', e.message));
          }
          await c.query(`UPDATE bookings SET ${col}=$1, updated_at=NOW() WHERE id=$2`,
            [session.url, booking.id]);
          return json(200, { url: session.url });
        } catch (e) {
          console.error('finalise: pay_link failed for', reference, '|', e.message);
          return json(502, { error: 'Could not start checkout — call us on (405) 431-6625.' });
        }
      });
    }

    return withClient(async (c) => {
      await ensureBookingChanges(c);
      await ensureEmailLog(c);

      const booking = await authenticate(c, reference, email);
      if (!booking) return json(404, { error: 'Booking not found' });

      // Same hand-off as the GET above — a camp day's edits must go through
      // the camp's own finalise form so every day stays in lockstep (see
      // finalise-camp.js), not through this per-day endpoint.
      if (booking.camp_id) {
        const redirect = await campRedirectFor(c, booking.camp_id);
        if (redirect) return json(200, { redirect });
      }

      // A booking already paid for is finished being finalised. Editing it here
      // would change details the crew may already be working from.
      if (booking.deposit_paid) {
        return json(409, { error: 'This booking is already confirmed. Call us on (405) 431-6625 to change anything.' });
      }

      const { fields, rejected } = sanitiseClientEdit(updates);
      if (rejected.length) console.error('finalise: rejected fields for', booking.reference, '|', rejected.join(', '));
      if (!Object.keys(fields).length) return json(400, { error: 'Nothing to save', rejected });

      // Keep the ZIP out of the address line, same as every other writer.
      let addrConflict = null;
      if (fields.event_location !== undefined || fields.event_zip !== undefined) {
        const addr = normaliseAddress(
          fields.event_location !== undefined ? fields.event_location : booking.event_location,
          fields.event_zip      !== undefined ? fields.event_zip      : booking.event_zip
        );
        // Same signal every other writer surfaces (bookings.js, booking.js) —
        // a disagreement between the address's embedded ZIP and event_zip
        // must not vanish just because this caller doesn't re-price on it.
        if (addr.conflict) {
          console.error('finalise: address/ZIP disagree on', booking.reference, '|', addr.conflict);
          addrConflict = addr.conflict;
        }
        if (fields.event_location !== undefined) fields.event_location = addr.location;
        if (fields.event_zip !== undefined) fields.event_zip = addr.zip;
      }

      const keys = Object.keys(fields);
      const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
      const { rows } = await c.query(
        `UPDATE bookings SET ${sets}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
        [...keys.map(k => fields[k]), booking.id]
      );
      const updated = rows[0];

      // Reused below for the client's per-save receipt. client_email is left
      // out — a change to it is already covered by the two emails the
      // email-change flow below sends, and a third mention would be noise.
      const changesForEmail = [];
      for (const k of keys) {
        if (String(booking[k] ?? '') !== String(updated[k] ?? '')) {
          await logChange(c, booking.id, 'Client finalised details', `${k}: "${booking[k] ?? ''}" → "${updated[k] ?? ''}"`);
          if (k !== 'client_email') changesForEmail.push(describeFieldChange(k, booking[k], updated[k]));
        }
      }

      // The ZIP prices the job. Changing it does NOT re-price (Joe's ruling
      // 2026-08-15) — a client watching their total move mid-checkout is the
      // worst moment for it. Tell a human and let them decide.
      //
      // Two distinct ways the price can now be wrong: the client changed
      // event_zip directly (zip.changed), OR they edited only event_location
      // to an address whose embedded ZIP disagrees with the stored event_zip
      // (addrConflict) — normaliseAddress keeps the stored ZIP in that case,
      // so zip.changed is false and the event has still moved. Either one
      // must alert; only firing on zip.changed left the address-only path
      // silent.
      const zip = zipChanged(booking, updated);
      if (zip.changed || addrConflict) {
        // Both can be true at once — the client typed a new ZIP directly AND
        // the address they typed embeds a still-different ZIP. Each is its
        // own detail; showing only one silently drops the other.
        const detailParts = [];
        if (zip.changed) detailParts.push(`${zip.from} → ${zip.to}`);
        if (addrConflict) detailParts.push(`event_zip ${zip.changed ? `now ${updated.event_zip}` : `unchanged (${updated.event_zip})`} but ${addrConflict}`);
        const detail = detailParts.join(' | ');
        await logChange(c, booking.id, 'ZIP changed by client — price NOT recalculated', detail);
        const caseParts = [];
        if (zip.changed) caseParts.push(`<p><strong>Quoted from:</strong> ${esc(zip.from)}<br/><strong>Now:</strong> ${esc(zip.to)}</p>`);
        if (addrConflict) caseParts.push(zip.changed
          ? `<p>The address they entered also names a different ZIP than the one just saved: <strong>${esc(addrConflict)}</strong>.</p>`
          : `<p>The ZIP on file (<strong>${esc(updated.event_zip)}</strong>) was not changed, but the address they entered now names a different ZIP than the one we priced: <strong>${esc(addrConflict)}</strong>.</p>`);
        const caseHtml = caseParts.join('');
        const changedWhat = zip.changed && addrConflict ? 'the ZIP and address' : zip.changed ? 'the ZIP' : 'the address';
        try {
          // Wording in 'zip_changed_alert'; the two facts it turns on — what
          // they changed and which case it is — are decided above.
          const r = await sendTemplate(c, updated, 'zip_changed_alert', null,
            { extra: { changed_what: changedWhat, zip_case: caseHtml } });
          if (!r.sent) console.error('finalise: ZIP-change alert not sent —', r.error);
        } catch (e) {
          // The save has committed and is what matters. A failed alert must not
          // 500 the client or undo their edit — but it must be loud, because a
          // silent one means a price nobody rechecked.
          console.error('finalise: ZIP-change alert FAILED for', updated.reference, '|', e.message);
        }
      }

      // ── The email changed, so the link they are holding is now dead ────────
      // client_email is half the authentication key: the link in their inbox
      // carries the OLD address and will 404 from here on. Re-issue to the new
      // one (Joe's ruling 2026-08-15).
      //
      // The notice to the OLD address is not a courtesy — it is the only
      // control this flow has. Auth is a reference plus an email, so anyone
      // forwarded the original message could change the contact address and
      // quietly take over the booking. Telling the previous address means that
      // cannot happen silently. Send it FIRST: it is the one with a security
      // job, and it must not be skipped if the second send throws.
      const emailChanged = keys.includes('client_email') &&
        (booking.client_email || '').toLowerCase() !== (updated.client_email || '').toLowerCase();

      if (emailChanged) {
        await logChange(c, booking.id, 'Client changed their email — link re-issued',
          `${booking.client_email || '(none)'} → ${updated.client_email}`);

        if (booking.client_email) {
          try {
            // `updated` for the body — {{client_email}} must be the NEW address
            // this is warning about — but addressed explicitly to the OLD one.
            const r = await sendTemplate(c, updated, 'contact_email_changed', null,
              { to: booking.client_email });
            if (!r.sent) console.error('finalise: old-address change notice not sent —', r.error);
          } catch (e) {
            console.error('finalise: old-address change notice FAILED for', updated.reference, '|', e.message);
          }
        }

        // Folded in rather than sent as a third email — see changesForEmail
        // above and the receipt block below, which only fires when the email
        // did NOT change.
        const changesHtml = changesForEmail.length
          ? `<p style="margin-top:16px">They also updated:</p><ul>${changesForEmail.map(line => `<li>${line}</li>`).join('')}</ul>`
          : '';
        try {
          const r = await sendTemplate(c, updated, 'finalise_link_reissued', null,
            { extra: { change_block: changesHtml } });
          if (!r.sent) console.error('finalise: link re-issue not sent —', r.error);
        } catch (e) {
          // The change has committed and their page keeps working for this
          // session (Task 4 Step 4 updates it in place). A failed re-issue
          // means only that they have no link for NEXT time — loud, not fatal.
          console.error('finalise: link re-issue FAILED for', updated.reference, '|', e.message);
        }
      }

      // ── Per-save receipt ────────────────────────────────────────────────
      // Of the twelve client-editable fields, only client_email (above) and
      // event_zip (via the alert above) ever told anyone what changed — the
      // other ten changed in total silence, with booking_changes as the only
      // record and nothing reading it proactively. Since the auth key is
      // just a reference + this same email, someone forwarded the link could
      // move a party time and nobody would know. Skipped when the email
      // itself changed — that case already sends two emails (above), and a
      // third would be noise, so the change list is folded into the reissue
      // email instead.
      if (!emailChanged && changesForEmail.length) {
        try {
          const r = await sendTemplate(c, updated, 'booking_updated_receipt', null,
            { extra: { change_list: changesForEmail.map(line => `<li>${line}</li>`).join('') } });
          if (!r.sent) console.error('finalise: change receipt not sent —', r.error);
        } catch (e) {
          // The save has committed and is what matters — a failed receipt
          // must not 500 the client or undo their edit, only be loud enough
          // that a silent one doesn't stay silent twice.
          console.error('finalise: change receipt FAILED for', updated.reference, '|', e.message);
        }
      }

      // emailChanged tells the page to update the key it authenticates with,
      // so the client can carry on saving without a reload.
      return json(200, { success: true, booking: buildFinaliseResponse(updated), rejected, emailChanged });
    });
  }

  return json(405, { error: 'Method not allowed' });
};

// ponytail: auth is reference + email, matching the two client-facing endpoints
// that already exist. Anyone forwarded the email can therefore edit the booking.
// Acceptable because the same key already gates accept-quote, the editable set
// carries no money, and every change is written to booking_changes. Upgrade to a
// signed expiring token if bookings ever carry anything more sensitive.
module.exports.handler = exports.handler;
module.exports.buildFinaliseResponse = buildFinaliseResponse;
module.exports.FINALISE_FIELDS = FINALISE_FIELDS;
module.exports.emailMatches = emailMatches;
module.exports.campRedirectFor = campRedirectFor;
