const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  STAFFABLE_STATUSES, isStaffable, slotTags, eligibleStaff,
} = require('../netlify/functions/staff-assignments');

const SRC = fs.readFileSync(
  path.join(__dirname, '../netlify/functions/staff-assignments.js'), 'utf8'
);

// ── The emailed ⟺ visible invariant ─────────────────────────────────────────
// The reported bug: staff got "a gig is available, check your portal", logged
// in, and the portal was empty. The notifier fired on every new booking while
// the portal only ever listed status='confirmed'. These two must not drift.

test('a raw inbound lead is never emailed about', () => {
  assert.strictEqual(isStaffable({ status: 'review' }), false);
});

test('a quote the client has not accepted is never emailed about', () => {
  assert.strictEqual(isStaffable({ status: 'quoted' }), false);
});

test('committed work is emailed about', () => {
  for (const s of ['accepted', 'confirmed']) {
    assert.strictEqual(isStaffable({ status: s }), true, `${s} should be staffable`);
  }
});

test('dead bookings are never emailed about', () => {
  for (const s of ['draft', 'cancelled', 'completed']) {
    assert.strictEqual(isStaffable({ status: s }), false, `${s} must not be staffable`);
  }
});

// 'pending' was retired with the seven-status model and its last nine rows were
// migrated to 'accepted' on 2026-08-05. Staffing off it again would silently
// resurrect a status nothing else in the system renders.
test('the retired pending status is not staffable', () => {
  assert.strictEqual(isStaffable({ status: 'pending' }), false);
});

test('a missing or malformed booking is not staffable', () => {
  for (const b of [null, undefined, {}, { status: null }, { status: '' }]) {
    assert.strictEqual(isStaffable(b), false);
  }
});

test('the portal query and the notifier read the same status list', () => {
  // Both consumers must reference the shared constant. A literal
  // status='confirmed' in the open-gig query is the exact drift that caused
  // the empty-portal bug, so fail if one reappears.
  assert.ok(
    !/b\.status\s*=\s*'confirmed'/.test(SRC),
    'open-gig query must not hardcode a status — use STAFFABLE_STATUSES'
  );
  assert.ok(
    SRC.includes('b.status = ANY($3::text[])'),
    'open-gig query must filter on the shared STAFFABLE_STATUSES list'
  );
});

// ── Slot tags are the only source of truth ──────────────────────────────────
// The old fallback used the service name as a skill tag when a service had no
// slots configured. Service names and skill names are different vocabularies,
// so it matched nobody and reported that as a successful send.

test('slot tags are de-duplicated', () => {
  const tags = slotTags([
    { tag_required: 'Foam Party' },
    { tag_required: 'Driver' },
    { tag_required: 'Foam Party' },
  ]);
  assert.deepStrictEqual(tags, ['Foam Party', 'Driver']);
});

test('no slots means no tags — never a service-name guess', () => {
  assert.deepStrictEqual(slotTags([]), []);
});

test('the service-name fallback could never have matched a skill', () => {
  // Real values from the live catalogue and staff records.
  const SERVICE_NAMES = [
    'Foam Party — Single Cannon', 'Foam Party — Double Cannon',
    'Deluxe Birthday Magic Show', 'Library — Magic Show',
    'Balloon Workshop — Up to 40 Kids', 'Snow Party — 45 Minutes',
  ];
  const SKILL_NAMES = [
    'Foam Party', 'Magic Show', 'Childrens Magic', 'Balloon Sculpting',
    'Snow Experience', 'Driver', 'Setup',
  ];
  for (const name of SERVICE_NAMES) {
    assert.ok(
      !SKILL_NAMES.includes(name),
      `service name "${name}" is not a skill name — the fallback was dead code`
    );
  }
  assert.ok(
    !SRC.includes('[booking.service_name]'),
    'the service-name fallback must stay deleted'
  );
});

// ── Eligibility ─────────────────────────────────────────────────────────────

const STAFF = [
  { id: 1, name: 'Joe',   skills: [{ name: 'Foam Party' }, { name: 'Driver' }] },
  { id: 2, name: 'Troy',  skills: JSON.stringify([{ name: 'Face Painting' }]) }, // stored as text
  { id: 3, name: 'Dani',  skills: [] },
  { id: 4, name: 'Amie',  skills: null },
];

test('only staff holding a required skill are eligible', () => {
  const out = eligibleStaff(STAFF, ['Foam Party']);
  assert.deepStrictEqual(out.map(e => e.staff.id), [1]);
  assert.deepStrictEqual(out[0].matched, ['Foam Party']);
});

test('skills stored as a JSON string are parsed, not skipped', () => {
  const out = eligibleStaff(STAFF, ['Face Painting']);
  assert.deepStrictEqual(out.map(e => e.staff.id), [2]);
});

test('staff with no skills are never notified and never crash the loop', () => {
  const out = eligibleStaff(STAFF, ['Driver']);
  assert.deepStrictEqual(out.map(e => e.staff.id), [1]);
});

test('every matched tag is reported, not just the first', () => {
  const out = eligibleStaff(STAFF, ['Foam Party', 'Driver']);
  assert.deepStrictEqual(out[0].matched, ['Foam Party', 'Driver']);
});

test('no required tags means nobody is notified', () => {
  assert.deepStrictEqual(eligibleStaff(STAFF, []), []);
});

// ── One gig_log per assignment ──────────────────────────────────────────────
// The duplicate-staff bug: gig_logs had only a NON-unique index on
// assignment_id, so `ON CONFLICT DO NOTHING` could never conflict. Every
// re-assign appended another log, and the LEFT JOIN in the admin and portal
// reads returned that staff member once per log row.

// Comments in this file discuss the old bare-conflict bug by name, so only
// look at lines that are actual SQL.
const CODE_LINES = SRC.split('\n').filter(l => !l.trim().startsWith('//'));

test('the gig_logs conflict target names the unique constraint', () => {
  const bare = CODE_LINES.filter(l => /ON CONFLICT DO NOTHING/.test(l));
  assert.deepStrictEqual(
    bare, [],
    'a bare ON CONFLICT DO NOTHING cannot fire without a constraint — name the target'
  );
  const targeted = SRC.match(/ON CONFLICT \(assignment_id\)/g) || [];
  assert.strictEqual(targeted.length, 2, 'both gig_logs inserts must target assignment_id');
});

test('the unique index backing that conflict target is created', () => {
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS gig_logs_assignment_id_key/.test(SRC),
    'the ON CONFLICT target needs a real unique index behind it'
  );
});

test('the duplicate-collapsing migration runs outside the swallow-all loop', () => {
  // If the dedupe or the index creation is swallowed, every later assign
  // throws on an unmatched conflict target. It must be allowed to fail loudly.
  const loopEnd = SRC.indexOf('for (const sql of migrations)');
  const dedupe  = SRC.indexOf('DELETE FROM gig_logs WHERE id NOT IN');
  assert.ok(dedupe > loopEnd, 'dedupe must not be inside the try/catch migration loop');
});

// ── Staff portal links ──────────────────────────────────────────────────────

test('staff emails point at the staff portal, not the admin dashboard', () => {
  assert.ok(SRC.includes('/staff-portal.html'), 'PORTAL must resolve to the staff portal');

  // The two staff-facing CTAs ("a gig is available" and "you're booked") must
  // send people to the portal. The one surviving admin.html link is the
  // post-gig survey notification, which goes to Joe and belongs on the
  // dashboard — so it is scoped out by name rather than blanket-banned.
  const adminLinks = CODE_LINES.filter(l => /\$\{SITE\}\/admin\.html/.test(l));
  assert.strictEqual(adminLinks.length, 1, 'only the admin survey notice may link to the dashboard');
  assert.ok(
    adminLinks[0].includes('View in Dashboard'),
    'the sole admin.html link must be the admin-facing survey notice'
  );

  const portalLinks = SRC.match(/\$\{PORTAL\}/g) || [];
  assert.ok(portalLinks.length >= 3, 'both staff emails must link to the portal');
});

// ── Client and server must agree on what "exclusive" means ──────────────────
// staff_slots.exclusive is written by the server and read by the admin UI to
// decide how many bodies a gig still needs. The two had drifted: the browser
// kept a hand-maintained list while the server applied a rule, so any tag added
// to one side was classified differently by the other.

const ADMIN = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

test('the server decides exclusivity by the stackable-role rule', () => {
  assert.ok(
    SRC.includes("!['Driver','Setup'].includes(sl.tag_required)"),
    'server exclusivity rule moved — update the client rule with it'
  );
});

test('the admin UI applies that same rule instead of a parallel list', () => {
  assert.ok(
    /const STACKABLE_TAGS = new Set\(\['Driver','Setup'\]\)/.test(ADMIN),
    'admin must derive exclusivity from the same two stackable roles'
  );
  assert.ok(
    /has:\s*\(tag\)\s*=>\s*!STACKABLE_TAGS\.has\(tag\)/.test(ADMIN),
    'admin exclusivity must be a predicate, not a hand-kept list that can drift'
  );
});

test('every skill dropdown reads the live tag list, not the frozen presets', () => {
  // A tag saved onto a staff record must stay selectable after a reload.
  const frozen = ADMIN.split('\n').filter(l =>
    /SKILL_PRESETS/.test(l) && /<option/.test(l));
  assert.deepStrictEqual(frozen, [], 'dropdowns must render from skillTags()');
  assert.ok(/function skillTags\(\)/.test(ADMIN), 'skillTags() must exist');
});

// ── Sanity ──────────────────────────────────────────────────────────────────

test('STAFFABLE_STATUSES is a real, non-empty allowlist', () => {
  assert.ok(Array.isArray(STAFFABLE_STATUSES) && STAFFABLE_STATUSES.length > 0);
  assert.ok(!STAFFABLE_STATUSES.includes('review'), 'review must stay out of the allowlist');
});
