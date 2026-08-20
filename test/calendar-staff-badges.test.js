const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// The calendar's staff initials disappeared after 38239c8 changed the grid to
// minmax(0,1fr) so columns could shrink below content width. .cal-evt is a
// flex row with overflow:hidden; the badges kept the default flex-shrink:1 and
// were squeezed to zero. Nothing errored — the name just took the space.
test('.cal-evt is still a flex row that can shrink', () => {
  const rule = HTML.split('.cal-evt{')[1].split('}')[0];
  assert.ok(/display:flex/.test(rule), '.cal-evt is no longer flex — re-check the badge assumptions');
  assert.ok(/overflow:hidden/.test(rule), '.cal-evt no longer clips — re-check the badge assumptions');
});

test('calendar staff badges refuse to shrink', () => {
  const badge = HTML.split('const staffBadges = ')[1].split('.join')[0];
  assert.ok(/flex:0 0 auto/.test(badge),
    'calendar staff badges lost flex:0 0 auto — they will be squeezed to nothing in a narrow column');
  assert.ok(/width:18px/.test(badge), 'badge lost its fixed width');
});

test('the grid still uses minmax(0,1fr), the reason the badges need pinning', () => {
  // If this ever goes back to plain 1fr the mobile overflow returns. Pinned so
  // the two facts stay connected: the badge fix only matters because of this.
  assert.ok(/\.cal-grid\{[^}]*minmax\(0,1fr\)/.test(HTML),
    '.cal-grid no longer uses minmax(0,1fr) — mobile columns will overflow again');
});

// The actual cause of the missing initials: loadBookings() ends with
// refreshAllViews() -> renderCalendar(), so in init() the grid was built while
// calStaffMap was still {}. The map then filled (44 bookings) and nothing
// re-rendered, so the badges were absent from the DOM while the data was
// present in memory — which is why every check of the data looked healthy.
test('init loads the staff map before the calendar is rendered', () => {
  const raw = HTML.split('async function init()')[1].split('\n}')[0];
  // Comments explain the bug and name renderCalendar(), so they must be
  // stripped before asking where the call actually sits.
  const init = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(/Promise\.all\(\[[^\]]*loadCalStaffMap\(\)/s.test(init),
    'loadCalStaffMap must be awaited alongside loadBookings, not after it');
  const renderIdx = init.indexOf('renderCalendar()');
  const awaitIdx = init.indexOf('await Promise.all');
  assert.ok(renderIdx > awaitIdx && awaitIdx !== -1,
    'init must call renderCalendar() after the data load — loadBookings renders it too early');
});
