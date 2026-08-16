# Client Finalisation & Deposit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One link a client can open to review and complete their own booking details, then pay the deposit — replacing the current two-email round trip where they accept a quote and wait for Joe to send a payment link.

**Architecture:** A new `finalise.js` function reusing the reference+email authentication `my-booking.html` and `accept-quote.js` already share. It exposes a deliberately narrow whitelist of client-editable fields — no money, no status, no staffing. `my-booking.html` gains an editable mode and hands off to the Stripe link stored on the booking, which the admin creates when it sends the finalisation email. No public endpoint can mint a Stripe session.

**Tech Stack:** Netlify Functions, CommonJS, no build step, `pg`, `node --test`, native `fetch`. No new npm dependencies.

## Global Constraints

- **No new npm dependencies.**
- **Authentication is booking reference + matching client email**, case-insensitive, 404 on any mismatch without revealing whether the reference exists. Identical shape to `accept-quote.js:62-67` and `bookings.js:218`. Do not invent a second auth model.
- **The client may never edit anything that carries money or workflow state.** Not `total_price`, `service_price`, `deposit_amount`, `balance_due`, `mileage_cost`, `items`, `status`, `deposit_paid`, `admin_notes`, or any staffing field. The whitelist is the contract; anything absent from it is rejected, not ignored.
- **A ZIP change does NOT re-price.** (Joe's ruling, 2026-08-15.) Mileage and travel are calculated from `event_zip`; a client watching their total move mid-checkout is the worst possible moment for it. Save the new address, keep the price, and alert Joe with both ZIP values so a human decides whether to re-quote.
- **No public endpoint may create a Stripe session.** The deposit link must already exist on the booking (`stripe_payment_link`) before the finalisation email is sent.
- **Nothing here may confirm a booking.** `stripe-webhook.js` sets `deposit_paid` and `status='confirmed'` on payment and remains the only thing that does.
- `event_location` never stores the ZIP — `normaliseAddress()` in `_address.js` splits it, and every writer must go through it.
- Test command is `npm test` (`node --test 'test/**/*.test.js'`). No frameworks, no fixtures, no database in tests.
- Baseline before this plan: **288 tests passing.**

---

## Task 1: The client-edit contract

Pure functions, no HTTP and no database. This is where the security boundary lives, so it lands first with tests.

**Files:**
- Create: `netlify/functions/_finalise.js`
- Test: `test/finalise-contract.test.js`

**Interfaces:**
- Produces:
  - `CLIENT_EDITABLE` — frozen array of field names a client may change
  - `sanitiseClientEdit(body) -> { fields: object, rejected: string[] }`
  - `zipChanged(prev, next) -> { changed: boolean, from: string, to: string }`

- [ ] **Step 1: Write the failing tests**

Create `test/finalise-contract.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { CLIENT_EDITABLE, sanitiseClientEdit, zipChanged } = require('../netlify/functions/_finalise.js');

// The whitelist IS the security boundary. This test exists so that adding a
// field to it is a deliberate act with a visible diff, never a side effect.
test('the client-editable whitelist is exactly these fields', () => {
  assert.deepStrictEqual([...CLIENT_EDITABLE].sort(), [
    'child_name', 'client_email', 'client_name', 'client_phone',
    'event_location', 'event_time', 'event_zip', 'guest_count',
    'guests_of_honour', 'notes', 'surface_type', 'venue',
  ]);
});

// Every one of these has moved a price or a workflow in this system before.
test('money and workflow fields are rejected, never silently dropped', () => {
  const r = sanitiseClientEdit({
    client_name: 'Dana Ruiz',
    total_price: 1, deposit_amount: 0, balance_due: 0, service_price: 1,
    mileage_cost: 0, items: [], status: 'confirmed', deposit_paid: true,
    admin_notes: 'x', reference: 'FM-OTHER', id: 99,
  });
  assert.deepStrictEqual(Object.keys(r.fields), ['client_name']);
  assert.ok(r.rejected.includes('total_price'));
  assert.ok(r.rejected.includes('status'));
  assert.ok(r.rejected.includes('deposit_paid'));
  assert.ok(r.rejected.includes('reference'), 'the reference is the auth key and must never be writable');
  assert.ok(r.rejected.includes('id'));
});

test('an allowed field passes through untouched', () => {
  const r = sanitiseClientEdit({ notes: 'Garden is on a slope', guest_count: 24 });
  assert.deepStrictEqual(r.fields, { notes: 'Garden is on a slope', guest_count: 24 });
  assert.deepStrictEqual(r.rejected, []);
});

// An empty submit must be distinguishable from a rejected one, so the caller
// can answer "nothing changed" rather than reporting a success that did nothing.
test('an empty body yields no fields and no rejections', () => {
  assert.deepStrictEqual(sanitiseClientEdit({}), { fields: {}, rejected: [] });
  assert.deepStrictEqual(sanitiseClientEdit(null), { fields: {}, rejected: [] });
});

// guest_count drives per-guest pricing on some add-ons. It is editable because
// it genuinely changes, but it must arrive as a number.
test('guest_count is coerced to a number and rejected when it is not one', () => {
  assert.strictEqual(sanitiseClientEdit({ guest_count: '24' }).fields.guest_count, 24);
  const bad = sanitiseClientEdit({ guest_count: 'lots' });
  assert.ok(!('guest_count' in bad.fields));
  assert.ok(bad.rejected.includes('guest_count'));
});

// client_email is half the auth key. A malformed one locks the client out AND
// sends the re-issued link nowhere, so it never reaches the database.
test('a malformed email is rejected rather than stored', () => {
  for (const bad of ['notanemail', 'no@domain', 'two @spaces.com', '', '@x.com']) {
    const r = sanitiseClientEdit({ client_email: bad });
    assert.ok(!('client_email' in r.fields), `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.rejected.includes('client_email'));
  }
});

// Stored lowercase because authenticate() compares lowercased. Storing "Dana@
// Example.com" verbatim would authenticate fine today and break the moment
// anything compares it case-sensitively.
test('an accepted email is normalised to lowercase and trimmed', () => {
  assert.strictEqual(sanitiseClientEdit({ client_email: '  Dana@Example.COM ' }).fields.client_email, 'dana@example.com');
});

// ── zipChanged ──────────────────────────────────────────────────────────────
test('a real ZIP change is reported with both values', () => {
  const r = zipChanged({ event_zip: '73120' }, { event_zip: '73072' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.from, '73120');
  assert.strictEqual(r.to, '73072');
});

test('an unchanged ZIP is not a change', () => {
  assert.strictEqual(zipChanged({ event_zip: '73120' }, { event_zip: '73120' }).changed, false);
});

// A booking that never had a ZIP gaining one is the finalisation working as
// intended, not a re-quote trigger.
test('filling in a ZIP that was empty is not a change worth alerting on', () => {
  assert.strictEqual(zipChanged({ event_zip: '' }, { event_zip: '73120' }).changed, false);
  assert.strictEqual(zipChanged({ event_zip: null }, { event_zip: '73120' }).changed, false);
});

test('a ZIP+4 matching the stored five digits is not a change', () => {
  assert.strictEqual(zipChanged({ event_zip: '73120' }, { event_zip: '73120-4455' }).changed, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../netlify/functions/_finalise.js'`

- [ ] **Step 3: Write `_finalise.js`**

```js
// netlify/functions/_finalise.js — what a client is allowed to change about
// their own booking, and how we notice when that changes the price.
//
// The whitelist is the security boundary for a page authenticated by nothing
// stronger than a booking reference and an email address. Everything absent
// from it is REJECTED and reported, never quietly dropped: a client who edits
// a field and is told "saved" while it was discarded is the silent-failure
// shape this codebase has eighteen documented instances of.

// Deliberately excludes every field that carries money (total_price,
// deposit_amount, balance_due, service_price, mileage_cost, items), workflow
// state (status, deposit_paid), anything internal (admin_notes), and the
// identifiers the auth check itself relies on (id, reference, client_email is
// editable but see the note in finalise.js about re-authentication).
const CLIENT_EDITABLE = Object.freeze([
  'client_name', 'client_phone', 'client_email',
  'event_time', 'event_location', 'event_zip', 'venue', 'surface_type',
  'guest_count', 'child_name', 'guests_of_honour', 'notes',
]);

// Two editable fields have types that matter.
//
// guest_count feeds per-guest add-on pricing, so "lots" must be a rejection
// rather than a NaN that silently zeroes a line.
//
// client_email is half the authentication key. A malformed one does not just
// store bad data — it locks the client out of their own booking AND sends the
// re-issued link into the void, so it is rejected here rather than discovered
// later. Deliberately a shape check, not a validity check: we cannot know if an
// address exists, and rejecting unusual-but-legal addresses would be worse than
// accepting a typo the re-issue notice will surface anyway.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitiseClientEdit(body) {
  const fields = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!CLIENT_EDITABLE.includes(k)) { rejected.push(k); continue; }
    if (k === 'guest_count') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { rejected.push(k); continue; }
      fields[k] = Math.trunc(n);
      continue;
    }
    if (k === 'client_email') {
      const e = String(v || '').trim().toLowerCase();
      if (!EMAIL_SHAPE.test(e)) { rejected.push(k); continue; }
      fields[k] = e;
      continue;
    }
    fields[k] = v;
  }
  return { fields, rejected };
}

// Mileage and travel cost are calculated from event_zip, so a client moving the
// event to a different ZIP after being quoted has changed what the job costs.
// We do not re-price (Joe's ruling 2026-08-15) — we tell a human. Filling in a
// ZIP that was previously empty is the page doing its job, not a re-quote.
function zipChanged(prev, next) {
  const from = String((prev && prev.event_zip) || '').trim().slice(0, 5);
  const to   = String((next && next.event_zip) || '').trim().slice(0, 5);
  if (!from || !to || from === to) return { changed: false, from, to };
  return { changed: true, from, to };
}

module.exports = { CLIENT_EDITABLE, sanitiseClientEdit, zipChanged };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, 288 + 9 = 297

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_finalise.js test/finalise-contract.test.js
git commit -m "feat(finalise): the contract for what a client may change"
```

---

## Task 2: The finalisation endpoint

**Files:**
- Create: `netlify/functions/finalise.js`
- Modify: `netlify.toml` (redirect)
- Test: `test/finalise-endpoint.test.js`

**Interfaces:**
- Consumes: `sanitiseClientEdit`, `zipChanged` (Task 1); `normaliseAddress` from `_address.js`; `logChange`, `sendEmail`, `wrap`, `esc`, **`finaliseLinkFor`** from `_email.js`
- **Ordering note:** `finaliseLinkFor` is written in Task 3 Step 3 but is needed here for the re-issue email. Build that one function first — it is eight lines and has no dependencies — or Task 2 will not run.
- Produces: `GET /api/finalise?reference=&email=` → the client's own booking, wider than `PUBLIC_FIELDS`; `PATCH /api/finalise` → applies a sanitised edit

**Why not extend `bookings.js`:** `PUBLIC_FIELDS` is a deliberate published contract with a comment explaining each exclusion (`venue` "deliberately not exposed publicly", `client_phone` absent). The finalisation page needs a *different, wider* set — a client's own phone number is not a public field, but it is a field they must be able to correct. Widening `PUBLIC_FIELDS` to serve this page would change what every other public consumer sees.

- [ ] **Step 1: Write the failing tests**

Create `test/finalise-endpoint.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildFinaliseResponse, FINALISE_FIELDS } = require('../netlify/functions/finalise.js');

// The client sees their own data, which is a wider set than PUBLIC_FIELDS —
// but it must still never carry anything internal.
test('the finalisation view never exposes internal fields', () => {
  const row = {
    reference: 'FM-1', client_name: 'Dana', client_phone: '4055417953',
    admin_notes: 'chase for deposit', stripe_session_id: 'cs_x',
    stripe_payment_intent_id: 'pi_x', payment_ref: 'x', id: 7,
  };
  const out = buildFinaliseResponse(row);
  assert.strictEqual(out.client_phone, '4055417953', 'their own phone is theirs to correct');
  for (const leak of ['admin_notes', 'stripe_session_id', 'stripe_payment_intent_id', 'payment_ref', 'id']) {
    assert.ok(!(leak in out), `${leak} must not reach the client`);
  }
});

test('every client-editable field is present in the view', () => {
  const { CLIENT_EDITABLE } = require('../netlify/functions/_finalise.js');
  for (const f of CLIENT_EDITABLE) {
    assert.ok(FINALISE_FIELDS.includes(f), `${f} is editable but not readable — the form could not show it`);
  }
});

// The page must be able to tell the client what they owe and offer the link,
// without those being editable.
test('the view carries the money figures read-only', () => {
  const out = buildFinaliseResponse({ total_price: 450, deposit_amount: 100, balance_due: 350, stripe_payment_link: 'https://pay' });
  assert.strictEqual(out.total_price, 450);
  assert.strictEqual(out.deposit_amount, 100);
  assert.strictEqual(out.stripe_payment_link, 'https://pay');
});

// A missing link is the state that must be visible rather than rendering a
// dead button — the admin creates it when sending the email, and if that step
// was skipped the page has to say so.
test('a booking with no payment link says so rather than pretending', () => {
  const out = buildFinaliseResponse({ reference: 'FM-1' });
  assert.strictEqual(out.stripe_payment_link, '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../netlify/functions/finalise.js'`

- [ ] **Step 3: Write `finalise.js`**

```js
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
const { wrap, esc, sendEmail, logChange, ensureBookingChanges, ensureEmailLog } = require('./_email');
const { normaliseAddress } = require('./_address');
const { sanitiseClientEdit, zipChanged } = require('./_finalise');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const NOTIFY = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
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

function buildFinaliseResponse(row) {
  const out = {};
  for (const f of FINALISE_FIELDS) out[f] = row[f] ?? (typeof row[f] === 'number' ? 0 : '');
  // An absent link must read as absent so the page can say "we'll send this
  // shortly" rather than rendering a button that goes nowhere.
  out.stripe_payment_link = row.stripe_payment_link || '';
  return out;
}

// Shared auth. Returns the row or null; the caller 404s either way so a
// wrong reference and a wrong email are indistinguishable from outside.
async function authenticate(c, reference, email) {
  const { rows } = await c.query('SELECT * FROM bookings WHERE reference = $1', [String(reference || '').toUpperCase()]);
  if (!rows.length) return null;
  if ((rows[0].client_email || '').toLowerCase() !== String(email || '').trim().toLowerCase()) return null;
  return rows[0];
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    return withClient(async (c) => {
      const booking = await authenticate(c, qs.reference, qs.email);
      if (!booking) return json(404, { error: 'Booking not found' });
      return json(200, { booking: buildFinaliseResponse(booking) });
    });
  }

  if (event.httpMethod === 'PATCH' || event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const { reference, email, updates } = body;

    return withClient(async (c) => {
      await ensureBookingChanges(c);
      await ensureEmailLog(c);

      const booking = await authenticate(c, reference, email);
      if (!booking) return json(404, { error: 'Booking not found' });

      // A booking already paid for is finished being finalised. Editing it here
      // would change details the crew may already be working from.
      if (booking.deposit_paid) {
        return json(409, { error: 'This booking is already confirmed. Call us on (405) 431-6625 to change anything.' });
      }

      const { fields, rejected } = sanitiseClientEdit(updates);
      if (rejected.length) console.error('finalise: rejected fields for', booking.reference, '|', rejected.join(', '));
      if (!Object.keys(fields).length) return json(400, { error: 'Nothing to save', rejected });

      // Keep the ZIP out of the address line, same as every other writer.
      if (fields.event_location !== undefined || fields.event_zip !== undefined) {
        const addr = normaliseAddress(
          fields.event_location !== undefined ? fields.event_location : booking.event_location,
          fields.event_zip      !== undefined ? fields.event_zip      : booking.event_zip
        );
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

      for (const k of keys) {
        if (String(booking[k] ?? '') !== String(updated[k] ?? '')) {
          await logChange(c, booking.id, 'Client finalised details', `${k}: "${booking[k] ?? ''}" → "${updated[k] ?? ''}"`);
        }
      }

      // The ZIP prices the job. Changing it does NOT re-price (Joe's ruling
      // 2026-08-15) — a client watching their total move mid-checkout is the
      // worst moment for it. Tell a human and let them decide.
      const zip = zipChanged(booking, updated);
      if (zip.changed) {
        await logChange(c, booking.id, 'ZIP changed by client — price NOT recalculated', `${zip.from} → ${zip.to}`);
        try {
          await sendEmail(NOTIFY,
            `⚠ ZIP changed after quote — ${updated.reference}`,
            wrap(`<h2>The client moved the event</h2>
              <p><strong>${esc(updated.client_name || 'A client')}</strong> changed the ZIP on <strong>${esc(updated.reference)}</strong> while finalising their details.</p>
              <p><strong>Quoted from:</strong> ${esc(zip.from)}<br/><strong>Now:</strong> ${esc(zip.to)}</p>
              <p><strong>Address:</strong> ${esc(updated.event_location || '')}</p>
              <p>The total is unchanged at $${Number(updated.total_price || 0).toFixed(2)} — mileage was <em>not</em> recalculated. Re-quote if the drive is materially different.</p>
              <a href="${SITE}/admin.html" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>`));
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
            await sendEmail(booking.client_email,
              `Contact email changed on your booking — ${updated.reference}`,
              wrap(`<h2>Your contact email was changed</h2>
                <p>The email address on booking <strong>${esc(updated.reference)}</strong> was just changed to <strong>${esc(updated.client_email)}</strong>.</p>
                <p><strong>If this was you, nothing further is needed</strong> — your new link has been sent to that address.</p>
                <p>If it was not you, call us straight away on <a href="tel:+14054316625">(405) 431-6625</a>.</p>`));
          } catch (e) {
            console.error('finalise: old-address change notice FAILED for', updated.reference, '|', e.message);
          }
        }

        try {
          await sendEmail(updated.client_email,
            `Your updated booking link — ${updated.reference}`,
            wrap(`<h2>Here is your new link</h2>
              <p>Your contact email is now <strong>${esc(updated.client_email)}</strong>, so your previous link no longer works. Use this one from now on:</p>
              <p><a href="${finaliseLinkFor(updated)}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open my booking</a></p>`));
        } catch (e) {
          // The change has committed and their page keeps working for this
          // session (Task 4 Step 4 updates it in place). A failed re-issue
          // means only that they have no link for NEXT time — loud, not fatal.
          console.error('finalise: link re-issue FAILED for', updated.reference, '|', e.message);
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
```

- [ ] **Step 4: Add the redirect**

Append to `netlify.toml`:

```toml
[[redirects]]
  from = "/api/finalise"
  to = "/.netlify/functions/finalise"
  status = 200
```

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/finalise.js netlify.toml test/finalise-endpoint.test.js
git commit -m "feat(finalise): client-authenticated endpoint to complete their own details"
```

---

## Task 3: The link, the token, and the admin action

**Files:**
- Modify: `netlify/functions/_email.js` (add `{{finalise_link}}` to `render`)
- Modify: `netlify/functions/_sms.js` (add `{{finalise_link}}` to `renderSms`)
- Modify: `netlify/functions/create-stripe-link.js` (return the link so the admin can chain)
- Modify: `admin.html` (a "Send finalisation link" action on the booking detail)
- Test: `test/finalise-token.test.js`

**Interfaces:**
- Produces: `finaliseLinkFor(booking) -> string` exported from `_email.js`, used by both renderers

- [ ] **Step 1: Write the failing test**

Create `test/finalise-token.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { render, finaliseLinkFor } = require('../netlify/functions/_email.js');
const { renderSms } = require('../netlify/functions/_sms.js');

const BOOKING = { reference: 'FM-MUDVW9PM', client_email: 'dana@example.com', client_name: 'Dana Ruiz' };

test('the finalisation link carries the reference and the email', () => {
  const url = finaliseLinkFor(BOOKING);
  assert.match(url, /my-booking\.html/);
  assert.match(url, /ref=FM-MUDVW9PM/);
  assert.match(url, /email=dana%40example\.com/, 'the email must be URL-encoded or the link breaks on the @');
});

// A booking with no email cannot be finalised by link — the auth needs it.
// Better an empty token than a link that 404s the moment it is clicked.
test('a booking with no client email produces no link', () => {
  assert.strictEqual(finaliseLinkFor({ reference: 'FM-1' }), '');
});

test('{{finalise_link}} renders in email templates', () => {
  const out = render('Click here: {{finalise_link}}', BOOKING);
  assert.match(out, /ref=FM-MUDVW9PM/);
  assert.doesNotMatch(out, /{{finalise_link}}/);
});

// The SMS renderer has its own token list; a token that works in one and not
// the other is exactly the divergence the shared rule editor invites.
test('{{finalise_link}} renders in SMS templates too', () => {
  const out = renderSms('Finish up: {{finalise_link}}', BOOKING);
  assert.match(out, /ref=FM-MUDVW9PM/);
  assert.doesNotMatch(out, /{{finalise_link}}/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `finaliseLinkFor is not a function`

- [ ] **Step 3: Add `finaliseLinkFor` to `_email.js`**

Add above `render`, and to the export list:

```js
// The one link a client needs to complete their booking. Both the email and
// the SMS renderer use this, so the two cannot drift into pointing at
// different pages — a divergence the shared rule editor actively invites,
// since {{deposit_link}} and {{payment_link}} already differ between them.
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
```

In `render`, add the token alongside the others:

```js
    .replace(/{{finalise_link}}/g,     finaliseLinkFor(booking))
```

- [ ] **Step 4: Add the same token to `_sms.js`**

`_sms.js` already imports from `_email.js`. Extend that import to include `finaliseLinkFor`, and add to `renderSms`:

```js
    .replace(/{{finalise_link}}/g,     finaliseLinkFor(booking))
```

- [ ] **Step 5: Add the admin action**

On the booking detail in `admin.html`, beside the existing actions, add a button that (a) ensures a Stripe deposit link exists, then (b) emails the client the finalisation link. The link must exist *before* the email goes out — a public endpoint that mints Stripe sessions is explicitly out of scope, so the page can only ever surface a link the admin already created.

```js
async function sendFinalisationLink(id) {
  const b = allBookings.find(x => String(x.id) === String(id));
  if (!b) return;
  if (!b.client_email) { alert('This booking has no client email, so there is nobody to send the link to.'); return; }
  if (!confirm(`Email ${b.client_email} a link to finalise their details and pay the deposit?`)) return;
  try {
    // Create the deposit link first. The finalisation page only ever surfaces
    // a link that already exists — it cannot create one, by design.
    if (!b.stripe_payment_link) {
      const linkRes = await apiFetch('/api/create-stripe-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_id: b.id })
      });
      if (!linkRes.ok) throw new Error('Could not create the deposit link');
    }
    const res = await apiFetch('/api/automations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send_manual', booking_id: b.id,
        subject: `Finalise your booking — ${b.reference}`,
        html: `<p>Hi ${esc((b.client_name||'').split(' ')[0] || 'there')}!</p>
               <p>Please review your details, fill in anything missing, and pay your deposit to secure the date:</p>
               <p><a href="${finaliseLinkClient(b)}">Finalise my booking</a></p>` })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Send failed');
    alert('Sent.');
  } catch (e) { alert('Could not send: ' + e.message); }
}

// Mirrors finaliseLinkFor() in _email.js. Duplicated deliberately — admin.html
// is a static page with no access to server modules — so if that one changes,
// change this in the same commit.
function finaliseLinkClient(b) {
  if (!b.reference || !b.client_email) return '';
  return `${location.origin}/my-booking.html?ref=${encodeURIComponent(b.reference)}&email=${encodeURIComponent(b.client_email)}`;
}
```

- [ ] **Step 6: Run the tests and commit**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

```bash
git add netlify/functions/_email.js netlify/functions/_sms.js admin.html test/finalise-token.test.js
git commit -m "feat(finalise): {{finalise_link}} token and the admin send action"
```

---

## Task 4: The client page

**Files:**
- Modify: `my-booking.html`

**Interfaces:**
- Consumes: `GET /api/finalise`, `PATCH /api/finalise` (Task 2)

- [ ] **Step 1: Accept the link's query parameters**

`my-booking.html` currently asks for reference and email in a form. When `?ref=` and `?email=` are present, prefill both and look up immediately, so the client lands on their booking rather than on a login they must retype. Keep the manual form for anyone arriving without a link.

```js
  // Arriving from a finalisation email: the link carries both halves of the
  // auth, so do not make them retype what we just sent them.
  const params = new URLSearchParams(location.search);
  if (params.get('ref') && params.get('email')) {
    document.getElementById('reference').value = params.get('ref');
    document.getElementById('email').value = params.get('email');
    lookupBooking();
  }
```

- [ ] **Step 2: Fetch from the finalisation endpoint**

Point the lookup at `/api/finalise?reference=&email=` rather than `/api/bookings`, so the page receives the wider field set it needs to render the form.

- [ ] **Step 3: Render the editable form**

For a booking that is **not** `deposit_paid`, render each `CLIENT_EDITABLE` field as an input. Empty fields are the point — they are what the client is being asked to complete — so mark them visibly rather than leaving them looking optional. Read-only: service, date, total, deposit amount.

- [ ] **Step 4: Save, then pay**

One button saves via `PATCH /api/finalise`. On success:

- If the response carries `emailChanged: true`, **update the email this page authenticates with** before doing anything else. The client is holding a link with their old address; without this the very next save — or the page reload after payment — 404s on a booking they are looking at.

```js
  // The email is half the auth key. It just changed, so the key this page
  // holds is stale — swap it in place rather than making them dig a new link
  // out of their inbox mid-flow.
  if (data.emailChanged) {
    document.getElementById('email').value = data.booking.client_email;
    currentBooking.client_email = data.booking.client_email;
    history.replaceState(null, '', `?ref=${encodeURIComponent(data.booking.reference)}&email=${encodeURIComponent(data.booking.client_email)}`);
    showNotice(`Your email is now ${data.booking.client_email}. We've sent a new link there for next time.`);
  }
```

- If `stripe_payment_link` is present, show the deposit button pointing at it.
- If it is absent, say so plainly — *"Your details are saved. We'll email your deposit link shortly."* — rather than rendering a dead button. This is the state that occurs when the admin sent the link before a Stripe link existed.

- [ ] **Step 5: Handle the already-paid case**

A booking with `deposit_paid` renders read-only with a note to call. The endpoint returns 409 for this, so the page must not offer a form it cannot submit.

- [ ] **Step 6: Verify in a browser**

Serve the page locally and confirm: the link prefills and looks up; empty fields are visibly flagged; saving persists; a ZIP change saves without the total moving; an already-paid booking shows read-only. Screenshot the finalisation form.

- [ ] **Step 7: Commit**

```bash
git add my-booking.html
git commit -m "feat(finalise): clients complete their own details, then pay"
```

---

## Task 5: Go-live (manual, Joe)

- [ ] **Step 1: Deploy** — push, Netlify → Trigger deploy, confirm Published.

- [ ] **Step 2: End-to-end on a real booking of your own.** Create a test booking with your own email, send yourself the finalisation link, complete the details, pay the deposit with a real card, and confirm the booking flips to `confirmed` via the Stripe webhook.

- [ ] **Step 3: Check the ZIP alert fires.** Change the ZIP on a test booking through the client page and confirm you get the ⚠ email and that the total did **not** move.

- [ ] **Step 4: Replace the email template.** Your draft's `[client.link.finalisation]` placeholder becomes `{{finalise_link}}`. Put the real copy into an automation rule on the `accepted` status change so it sends itself, rather than being a manual step.

---

## Self-review notes

**Spec coverage.** The flow Joe described — click in, finalise details, pay the deposit — is carried by Tasks 2, 3 and 4. Both of his rulings are implemented and tested: a ZIP change alerts rather than re-prices (Task 1 `zipChanged`, Task 2 alert), and payment happens in the same flow (Task 4 Step 4) off a link the admin created (Task 3 Step 5).

**Three things I want flagged before anyone builds this:**

1. **The auth is modest.** Reference + email in a URL means anyone forwarded that email can edit the booking. I chose it for consistency — the same key already gates `accept-quote.js`, which commits a client to a quote — and the editable set carries no money. But it is a real widening of what that key permits, and if it ever feels wrong the upgrade is a signed expiring token, which is a contained change to `authenticate()` and `finaliseLinkFor()`.

2. **`client_email` is editable, and it is half the auth key — resolved.** Joe's ruling (2026-08-15): re-issue the link when it changes. Task 1 rejects a malformed address before it can reach the database, Task 2 re-issues to the new address and — more importantly — notifies the OLD one, and Task 4 swaps the key the open page is using so the client's session survives. The notice to the previous address is the security control this flow otherwise lacks: with auth being a reference plus an email, anyone forwarded the original message could otherwise change the contact address and take the booking over silently.

3. **`finaliseLinkFor` is duplicated in `admin.html`.** A static page cannot import a server module. Marked in both places; if a third copy ever appears, that is the signal to serve the link from an endpoint instead.
