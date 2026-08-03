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
    '\nout = { groupByCategory, shouldSection, CATEGORY_ORDER, resolveAddon, step2Subtotal };',
    ctx
  );
  return ctx.out;
}

const { groupByCategory, shouldSection, CATEGORY_ORDER } = loadHelpers();
const { resolveAddon, step2Subtotal } = loadHelpers();

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
  // Corporate has 2 categories but only 4 services.
  assert.strictEqual(shouldSection(ENTRY_POINTS.corporate, catOf), false);
  // Library has 6 services but only 1 category.
  assert.strictEqual(shouldSection(ENTRY_POINTS.library, catOf), false);
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

test('kids birthday splits 2 shows / 3 performers / 9 experiences', () => {
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
  const labels = plain(groupByCategory(ENTRY_POINTS.browse_all, catOf)).map(s => s.label);
  assert.deepStrictEqual(labels,
    ['Main Shows','Add-On Entertainers','Party Experiences','Library Programs']);
  for (const raw of plain(CATEGORY_ORDER)) {
    assert.ok(!labels.includes(raw), `raw category "${raw}" must not be shown to customers`);
  }
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
  assert.ok(Number.isFinite(r.total));
});

test('no service selected yields null', () => {
  assert.strictEqual(step2Subtotal(null, 0, [], mkResolve(FOAM)), null);
});
