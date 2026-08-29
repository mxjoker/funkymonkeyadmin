// netlify/functions/camps.js
// Phase 1 of "camps": a week-long booking taken as one deliberate group
// instead of separately-typed rows, one per day. Nothing here infers a camp
// — the same query that finds a real camp also finds jfuller@eols.org's 14
// separate summer shows in one week, and grouping those would be wrong. A
// camp exists only when someone creates one here.
//
// Scope is deliberately narrow: this table, plus bookings.camp_id, is the
// whole of Phase 1. Each day is still an ordinary booking — contracts,
// finalise, invoices, email, staffing and payroll all stay strictly per-day.
// One contract, per-kid invoicing and camp-specific email are later phases
// and nothing here anticipates them (no per-kid rate field — see the spec).

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { generateReference } = require('./_reference');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const cap255 = (v) => String(v || '').trim().slice(0, 255);
const cap5k  = (v) => String(v || '').trim().slice(0, 5000);

// Creates the camps table and the bookings.camp_id column that links a day
// to it. ON DELETE SET NULL is load-bearing, not a default: deleting a camp
// must ungroup its days back into ordinary bookings, never delete a week of
// real work — see test/camps.test.js for the test that pins this.
//
// Phase 2 adds: reference (CAMP-, same generator and alphabet as a booking's
// FM- — see _reference.js), and the three shared fields the camp finalise
// form collects that Phase 1 had no column for (event_time, venue,
// surface_type — a camp's day is one shared time, per the owner's ruling).
async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS camps (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      client_name VARCHAR(255) DEFAULT '',
      client_email VARCHAR(255) DEFAULT '',
      client_phone VARCHAR(50) DEFAULT '',
      organisation_name VARCHAR(255) DEFAULT '',
      event_location TEXT DEFAULT '',
      event_zip VARCHAR(10) DEFAULT '',
      service_id VARCHAR(64) DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE camps ADD COLUMN IF NOT EXISTS reference VARCHAR(20) DEFAULT ''`);
  await client.query(`ALTER TABLE camps ADD COLUMN IF NOT EXISTS event_time VARCHAR(10) DEFAULT ''`);
  await client.query(`ALTER TABLE camps ADD COLUMN IF NOT EXISTS venue VARCHAR(255) DEFAULT ''`);
  await client.query(`ALTER TABLE camps ADD COLUMN IF NOT EXISTS surface_type VARCHAR(64) DEFAULT ''`);
  try {
    // Guarded separately: in a brand new environment this can run before the
    // bookings table exists. IF NOT EXISTS already makes it safe to re-run —
    // bookings.js calls this same function before it ever needs the column.
    await client.query(
      `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS camp_id INTEGER REFERENCES camps(id) ON DELETE SET NULL`
    );
  } catch (_) { /* bookings table not there yet — nothing to link to */ }

  await backfillReferences(client);
}

// The MAC's 5-day camp (and any other camp created under Phase 1) predates
// the reference column — this mints one for every camp that still has none,
// so a camp created before Phase 2 shipped still gets a working finalise
// link without a manual migration. Cheap and idempotent: a no-op once every
// camp has one.
async function backfillReferences(client) {
  const { rows } = await client.query(`SELECT id FROM camps WHERE reference IS NULL OR reference = ''`);
  for (const { id } of rows) {
    let reference;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateReference('CAMP-');
      const { rows: existing } = await client.query('SELECT 1 FROM camps WHERE reference=$1', [candidate]);
      if (!existing.length) { reference = candidate; break; }
    }
    if (reference) await client.query('UPDATE camps SET reference=$1 WHERE id=$2', [reference, id]);
  }
}

// Every camp with its day count and date range, computed from its actual
// bookings — a camp with no days yet reads as 0 / null / null, not an error.
async function listCamps(client) {
  const { rows } = await client.query(`
    SELECT c.*,
           COUNT(b.id)::int AS day_count,
           MIN(b.event_date) AS start_date,
           MAX(b.event_date) AS end_date
    FROM camps c
    LEFT JOIN bookings b ON b.camp_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `);
  return rows;
}

async function createCamp(client, body) {
  const label = cap255(body.label);
  if (!label) throw Object.assign(new Error('label is required'), { statusCode: 400 });

  // Same scheme as a booking's FM- reference (_reference.js), CAMP- prefixed
  // so the two are never confused in a support conversation. Retry-on-collision,
  // same pattern as bookings.js:420 — there's no UNIQUE constraint backing this,
  // just the same "check, then insert" loop.
  let reference;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateReference('CAMP-');
    const { rows: existing } = await client.query('SELECT 1 FROM camps WHERE reference=$1', [candidate]);
    if (!existing.length) { reference = candidate; break; }
  }
  if (!reference) throw Object.assign(new Error('Could not generate unique reference'), { statusCode: 500 });

  const { rows } = await client.query(
    `INSERT INTO camps (
       label, client_name, client_email, client_phone,
       organisation_name, event_location, event_zip, service_id, notes, reference
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      label,
      cap255(body.client_name),
      cap255(body.client_email),
      cap255(body.client_phone),
      cap255(body.organisation_name),
      cap5k(body.event_location),
      cap255(body.event_zip),
      cap255(body.service_id),
      cap5k(body.notes),
      reference,
    ]
  );
  return rows[0];
}

// Fields a rename/edit may touch. Same set the camp was created with, minus
// label (worth keeping renameable — deliberately included, "renames/edits"
// per spec).
const CAMP_FIELDS = [
  'label', 'client_name', 'client_email', 'client_phone',
  'organisation_name', 'event_location', 'event_zip', 'service_id', 'notes',
];
const LONG_FIELDS = new Set(['event_location', 'notes']);

async function updateCamp(client, id, body) {
  const updates = [];
  const values = [];
  let idx = 1;
  for (const f of CAMP_FIELDS) {
    if (body[f] === undefined) continue;
    updates.push(`${f} = $${idx++}`);
    values.push(LONG_FIELDS.has(f) ? cap5k(body[f]) : cap255(body[f]));
  }
  if (!updates.length) throw Object.assign(new Error('No fields to update'), { statusCode: 400 });
  values.push(id);
  const { rows } = await client.query(
    `UPDATE camps SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// Removes the camp row only. bookings.camp_id's ON DELETE SET NULL ungroups
// its days back to ordinary bookings — nothing here touches the bookings
// table, and none of its days are deleted.
async function deleteCamp(client, id) {
  const { rows } = await client.query(`DELETE FROM camps WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Admin-only, every method — a camp groups a client's real bookings, not
  // something the public form or a staff login should ever touch.
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    try {
      await ensureTables(client);

      if (event.httpMethod === 'GET') {
        return json(200, { camps: await listCamps(client) });
      }

      if (event.httpMethod === 'POST') {
        let body;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
        try {
          const camp = await createCamp(client, body);
          return json(201, { success: true, camp });
        } catch (e) {
          return json(e.statusCode || 500, { error: e.message });
        }
      }

      if (event.httpMethod === 'PATCH') {
        const id = parseInt(event.path.split('/').pop(), 10);
        if (!id) return json(400, { error: 'camp id required' });
        let body;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
        try {
          const camp = await updateCamp(client, id, body);
          if (!camp) return json(404, { error: 'Camp not found' });
          return json(200, { success: true, camp });
        } catch (e) {
          return json(e.statusCode || 500, { error: e.message });
        }
      }

      if (event.httpMethod === 'DELETE') {
        const id = parseInt(event.path.split('/').pop(), 10);
        if (!id) return json(400, { error: 'camp id required' });
        const ok = await deleteCamp(client, id);
        if (!ok) return json(404, { error: 'Camp not found' });
        return json(200, { success: true });
      }

      return json(405, { error: 'Method not allowed' });
    } catch (err) {
      console.error('Camps error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

exports.ensureTables = ensureTables;
exports.listCamps = listCamps;
exports.createCamp = createCamp;
exports.updateCamp = updateCamp;
exports.deleteCamp = deleteCamp;
