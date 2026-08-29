const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized, forbidden } = require('./_auth');
const { notifyMatchingStaff } = require('./staff-assignments');
const { normaliseBrand } = require('./_brand');
const { ensureBookingItems, replaceItems, rollupItems, normaliseItems, getItems, getItemsForBookings } = require('./_items');
const { sendSms } = require('./_sms');
const { sendTemplate } = require('./automations');
const { normaliseAddress } = require('./_address');
const { getDriveMins } = require('./_schedule');
const { ensureTables: ensureCampTables } = require('./camps');
const { generateReference } = require('./_reference');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// The exact consent wording shown beside the checkbox on booking-form.html.
// Stored verbatim on any booking that consents, because the evidentiary
// question is never "did a box get ticked" but "what did they agree to". If the
// form's wording changes, change it here in the same commit — a consent record
// that quotes wording nobody ever saw is worse than no record.
const SMS_CONSENT_TEXT = "Yes, send me text messages about my booking at the number above. You'll get booking confirmations, deposit and payment links, a reminder before your event, and a review request afterwards — around 2-5 messages per booking. Msg & data rates may apply. Reply STOP to cancel, HELP for help. Consent is not a condition of booking.";

// The opt-in confirmation, sent once, immediately after a customer ticks the
// consent box. Declared verbatim on the A2P 10DLC campaign, so the registered
// text and the sent text are the same string by construction. Carrier rules
// require all four: brand name, message frequency, the rates disclaimer, and
// both keywords. Two segments.
const SMS_OPT_IN_MESSAGE = "Funky Monkey Events: you are signed up for text updates about your booking. Around 2-5 msgs per booking. Msg & data rates may apply. Reply STOP to cancel, HELP for help.";

// Public field subset per API contract.
//
// Every name here must be a real bookings column: pickPublicFields does
// `row[f] ?? null`, so a name that is not one serialises as null forever
// without erroring. start_time, end_time, venue_name and event_address were
// exactly that until 2026-08-12 — four nulls in every public response, no
// column, no writer, no reader. The live columns are `event_location` (the
// address, already listed) and `venue` (the venue name, deliberately not
// exposed publicly).
const PUBLIC_FIELDS = [
  'reference', 'status', 'service_id', 'service_name', 'event_type',
  'event_date', 'event_time', 'event_zip', 'event_location',
  'guest_count',
  'client_name', 'client_email', 'addons', 'total_price', 'mileage_cost',
  'deposit_amount', 'deposit_paid', 'balance_due', 'payment_amount', 'created_at',
  'items',
];

function pickPublicFields(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = row[f] ?? null;
  return out;
}

let schemaReady;
async function ensureTable(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      reference VARCHAR(20) UNIQUE,
      status VARCHAR(32) DEFAULT 'review',

      service_id VARCHAR(64),
      service_name VARCHAR(255),
      service_price NUMERIC(10,2),
      addons JSONB DEFAULT '[]',
      addon_total NUMERIC(10,2) DEFAULT 0,
      mileage_cost NUMERIC(10,2) DEFAULT 0,
      mileage_miles INTEGER DEFAULT 0,
      total_price NUMERIC(10,2),
      deposit_amount NUMERIC(10,2) DEFAULT 100,
      balance_due NUMERIC(10,2),
      deposit_paid BOOLEAN DEFAULT FALSE,
      deposit_paid_at TIMESTAMPTZ,
      stripe_session_id VARCHAR(255),
      stripe_payment_intent_id VARCHAR(255),
      stripe_payment_link TEXT DEFAULT '',

      event_date DATE,
      event_time VARCHAR(10),
      event_zip VARCHAR(10),
      event_location TEXT DEFAULT '',
      event_type VARCHAR(100),
      guest_count INTEGER,
      notes TEXT DEFAULT '',

      client_name VARCHAR(255),
      client_phone VARCHAR(50),
      client_email VARCHAR(255),
      referral_source VARCHAR(100) DEFAULT '',

      admin_notes TEXT DEFAULT '',
      contract_signed BOOLEAN DEFAULT FALSE,

      event_type_id VARCHAR(64) DEFAULT '',
      is_custom_quote BOOLEAN DEFAULT FALSE,
      extra_hours INTEGER DEFAULT 0,
      extra_hours_cost NUMERIC(10,2) DEFAULT 0,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add any missing columns for backwards compat
  const cols = [
    // Express SMS consent, captured at the booking form. NOT a duplicate of
    // sms_optout: that is a global STOP list, this is the positive record that
    // this person agreed, when, and to what wording. Carrier vetting requires
    // the affirmative act; this is where the evidence of it lives.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_consent_text TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference VARCHAR(20)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'review'",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_id VARCHAR(64)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_name VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_price NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons JSONB DEFAULT '[]'",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_total NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mileage_cost NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mileage_miles INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_price NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 100",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN DEFAULT FALSE",
    // A record of the service fee Stripe collected on balance payments, so
    // payouts reconcile against the books. Never an input: it is deliberately
    // absent from balance_due, total_price and balanceIsDerivable()'s formula.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_fee_collected NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_link TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_link TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_date DATE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_time VARCHAR(10)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_zip VARCHAR(10)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_location TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type VARCHAR(100)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_count INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email VARCHAR(255)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS referral_source VARCHAR(100) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contract_signed BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_note TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type_id VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_custom_quote BOOLEAN DEFAULT FALSE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_hours INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_hours_cost NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS child_name VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests_of_honour VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_type VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS venue VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmation_deadline DATE",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_ref VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS brand VARCHAR(8) DEFAULT 'fme'",
    // ── Admin direct entry (spec 2026-08-01) ──
    // Surface type drives foam party setup and liability; organisation_name
    // gives corporate and library bookings somewhere to record the org;
    // occasion frees event_type from doing double duty.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS surface_type VARCHAR(64) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS organisation_name VARCHAR(255) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS occasion VARCHAR(64) DEFAULT ''",
    // The deposit becomes its own payment record. payment_method/amount/ref
    // stay as the final-balance record — accounting-export.js:57 already
    // treats them that way.
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_method VARCHAR(50) DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_ref VARCHAR(255) DEFAULT ''"
  ];
  for (const sql of cols) {
    try { await client.query(sql); } catch (_) {}
  }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};

    // GET single booking by reference — public requires ?email matching
    if (qs.reference) {
      const ref = qs.reference.toUpperCase();

      // Check for admin token first (bypasses email requirement)
      const auth = await requireAuth(event, ['admin']);
      if (auth) {
        // Admin: full row
        return withClient(async (client) => {
          await ensureTable(client);
          await ensureBookingItems(client);
          const { rows } = await client.query(
            'SELECT * FROM bookings WHERE reference = $1',
            [ref]
          );
          if (!rows.length) return json(404, { error: 'Not found' });
          rows[0].items = await getItems(client, rows[0].id);
          return json(200, { bookings: rows });
        });
      }

      // Public: require email param, case-insensitive match — 404 on any mismatch
      const emailParam = (qs.email || '').trim().toLowerCase();
      if (!emailParam) return json(404, { error: 'Not found' });

      return withClient(async (client) => {
        await ensureTable(client);
        await ensureBookingItems(client);
        const { rows } = await client.query(
          'SELECT * FROM bookings WHERE reference = $1',
          [ref]
        );
        // Return 404 on not-found OR email mismatch (don't reveal existence)
        if (!rows.length) return json(404, { error: 'Not found' });
        if ((rows[0].client_email || '').toLowerCase() !== emailParam) {
          return json(404, { error: 'Not found' });
        }
        rows[0].items = await getItems(client, rows[0].id);
        return json(200, { bookings: [pickPublicFields(rows[0])] });
      });
    }

    // GET availability by service_id+date — admin or staff
    if (qs.service_id && qs.date) {
      const auth = await requireAuth(event, ['admin', 'staff']);
      if (!auth) return unauthorized();
      return withClient(async (client) => {
        await ensureTable(client);
        const { rows } = await client.query(
          `SELECT * FROM bookings WHERE service_id=$1 AND event_date=$2`,
          [qs.service_id, qs.date]
        );
        return json(200, rows);
      });
    }

    // GET all/filtered — admin only
    const auth = await requireAuth(event, ['admin']);
    if (!auth) return unauthorized();

    return withClient(async (client) => {
      await ensureTable(client);
      // Optional filters for agent delta-sync: ?brand=jcm|fme, ?since=ISO-date
      const conditions = [];
      const params = [];
      if (qs.brand) {
        params.push(qs.brand);
        conditions.push(`brand = $${params.length}`);
      }
      if (qs.since && !isNaN(Date.parse(qs.since))) {
        params.push(qs.since);
        conditions.push(`updated_at >= $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await client.query(
        `SELECT * FROM bookings ${where} ORDER BY created_at DESC`,
        params
      );
      await ensureBookingItems(client);
      const itemMap = await getItemsForBookings(client, rows.map(r => r.id));
      // zip_known: whether _schedule.js's ONE ZIP table recognises this
      // booking's event_zip. admin.html's dashboard uses it to flag an
      // upcoming gig whose drive/departure time is a guess, without keeping
      // its own copy of the ZIP table (see needsZipEstimate in admin.html).
      for (const r of rows) {
        r.items = itemMap.get(r.id) || [];
        r.zip_known = getDriveMins(r.event_zip).zipKnown;
      }
      return json(200, rows);
    });
  }

  // ── POST new booking (public) ────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let b;
    try {
      b = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }

    // ── Admin draft path (spec 2026-08-01) ────────────────────────────────────
    // A booking taken over the phone rarely has an email to hand. An
    // authenticated admin may post status:'draft' and skip the four required
    // fields. Everything below — length caps, numeric clamping, NaN rejection —
    // still applies, so a draft cannot write a malformed row. The relaxation is
    // gated on the token, not on the 'draft' string, so the public form cannot
    // post itself a draft to bypass validation.
    const isDraft = b.status === 'draft';
    if (isDraft) {
      const auth = await requireAuth(event, ['admin']);
      if (!auth) return unauthorized();
    }

    // ── Validation (contract §POST /api/bookings) ────────────────────────────
    const clientName = String(b.client_name || '').trim();
    // Strict true. An absent field, a string, or anything else is NOT consent —
    // this is the record that says a person affirmatively agreed, so it must
    // never be produced by a truthy accident.
    const smsConsent = b.sms_consent === true;

    // The ZIP belongs in event_zip and nowhere else — _address.js's fullAddress
    // has always excluded it, but a hand-typed or pasted address arrives with it
    // attached. Split here, at the writer, so every path stores the same shape.
    const addr = normaliseAddress(b.event_location, b.event_zip);
    if (addr.conflict) console.error('booking address/ZIP disagree:', addr.conflict, '| client:', clientName);
    if (!isDraft && !clientName) return json(400, { error: 'client_name is required' });
    if (clientName.length > 120) return json(400, { error: 'client_name too long (max 120)' });

    const clientEmail = String(b.client_email || '').trim();
    if (!isDraft && !clientEmail) return json(400, { error: 'client_email is required' });
    if (clientEmail.length > 200) return json(400, { error: 'client_email too long (max 200)' });
    // Plausible email check — applies whenever one is supplied, draft or not
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return json(400, { error: 'client_email is not valid' });
    }

    // A date is required unless this is a draft, but a supplied date must
    // always parse. Empty string becomes NULL — Postgres rejects '' for DATE.
    if (!isDraft && (!b.event_date || isNaN(Date.parse(String(b.event_date))))) {
      return json(400, { error: 'event_date must be a parseable date' });
    }
    if (b.event_date && isNaN(Date.parse(String(b.event_date)))) {
      return json(400, { error: 'event_date must be a parseable date' });
    }
    const eventDate = b.event_date || null;

    if (!isDraft && !b.service_id && !b.service_name) {
      return json(400, { error: 'service_id or service_name is required' });
    }

    // normaliseBrand throws on an unknown value; an uncaught throw here would
    // surface as an opaque 500, so translate it into a 400 that names the
    // offending brand.
    let brand;
    try {
      brand = normaliseBrand(b.brand);
    } catch (e) {
      return json(400, { error: e.message });
    }

    // Clamp / sanitize numerics — reject NaN
    const rawGuestCount = b.guest_count !== undefined ? Number(b.guest_count) : 0;
    if (isNaN(rawGuestCount)) return json(400, { error: 'guest_count must be a number' });
    const guestCount = Math.min(Math.max(Math.floor(rawGuestCount), 0), 10000);

    const clampPrice = (v, label) => {
      const n = Number(v);
      if (v !== undefined && v !== null && v !== '' && isNaN(n)) {
        throw Object.assign(new Error(`${label} must be a number`), { statusCode: 400 });
      }
      return Math.min(Math.max(n || 0, 0), 100000);
    };

    let servicePrice, addonTotal, mileageCost, totalPrice, extraHoursCost;
    try {
      servicePrice    = clampPrice(b.service_price,    'service_price');
      addonTotal      = clampPrice(b.addon_total,       'addon_total');
      mileageCost     = clampPrice(b.mileage_cost,      'mileage_cost');
      totalPrice      = clampPrice(b.total_price,       'total_price');
      extraHoursCost  = clampPrice(b.extra_hours_cost,  'extra_hours_cost');
    } catch (e) {
      return json(400, { error: e.message });
    }

    const rawExtraHours = b.extra_hours !== undefined ? Number(b.extra_hours) : 0;
    if (isNaN(rawExtraHours)) return json(400, { error: 'extra_hours must be a number' });
    const extraHours = Math.max(0, Math.floor(rawExtraHours));

    const rawMileageMiles = b.mileage_miles !== undefined ? Number(b.mileage_miles) : 0;
    const mileageMiles = Math.max(0, Math.floor(isNaN(rawMileageMiles) ? 0 : rawMileageMiles));

    // A day of a camp — set only by admin.html's "+ Day" flow, which always
    // supplies a real camp's id. Anything else (missing, 0, non-numeric)
    // stores NULL, which is exactly how every booking behaves today.
    const campId = b.camp_id ? (Number(b.camp_id) || null) : null;

    // Trim strings, cap free text at 5000
    const cap5k = (v) => String(v || '').trim().slice(0, 5000);
    const cap255 = (v) => String(v || '').trim().slice(0, 255);

    // Get deposit_amount from request or default to 100
    const depositAmount = Math.min(Math.max(Number(b.deposit_amount) || 100, 0), 100000);

    // Balance calc: total_price + mileage_cost - deposit_amount
    const balanceDue = Math.max(0, totalPrice + mileageCost - depositAmount);

    return withClient(async (client) => {
      await ensureTable(client);
      // Guarantees bookings.camp_id exists before it's referenced below —
      // see camps.js's comment on why this can't just live in ensureTable.
      await ensureCampTables(client);

      // Retry loop for unique reference
      let reference;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateReference();
        const { rows: existing } = await client.query(
          'SELECT 1 FROM bookings WHERE reference=$1', [candidate]
        );
        if (!existing.length) { reference = candidate; break; }
      }
      if (!reference) return json(500, { error: 'Could not generate unique reference' });

      // A cleared <date> input posts '' — Postgres rejects that for
      // TIMESTAMPTZ. Same treatment event_date already gets above.
      const depositPaidAt = b.deposit_paid_at ? b.deposit_paid_at : null;

      const { rows } = await client.query(`
        INSERT INTO bookings (
          reference, status,
          service_id, service_name, service_price,
          addons, addon_total, mileage_cost, mileage_miles,
          total_price, deposit_amount, balance_due,
          event_date, event_time, event_zip, event_location,
          event_type, event_type_id, guest_count, notes,
          is_custom_quote, extra_hours, extra_hours_cost,
          client_name, client_phone, client_email, referral_source,
          child_name, brand,
          organisation_name, occasion, surface_type, venue, customer_type,
          guests_of_honour, deposit_paid_at, deposit_method, deposit_ref,
          sms_consent, sms_consent_at, sms_consent_text, camp_id
        ) VALUES (
          $1, $29,
          $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18, $19,
          $20, $21, $22,
          $23, $24, $25, $26,
          $27, $28,
          $30, $31, $32, $33, $34,
          $35, $36, $37, $38,
          $39, $40, $41, $42
        ) RETURNING *
      `, [
        reference,
        cap255(b.service_id),
        cap255(b.service_name),
        servicePrice,
        JSON.stringify(b.addons || []),
        addonTotal,
        mileageCost,
        mileageMiles,
        totalPrice,
        depositAmount,
        balanceDue,
        eventDate,
        cap255(b.event_time),
        cap255(addr.zip),
        cap5k(addr.location),
        cap255(b.event_type),
        cap255(b.event_type_id),
        guestCount,
        cap5k(b.notes),
        b.is_custom_quote === true,
        extraHours,
        extraHoursCost,
        clientName,
        cap255(b.client_phone),
        clientEmail,
        cap255(b.referral_source),
        cap255(b.child_name),
        brand,
        isDraft ? 'draft' : 'review',
        cap255(b.organisation_name),
        cap255(b.occasion),
        cap255(b.surface_type),
        cap255(b.venue),
        cap255(b.customer_type),
        cap255(b.guests_of_honour),
        depositPaidAt,
        cap255(b.deposit_method),
        cap255(b.deposit_ref),
        smsConsent,
        smsConsent ? new Date() : null,
        smsConsent ? SMS_CONSENT_TEXT : '',
        campId,
      ]);

      const booking = rows[0];

      // Opt-in confirmation. Carrier rules require the first message after
      // consent to name the brand, the frequency, the rates disclaimer and both
      // keywords — and the campaign registration declares this exact text, so it
      // has to actually be sent. Fire-and-forget: sendSms does not throw, but a
      // cold ensureSmsTables can, and nothing here may cost the customer their
      // booking.
      if (smsConsent && booking.client_phone) {
        sendSms(client, booking.client_phone, SMS_OPT_IN_MESSAGE, {
          booking_id: booking.id, trigger_label: 'Opt-in confirmation'
        }).catch(e => console.error('opt-in confirmation SMS failed:', e.message));
      }

      // Items are authoritative when supplied. The legacy columns are then
      // derived, never hand-set, so there is one definition of the price.
      let items = [];
      const posted = normaliseItems(b.items);
      if (posted.length) {
        await ensureBookingItems(client);
        items = await replaceItems(client, booking.id, posted);
        const roll = rollupItems(items);
        const newBalance = Math.max(0, roll.total_price + roll.mileage_cost - Number(booking.deposit_amount || 0));
        const { rows: re } = await client.query(
          `UPDATE bookings SET service_id=$1, service_name=$2, service_price=$3,
                  addons=$4, addon_total=$5, mileage_cost=$6, total_price=$7,
                  balance_due=$8, updated_at=NOW()
           WHERE id=$9 RETURNING *`,
          [roll.service_id, roll.service_name, roll.service_price,
           JSON.stringify(roll.addons), roll.addon_total, roll.mileage_cost,
           roll.total_price, newBalance, booking.id]
        );
        Object.assign(booking, re[0]);
      }

      // Await both — in a serverless function the container may terminate as soon
      // as the handler returns, dropping any unawaited fetch calls to Resend.
      // Drafts send nothing: the record is half-finished, the client may have no
      // email address yet, and the owner is on the phone with them right now.
      if (!isDraft) {
        await sendBookingEmails(client, booking);
        await notifyMatchingStaff(booking).catch(e => console.error('Staff notify error:', e.message));
      }

      // `booking` is additive — booking-form.html reads `reference` and is
      // unaffected. The admin UI needs the full row for its local state.
      return json(201, { success: true, reference: booking.reference, id: booking.id, booking, items });
    });
  }

  return json(405, { error: 'Method not allowed' });
};

// Send admin notification then client acknowledgment, both awaited so the
// serverless container doesn't terminate before the Resend calls complete.
// Each is caught independently so admin failure never blocks client email.
//
// Both bodies used to be HTML literals here. They are rows in automation_rules
// now — 'new_booking_alert' and 'booking_request_received' — so the wording is
// editable in the Automations tab, and both sends land in email_log, which the
// client acknowledgment never did.
async function sendBookingEmails(c, booking) {
  for (const key of ['new_booking_alert', 'booking_request_received']) {
    try {
      const r = await sendTemplate(c, booking, key, null, {
        extra: {
          // A booking with no price yet says so rather than quoting $0.00, and
          // prints no balance line at all. The whole line is the token: a
          // conditional sentence is not a conditional word.
          total_line: Number(booking.total_price) > 0
            ? `<p><strong>Estimated Total:</strong> $${Number(booking.total_price).toFixed(2)}</p>` +
              `<p><strong>Balance Due at Event:</strong> $${Number(booking.balance_due || 0).toFixed(2)}</p>`
            : '<p><em>A custom quote will be included in our follow-up.</em></p>',
        }
      });
      if (!r.sent) console.error(`sendBookingEmails: ${key} not sent —`, r.error);
    } catch (e) {
      // One failed send must never skip the other.
      console.error(`sendBookingEmails: ${key} threw —`, e.message);
    }
  }
}


