// booking_items — one row per thing being sold on a booking.
//
// The legacy bookings.service_* / addons / addon_total / mileage_cost columns
// remain the contract for invoices, Stripe, the accounting export and the PPM
// sync. rollupItems() is the single place that derives them from the items, so
// there is exactly one definition of what a booking costs.

// 'discount' is entered as a POSITIVE amount and subtracted in rollupItems.
// The alternative — a negative price — would mean relaxing clampPrice, which is
// the one guard stopping a malformed payload from writing a negative line into
// any of the four money columns. One kind that flips sign in one place beats a
// sign that can appear anywhere.
// The one decider for a free-text service name -> catalogue service_id, shared
// with import-bookings.js and scripts/backfill-service-ids.js.
const { resolveServiceId, norm, catalogueServiceIds } = require('./_service-map');
const { platformBooked, platformLabel } = require('./_source');

const ITEM_KINDS = ['service', 'addon', 'travel', 'custom', 'discount'];

// ponytail: 50 lines is far past any real package (the largest historical
// booking has 4). The cap exists so a malformed client payload cannot write
// unbounded rows, not because 50 is meaningful.
const MAX_ITEMS = 50;

// Memoized per function instance, matching bookings.js's `schemaReady`. The
// two IF NOT EXISTS statements are no-ops after the first call, but they are
// still two network round trips to Neon on every request, and this now runs
// on the admin list path. A failed run nulls the memo so it is retried
// rather than caching the failure.
let itemsReady;
async function ensureBookingItems(client) {
  if (!itemsReady) {
    itemsReady = (async () => {
      await client.query(`
    CREATE TABLE IF NOT EXISTS booking_items (
      id         SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      service_id VARCHAR(64)  DEFAULT '',
      name       VARCHAR(255) NOT NULL,
      price      NUMERIC(10,2) NOT NULL DEFAULT 0,
      quantity   INTEGER      NOT NULL DEFAULT 1,
      kind       VARCHAR(16)  NOT NULL DEFAULT 'service',
      sort_order INTEGER      DEFAULT 0,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id, sort_order)'
      );
    })().catch(e => { itemsReady = null; throw e; });
  }
  return itemsReady;
}

function clampPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100000);
}

// Accepts whatever the admin UI or a client posts and returns rows safe to
// write. Anything nameless is dropped — a line item with no description is not
// a line item.
// A service row whose name matches the catalogue but carries no service_id gets
// one here. That link is the ONLY join to staff_slots and the time templates, so
// a row without it produces a gig that can be assigned nobody and whose shift
// window falls back to a guessed 60 minutes. Measured 2026-09-15, nine of
// thirty-three upcoming bookings had no service_id — every one entered by an
// admin or an agent, never by the public form, which always sends one.
//
// It goes here because this is the funnel every item-writing path already
// passes through (bookings.js POST and booking.js PATCH both call it), so the
// resolution exists once rather than in each writer — which is how the brand
// rule ended up with four private copies that disagreed.
//
// Only 'service' rows: an addon or a custom line is not a catalogue service,
// and giving one a service_id would have rollupItems report the wrong thing as
// the booking's service. resolveServiceId answers only for names it is sure
// about and returns '' for anything ambiguous ("Magic Show", "Custom Event",
// one-off event titles) — a wrong link sends the wrong roles to the wrong gig,
// which is worse than none, and none is now reported by the daily digest.
function normaliseItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((i) => ({
      service_id: String((i && i.service_id) || '').trim().slice(0, 64)
                  || (i && i.kind === 'service' ? resolveServiceId(i && i.name) : ''),
      name:       String((i && i.name) || '').trim().slice(0, 255),
      price:      clampPrice(i && i.price),
      quantity:   Math.min(Math.max(Math.floor(Number((i && i.quantity)) || 1), 1), 1000),
      kind:       ITEM_KINDS.includes(i && i.kind) ? i.kind : 'custom',
    }))
    .filter((i) => i.name !== '')
    .slice(0, MAX_ITEMS)
    .map((i, idx) => ({ ...i, sort_order: idx }));
}

const lineTotal = (i) => clampPrice(i.price) * Math.max(1, Number(i.quantity) || 1);
const sum = (arr) => arr.reduce((s, i) => s + lineTotal(i), 0);

// Derives the legacy bookings columns from a set of items.
//
// total_price EXCLUDES travel. The balance formula in bookings.js:329 and
// booking.js:196 is `total_price + mileage_cost - deposit_amount`, so folding
// travel into total_price would double-charge it on every invoice and every
// balance. Do not "simplify" this into one sum.
function rollupItems(items) {
  const list = Array.isArray(items) ? items : [];
  const byOrder = [...list].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const services  = byOrder.filter((i) => i.kind === 'service');
  const addons    = byOrder.filter((i) => i.kind === 'addon');
  const travel    = byOrder.filter((i) => i.kind === 'travel');
  const discounts = byOrder.filter((i) => i.kind === 'discount');
  const billable  = byOrder.filter((i) => i.kind !== 'travel' && i.kind !== 'discount');

  // service_price and addon_total say what those things COST and are left
  // gross on purpose: they feed the accounting export and the PPM sync, where
  // "we sold $920 of foam party and gave $92 away" is the useful shape.
  // total_price is the only figure that nets the discount off, and it is the
  // one the balance formula and every invoice read.
  //
  // Floored at zero: a discount larger than the bill must not produce a
  // negative total that Stripe would refuse and balance_due would clamp
  // anyway. The discount line stays visible on the quote and the invoice, so
  // an over-discount shows up as a $0.00 total rather than disappearing.
  return {
    service_id:    services.length ? String(services[0].service_id || '') : '',
    service_name:  services.map((i) => i.name).join(' + '),
    service_price: sum(services),
    addons:        addons.map((i) => ({ name: i.name, price: clampPrice(i.price) })),
    addon_total:   sum(addons),
    mileage_cost:  sum(travel),
    discount_total: sum(discounts),
    total_price:   Math.max(0, sum(billable) - sum(discounts)),
  };
}

async function getItems(client, bookingId) {
  const { rows } = await client.query(
    `SELECT id, booking_id, service_id, name, price::float8 AS price, quantity, kind, sort_order
     FROM booking_items WHERE booking_id = $1 ORDER BY sort_order, id`,
    [bookingId]
  );
  return rows;
}

// Batched sibling of getItems for list endpoints — one query instead of N.
async function getItemsForBookings(client, bookingIds) {
  const map = new Map();
  if (!bookingIds || !bookingIds.length) return map;
  const { rows } = await client.query(
    `SELECT id, booking_id, service_id, name, price::float8 AS price, quantity, kind, sort_order
     FROM booking_items WHERE booking_id = ANY($1) ORDER BY booking_id, sort_order, id`,
    [bookingIds]
  );
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push(r);
  }
  return map;
}

// Links service rows to the LIVE catalogue by name.
//
// normaliseItems already resolves the legacy PPM names in _service-map.js, but
// that map was written for the import and knows nothing the catalogue has
// gained since — there is no entry for game_show, dj_pinata, mini_donuts or
// either photo booth. So an admin typing "Game Show Champions", a service that
// exists, got no link, while "Story Doodles", a name PPM used, did. The
// catalogue is the source of truth for what services exist; the static map is
// only for legacy names that no longer match one.
//
// Exact match on the normalised name, never a prefix or a substring: "Corporate
// Magic Show (banquet style)" stays unlinked rather than being guessed into
// corporate_magic, because the suffix might be what changes the staffing. A
// name held by two catalogue rows is also refused — an ambiguous link sends the
// wrong roles to the gig, and the daily digest reports what stays unlinked.
async function linkCatalogueServices(client, items) {
  if (!items.some((i) => i.kind === 'service' && !i.service_id)) return items;

  const byName = await catalogueServiceIds(client);
  return items.map((i) => (i.kind === 'service' && !i.service_id
    ? { ...i, service_id: byName.get(norm(i.name)) || '' }
    : i));
}

// Replace-on-save. A quote is edited as a whole, so diffing rows would buy
// nothing but a chance to get it wrong. Runs in the caller's transaction.
async function replaceItems(client, bookingId, items) {
  const clean = await linkCatalogueServices(client, normaliseItems(items));
  await client.query('DELETE FROM booking_items WHERE booking_id = $1', [bookingId]);
  for (const i of clean) {
    await client.query(
      `INSERT INTO booking_items (booking_id, service_id, name, price, quantity, kind, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [bookingId, i.service_id, i.name, i.price, i.quantity, i.kind, i.sort_order]
    );
  }
  return getItems(client, bookingId);
}

// Is this booking's stored balance_due explained by the standard formula?
//
// balance_due = max(0, total_price + mileage_cost - deposit_amount) is the
// formula bookings.js:329 and booking.js use. It only works when deposit_amount
// reflects what was actually collected. It frequently does not: when a client
// settles in full, balance_due is zeroed directly and deposit_amount is left at
// whatever was originally requested. The formula then cannot reconstruct the
// truth, and re-running it resurrects the whole bill.
//
// Measured 2026-08-02: 106 of 667 production bookings fail this test, and 12 of
// them are fully paid — recomputing would have billed them $7,530 they had
// already paid. So: never overwrite a balance the formula does not already
// explain. Half a cent of tolerance absorbs NUMERIC/float round-tripping.
function balanceIsDerivable(row) {
  const derived = Math.max(0,
    Number(row.total_price || 0) + Number(row.mileage_cost || 0) - Number(row.deposit_amount || 0));
  return Math.abs(derived - Number(row.balance_due || 0)) <= 0.005;
}

// A balance paid through the Stripe link carries a 5% service fee.
//
// One formula, no special cases: balance_due is already
// total + mileage - deposit, so a booking that never took a deposit has a
// balance equal to the whole amount and needs no separate rule.
//
// It is a SERVICE fee, not a card surcharge (Joe, 2026-08-16). A 5% card-only
// surcharge would exceed Stripe's ~2.9% + 30¢ cost of acceptance and fall
// under Visa/Mastercard surcharge rules. Client-facing copy must never call
// it a card, processing or convenience fee.
//
// The fee is computed here at link-creation time and lives only on the Stripe
// session and in the email. It must NEVER be written into balance_due:
// balanceIsDerivable() above would fail for this booking forever, and
// booking.js:269 would refuse every later balance recompute — the exact guard
// that stops a paid customer being re-billed.
//
// ponytail: a constant, not a column. Waiving the fee on one booking needs a
// code change; if that ever comes up, a nullable bookings.service_fee_rate
// defaulting to 0.05 is the upgrade path.
const SERVICE_FEE_RATE = 0.05;

const toCents = (n) => Math.round(n * 100) / 100;

function balanceCharge(row) {
  const raw = Number(row && row.balance_due);
  const balance = isFinite(raw) && raw > 0 ? toCents(raw) : 0;
  const fee = toCents(balance * SERVICE_FEE_RATE);
  return { balance, fee, total: toCents(balance + fee) };
}

// ── What the crew collect from the client on the day ────────────────────────
// Deliberately NOT balanceCharge(). The 5% service fee above exists only on a
// Stripe checkout session; quoting the fee-bearing total to someone taking cash
// at a birthday party over-collects by 5% and there is no refund path for it.
//
// A platform booking is never collected from at all — GigSalad already took the
// client's money and added its own fees, so asking for a balance bills them
// twice. _source.js is the one decider for that, here as everywhere else.
//
// The three no-collect states are kept distinct rather than collapsed to "$0",
// because a crew member acts on the difference: "paid in full" is settled,
// "not priced yet" means the office has not finished and nobody should be
// inventing a figure at the door.
//
// One function for both readers — the calendar feed and the staff portal —
// because two copies of a "how much do we ask for" rule is how the brand rule
// ended up wrong in three of its four writers.
function collectFromClient(row) {
  if (platformBooked(row)) {
    return { amount: 0, note: `Paid through ${platformLabel(row)} — collect nothing` };
  }
  const raw = row && row.balance_due;
  if (raw === null || raw === undefined || raw === '') {
    return { amount: 0, note: 'Not priced yet — collect nothing' };
  }
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return { amount: 0, note: 'Paid in full — collect nothing' };
  return { amount: toCents(n), note: `COLLECT $${toCents(n).toFixed(2)} from the client` };
}

module.exports = {
  linkCatalogueServices, collectFromClient,
  ITEM_KINDS, ensureBookingItems, normaliseItems, rollupItems,
  getItems, getItemsForBookings, replaceItems, balanceIsDerivable,
  SERVICE_FEE_RATE, balanceCharge,
};
