const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsm = require('node:fs');
const { normaliseItems, rollupItems } = require('../netlify/functions/_items.js');

const CREATE = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/create-bookings.js'), 'utf8');

// service_id is the only join to staff_slots and the time templates. Without it
// a gig can be assigned nobody and its shift window falls back to a guessed 60
// minutes. Measured 2026-09-15: nine of thirty-three upcoming bookings had none,
// every one entered by an admin or an agent rather than the public form.
test('a catalogue service named in a line item gets linked', () => {
  const items = normaliseItems([{ kind: 'service', name: 'Corporate Magic Show', price: 900 }]);
  assert.strictEqual(items[0].service_id, 'corporate_magic');
  assert.strictEqual(rollupItems(items).service_id, 'corporate_magic', 'the booking column must get it too');
});

test('the name match survives the spacing and dashes real data arrives with', () => {
  const items = normaliseItems([{ kind: 'service', name: '  Magic Show — Library ', price: 300 }]);
  assert.strictEqual(items[0].service_id, 'lib_magic');
});

// The refusal is the point. A wrong link sends the wrong roles to the wrong gig
// and builds the shift window from the wrong time template, which is worse than
// no link — and no link is reported by the daily incomplete-gig digest.
test('an ambiguous name is left unlinked rather than guessed', () => {
  for (const name of ['Magic Show', 'Custom Event', 'Game Show Champions Experience']) {
    const items = normaliseItems([{ kind: 'service', name, price: 500 }]);
    assert.strictEqual(items[0].service_id, '', name + ' must not be guessed into a catalogue id');
  }
});

test('an explicit service_id always beats the name', () => {
  const items = normaliseItems([{ kind: 'service', name: 'Corporate Magic Show', service_id: 'wedding_magic', price: 900 }]);
  assert.strictEqual(items[0].service_id, 'wedding_magic', 'the caller knows more than a string match');
});

// Only service rows. An addon carrying a service_id would make rollupItems
// report the wrong thing as the booking's service.
test('an addon or custom line is never given a service_id', () => {
  const items = normaliseItems([
    { kind: 'addon',  name: 'Face Painting', price: 100 },
    { kind: 'custom', name: 'Corporate Magic Show', price: 50 },
    { kind: 'travel', name: 'Mileage', price: 40 },
  ]);
  for (const i of items) assert.strictEqual(i.service_id, '', i.kind + ' must stay unlinked');
});

// rollupItems reads services[0], so a booking whose first service resolves and
// whose second does not must still report the first.
test('resolution does not disturb which service the booking reports', () => {
  const items = normaliseItems([
    { kind: 'service', name: 'Face Painting', price: 200 },
    { kind: 'service', name: 'Custom Event', price: 300 },
  ]);
  assert.strictEqual(rollupItems(items).service_id, 'face_paint');
  assert.strictEqual(rollupItems(items).service_name, 'Face Painting + Custom Event');
});

// The other intake. import-bookings.js resolved names at intake and this seam
// did not, which is why the GS-/FME-/JCM- references arrived unlinked.
test('the import seam resolves a name when the caller sends no id', () => {
  assert.ok(/str\(b\.service_id, 64\)\s*\|\| resolveServiceId\(b\.service_name\)\s*\|\| catalogue\.get\(norm\(b\.service_name\)\)/.test(CREATE),
    'explicit id, then the legacy map, then the live catalogue — in that order');
  assert.ok(/require\('\.\/_service-map'\)/.test(CREATE), 'it must use the shared decider, not its own copy');
});

// A seam that quietly creates an unstaffable booking is the same silent-success
// shape as a dry run that could not fail.
test('the import seam reports what it could not link, in dry run too', () => {
  assert.ok(/unlinked: 0/.test(CREATE), 'the result needs an unlinked counter');
  assert.ok(/unlinked_service: str\(b\.service_name\)/.test(CREATE), 'it must name what went unlinked');
  const order = CREATE.indexOf('const serviceId = serviceIdFor(b);') < CREATE.indexOf('if (dryRun)');
  assert.ok(order, 'a preview that cannot show the gap is how the gap gets created');
});

// ── Linking against the LIVE catalogue ──────────────────────────────────────
// The static map is a legacy-PPM-name map. The catalogue has gained services it
// has never heard of — game_show, dj_pinata, mini_donuts, both photo booths —
// so an admin typing a service that genuinely exists got no link.
const { linkCatalogueServices } = require('../netlify/functions/_items.js');

const catalogue = (rows) => ({ query: async () => ({ rows }) });
const CATALOGUE = [
  { service_id: 'game_show', name: 'Game Show Champions' },
  { service_id: 'dj_pinata', name: 'DJ Piñata' },
  { service_id: 'corporate_magic', name: 'Corporate Magic Show' },
];

test('a service the catalogue actually lists gets linked, map or no map', async () => {
  const out = await linkCatalogueServices(catalogue(CATALOGUE),
    normaliseItems([{ kind: 'service', name: 'Game Show Champions', price: 1200 }]));
  assert.strictEqual(out[0].service_id, 'game_show', 'the catalogue has it even though the legacy map does not');
});

test('a suffix is not a match — it may be what changes the staffing', async () => {
  const out = await linkCatalogueServices(catalogue(CATALOGUE),
    normaliseItems([{ kind: 'service', name: 'Corporate Magic Show (banquet style)', price: 900 }]));
  assert.strictEqual(out[0].service_id, '', 'a prefix match would be a guess');
});

test('a name two catalogue rows share links to neither', async () => {
  const dupes = [{ service_id: 'a1', name: 'Magic Show' }, { service_id: 'b2', name: 'magic show' }];
  const out = await linkCatalogueServices(catalogue(dupes),
    normaliseItems([{ kind: 'service', name: 'Magic Show', price: 400 }]));
  assert.strictEqual(out[0].service_id, '', 'ambiguous must refuse, not take the last one');
});

test('an id the caller supplied is never overwritten by a name match', async () => {
  const out = await linkCatalogueServices(catalogue(CATALOGUE),
    normaliseItems([{ kind: 'service', name: 'Game Show Champions', service_id: 'wedding_magic', price: 900 }]));
  assert.strictEqual(out[0].service_id, 'wedding_magic');
});

// One query per save, and only when something actually needs resolving.
test('nothing to resolve means no catalogue query at all', async () => {
  let queried = false;
  const client = { query: async () => { queried = true; return { rows: CATALOGUE }; } };
  await linkCatalogueServices(client, normaliseItems([{ kind: 'addon', name: 'Face Painting', price: 100 }]));
  assert.strictEqual(queried, false, 'a save with no unlinked service row must not hit the catalogue');
});

test('replaceItems runs the linking, so every writer gets it', () => {
  const SRC = fsm.readFileSync(path.join(__dirname, '..', 'netlify/functions/_items.js'), 'utf8');
  assert.ok(/const clean = await linkCatalogueServices\(client, normaliseItems\(items\)\);/.test(SRC),
    'the one write funnel must do the linking — otherwise each writer needs its own copy');
});

// An import of 700 rows must not run 700 catalogue queries.
test('the import seam reads the catalogue once per request, not once per row', () => {
  const inLoop = CREATE.split('for (const b of rows) {')[1];
  assert.ok(!/catalogueServiceIds\(/.test(inLoop), 'the catalogue lookup must sit outside the row loop');
  assert.ok(/const catalogue = await catalogueServiceIds\(client\);/.test(CREATE));
});

// Both deciders, because they answer different questions: the map knows retired
// PPM names, the catalogue knows services added since the map was frozen.
test('neither decider alone is enough', () => {
  const { NAME_TO_SERVICE } = require('../netlify/functions/_service-map.js');
  assert.ok(NAME_TO_SERVICE['story doodles'], 'the map must keep the retired names');
  assert.ok(!Object.values(NAME_TO_SERVICE).includes('game_show'),
    'the map has no game_show — that is precisely why the catalogue lookup exists');
});

// ── The admin UI half ───────────────────────────────────────────────────────
// The link was a hidden input: settable only by picking from the catalogue
// dropdown, invisible to anyone typing their own title. That is how nine
// upcoming bookings came to have none.
const ADMIN = fsm.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

test('a service row exposes its catalogue link as a real field', () => {
  assert.ok(!/<input type="hidden" class="item-f" data-if="service_id"/.test(ADMIN),
    'the link must not be hidden any more');
  assert.ok(/<select class="item-f" data-if="service_id" data-service-link/.test(ADMIN),
    'it must be a select the admin can actually set');
  assert.ok(/readItemRows/.test(ADMIN) && /\[data-if="\$\{f\}"\]/.test(ADMIN),
    'readItemRows reads by data-if, so a select is picked up unchanged');
});

// The catalogue loads lazily. A <select> reports '' for a value it has no
// option for, so rendering before it arrives would turn an existing, correct
// link into no link on the next Save — silently, and on a staffed gig.
test('a link survives a render that happened before the catalogue loaded', () => {
  assert.ok(/function serviceLinkOptionsHtml\(current\)/.test(ADMIN));
  assert.ok(/cur && !listed \? `<option value="\$\{esc\(cur\)\}" selected>/.test(ADMIN),
    'the current value must always be emitted as an option, listed or not');
  const ensure = ADMIN.split('function ensureCatalogueLoaded')[1].split('\n}')[0];
  assert.ok(/data-service-link/.test(ensure), 'the late catalogue must refill the row selects');
  assert.ok(/serviceLinkOptionsHtml\(link\.value\)/.test(ensure), 'and must preserve what each row holds');
});

test('changing a row away from service clears a link that would be ignored', () => {
  const fn = ADMIN.split('function syncItemRowKind')[1].split('\n}')[0];
  assert.ok(/link\.hidden = sel\.value !== 'service'/.test(fn));
  assert.ok(/if \(link\.hidden\) link\.value = ''/.test(fn));
});
