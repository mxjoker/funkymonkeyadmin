const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function loadHelper() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = { URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = venmoPayLink;', ctx);
  return ctx.out;
}

const venmoPayLink = loadHelper();
const venmo = (handle) => ({ payment_method: 'Venmo', payment_handle: handle });

test('prefills the handle, the amount and the note', () => {
  const url = venmoPayLink(venmo('@Cody-Smith'), 155, 'week ending 2026-09-13');
  assert.ok(url.startsWith('https://venmo.com/Cody-Smith?'), url); // leading @ stripped
  const q = new URL(url).searchParams;
  assert.strictEqual(q.get('txn'), 'pay');
  assert.strictEqual(q.get('amount'), '155.00');
  assert.strictEqual(q.get('note'), 'week ending 2026-09-13');
});

// Paying the wrong person is worse than no button, so every case where we
// can't name a real Venmo recipient renders nothing at all.
test('no link unless we can name a real Venmo recipient and a real amount', () => {
  assert.strictEqual(venmoPayLink(null, 50, ''), null);
  assert.strictEqual(venmoPayLink(venmo(''), 50, ''), null, 'no handle');
  assert.strictEqual(venmoPayLink(venmo('   '), 50, ''), null, 'blank handle');
  assert.strictEqual(venmoPayLink({ payment_method: 'Zelle', payment_handle: 'x' }, 50, ''), null,
    'paid by Zelle — a Venmo button would send it to the wrong place');
  assert.strictEqual(venmoPayLink({ payment_handle: 'x' }, 50, ''), null, 'method never set');
  assert.strictEqual(venmoPayLink(venmo('x'), 0, ''), null, 'zero owed');
  assert.strictEqual(venmoPayLink(venmo('x'), null, ''), null, 'no amount');
});

test('case of the stored method does not matter', () => {
  assert.ok(venmoPayLink({ payment_method: 'venmo', payment_handle: 'x' }, 5, ''));
});
