# Booking Form Service Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group step-2 services into collapsible category sections and pin a selection bar to the viewport so Continue is always reachable.

**Architecture:** All changes live in `booking-form.html`. Category data is read from the `/api/services` response the form already fetches — nothing is hardcoded. The decision logic (grouping, section threshold, subtotal) is written as pure functions inside marked sentinels so a `node --test` file can extract and test them in a `vm` without a browser.

**Tech Stack:** Vanilla HTML/CSS/JS in a single file. Tests use `node:test` + `node:vm`, matching `test/staff-assignments.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-02-booking-form-service-grouping-design.md`

## Global Constraints

- Only two files change: `booking-form.html` (modify) and `test/booking-form-grouping.test.js` (create).
- Steps 1, 3 and 4 of the form are untouched. No changes to prices, the `SERVICES` map, add-on logic, or the submit payload shape.
- No new dependency, framework, CDN, or build step.
- Everything between the `// ══ PURE HELPERS` and `// ══ END PURE HELPERS` sentinels must stay free of DOM and network access — the test harness evaluates that block in a bare `vm` context with no `document`.
- Customer-facing labels only. The DB category strings (`shows`, `performers`, `experiences`, `library`) are never shown to customers.
- Degradation rule: if category data is missing for **any** listed service, render flat exactly as today. A half-grouped list is worse than none.
- Quote-only services (`isQuote:true` — `corporate_magic`, `game_show`, `wedding_magic`) must never display `$0`.
- Run `npm test` before every commit; all tests must pass.

## Prerequisite

The repo is on `main` with uncommitted staffing work (`admin.html`,
`netlify/functions/staff-assignments.js`, `netlify/functions/create-bookings.js`,
`test/staff-assignments.test.js`). Branch before starting so this work is
separable:

```bash
git checkout -b feat/booking-form-grouping
```

---

### Task 1: Capture categories and write the grouping decision

**Files:**
- Modify: `booking-form.html` — add sentinel block after `const ALL_SVC_IDS` (line 495); extend `loadAddonsFromDB()` (lines 519-542)
- Create: `test/booking-form-grouping.test.js`

**Interfaces:**
- Produces: `groupByCategory(ids, catOf) -> [{key, label, icon, ids}]`, `shouldSection(ids, catOf) -> boolean`, `CATEGORY_ORDER`, and the module-level `dbServiceCategories` object (`{service_id: category}`)
- Consumes: nothing

- [ ] **Step 1: Write the failing test**

Create `test/booking-form-grouping.test.js`:

```js
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
    '\nout = { groupByCategory, shouldSection, CATEGORY_ORDER };',
    ctx
  );
  return ctx.out;
}

const { groupByCategory, shouldSection, CATEGORY_ORDER } = loadHelpers();

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/booking-form-grouping.test.js`
Expected: FAIL — `pure-helper sentinels missing from booking-form.html`

- [ ] **Step 3: Add the pure helpers**

In `booking-form.html`, immediately after `const ALL_SVC_IDS = Object.keys(SERVICES);` (line 495), insert:

```js
// ══ PURE HELPERS — extracted verbatim by test/booking-form-grouping.test.js ══
// Nothing in this block may touch the DOM, network, or page state. It is
// evaluated in a bare vm context by the tests.

const CATEGORY_ORDER = ['shows', 'performers', 'experiences', 'library'];
const CATEGORY_META = {
  shows:       { label: 'Main Shows',          icon: '🎩' },
  performers:  { label: 'Add-On Entertainers', icon: '🎨' },
  experiences: { label: 'Party Experiences',   icon: '🎊' },
  library:     { label: 'Library Programs',    icon: '📚' },
};
// A category added in Catalogue later must still render. Without this bucket
// those services would silently disappear from the customer-facing form.
const OTHER_CATEGORY = { key: 'other', label: 'More Options', icon: '✨' };

// ids -> ordered, non-empty sections. catOf(id) returns a category or undefined.
function groupByCategory(ids, catOf) {
  const buckets = new Map();
  for (const id of ids) {
    const raw = catOf(id);
    const key = CATEGORY_META[raw] ? raw : OTHER_CATEGORY.key;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id);
  }
  return [...CATEGORY_ORDER, OTHER_CATEGORY.key]
    .filter(k => buckets.has(k))
    .map(k => ({
      key:   k,
      label: (CATEGORY_META[k] || OTHER_CATEGORY).label,
      icon:  (CATEGORY_META[k] || OTHER_CATEGORY).icon,
      ids:   buckets.get(k),
    }));
}

// Sections only when they earn their keep: 2+ sections AND more than 4
// services. Both halves matter — the category count alone would wrap
// Corporate's 4 services in two drawers, and the service count alone would
// wrap Library's 6 in one pointless drawer.
function shouldSection(ids, catOf) {
  if (ids.some(id => !catOf(id))) return false;  // catalogue data did not load
  return groupByCategory(ids, catOf).length >= 2 && ids.length > 4;
}
// ══ END PURE HELPERS ══
```

- [ ] **Step 4: Capture categories from the API response**

In `booking-form.html`, add beside the existing `dbServiceAddons` declaration (line 518):

```js
let dbServiceCategories = {}; // { service_id: category } from /api/services
```

Inside `loadAddonsFromDB()`, directly after `dbServiceAddons = data.service_addons || {};` (line 522), add:

```js
    // The catalogue already carries the grouping the form needs; it was being
    // discarded. Read it rather than duplicating 27 rows into SERVICES.
    for (const s of (data.services || [])) {
      if (s.service_id && s.category) dbServiceCategories[s.service_id] = s.category;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all existing tests plus 8 new ones.

- [ ] **Step 6: Commit**

```bash
git add booking-form.html test/booking-form-grouping.test.js
git commit -m "feat: read service categories from the catalogue and decide sectioning"
```

---

### Task 2: Render the sections

**Files:**
- Modify: `booking-form.html` — `buildStep2()` (lines 595-635), CSS after `.services-grid` (line 43)

**Interfaces:**
- Consumes: `groupByCategory`, `shouldSection`, `dbServiceCategories` from Task 1
- Produces: `renderSvcCard(id) -> HTMLElement`, `toggleSection(key)`, `sectionKeyToOpen(sections)`, section DOM with `.svc-section` / `.svc-section-head` / `.svc-section-body`, and `data-section` attributes carrying the category key

Sections must be operable the moment they are rendered, so `toggleSection` ships
in this task rather than the next — a commit that renders a header whose click
handler does not exist is a broken commit, not a staged one.

- [ ] **Step 1: Add the section CSS**

In `booking-form.html`, after line 43 (`.services-grid{...}`), insert:

```css
/* ── Service sections ── */
.svc-section{border:2px solid #e9d5ff;border-radius:12px;overflow:hidden;background:#fff}
.svc-section-head{width:100%;display:flex;align-items:center;gap:10px;padding:13px 16px;
  background:#faf5ff;border:none;cursor:pointer;font:inherit;text-align:left;color:#1e1b4b}
.svc-section-head:hover{background:#f3e8ff}
.svc-section-icon{font-size:1.15rem;flex-shrink:0}
.svc-section-label{flex:1;font-weight:800;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em}
.svc-section-count{font-size:.75rem;font-weight:700;color:#7c3aed;background:#ede9fe;
  border-radius:10px;padding:2px 9px}
.svc-section-chev{font-size:.7rem;color:#7c3aed;transition:transform .2s}
.svc-section[open] .svc-section-chev{transform:rotate(180deg)}
.svc-section-body{display:none;flex-direction:column;gap:10px;padding:10px;background:#fdfcff;
  border-top:2px solid #e9d5ff}
.svc-section[open] .svc-section-body{display:flex}
```

- [ ] **Step 2: Extract card building from `buildStep2`**

Replace the body of `buildStep2()` (lines 595-635) with:

```js
function buildStep2() {
  const ids = S.seeAll ? ALL_SVC_IDS : (S.eventType ? S.eventType.svcs : []);
  document.getElementById('s2-heading').textContent = 'Choose your entertainment';
  document.getElementById('s2-sub').textContent = S.seeAll
    ? 'Showing all available services'
    : `Showing options for: ${S.eventType.label}`;

  const grid = document.getElementById('svc-grid');
  grid.innerHTML = '';

  const catOf = (id) => dbServiceCategories[id];
  const valid = ids.filter(id => SERVICES[id]);

  if (!shouldSection(valid, catOf)) {
    valid.forEach(id => grid.appendChild(renderSvcCard(id)));
    return;
  }

  const sections = groupByCategory(valid, catOf);
  // The first non-empty section opens — not literally "shows", so a
  // library-only flow opens Library rather than showing shut drawers.
  const openKey = sectionKeyToOpen(sections);

  sections.forEach(sec => {
    const wrap = document.createElement('div');
    wrap.className = 'svc-section';
    wrap.dataset.section = sec.key;
    if (sec.key === openKey) wrap.setAttribute('open', '');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'svc-section-head';
    head.setAttribute('aria-expanded', String(sec.key === openKey));
    head.innerHTML =
      `<span class="svc-section-icon">${sec.icon}</span>` +
      `<span class="svc-section-label">${sec.label}</span>` +
      `<span class="svc-section-count">${sec.ids.length}</span>` +
      `<span class="svc-section-chev">▼</span>`;
    head.onclick = () => toggleSection(sec.key);

    const body = document.createElement('div');
    body.className = 'svc-section-body';
    sec.ids.forEach(id => body.appendChild(renderSvcCard(id)));

    wrap.appendChild(head);
    wrap.appendChild(body);
    grid.appendChild(wrap);
  });
}

// Open the section holding the current selection, else the first one.
function sectionKeyToOpen(sections) {
  if (S.svcId) {
    const owner = sections.find(s => s.ids.includes(S.svcId));
    if (owner) return owner.key;
  }
  return sections.length ? sections[0].key : null;
}

function renderSvcCard(id) {
  const svc = SERVICES[id];
  const card = document.createElement('div');
  card.className = 'svc-card' + (S.svcId === id ? ' selected' : '');
  card.id = 'svc-card-' + id;

  const priceStr = svc.priceNote
    ? `<span class="price-note">${svc.priceNote} </span>$${svc.price.toLocaleString()}`
    : `$${svc.price.toLocaleString()}`;

  card.innerHTML = `
    <div class="svc-card-header" onclick="selectService('${id}')">
      <div class="svc-icon">${svc.icon}</div>
      <div class="svc-info">
        <div class="svc-name">${svc.name}</div>
        <div class="svc-price">${priceStr}</div>
        ${svc.desc ? `<div class="svc-desc">${svc.desc}</div>` : ''}
        ${svc.duration ? `<div class="svc-duration">⏱ ${svc.duration}</div>` : ''}
      </div>
      <div class="svc-select-indicator"></div>
    </div>
    <div class="svc-accordion" id="acc-${id}">
      ${buildAccordion(svc)}
    </div>`;
  return card;
}
```

- [ ] **Step 3: Add `toggleSection` so the headers actually work**

Insert directly above `function selectService(id)` (line 726):

```js
function toggleSection(key) {
  const sec = document.querySelector(`.svc-section[data-section="${key}"]`);
  if (!sec) return;
  const nowOpen = !sec.hasAttribute('open');
  if (nowOpen) sec.setAttribute('open', '');
  else sec.removeAttribute('open');
  const head = sec.querySelector('.svc-section-head');
  if (head) head.setAttribute('aria-expanded', String(nowOpen));
}
```

- [ ] **Step 4: Verify in the browser**

Serve the form and check all four structural shapes. Confirm: Kids Birthday
shows three section headers with counts 2/3/9 and only Main Shows open;
Library Summer Reading shows six bare cards with no headers; School Assembly
shows one bare card; Browse all shows four headers. Click each header open and
shut. Tab to a header and press Enter — it toggles, and `aria-expanded` flips
in devtools.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS — Task 1 tests still green (the helpers did not change).

- [ ] **Step 6: Commit**

```bash
git add booking-form.html
git commit -m "feat: group step-2 services into collapsible category sections"
```

---

### Task 3: Keep the selection visible

**Files:**
- Modify: `booking-form.html` — `selectService` (line 726)

**Interfaces:**
- Consumes: `toggleSection`, `sectionKeyToOpen` and the section DOM from Task 2
- Produces: nothing new — this task only changes behaviour

- [ ] **Step 1: Keep the selected card's section open**

`selectService` rebuilds the accordion but must not let a later re-render close
the section around the selection. Replace the `setTimeout` scroll line (line 740)
with:

```js
    // Keep the section holding this card open, then bring the card into view.
    const sec = card.closest('.svc-section');
    if (sec && !sec.hasAttribute('open')) toggleSection(sec.dataset.section);
    setTimeout(() => card.scrollIntoView({ behavior:'smooth', block:'nearest' }), 50);
```

- [ ] **Step 3: Verify in the browser**

On Kids Birthday: expand Party Experiences, pick Foam Party, collapse and
re-expand the section — the card stays selected. Go to step 3 and press Back —
Party Experiences is open with Foam Party still selected, not Main Shows.
Tab to a header and press Enter — it toggles, and `aria-expanded` flips in devtools.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add booking-form.html
git commit -m "feat: collapse/expand sections and keep the selection visible"
```

---

### Task 4: Subtotal helpers

**Files:**
- Modify: `booking-form.html` — extend the pure-helper block from Task 1
- Modify: `test/booking-form-grouping.test.js` — add subtotal tests

**Interfaces:**
- Consumes: nothing
- Produces: `resolveAddon(svc, aid, pbAddons, dbAddonList) -> {id,name,price}|null`, `step2Subtotal(svc, extraHours, addonIds, resolve) -> {total, perGuest, isQuote, addonCount}|null`

- [ ] **Step 1: Write the failing tests**

Append to `test/booking-form-grouping.test.js`. Also update the extraction line
in `loadHelpers()` to export the new functions:

```js
// In loadHelpers(), change the export line to:
//   '\nout = { groupByCategory, shouldSection, CATEGORY_ORDER, resolveAddon, step2Subtotal };'
const { resolveAddon, step2Subtotal } = loadHelpers();

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/booking-form-grouping.test.js`
Expected: FAIL — `resolveAddon is not defined`

- [ ] **Step 3: Add the helpers**

Inside the pure-helper block in `booking-form.html`, before `// ══ END PURE HELPERS ══`:

```js
// Resolve an add-on id using the same precedence as the submitted payload
// (service list, then photo-booth list, then the DB catalogue). One resolver
// so the sticky-bar subtotal and the price actually submitted cannot disagree.
function resolveAddon(svc, aid, pbAddons, dbAddonList) {
  let a = ((svc && svc.addons) || []).find(x => x.id === aid)
       || (pbAddons || []).find(x => x.id === aid);
  if (!a) {
    const db = (dbAddonList || []).find(x => x.addon_id === aid);
    if (db) a = { id: db.addon_id, name: db.name, price: Number(db.price) };
  }
  return a || null;
}

// Step-2 subtotal: service + extra hours + fixed-price add-ons.
// Per-guest add-ons cannot be priced here because guest count is collected at
// step 3, so they are counted separately and surfaced as "+ per-guest extras"
// rather than being silently valued at zero.
function step2Subtotal(svc, extraHours, addonIds, resolve) {
  if (!svc) return null;
  let total = svc.isQuote ? 0 : (Number(svc.price) || 0);
  if (svc.extraHourRate && extraHours > 0) total += svc.extraHourRate * extraHours;
  let perGuest = 0;
  for (const aid of (addonIds || [])) {
    const a = resolve(aid);
    if (!a) continue;
    if (a.price === 'per_child') { perGuest++; continue; }
    total += Number(a.price) || 0;
  }
  return { total, perGuest, isQuote: !!svc.isQuote, addonCount: (addonIds || []).length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 16 tests in this file.

- [ ] **Step 5: Commit**

```bash
git add booking-form.html test/booking-form-grouping.test.js
git commit -m "feat: shared add-on resolver and step-2 subtotal"
```

---

### Task 5: Sticky selection bar

**Files:**
- Modify: `booking-form.html` — CSS after the section CSS; markup after `#step-2`'s `.btn-row` (line 184); `updateStep2Btn()` (line 757); `toggleAddon()` (line 745); `goTo()` (line 764)

**Interfaces:**
- Consumes: `step2Subtotal`, `resolveAddon` (Task 4)
- Produces: `renderStickyBar()`

- [ ] **Step 1: Add the CSS**

```css
/* ── Sticky selection bar ── */
#svc-sticky{position:fixed;left:0;right:0;bottom:0;z-index:60;display:none;
  background:#fff;border-top:2px solid #7c3aed;box-shadow:0 -6px 20px rgba(0,0,0,.12);
  padding:12px 18px;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
#svc-sticky.show{display:block}
.sticky-inner{max-width:760px;margin:0 auto;display:flex;align-items:center;gap:14px}
.sticky-text{flex:1;min-width:0}
.sticky-name{font-weight:700;color:#1e1b4b;font-size:.86rem;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.sticky-total{color:#7c3aed;font-weight:800;font-size:.95rem;margin-top:1px}
.sticky-note{font-size:.7rem;color:#888;font-weight:400}
body.sticky-on #step-2{padding-bottom:96px}
```

- [ ] **Step 2: Add the markup**

In `booking-form.html`, immediately after the closing `</div>` of `#step-2`'s
`.btn-row` (line 184), add:

```html
    <div id="svc-sticky">
      <div class="sticky-inner">
        <div class="sticky-text">
          <div class="sticky-name" id="sticky-name"></div>
          <div class="sticky-total" id="sticky-total"></div>
        </div>
        <button class="btn btn-primary" onclick="goTo(3)">Continue →</button>
      </div>
    </div>
```

- [ ] **Step 3: Render the bar**

Replace `updateStep2Btn()` (lines 757-759) with:

```js
function updateStep2Btn() {
  document.getElementById('btn-2').disabled = !S.svcId;
  renderStickyBar();
}

function renderStickyBar() {
  const bar = document.getElementById('svc-sticky');
  if (!bar) return;
  const svc = S.svcId ? SERVICES[S.svcId] : null;

  // Only on step 2, and only once something is selected.
  if (!svc || S.currentStep !== 2) {
    bar.classList.remove('show');
    document.body.classList.remove('sticky-on');
    return;
  }

  const pbList = ['pb_kiosk', 'pb_360']
    .map(id => dbAddons.find(x => x.addon_id === id))
    .filter(Boolean)
    .map(db => ({ id: db.addon_id, name: db.name, price: Number(db.price) }));
  const resolve = (aid) => resolveAddon(svc, aid,
    pbList.length ? pbList : PHOTO_BOOTH_ADDONS, dbAddons);

  const r = step2Subtotal(svc, getExtraHours(S.svcId), S.addons, resolve);

  const addonBit = r.addonCount
    ? ` + ${r.addonCount} add-on${r.addonCount > 1 ? 's' : ''}` : '';
  document.getElementById('sticky-name').textContent = svc.name + addonBit;

  // Quote-only services must never read "$0" — these are the highest-value
  // bookings on the form. Travel is unknown until the ZIP at step 3, so the
  // figure is always labelled a subtotal.
  const perGuestNote = r.perGuest ? ' <span class="sticky-note">+ per-guest extras</span>' : '';
  document.getElementById('sticky-total').innerHTML = r.isQuote
    ? `Custom quote <span class="sticky-note">from $${svc.price.toLocaleString()}</span>`
    : `$${r.total.toLocaleString()} <span class="sticky-note">subtotal</span>${perGuestNote}`;

  bar.classList.add('show');
  document.body.classList.add('sticky-on');
}
```

- [ ] **Step 4: Wire the missing add-on recalculation**

`toggleAddon` currently only flips CSS classes, so the subtotal would go stale
the moment an add-on is ticked. Append to `toggleAddon` (after line 754):

```js
  renderStickyBar();
```

- [ ] **Step 5: Hide the bar when leaving step 2**

In `goTo(n)` (line 764), after `S.currentStep = n;` (line 768), add:

```js
  renderStickyBar();  // clears the bar when leaving step 2
```

- [ ] **Step 6: Avoid two Continue buttons on screen**

Append after `renderStickyBar`:

```js
// When the real Back/Next row is already visible there is no reason to float a
// second Continue over it.
let btnRowObserver = null;
function watchStep2BtnRow() {
  if (btnRowObserver || !('IntersectionObserver' in window)) return;
  const row = document.getElementById('btn-2');
  if (!row) return;
  btnRowObserver = new IntersectionObserver(([entry]) => {
    const bar = document.getElementById('svc-sticky');
    if (!bar || !bar.classList.contains('show')) return;
    bar.style.visibility = entry.isIntersecting ? 'hidden' : 'visible';
  }, { rootMargin: '0px 0px -40px 0px' });
  btnRowObserver.observe(row);
}
```

Call it once at the end of the `DOMContentLoaded` handler (line 569):

```js
  watchStep2BtnRow();
```

- [ ] **Step 7: Verify in the browser**

Pick a service near the top of Kids Birthday — the bar appears immediately with
the right name and subtotal, without scrolling. Tick Glitter Tattoos: the total
rises by $75. Pick Game Show (Corporate): the bar reads "Custom quote from
$3,500", never `$0`. Scroll to the bottom: the floating bar hides as the real
Next button comes into view. On a narrow viewport confirm the last card is not
covered. Press Continue on the bar and confirm it lands on step 3 and the bar
disappears.

- [ ] **Step 8: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add booking-form.html
git commit -m "feat: sticky selection bar keeps Continue reachable on step 2"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 category from API, no hardcoding, flat fallback | Task 1 steps 3-4 |
| §2 `shouldSection` rule, nine entry points | Task 1 steps 1-3 |
| §3 order, labels, More Options, first-open, `aria-expanded`, re-open on return | Tasks 2 and 3 |
| §4 sticky bar, `isQuote`, subtotal label, IntersectionObserver, bottom padding | Tasks 4 and 5 |
| §Verification automated tests | Tasks 1 and 4 |
| §Verification manual browser pass | Tasks 2, 3, 5 |

**Placeholder scan:** none — every step carries the literal code to apply.

**Type consistency:** `groupByCategory` returns `{key,label,icon,ids}` in Task 1
and is consumed with exactly those fields in Task 2. `shouldSection(ids, catOf)`
keeps its two-argument shape at both sites. `step2Subtotal` returns
`{total, perGuest, isQuote, addonCount}` in Task 4 and Task 5 reads exactly
those four.

**Prototyped before handing over:** the sentinel-plus-`vm` extraction and every
helper in Tasks 1 and 4 were run end to end against the exact code in this plan.
That run surfaced a defect in the first draft — `assert.deepStrictEqual` compares
prototypes, and values built inside a `vm` context belong to a different realm,
so structural assertions failed with "same structure but not reference-equal".
Every such assertion now goes through `plain()`. Without this the whole test file
would have failed on first run against correct implementation code.

**Fixed during review:** `toggleSection` was originally defined in Task 3 but
called from Task 2's `head.onclick`, so the Task 2 commit would have rendered
headers that threw a ReferenceError when clicked. It now ships in Task 2
alongside the markup that needs it, and Task 3 narrowed to the genuinely
separate concern of keeping the selection visible. Every task now leaves the
form in a working state.

**Every commit is releasable:** Task 1 changes no behaviour (helpers are unused
until Task 2). Task 2 leaves sections rendering and toggling. Task 3 refines
which section is open. Task 4 again changes no behaviour. Task 5 adds the bar.
No intermediate state ships a broken form.

**Note carried from the spec:** the `> 4` threshold puts Corporate Event
(4 services, 2 categories) on the flat path. Owner accepted this; changing it to
`>= 4` is a one-character edit in `shouldSection`.
