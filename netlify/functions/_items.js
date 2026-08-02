// booking_items — one row per thing being sold on a booking.
//
// The legacy bookings.service_* / addons / addon_total / mileage_cost columns
// remain the contract for invoices, Stripe, the accounting export and the PPM
// sync. rollupItems() is the single place that derives them from the items, so
// there is exactly one definition of what a booking costs.

const ITEM_KINDS = ['service', 'addon', 'travel', 'custom'];

// ponytail: 50 lines is far past any real package (the largest historical
// booking has 4). The cap exists so a malformed client payload cannot write
// unbounded rows, not because 50 is meaningful.
const MAX_ITEMS = 50;

async function ensureBookingItems(client) {
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
}

function clampPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100000);
}

// Accepts whatever the admin UI or a client posts and returns rows safe to
// write. Anything nameless is dropped — a line item with no description is not
// a line item.
function normaliseItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((i) => ({
      service_id: String((i && i.service_id) || '').trim().slice(0, 64),
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

  const services = byOrder.filter((i) => i.kind === 'service');
  const addons   = byOrder.filter((i) => i.kind === 'addon');
  const travel   = byOrder.filter((i) => i.kind === 'travel');
  const billable = byOrder.filter((i) => i.kind !== 'travel');

  return {
    service_id:    services.length ? String(services[0].service_id || '') : '',
    service_name:  services.map((i) => i.name).join(' + '),
    service_price: sum(services),
    addons:        addons.map((i) => ({ name: i.name, price: clampPrice(i.price) })),
    addon_total:   sum(addons),
    mileage_cost:  sum(travel),
    total_price:   sum(billable),
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

// Replace-on-save. A quote is edited as a whole, so diffing rows would buy
// nothing but a chance to get it wrong. Runs in the caller's transaction.
async function replaceItems(client, bookingId, items) {
  const clean = normaliseItems(items);
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

module.exports = {
  ITEM_KINDS, ensureBookingItems, normaliseItems, rollupItems,
  getItems, getItemsForBookings, replaceItems,
};
