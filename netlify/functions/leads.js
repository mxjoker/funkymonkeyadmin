// netlify/functions/leads.js
// Outbound sales pipeline — prospects not yet booked. Admin-only.
// GET    /api/leads        — list all leads (with filters)
// GET    /api/leads/:id    — fetch one lead
// POST   /api/leads        — create new lead
// PATCH  /api/leads/:id    — update lead
// DELETE /api/leads/:id    — delete lead
//
// Uses the shared pool (_db.js) and shared bearer-token auth (_auth.js) so it
// matches every other endpoint — never create a per-file Pool (connection
// exhaustion) and never expose an unauthenticated CRUD endpoint.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      org TEXT,
      role TEXT,
      phone TEXT,
      email TEXT,
      lead_type TEXT DEFAULT 'general',
      stage TEXT DEFAULT 'new',
      source TEXT,
      notes TEXT,
      last_contact_at TIMESTAMPTZ,
      next_followup_at TIMESTAMPTZ,
      converted_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const cols = [
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS org TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS role TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type TEXT DEFAULT 'general'`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'new'`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_booking_id INTEGER`,
  ];
  for (const sql of cols) {
    await client.query(sql).catch(() => {});
  }
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Leads are an internal sales tool — admin only.
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    try {
      await ensureTable(client);

      const { httpMethod, path, queryStringParameters: qs } = event;
      const segments = (path || '').replace(/^\/api\/leads\/?/, '').split('/').filter(Boolean);
      const id = segments[0];

      // ── GET /api/leads ──────────────────────────────────────────────────
      if (httpMethod === 'GET' && !id) {
        const conditions = [];
        const params = [];

        if (qs?.stage) {
          params.push(qs.stage);
          conditions.push(`stage = $${params.length}`);
        }
        if (qs?.lead_type) {
          params.push(qs.lead_type);
          conditions.push(`lead_type = $${params.length}`);
        }
        if (qs?.overdue === 'true') {
          conditions.push(`next_followup_at < NOW() AND converted_booking_id IS NULL AND stage NOT IN ('lost', 'converted')`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows } = await client.query(
          `SELECT * FROM leads ${where} ORDER BY
            CASE WHEN next_followup_at IS NOT NULL AND next_followup_at < NOW() THEN 0 ELSE 1 END,
            next_followup_at ASC NULLS LAST,
            created_at DESC`,
          params
        );
        return json(200, { leads: rows });
      }

      // ── GET /api/leads/:id ──────────────────────────────────────────────
      if (httpMethod === 'GET' && id) {
        const { rows } = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        if (!rows.length) return json(404, { error: 'Not found' });
        return json(200, { lead: rows[0] });
      }

      // ── POST /api/leads ─────────────────────────────────────────────────
      if (httpMethod === 'POST' && !id) {
        const d = JSON.parse(event.body || '{}');
        if (!d.name) return json(400, { error: 'name required' });

        const { rows } = await client.query(`
          INSERT INTO leads
            (name, org, role, phone, email, lead_type, stage, source, notes, last_contact_at, next_followup_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING *`,
          [
            d.name,
            d.org || null,
            d.role || null,
            d.phone || null,
            d.email || null,
            d.lead_type || 'general',
            d.stage || 'new',
            d.source || null,
            d.notes || null,
            d.last_contact_at || null,
            d.next_followup_at || null,
          ]
        );
        return json(201, { lead: rows[0] });
      }

      // ── PATCH /api/leads/:id ────────────────────────────────────────────
      if (httpMethod === 'PATCH' && id) {
        const d = JSON.parse(event.body || '{}');
        const colMap = {
          name: 'name',
          org: 'org',
          role: 'role',
          phone: 'phone',
          email: 'email',
          lead_type: 'lead_type',
          stage: 'stage',
          source: 'source',
          notes: 'notes',
          last_contact_at: 'last_contact_at',
          next_followup_at: 'next_followup_at',
          converted_booking_id: 'converted_booking_id',
        };

        const sets = [];
        const params = [];
        for (const [key, col] of Object.entries(colMap)) {
          if (key in d) {
            params.push(d[key]);
            sets.push(`${col} = $${params.length}`);
          }
        }
        if (!sets.length) return json(400, { error: 'Nothing to update' });

        params.push(id);
        const { rows } = await client.query(
          `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
          params
        );
        if (!rows.length) return json(404, { error: 'Not found' });
        return json(200, { lead: rows[0] });
      }

      // ── DELETE /api/leads/:id ───────────────────────────────────────────
      if (httpMethod === 'DELETE' && id) {
        await client.query('DELETE FROM leads WHERE id = $1', [id]);
        return json(200, { success: true });
      }

      return json(405, { error: 'Method not allowed' });

    } catch (err) {
      console.error('leads error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};
