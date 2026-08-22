const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function load() {
  const a = HTML.indexOf('function matchesStatusFilter');
  const b = HTML.indexOf('function exportBookingsCSV');
  assert.ok(a !== -1 && b > a, 'matchesStatusFilter is gone from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = matchesStatusFilter;', ctx);
  return ctx.out;
}
const matches = load();

test('an empty filter shows everything, cancelled included', () => {
  for (const status of ['draft', 'review', 'quoted', 'accepted', 'confirmed', 'completed', 'cancelled']) {
    assert.strictEqual(matches({ status }, ''), true, `${status} was hidden by "All Statuses"`);
  }
});

test('a bare status shows only that status', () => {
  assert.strictEqual(matches({ status: 'confirmed' }, 'confirmed'), true);
  assert.strictEqual(matches({ status: 'quoted' }, 'confirmed'), false);
  assert.strictEqual(matches({ status: 'cancelled' }, 'cancelled'), true);
});

test('"All but Cancelled" shows every other status', () => {
  for (const status of ['draft', 'review', 'quoted', 'accepted', 'confirmed', 'completed']) {
    assert.strictEqual(matches({ status }, '!cancelled'), true, `${status} was hidden`);
  }
  assert.strictEqual(matches({ status: 'cancelled' }, '!cancelled'), false);
});

// A booking with no status set reads as live, not as cancelled — hiding a row
// because a column is NULL is how a real booking disappears off the board.
test('a booking with no status survives "All but Cancelled"', () => {
  assert.strictEqual(matches({ status: null }, '!cancelled'), true);
  assert.strictEqual(matches({}, '!cancelled'), true);
});

// The option and the rule are in different parts of the file; a value typo in
// one is invisible until someone picks it and sees an empty table.
test('the dropdown option matches the rule the filter implements', () => {
  assert.match(HTML, /<option value="!cancelled" selected>All but Cancelled<\/option>/,
    'the "All but Cancelled" option is gone, renamed, or no longer the default');
});

// The CSV export used to carry its own copy of the status test. Exporting a
// different set from the one on screen is only noticed once it is in a
// spreadsheet.
test('the export and the table share one status rule', () => {
  const exportFn = HTML.slice(HTML.indexOf('function exportBookingsCSV'),
                              HTML.indexOf('function exportBookingsCSV') + 600);
  assert.match(exportFn, /matchesStatusFilter\(b, statusFilter\)/,
    'the CSV export is filtering on its own copy of the rule again');
  const table = HTML.slice(HTML.indexOf('  // Apply filters'), HTML.indexOf('  if (search) {'));
  assert.match(table, /matchesStatusFilter\(b, statusFilter\)/,
    'the table is filtering on its own copy of the rule again');
});

// ── "Review now →" ──────────────────────────────────────────────────────────
// The dashboard alert counts bookings stuck in Review and then used to land on
// an unfiltered list of every booking there has ever been — making you redo the
// search it had just done for you.
test('the review alert opens the bookings page already filtered', () => {
  assert.match(HTML, /onclick="showBookingsFiltered\('review'\);return false"/,
    'the Review now link no longer opens the filtered view');
});

test('opening a filtered view sets the status and clears the other filters', () => {
  const a = HTML.indexOf('function showBookingsFiltered');
  const b = HTML.indexOf('function toggleActionBadge');
  assert.ok(a !== -1 && b > a, 'showBookingsFiltered is gone');

  const values = {}, checks = {};
  let rendered = 0, page = null;
  const el = (id) => ({
    get value() { return values[id]; }, set value(v) { values[id] = v; },
    get checked() { return checks[id]; }, set checked(v) { checks[id] = v; },
  });
  const ctx = {
    document: { getElementById: el },
    showPage: (p) => { page = p; },
    renderBookingsTable: () => { rendered++; },
  };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b), ctx);

  // Arrive with every filter left over from a previous look at the page.
  values['filter-search'] = 'burkhart';
  values['filter-date-range'] = 'upcoming';
  values['filter-deposit'] = 'unpaid';
  checks['filter-hide-past'] = true;
  checks['filter-hide-completed'] = true;

  ctx.showBookingsFiltered('review');

  assert.strictEqual(page, 'bookings', 'it must switch to the bookings page');
  assert.strictEqual(values['filter-status'], 'review');
  // A leftover filter would show fewer rows than the alert promised, and the
  // obvious conclusion is that the alert was lying.
  assert.strictEqual(values['filter-search'], '');
  assert.strictEqual(values['filter-date-range'], 'all');
  assert.strictEqual(values['filter-deposit'], '');
  for (const id of ['filter-hide-past', 'filter-hide-completed']) {
    assert.strictEqual(checks[id], false, `${id} was left on`);
  }
  assert.strictEqual(rendered, 1, 'the table must be re-rendered with the new filter');
});

// ── The default view ────────────────────────────────────────────────────────
// 158 of 717 bookings are cancelled. The list is almost always wanted without
// them, and the separate "Hide Cancelled" checkbox that used to do this job was
// a second control for one rule.
test('the bookings list opens without cancelled bookings', () => {
  const select = HTML.slice(HTML.indexOf('<select id="filter-status"'),
                            HTML.indexOf('</select>', HTML.indexOf('<select id="filter-status"')));
  const selected = select.match(/<option value="([^"]*)" selected>/);
  assert.ok(selected, 'no default is marked on the status filter');
  assert.strictEqual(selected[1], '!cancelled');
});

test('the Hide Cancelled checkbox is gone, and nothing still reads it', () => {
  assert.ok(!/filter-hide-cancelled/.test(HTML),
    'the checkbox is back — two controls for one rule is how they end up disagreeing');
});
