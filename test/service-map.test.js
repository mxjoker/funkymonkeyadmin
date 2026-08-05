const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NAME_TO_SERVICE, resolveServiceId } = require('../netlify/functions/_service-map');

// ── Why this is tested ──────────────────────────────────────────────────────
// staff_slots, service_time_templates and the availability lookup are all keyed
// on services.service_id. A booking with a name but no id joins to zero slots,
// so the admin reports "no staff requirements" for a service whose roles are
// configured — and notifyStaffForBooking() emails nobody. This map is the only
// thing standing between a PPM package name and that failure, and it is now
// read at intake (import-bookings.js), not just by a one-off backfill.

test('a known name resolves to its catalogue id', () => {
  assert.strictEqual(resolveServiceId('Story Doodles'), 'lib_doodles');
  assert.strictEqual(resolveServiceId('Corporate Magic Show'), 'corporate_magic');
});

test('spacing and case do not matter', () => {
  assert.strictEqual(resolveServiceId('  story   DOODLES '), 'lib_doodles');
});

test('an em dash matches a hyphen', () => {
  // PPM exports both "Magic Show - Library" and "Magic Show — Library".
  assert.strictEqual(resolveServiceId('Magic Show — Library'), 'lib_magic');
  assert.strictEqual(resolveServiceId('Magic Show - Library'), 'lib_magic');
});

test('ambiguous names stay unmapped rather than guessing', () => {
  // Linking these to the wrong service sends the wrong skill requirement and
  // the wrong time template — worse than being visibly unlinked.
  for (const name of ['Custom Event', 'Magic Show', 'Show', 'Conference Mega Show']) {
    assert.strictEqual(resolveServiceId(name), '', `${name} must not resolve`);
  }
});

test('missing input returns empty string, never null or undefined', () => {
  // bookings.service_id is VARCHAR and rollupItems() uses '' for "no link", so
  // a null here would write a different flavour of empty than the rest of the
  // money path uses.
  assert.strictEqual(resolveServiceId(''), '');
  assert.strictEqual(resolveServiceId(null), '');
  assert.strictEqual(resolveServiceId(undefined), '');
});

test('the retired "pending" status is not produced by the importer', () => {
  // The seven-status model has no 'pending'. import-bookings.js was its last
  // producer; nine live rows held it until the 2026-08-05 migration.
  const src = fs.readFileSync(
    path.join(__dirname, '../netlify/functions/import-bookings.js'), 'utf8'
  );
  const statusMap = /const STATUS_MAP = \{[\s\S]*?\};/.exec(src);
  assert.ok(statusMap, 'STATUS_MAP must still be findable');
  assert.ok(!/:\s*'pending'/.test(statusMap[0]), 'STATUS_MAP must not map anything to pending');
});

test('every mapped id looks like a catalogue id, not a display name', () => {
  // A display name here ("Library — Story-Doodles") would join to zero slots
  // exactly like the NULL this map exists to eliminate.
  for (const [name, id] of Object.entries(NAME_TO_SERVICE)) {
    assert.match(id, /^[a-z0-9_]+$/, `${name} → ${id} is not a service_id`);
  }
});
