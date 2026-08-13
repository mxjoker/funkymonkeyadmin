const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../booking-form.html'), 'utf8');

// The helpers are extracted from the page and run in a bare context: if any of
// them ever reaches for `document` or `fetch`, these tests throw rather than
// silently passing against a stub.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from booking-form.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    HTML.slice(a, b) +
    // CATEGORY_ORDER/META are reassigned by setCategories, so they are exposed
    // through getters — a plain snapshot would freeze the fallback values and
    // hide whatever setCategories actually did.
    '\nout = { groupByCategory, shouldSection, CATEGORY_ORDER, resolveAddon, step2Subtotal, sectionKeyToOpen,' +
    '\n        setCategories, get order() { return CATEGORY_ORDER }, get meta() { return CATEGORY_META } };',
    ctx
  );
  return ctx.out;
}

const { groupByCategory, shouldSection, CATEGORY_ORDER, resolveAddon, step2Subtotal, sectionKeyToOpen } = loadHelpers();

// Values built inside a vm context carry THAT realm's prototypes, so
// assert.deepStrictEqual rejects them even when the structure is identical
// ("same structure but not reference-equal"). Round-trip through JSON to bring
// them into this realm before comparing. Every structural assertion below goes
// through this — comparing vm output directly is the trap here.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Real catalogue categories, verified against the live DB on 2026-08-02.
const CAT = {
  deluxe_magic:'shows', basic_magic:'shows', corporate_magic:'shows', game_show:'shows',
  school_asm:'shows', dj_pinata:'shows', wedding_magic:'shows',
  balloon_40:'performers', balloon_60:'performers', face_paint:'performers',
  airbrush:'performers', glitter:'performers',
  foam_single:'experiences', foam_double:'experiences', snow_45:'experiences',
  snow_90:'experiences', cotton_candy:'experiences', mini_donuts:'experiences',
  bubble_show:'experiences', pb_kiosk_svc:'experiences', pb_360_svc:'experiences',
  lib_magic:'library', lib_balloon:'library', lib_bubble:'library',
  lib_doodles:'library', lib_foam:'library', lib_workshop:'library',
};
const catOf = (id) => CAT[id];

// The nine real entry points, taken from EVENT_TYPES in booking-form.html.
// FIXTURE, not a live-data guarantee: loadAddonsFromDB() overwrites each
// EVENT_TYPES[].svcs from the DB at runtime, so these exact id lists (and
// their per-category counts below) will drift from what's actually live —
// e.g. kids_bday is 16 services live (2/5/9) vs. 14 (2/3/9) here, family is
// 17 vs. 15, community is 18 vs. 16. That's fine: these tests pin the pure
// grouping function against a fixed input, and all nine sectioning verdicts
// (section vs. no section) are unchanged by the drift.
const ENTRY_POINTS = {
  kids_bday: ['deluxe_magic','basic_magic','foam_single','foam_double','snow_45','snow_90',
              'cotton_candy','mini_donuts','face_paint','airbrush','glitter','bubble_show',
              'pb_kiosk_svc','pb_360_svc'],
  family:    ['deluxe_magic','basic_magic','foam_single','foam_double','snow_45','snow_90',
              'cotton_candy','mini_donuts','face_paint','airbrush','glitter','bubble_show',
              'game_show','pb_kiosk_svc','pb_360_svc'],
  school_asm:  ['school_asm'],
  school_fund: ['dj_pinata'],
  corporate:   ['corporate_magic','game_show','pb_kiosk_svc','pb_360_svc'],
  community:   ['deluxe_magic','basic_magic','foam_single','foam_double','snow_45','snow_90',
                'cotton_candy','mini_donuts','face_paint','airbrush','glitter','bubble_show',
                'school_asm','game_show','pb_kiosk_svc','pb_360_svc'],
  wedding:   ['wedding_magic','pb_kiosk_svc','pb_360_svc'],
  library:   ['lib_magic','lib_balloon','lib_bubble','lib_doodles','lib_foam','lib_workshop'],
  browse_all: Object.keys(CAT),
};

test('sections appear only for the entry points that earn them', () => {
  const expected = {
    kids_bday: true, family: true, community: true, browse_all: true,
    library: false, corporate: false, wedding: false,
    school_asm: false, school_fund: false,
  };
  for (const [name, ids] of Object.entries(ENTRY_POINTS)) {
    assert.strictEqual(shouldSection(ids, catOf), expected[name],
      `${name} (${ids.length} services) sectioning verdict is wrong`);
  }
});

test('both halves of the threshold are load-bearing', () => {
  // 5 services, all "shows": clears the >4 count half but fails the 2+
  // category half on its own — proves the category check still rejects
  // when the count check alone would have allowed it through.
  const fiveOneCategory = ['deluxe_magic','basic_magic','corporate_magic','game_show','school_asm'];
  assert.strictEqual(shouldSection(fiveOneCategory, catOf), false);

  // 4 services split across 2 categories: clears the 2+ category half but
  // fails the >4 count half on its own — proves the count check still
  // rejects when the category check alone would have allowed it through.
  const fourTwoCategories = ['deluxe_magic','basic_magic','balloon_40','balloon_60'];
  assert.strictEqual(shouldSection(fourTwoCategories, catOf), false);
});

test('grouping never drops a service', () => {
  for (const [name, ids] of Object.entries(ENTRY_POINTS)) {
    const got = plain(groupByCategory(ids, catOf)).flatMap(s => s.ids);
    assert.deepStrictEqual(got.sort(), [...ids].sort(),
      `${name} lost or duplicated a service`);
  }
});

test('sections come back in catalogue order regardless of input order', () => {
  const shuffled = ['glitter','lib_magic','foam_single','deluxe_magic'];
  const keys = plain(groupByCategory(shuffled, catOf)).map(s => s.key);
  assert.deepStrictEqual(keys, ['shows','performers','experiences','library']);
});

test('groups a mixed fixture into shows/performers/experiences in that order', () => {
  const s = plain(groupByCategory(ENTRY_POINTS.kids_bday, catOf));
  assert.deepStrictEqual(s.map(x => [x.key, x.ids.length]),
    [['shows',2],['performers',3],['experiences',9]]);
});

test('an unknown category surfaces in More Options instead of vanishing', () => {
  const withNew = ['deluxe_magic','some_new_thing','foam_single'];
  const catNew = (id) => id === 'some_new_thing' ? 'seasonal' : CAT[id];
  const s = plain(groupByCategory(withNew, catNew));
  assert.deepStrictEqual(s.flatMap(x => x.ids).sort(), [...withNew].sort());
  const other = s.find(x => x.key === 'other');
  assert.ok(other, 'unknown category must land in a bucket');
  assert.deepStrictEqual(other.ids, ['some_new_thing']);
  assert.strictEqual(s[s.length - 1].key, 'other', 'More Options sorts last');
});

test('missing category data forces the flat path', () => {
  // Simulates the /api/services fetch failing: no grouping is better than
  // grouping half the list.
  const partial = (id) => id === 'foam_single' ? undefined : CAT[id];
  assert.strictEqual(shouldSection(ENTRY_POINTS.kids_bday, partial), false);
  assert.strictEqual(shouldSection(ENTRY_POINTS.kids_bday, () => undefined), false);
});

test('customer-facing labels never leak the DB category strings', () => {
  const sections = plain(groupByCategory(ENTRY_POINTS.browse_all, catOf));
  assert.deepStrictEqual(sections.map(s => s.label),
    ['Main Shows','Add-On Entertainers','Party Experiences','Library Programs']);
  // .key stays the raw DB category (used internally for dataset/toggle wiring);
  // only .label is shown to customers. Pins that the two never get swapped.
  assert.deepStrictEqual(sections.map(s => s.key), plain(CATEGORY_ORDER));
});

const FOAM = { id:'foam_single', name:'Foam Party', price:385,
  addons:[{ id:'glitter_addon', name:'Glitter', price:75 }] };
const QUOTE_SVC = { id:'game_show', name:'Game Show', price:3500, isQuote:true, addons:[] };
const PAINT = { id:'face_paint', name:'Face Painting', price:200, extraHourRate:150, addons:[] };
const PER_GUEST = { id:'deluxe_magic', name:'Deluxe Magic', price:385,
  addons:[{ id:'mini_donuts', name:'Mini Donuts', price:'per_child', rate:5 }] };

const PB = [{ id:'pb_360', name:'360 Video Booth', price:150 }];
const DB_ADDONS = [{ addon_id:'extra_hour', name:'Extra Hour', price:'85' }];
const mkResolve = (svc) => (aid) => resolveAddon(svc, aid, PB, DB_ADDONS);

test('subtotal adds fixed-price add-ons to the service price', () => {
  const r = step2Subtotal(FOAM, 0, ['glitter_addon'], mkResolve(FOAM));
  assert.strictEqual(r.total, 460);
  assert.strictEqual(r.addonCount, 1);
  assert.strictEqual(r.perGuest, 0);
});

test('quote-only services contribute zero and are flagged, never shown as $0', () => {
  const r = step2Subtotal(QUOTE_SVC, 0, [], mkResolve(QUOTE_SVC));
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.isQuote, true);
});

test('extra hours are billed at the service rate', () => {
  const r = step2Subtotal(PAINT, 2, [], mkResolve(PAINT));
  assert.strictEqual(r.total, 200 + 300);
});

test('per-guest add-ons are counted, not silently priced at zero', () => {
  // Guest count is collected at step 3, so these cannot be priced here.
  const r = step2Subtotal(PER_GUEST, 0, ['mini_donuts'], mkResolve(PER_GUEST));
  assert.strictEqual(r.total, 385, 'per-guest add-on must not inflate the subtotal');
  assert.strictEqual(r.perGuest, 1, 'and must not vanish either');
});

test('photo-booth add-ons resolve even though they are not on the service', () => {
  const r = step2Subtotal(FOAM, 0, ['pb_360'], mkResolve(FOAM));
  assert.strictEqual(r.total, 535);
});

test('add-ons resolve from the DB list as a last resort, with string prices', () => {
  const r = step2Subtotal(FOAM, 0, ['extra_hour'], mkResolve(FOAM));
  assert.strictEqual(r.total, 470, 'DB prices arrive as strings and must be coerced');
});

test('an unresolvable add-on is ignored rather than producing NaN', () => {
  const r = step2Subtotal(FOAM, 0, ['ghost_addon'], mkResolve(FOAM));
  assert.strictEqual(r.total, 385);
});

test('an unresolvable add-on id does not inflate addonCount', () => {
  const r = step2Subtotal(FOAM, 0, ['glitter_addon', 'ghost_addon'], mkResolve(FOAM));
  assert.strictEqual(r.addonCount, 1, 'the stale/unresolvable id must not be counted');
});

test('no service selected yields null', () => {
  assert.strictEqual(step2Subtotal(null, 0, [], mkResolve(FOAM)), null);
});

test('sectionKeyToOpen returns the key of the section containing svcId', () => {
  const sections = plain(groupByCategory(ENTRY_POINTS.kids_bday, catOf));
  assert.strictEqual(sectionKeyToOpen(sections, 'foam_single'), 'experiences');
});

test('sectionKeyToOpen falls back to the first section when svcId is null', () => {
  const sections = plain(groupByCategory(ENTRY_POINTS.kids_bday, catOf));
  assert.strictEqual(sectionKeyToOpen(sections, null), 'shows');
});

test('sectionKeyToOpen falls back to the first section when svcId matches no section', () => {
  const sections = plain(groupByCategory(ENTRY_POINTS.kids_bday, catOf));
  assert.strictEqual(sectionKeyToOpen(sections, 'not_a_real_id'), 'shows');
});

test('sectionKeyToOpen returns null for an empty sections array', () => {
  assert.strictEqual(sectionKeyToOpen([], 'anything'), null);
});

// ── Categories now come from the DB (the `categories` table) ─────────────────
// Each of these loads its OWN helper context: setCategories reassigns
// module-level state, so sharing one context would leak between tests.

test('DB categories replace the hardcoded fallback, order and all', () => {
  const h = loadHelpers();
  h.setCategories([
    { category_id: 'most_popular', label: 'Most Popular',       icon: '⭐', active: true },
    { category_id: 'magic',        label: 'Magic',              icon: '🎩', active: true },
    { category_id: 'foam',         label: 'Foam Parties',       icon: '🫧', active: true },
    { category_id: 'other',        label: 'Other Entertainment', icon: '✨', active: true },
  ]);
  assert.deepStrictEqual(plain(h.order), ['most_popular', 'magic', 'foam', 'other']);

  const catOf2 = (id) => ({ a: 'magic', b: 'foam', c: 'most_popular' })[id];
  const sections = h.groupByCategory(['a', 'b', 'c'], catOf2);
  // Rendered in the categories' sort order, not the order the ids arrived in.
  assert.deepStrictEqual(plain(sections.map(s => s.key)),   ['most_popular', 'magic', 'foam']);
  assert.deepStrictEqual(plain(sections.map(s => s.label)), ['Most Popular', 'Magic', 'Foam Parties']);
  assert.deepStrictEqual(plain(sections.map(s => s.icon)),  ['⭐', '🎩', '🫧']);
});

test('an empty or missing categories payload keeps the fallback', () => {
  // A stale function or a failed fetch must not collapse every service into
  // one "More Options" heap on a live customer-facing form.
  for (const payload of [undefined, null, [], [{ label: 'no id' }]]) {
    const h = loadHelpers();
    h.setCategories(payload);
    assert.deepStrictEqual(plain(h.order), ['shows', 'performers', 'experiences', 'library']);
  }
});

test('a deactivated category stops being a section', () => {
  const h = loadHelpers();
  h.setCategories([
    { category_id: 'magic', label: 'Magic',        icon: '🎩', active: true  },
    { category_id: 'foam',  label: 'Foam Parties', icon: '🫧', active: false },
  ]);
  assert.deepStrictEqual(plain(h.order), ['magic']);
});

test('services in a deactivated category still render, under More Options', () => {
  // This is the whole safety net: switching a category off in admin must never
  // make its services vanish from the booking form.
  const h = loadHelpers();
  h.setCategories([
    { category_id: 'magic', label: 'Magic',        icon: '🎩', active: true  },
    { category_id: 'foam',  label: 'Foam Parties', icon: '🫧', active: false },
  ]);
  const sections = h.groupByCategory(['m1', 'f1', 'f2'], (id) => id[0] === 'm' ? 'magic' : 'foam');
  assert.deepStrictEqual(plain(sections.map(s => s.key)), ['magic', 'other']);
  assert.deepStrictEqual(plain(sections.find(s => s.key === 'other').ids), ['f1', 'f2']);
  assert.strictEqual(sections.find(s => s.key === 'other').label, 'More Options');
});

test('a category id absent from the table falls through, it does not disappear', () => {
  const h = loadHelpers();
  h.setCategories([{ category_id: 'magic', label: 'Magic', icon: '🎩', active: true }]);
  const sections = h.groupByCategory(['x'], () => 'deleted_category');
  assert.deepStrictEqual(plain(sections.map(s => s.key)), ['other']);
  assert.deepStrictEqual(plain(sections[0].ids), ['x']);
});

test('a category with no label falls back to its id rather than an empty heading', () => {
  const h = loadHelpers();
  h.setCategories([{ category_id: 'magic', label: '', icon: '', active: true }]);
  assert.strictEqual(h.meta.magic.label, 'magic');
  assert.strictEqual(h.meta.magic.icon, '✨');
});
