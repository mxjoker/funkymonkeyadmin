const { test } = require('node:test');
const assert = require('node:assert');
const { TEMPLATES } = require('../netlify/functions/_templates.js');

// Phase 4 of camps. Before this, a client could fill in the whole camp form
// and hear nothing back, and a camp could be moved to a different town with
// nobody told. A single booking's finalise had sent both since August; the
// camp path sent neither.
//
// The security case is the sharper one: auth is a reference plus an email, so
// anyone forwarded a camp link could change the contact address and quietly
// take over a WEEK of bookings. The notice to the old address is the only
// control that flow has.

function loadHandler(client, opts = {}) {
  const mods = [
    '../netlify/functions/finalise-camp.js', '../netlify/functions/finalise.js',
    '../netlify/functions/_db.js', '../netlify/functions/_auth.js',
    '../netlify/functions/automations.js', '../netlify/functions/_email.js',
  ];
  for (const m of mods) delete require.cache[require.resolve(m)];
  require('../netlify/functions/_db.js').withClient = async (fn) => fn(client);
  require('../netlify/functions/_auth.js').preflight = () => null;

  const automations = require('../netlify/functions/automations.js');
  automations.sendTemplate = async (_c, booking, key, _link, o = {}) => {
    if (opts.failOn === key) throw new Error('simulated send failure');
    client.sent.push({ key, to: o.to || booking.client_email, extra: o.extra || {}, booking });
    return { sent: true };
  };
  require('../netlify/functions/_email.js').logChange = async (_c, id, action, detail) => {
    client.logged.push({ id, action, detail });
  };
  return require('../netlify/functions/finalise-camp.js');
}

const CAMP = {
  id: 5, reference: 'CAMP-ABCDEFGH', label: 'MAC Summer Camp',
  client_name: 'Jane Doe', client_phone: '4055550000', client_email: 'jane@example.com',
  event_location: '100 Main St, Edmond, OK', event_zip: '73034',
  venue: 'The MAC', surface_type: 'gym', event_time: '09:00', notes: '',
};
const DAYS = [
  { id: 10, camp_id: 5, event_date: '2026-07-14', contract_signed: false },
  { id: 11, camp_id: 5, event_date: '2026-07-15', contract_signed: false },
  { id: 12, camp_id: 5, event_date: '2026-07-16', contract_signed: false },
];

function fakeClient(camp = CAMP, days = DAYS) {
  const camps = [{ ...camp }];
  const bookings = days.map(d => ({ ...d }));
  return {
    sent: [], logged: [],
    get camps() { return camps; },
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
      if (/SELECT \* FROM camps WHERE reference = \$1/i.test(sql)) {
        // Copies, not the live rows: a real SELECT hands back a fresh object,
        // and returning the stored one let the later UPDATE mutate the very
        // snapshot the change detection compares against — so every test saw
        // "nothing changed".
        return { rows: camps.filter(c => c.reference === params[0]).map(c => ({ ...c })) };
      }
      if (/SELECT id, event_date, contract_signed FROM bookings WHERE camp_id = \$1/i.test(sql)) {
        return { rows: bookings.filter(b => b.camp_id === params[0]) };
      }
      if (/^\s*UPDATE camps SET/i.test(sql)) {
        const row = camps.find(c => c.id === params[params.length - 1]);
        [...sql.matchAll(/(\w+)=\$\d+/g)].map(m => m[1]).forEach((col, i) => { row[col] = params[i]; });
        return { rows: [{ ...row }] };
      }
      if (/^\s*UPDATE bookings SET/i.test(sql)) return { rows: [] };
      throw new Error('unexpected SQL: ' + sql.trim().split('\n')[0]);
    },
  };
}

const save = async (client, updates, opts) => {
  const mod = loadHandler(client, opts);
  return mod.handler({
    httpMethod: 'PATCH', path: '/api/finalise-camp',
    body: JSON.stringify({ reference: 'CAMP-ABCDEFGH', email: 'jane@example.com', updates }),
  });
};
const keys = (c) => c.sent.map(s => s.key);

// ── the client hears back ─────────────────────────────────────────────────

test('an ordinary camp edit sends the client a receipt listing what changed', async () => {
  const c = fakeClient();
  const res = await save(c, { venue: 'The MAC — Gym B', event_time: '10:00' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(keys(c), ['booking_updated_receipt']);
  assert.strictEqual(c.sent[0].to, 'jane@example.com');
  assert.match(c.sent[0].extra.change_list, /Gym B/, 'the receipt must say what actually changed');
  assert.match(c.sent[0].extra.change_list, /10:00/);
});

test('a save that changes nothing sends nothing', async () => {
  const c = fakeClient();
  await save(c, { venue: 'The MAC' });   // already its value
  assert.deepStrictEqual(keys(c), [], 'a no-op save must not mail the client');
});

// ── the camp moved ────────────────────────────────────────────────────────

test('moving the camp alerts us, and says it moves every day', async () => {
  const c = fakeClient();
  await save(c, { event_zip: '73013' });
  assert.ok(keys(c).includes('camp_moved_alert'), 'a camp changed town and nobody was told');
  const alert = c.sent.find(s => s.key === 'camp_moved_alert');
  assert.match(alert.extra.zip_case, /73034/);
  assert.match(alert.extra.zip_case, /73013/);
  assert.strictEqual(alert.extra.changed_what, 'the ZIP');
  assert.strictEqual(alert.extra.day_count, '3 days');
  assert.match(alert.extra.camp_dates, /Jul/, 'the alert should name the camp dates');
});

// The address-only path: normaliseAddress keeps the stored ZIP when the typed
// address embeds a different one, so zipChanged() stays false and the camp has
// still moved. Watching only the ZIP left this silent for a booking once.
test('an address whose ZIP disagrees also alerts, even though event_zip did not change', async () => {
  const c = fakeClient();
  await save(c, { event_location: '55 Broadway, Oklahoma City, OK 73102' });
  const alert = c.sent.find(s => s.key === 'camp_moved_alert');
  assert.ok(alert, 'the address-only move was silent');
  assert.strictEqual(alert.extra.changed_what, 'the address');
});

test('the move is written to the changelog against the camp first day', async () => {
  const c = fakeClient();
  await save(c, { event_zip: '73013' });
  const moved = c.logged.find(l => /moved by client/.test(l.action));
  assert.ok(moved, 'nothing recorded that the camp moved');
  assert.strictEqual(moved.id, 10, 'logged against the first day, the anchor row');
  assert.match(moved.detail, /CAMP-ABCDEFGH/, 'the entry must name the camp, not just a day');
});

// ── the email changed ─────────────────────────────────────────────────────

test('changing the contact email warns the OLD address first, then re-issues', async () => {
  const c = fakeClient();
  await save(c, { client_email: 'new@example.com' });
  assert.deepStrictEqual(keys(c), ['contact_email_changed', 'finalise_link_reissued'],
    'the warning to the old address must go first — it is the only control this flow has');
  assert.strictEqual(c.sent[0].to, 'jane@example.com', 'the warning went to the wrong address');
  assert.strictEqual(c.sent[1].to, 'new@example.com');
});

test('no receipt is sent on top of the email-change pair', async () => {
  const c = fakeClient();
  await save(c, { client_email: 'new@example.com', venue: 'Gym B' });
  assert.ok(!keys(c).includes('booking_updated_receipt'), 'a third email would be noise');
  const reissue = c.sent.find(s => s.key === 'finalise_link_reissued');
  assert.match(reissue.extra.change_block, /Gym B/, 'the other changes must be folded in, not lost');
});

test('a camp whose old address is blank still re-issues to the new one', async () => {
  const c = fakeClient({ ...CAMP, client_email: 'jane@example.com' });
  c.camps[0].client_email = 'jane@example.com';
  await save(c, { client_email: 'new@example.com' });
  assert.ok(keys(c).includes('finalise_link_reissued'));
});

// ── failures must not cost the client their save ──────────────────────────

test('a failed send still returns 200 — the save is what matters', async () => {
  const c = fakeClient();
  const res = await save(c, { event_zip: '73013' }, { failOn: 'camp_moved_alert' });
  assert.strictEqual(res.statusCode, 200, 'an email failure must never undo a client edit');
  assert.strictEqual(c.camps[0].event_zip, '73013', 'and the edit must still be saved');
});

test('a failed old-address warning does not stop the re-issue', async () => {
  const c = fakeClient();
  const res = await save(c, { client_email: 'new@example.com' }, { failOn: 'contact_email_changed' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(keys(c), ['finalise_link_reissued'],
    'the client would otherwise be left with no working link at all');
});

// ── the template itself ───────────────────────────────────────────────────

test('camp_moved_alert exists, goes to us, and declares its extras', () => {
  const t = TEMPLATES.find(x => x.template_key === 'camp_moved_alert');
  assert.ok(t, 'the camp move alert is not seeded');
  assert.strictEqual(t.recipient, 'admin', 'this is an internal alert — never mail it to the client');
  assert.deepStrictEqual([...t.extras].sort(),
    ['camp_dates', 'changed_what', 'day_count', 'zip_case']);
  for (const e of t.extras) {
    assert.ok(t.body_html.includes(`{{${e}}}`), `${e} is declared but never used in the body`);
  }
});

// The whole reason it is not just reusing zip_changed_alert: that template
// closes with "the total is unchanged at ${{total_price}} — mileage was not
// recalculated", which is false twice over for a camp. An alert to ourselves
// has to be accurate to be worth having.
test('camp_moved_alert does not quote a total or mileage', () => {
  const t = TEMPLATES.find(x => x.template_key === 'camp_moved_alert');
  assert.ok(!t.body_html.includes('{{total_price}}'), 'a camp has no total until it is closed out');
  assert.ok(!t.body_html.includes('{{mileage_cost}}'), 'a camp is priced per kid — mileage is not in it');
});

test('every template key finalise-camp sends is actually seeded', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../netlify/functions/finalise-camp.js'), 'utf8');
  const used = [...src.matchAll(/sendTemplate\([^,]+,[^,]+,\s*'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(used.length >= 3, 'expected finalise-camp to send at least three templates');
  for (const k of used) {
    assert.ok(TEMPLATES.some(t => t.template_key === k), `finalise-camp sends "${k}" but nothing seeds it`);
  }
});

test('template keys and sort_orders are unique', () => {
  const k = TEMPLATES.map(t => t.template_key);
  assert.strictEqual(new Set(k).size, k.length, 'a duplicate template_key would overwrite wording');
  const admin = TEMPLATES.filter(t => t.recipient === 'admin').map(t => t.sort_order);
  assert.strictEqual(new Set(admin).size, admin.length, 'two admin messages share a sort_order');
});
