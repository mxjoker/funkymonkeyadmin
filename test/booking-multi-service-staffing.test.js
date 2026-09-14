const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SA = fs.readFileSync(path.join(__dirname, '../netlify/functions/staff-assignments.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

// FM-PM3CRC4Z sold a Foam Party AND a Magic School Assembly. bookings.service_id
// is only the FIRST service, so every staffing query keyed on it saw half the
// booking — and which half depended on the order the lines were typed in.
// These pin that no staffing query reads that column any more.
test('no staffing query reads the single bookings.service_id column', () => {
  // Every SQL string that touches staff_slots, taken whole so a b.service_id
  // three lines below the join still counts.
  // The three per-booking lookups: the admin slot panel, the portal's open-gig
  // list, and the notifier. The slot-config reads and the DELETE behind
  // Catalogue → Staff Requirements are keyed on a service, not a booking, and
  // are correctly left alone.
  const queries = (SA.match(/`[^`]*staff_slots[^`]*`/g) || [])
    .filter(q => /SELECT/.test(q) && !/CREATE TABLE/.test(q));
  assert.strictEqual(queries.length, 3, 'expected exactly the three staffing lookups');
  for (const q of queries) {
    assert.ok(/booking_service_ids/.test(q), `not going through the view:\n${q}`);
    assert.ok(!/ss\.service_id\s*=\s*b\.service_id/.test(q), `still keyed on the first service:\n${q}`);
  }
});

test('the notifier asks for slots by booking, not by one service id', () => {
  const fn = SA.slice(SA.indexOf('async function notifyStaffForBooking'));
  const q = fn.slice(0, fn.indexOf('const tags ='));
  assert.ok(/booking_service_ids/.test(q), 'notifier still resolves slots from one service id');
  assert.ok(!/\[booking\.service_id\]/.test(q));
});

test('the view covers every service line and falls back for legacy rows', () => {
  const view = SA.slice(SA.indexOf('CREATE OR REPLACE VIEW booking_service_ids'), SA.indexOf(') x'));
  assert.ok(/booking_items/.test(view), 'must read the item rows');
  assert.ok(/kind = 'service'/.test(view), 'addons and travel are not staffed');
  assert.ok(/FROM bookings b/.test(view), 'legacy rows with no items still need their service');
  assert.ok(/SELECT DISTINCT/.test(view), 'the two arms overlap on every modern booking');
});

// ── The reported symptom: "✅ Notified 0 staff" over a send that never happened.
function loadHelper() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = notifyOutcome;', ctx);
  return ctx.out;
}
const notifyOutcome = loadHelper();

test('a send that reached nobody is never reported as success', () => {
  const quoted = notifyOutcome({ notified: 0, skipped: true, reason: "status 'quoted' is not open to staff yet" });
  assert.strictEqual(quoted.ok, false);
  assert.ok(!quoted.button.includes('✅'), 'no green tick over a zero send');
  assert.match(quoted.message, /quoted/);

  const unconfigured = notifyOutcome({ notified: 0, configured: false, reason: '"Foam Party" has no staff requirements set.' });
  assert.strictEqual(unconfigured.ok, false);
  assert.match(unconfigured.message, /staff requirements/);
});

test('a zero with no reason still says something actionable', () => {
  const bare = notifyOutcome({ notified: 0 });
  assert.strictEqual(bare.ok, false);
  assert.ok(bare.message.length > 0, 'silence is what caused this bug');
});

test('a real send reports the count and no warning', () => {
  const sent = notifyOutcome({ notified: 3, configured: true });
  assert.strictEqual(sent.ok, true);
  assert.match(sent.button, /3 staff/);
  assert.strictEqual(sent.message, '');
});
