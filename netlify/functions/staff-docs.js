// netlify/functions/staff-docs.js
// Which employment documents each staff member owes, and which have arrived.
//
// This deliberately stores NO FILES. Staff email their paperwork to Joe and he
// marks it received — his inbox is the storage, this is the checklist over it
// (owner's call, 2026-09-10). That choice is what keeps the whole feature to
// two tables and no new dependency: no upload route, no 6MB function-payload
// ceiling, no blob store to secure, and no copy of somebody's driving licence
// sitting in a database that a booking form can reach.
//
// The handbook side rides the same mechanism rather than a second one. "Read
// this and send back the signed acknowledgment page" is a document that arrives
// by email like any other, and a signed page is better evidence than a checkbox
// that says someone ticked a box.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized, forbidden } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// A row is only ever written once a document has ARRIVED (or been waived).
// Absence means outstanding, which is why there is no backfill when a new
// document type is added or a new person is hired — they are simply missing
// every row, which is exactly true on their first day.
const STATUSES = new Set(['received', 'waived']);

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_doc_types (
      id           SERIAL PRIMARY KEY,
      label        VARCHAR(120) NOT NULL,
      instructions TEXT DEFAULT '',
      link_url     TEXT DEFAULT '',
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order   INTEGER NOT NULL DEFAULT 100,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_docs (
      id           SERIAL PRIMARY KEY,
      staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      doc_type_id  INTEGER NOT NULL REFERENCES staff_doc_types(id) ON DELETE CASCADE,
      status       VARCHAR(16) NOT NULL DEFAULT 'received',
      received_at  TIMESTAMPTZ,
      notes        TEXT DEFAULT '',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (staff_id, doc_type_id)
    )
  `);
}

// Starter set, seeded once. INSERT-only on conflict of label, the same contract
// _templates.js uses: the code owns that a sensible list exists, the database
// owns what it says once Joe has edited it. Re-seeding must never overwrite his
// wording or resurrect a type he deactivated.
const SEED = [
  ['W-9', 'Needed before we can pay you. Download, sign, and email it back.', 'https://www.irs.gov/pub/irs-pdf/fw9.pdf', 10],
  ['Photo ID', 'A clear photo or scan of your driving licence or passport.', '', 20],
  ['Employee handbook — signed acknowledgment', 'Read the handbook, then sign the last page and email it back.', '', 30],
  ['Payment details', 'How you want to be paid — Venmo, Cash App or bank transfer.', '', 40],
];

async function seedTypes(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM staff_doc_types');
  if (rows[0].n > 0) return;
  for (const [label, instructions, link_url, sort_order] of SEED) {
    await client.query(
      `INSERT INTO staff_doc_types (label, instructions, link_url, sort_order)
       VALUES ($1,$2,$3,$4)`,
      [label, instructions, link_url, sort_order]
    );
  }
}

// What one person still owes. Active types only — deactivating a type must stop
// it nagging everyone, without deleting the record that others already sent it.
async function forStaff(client, staffId) {
  const { rows } = await client.query(
    `SELECT t.id, t.label, t.instructions, t.link_url, t.sort_order,
            d.status, d.received_at, d.notes
     FROM staff_doc_types t
     LEFT JOIN staff_docs d ON d.doc_type_id = t.id AND d.staff_id = $1
     WHERE t.active = TRUE
     ORDER BY t.sort_order, t.id`,
    [staffId]
  );
  return rows.map(r => ({ ...r, status: r.status || 'outstanding' }));
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const auth = await requireAuth(event);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    await ensureTables(client);
    await seedTypes(client);

    if (event.httpMethod === 'GET') {
      // A staff member sees their own list and nobody else's.
      if (auth.role !== 'admin') {
        if (!auth.staffId) return forbidden();
        return json(200, { mine: await forStaff(client, auth.staffId) });
      }

      // Admin: the whole matrix, active staff only. An archived person owes us
      // nothing — chasing paperwork from someone who no longer works here is
      // noise, and their existing rows stay for the record either way.
      const { rows: types } = await client.query(
        'SELECT * FROM staff_doc_types ORDER BY sort_order, id');
      const { rows: staff } = await client.query(
        `SELECT id, name, preferred_name, role FROM staff
         WHERE active = TRUE ORDER BY sort_order, id`);
      const { rows: docs } = await client.query(
        `SELECT d.staff_id, d.doc_type_id, d.status, d.received_at, d.notes
         FROM staff_docs d JOIN staff s ON s.id = d.staff_id
         WHERE s.active = TRUE`);
      return json(200, { types, staff, docs });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (auth.role !== 'admin') return forbidden();

    let b;
    try { b = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    // ── Mark one document for one person ────────────────────────────────────
    if (b.action === 'mark') {
      const staffId = parseInt(b.staff_id, 10);
      const typeId = parseInt(b.doc_type_id, 10);
      if (!staffId || !typeId) return json(400, { error: 'staff_id and doc_type_id are required' });

      // Un-marking is a delete, not a third status: absence already means
      // outstanding everywhere else, and two ways to say the same thing is how
      // a checklist starts disagreeing with itself.
      if (b.status === 'outstanding') {
        await client.query('DELETE FROM staff_docs WHERE staff_id=$1 AND doc_type_id=$2',
          [staffId, typeId]);
        return json(200, { success: true, status: 'outstanding' });
      }

      if (!STATUSES.has(b.status)) return json(400, { error: 'Unknown status' });
      const { rows } = await client.query(
        `INSERT INTO staff_docs (staff_id, doc_type_id, status, received_at, notes)
         VALUES ($1,$2,$3,NOW(),$4)
         ON CONFLICT (staff_id, doc_type_id) DO UPDATE
           SET status=$3, received_at=NOW(), notes=$4, updated_at=NOW()
         RETURNING *`,
        [staffId, typeId, b.status, String(b.notes || '')]
      );
      return json(200, { success: true, doc: rows[0] });
    }

    // ── Add or edit a document type ─────────────────────────────────────────
    if (b.action === 'save_type') {
      const label = String(b.label || '').trim();
      if (!label) return json(400, { error: 'label is required' });
      if (label.length > 120) return json(400, { error: 'label too long (max 120)' });
      const args = [label, String(b.instructions || ''), String(b.link_url || ''),
                    b.active === false ? false : true,
                    Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 100];
      if (b.id) {
        const { rows } = await client.query(
          `UPDATE staff_doc_types SET label=$1, instructions=$2, link_url=$3, active=$4, sort_order=$5
           WHERE id=$6 RETURNING *`, [...args, parseInt(b.id, 10)]);
        if (!rows.length) return json(404, { error: 'Document type not found' });
        return json(200, { success: true, type: rows[0] });
      }
      const { rows } = await client.query(
        `INSERT INTO staff_doc_types (label, instructions, link_url, active, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, args);
      return json(200, { success: true, type: rows[0] });
    }

    return json(400, { error: 'Unknown action' });
  });
};

module.exports.forStaff = forStaff;
module.exports.ensureTables = ensureTables;
module.exports.seedTypes = seedTypes;
module.exports.SEED = SEED;
