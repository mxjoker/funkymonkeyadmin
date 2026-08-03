# Booking Form — Service Grouping and Reachable Continue

**Date:** 2026-08-02
**File touched:** `booking-form.html` (only)
**Status:** approved, ready for implementation planning

## Problem

Step 2 of the booking form renders every service for the chosen event type as a
flat single-column stack. `.services-grid` is `display:flex; flex-direction:column`
with no headings, no categories, and no collapsing.

Measured against the live catalogue:

| Entry point | Services | Approx. stack height |
|---|---|---|
| Kids Birthday Party | 14 | ~1,550px |
| Family Gathering | 15 | ~1,650px |
| Community Event | 16 | ~1,760px |
| Browse all services | 27 | ~2,970px |

Two consequences, both reported by the owner:

1. **No grouping.** Fourteen-plus unrelated services — magic shows, face painting,
   foam cannons, photo booths — read as one undifferentiated list.
2. **Continue is unreachable.** The `.btn-row` holding "Next: Event Details →"
   sits *after* the entire grid. Selecting a service also expands its
   `.svc-accordion` inline (add-ons, hour pickers), pushing Continue further down.
   Picking the first card is precisely when Continue is furthest away.

## Non-goals

- Steps 1, 3 and 4 are untouched.
- No changes to prices, the `SERVICES` data, add-on logic, or the submit payload.
- No new dependency, framework, or build step.
- Auto-advancing on selection is explicitly rejected: the accordion holds add-on
  choices the customer still needs to make.

## Design

### 1. Grouping data comes from the API, not from hardcoded data

`loadAddonsFromDB()` already fetches `/api/services`. Those rows carry a
`category` column (`shows` | `performers` | `experiences` | `library`) that the
form currently discards.

Capture it into a `dbServiceCategories` map (`{ service_id: category }`),
following the existing `dbServiceAddons` / `dbServiceEventTypes` pattern.

Verified 2026-08-02: all 27 entries in the form's `SERVICES` map correspond 1:1
to DB services, every one has a category, and there are no services on either
side that the other lacks. Hardcoding categories into `SERVICES` was rejected —
it would duplicate 27 rows the owner already maintains in Catalogue, and drift.

**Degradation:** if the fetch fails (the existing `catch`) or a service has no
category, that service is uncategorised and the list renders flat, exactly as it
does today. The worst case is current behaviour, never a broken list.

### 2. Sections appear only when they earn their keep

```
shouldSection(services) === (distinct non-empty categories >= 2) && (services.length > 4)
```

Applied to all nine real entry points:

| Entry point | Services | Categories | Result |
|---|---|---|---|
| Kids Birthday Party | 14 | 3 | Sectioned (shows 2, performers 3, experiences 9) |
| Family Gathering | 15 | 3 | Sectioned (shows 3, performers 3, experiences 9) |
| Community Event | 16 | 3 | Sectioned (shows 4, performers 3, experiences 9) |
| Browse all services | 27 | 4 | Sectioned |
| Library Summer Reading | 6 | 1 | **Flat** — one category; a lone wrapper is pure chrome |
| Corporate Event | 4 | 2 | **Flat** — 4 cards is ~440px |
| Wedding | 3 | 2 | **Flat** |
| School Assembly | 1 | 1 | **Flat** — no `MAIN SHOWS 1 ▲` around one card |
| School Fundraiser | 1 | 1 | **Flat** |

Both halves of the condition are load-bearing: the category count alone would
wrap Corporate's 4 services in two drawers, and the service count alone would
wrap Library's 6 in a single pointless drawer.

### 3. Section rendering and behaviour

Display order and customer-facing labels (admin vocabulary is not shown):

| DB category | Label | Icon | Order |
|---|---|---|---|
| `shows` | Main Shows | 🎩 | 1 |
| `performers` | Add-On Entertainers | 🎨 | 2 |
| `experiences` | Party Experiences | 🎊 | 3 |
| `library` | Library Programs | 📚 | 4 |
| *(anything else)* | More Options | ✨ | last |

The `More Options` bucket exists so a category added in Catalogue later still
renders rather than vanishing from the form.

- **The first non-empty section starts open** — not literally `shows`. A
  Library-only flow opens Library rather than presenting shut drawers.
- Headers are real `<button>` elements carrying `aria-expanded`, so keyboard and
  screen-reader users can operate them. Header shows icon, label, service count,
  and a chevron reflecting state.
- Collapsing toggles a class controlling `display` on the section body. No
  animation library; a CSS transition at most.
- Selecting a service keeps its section open.
- Re-entering step 2 (via Back, or the progress-bar `navToStep`) re-opens
  whichever section contains the current selection, so the choice is never
  hidden behind a collapsed header.

### 4. Sticky selection bar

A bar pinned to the viewport bottom, rendered only when `S.svcId` is set.

Contents: service name · add-on count · subtotal · Continue.

Two deliberate decisions:

- **Quote-only services show "Custom quote", never `$0`.** `corporate_magic`,
  `game_show` and `wedding_magic` all carry `isQuote:true` and compute
  `svcPrice = 0`. A `$0` on the three highest-value bookings would be alarming
  and wrong.
- **The figure is labelled a subtotal.** Travel is unknown until the ZIP is
  entered at step 3, and `total_price` excludes travel by design. Labelling it
  a subtotal keeps the higher step-4 figure from reading as a bait-and-switch.

Subtotal formula matches the existing step-4 computation minus mileage:
`svcPrice + extraHoursCost + addonTotal`. It updates when add-ons or the hour
picker change.

Supporting behaviour:

- The bar hides itself while the real `.btn-row` is in view, via
  `IntersectionObserver`, so two Continue buttons are never on screen at once.
- Step 2 gains bottom padding while the bar is visible so the last card is never
  covered.
- The existing `.btn-row` stays exactly as it is — it is also the home of the
  Back button, which the sticky bar does not duplicate.

## Verification

The form currently has no tests. `groupByCategory()` and `shouldSection()` are
extracted as pure functions so they can be tested without a browser, using the
same `vm`-extraction approach already used against `admin.html` in
`test/staff-assignments.test.js` (which caught a real `EXCLUSIVE_TAGS` drift).

Automated (`node --test`, added to the existing suite):

- `shouldSection` returns the expected verdict for all nine entry points above.
- `groupByCategory` preserves every input service (nothing silently dropped).
- Section order follows the table in §3 regardless of input order.
- An unknown category lands in `More Options` rather than disappearing.
- A service with no category forces the flat path.
- The first non-empty section is the one marked open.

Manual browser pass on the four structurally distinct shapes: Kids Birthday
(sectioned, 3), Library Summer Reading (flat, 6), School Assembly (flat, 1),
Browse all (sectioned, 4). Confirm on a narrow viewport that the sticky bar does
not cover the last card and does not double up with the `.btn-row`.

## Open judgment call

Corporate Event (4 services, 2 categories) falls flat under the `> 4` threshold.
Raised with the owner; flat was accepted. Changing the threshold to `>= 4` is a
one-character change if that proves wrong in practice.
