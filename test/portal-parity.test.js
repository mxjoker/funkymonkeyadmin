const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ── The portal must know everything the calendar knows ─────────────────────
// Joe's calendar feed and the staff portal describe the same gig to two
// different people. The calendar is his alone; the portal is what the crew
// have in their hand, and it must not be the poorer of the two.
//
// It was, twice over: venue and surface_type went onto the calendar with the
// call time and appeared in the portal only inside comments, and the crew
// list was calendar-only — a crew member could not see who else was working
// their own gig. surface_type is the sharper example, because it decides what
// comes out of the van, and the people doing the loading were the ones who
// could not see it.
//
// This is a text check, not a render: it fails when a field is added to one
// screen and forgotten on the other, which is the drift it exists to catch.

const ROOT = path.join(__dirname, '..');
const PORTAL = fs.readFileSync(path.join(ROOT, 'staff-portal.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'netlify/functions/staff-assignments.js'), 'utf8');
const CAL    = fs.readFileSync(path.join(ROOT, 'netlify/functions/calendar.js'), 'utf8');

// Comments describe a field; only code shows it. Strip both comment styles
// before looking, or "// ...standing at the venue" passes for a venue.
const portalCode = PORTAL
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('every booking field the calendar prints is fetched for the portal too', () => {
  for (const col of ['b.venue', 'b.surface_type', 'b.reference']) {
    assert.ok(SERVER.includes(col),
      `the calendar shows ${col} but the portal query does not fetch it`);
  }
});

test('and the portal actually shows them', () => {
  for (const field of ['g.venue', 'g.surface_type', 'g.reference']) {
    assert.ok(portalCode.includes(field),
      `${field} reaches the portal and is never rendered — it is on Joe\'s calendar only`);
  }
});

test('a crew member can see who else is on the gig', () => {
  // The calendar has always listed the crew. The portal showed you your own
  // roles and nobody else\'s.
  assert.match(CAL, /Staff:/, 'the calendar stopped listing crew — re-check this parity');
  assert.ok(SERVER.includes('crewByBooking'), 'the portal no longer fetches the other crew');
  assert.ok(portalCode.includes('g.crew'), 'the portal fetches the crew and does not show them');
});

test('the crew list carries no phone numbers', () => {
  // Deliberate: who you are working with is operational, handing out a
  // colleague\'s mobile is Joe\'s decision to make.
  const q = SERVER.split('crewByBooking')[1].split('`')[1] || '';
  assert.ok(!/phone/i.test(q), 'the co-crew query started selecting phone numbers');
});

test('the portal never shows the client total or deposit', () => {
  // The calendar carries "Total $1250.00 · deposit paid". The portal must
  // not: what the client is paying us is not crew business, and the one
  // money figure they DO need is the collect line.
  assert.match(CAL, /Total \$/, 'the calendar stopped showing a total');
  assert.ok(!/$\{[^}]*g\.total_price/.test(portalCode), 'the portal renders total_price');
  assert.ok(!/$\{[^}]*g\.deposit_paid/.test(portalCode), 'the portal renders deposit_paid');
});
