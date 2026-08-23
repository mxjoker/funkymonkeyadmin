const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// staff-portal and admin are installable to a phone home screen; my-booking is
// deliberately not (clients visit twice and install nothing).
const APPS = [
  { page: 'staff-portal.html', manifest: 'manifest-staff.json', start: '/staff' },
  { page: 'admin.html',        manifest: 'manifest-admin.json', start: '/admin.html' },
];

for (const app of APPS) {
  test(`${app.page} is installable`, () => {
    const html = read(app.page);

    assert.match(html, /viewport-fit=cover/, 'env() safe-area values are all 0 without this');
    assert.match(html, new RegExp(`<link rel="manifest" href="/${app.manifest}"`));
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/,
      'iOS ignores the manifest for standalone mode — it needs this tag');

    const m = JSON.parse(read(app.manifest));
    assert.equal(m.start_url, app.start);
    assert.equal(m.display, 'standalone');

    // Every icon the manifest or the head tag promises must actually exist —
    // a 404 here degrades silently to a screenshot thumbnail on the home screen.
    const appleIcon = html.match(/rel="apple-touch-icon" href="([^"]+)"/);
    assert.ok(appleIcon, 'iOS will not use a manifest icon; it needs apple-touch-icon');
    for (const src of [...m.icons.map(i => i.src), appleIcon[1]]) {
      assert.ok(fs.existsSync(path.join(root, src)), `missing icon file: ${src}`);
    }
  });

  test(`${app.page} keeps the session across launches`, () => {
    const html = read(app.page);
    // An installed app that logs you out on every launch is worse than a
    // bookmark. sessionStorage dies with the tab, so it must not come back.
    assert.doesNotMatch(html, /sessionStorage/,
      'auth must go through authStore (localStorage), not sessionStorage');
    assert.match(html, /const authStore = localStorage/);
    // localStorage.clear() would wipe the whole origin, not just the session.
    assert.doesNotMatch(html, /authStore\.clear\(\)/);
  });

  test(`${app.page} registers no service worker`, () => {
    // Deliberate: every screen is live DB data, and deploys are manual — a cache
    // would serve staff stale code with no way to tell them to hard-refresh.
    assert.doesNotMatch(read(app.page), /serviceWorker/);
  });
}
