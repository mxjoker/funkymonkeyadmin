// netlify/functions/agent-queue.js
// The Otto ↔ dashboard queue. One table, four kinds of row:
//
//   briefing — Otto's run summary (markdown). Newest = "today's briefing".
//   gate     — Otto needs a decision from Joe (approve / reject / note).
//   task     — Joe asks Otto to do something on its next run.
//   run      — Joe asks Otto to run a sweep at its next wake.
//
// Otto pushes briefings + gates and pulls decisions + tasks; the dashboard does
// the mirror image. Netlify can't reach Joe's Mac, so this table IS the
// transport: both sides poll it. Approvals therefore take effect on Otto's next
// scheduled run, not instantly.
//
// GET    /api/agent-queue?kind=&status=&limit=   list
// GET    /api/agent-queue?for=otto               everything Otto should act on, one call
// POST   /api/agent-queue                        upsert by token (idempotent re-push)
// PATCH  /api/agent-queue/:id                    { status, note }
//
// Admin only. The Booked Solid AGENT_API_TOKEN resolves to admin (_auth.js), so
// Otto comes through the same door with the same rights.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const KINDS = ['briefing', 'gate', 'task', 'run'];
const STATUSES = ['open', 'approved', 'rejected', 'done', 'cancelled'];

let schemaReady;
async function ensureTable(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_queue (
          id          SERIAL PRIMARY KEY,
          token       TEXT,
          kind        TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'open',
          title       TEXT,
          summary     TEXT,
          body        TEXT,
          meta        JSONB DEFAULT '{}',
          note        TEXT,
          booking_id  INTEGER,
          lead_id     INTEGER,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          decided_at  TIMESTAMPTZ,
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      // token is Otto's own gate token — unique so a re-push updates instead of duplicating
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS agent_queue_token_uniq
           ON agent_queue (token) WHERE token IS NOT NULL`
      ).catch(() => {});
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_queue_kind_status ON agent_queue (kind, status, created_at DESC)`
      ).catch(() => {});
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const q = event.queryStringParameters || {};
  // /api/agent-queue/:id — same path-matching pattern as staff.js / payroll.js
  const pathMatch = (event.path || '').match(/\/agent-queue\/(\d+)$/);
  const pathId = pathMatch ? parseInt(pathMatch[1]) : null;

  return withClient(async (client) => {
    await ensureTable(client);

    if (event.httpMethod === 'GET') {
      // One call for Otto: decisions waiting to be acted on + work Joe pushed.
      if (q.for === 'otto') {
        const { rows } = await client.query(
          `SELECT * FROM agent_queue
            WHERE (kind = 'gate' AND status IN ('approved','rejected'))
               OR (kind IN ('task','run') AND status = 'open')
            ORDER BY created_at ASC`
        );
        return json(200, { items: rows });
      }

      const where = [];
      const params = [];
      if (q.kind) { params.push(q.kind); where.push(`kind = $${params.length}`); }
      if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
      params.push(Math.min(Number(q.limit) || 50, 200));

      const { rows } = await client.query(
        `SELECT * FROM agent_queue
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return json(200, { items: rows });
    }

    if (event.httpMethod === 'POST') {
      let b;
      try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

      if (!KINDS.includes(b.kind)) return json(400, { error: `kind must be one of ${KINDS.join(', ')}` });
      if (b.status && !STATUSES.includes(b.status)) return json(400, { error: 'invalid status' });

      // One open run request at a time — tapping "run now" twice shouldn't queue two sweeps.
      if (b.kind === 'run') {
        const { rows } = await client.query(
          `SELECT * FROM agent_queue WHERE kind='run' AND status='open' ORDER BY created_at DESC LIMIT 1`
        );
        if (rows[0]) return json(200, { item: rows[0], deduped: true });
      }

      const vals = [
        b.token || null,
        b.kind,
        b.status || 'open',
        b.title || null,
        b.summary || null,
        b.body || null,
        JSON.stringify(b.meta || {}),
        b.booking_id || null,
        b.lead_id || null,
      ];

      // Idempotent by token: Otto re-pushing the same gate updates it in place.
      // A row Joe has already decided keeps his decision — a re-push never
      // reopens something he closed.
      const { rows } = await client.query(
        `INSERT INTO agent_queue (token, kind, status, title, summary, body, meta, booking_id, lead_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (token) WHERE token IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title,
           summary = EXCLUDED.summary,
           body = EXCLUDED.body,
           meta = EXCLUDED.meta,
           booking_id = EXCLUDED.booking_id,
           lead_id = EXCLUDED.lead_id,
           updated_at = NOW()
         RETURNING *`,
        vals
      );
      return json(200, { item: rows[0] });
    }

    if (event.httpMethod === 'PATCH') {
      const id = pathId;
      if (!id) return json(400, { error: 'usage: PATCH /api/agent-queue/:id' });

      let b;
      try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
      if (b.status && !STATUSES.includes(b.status)) return json(400, { error: 'invalid status' });
      if (!b.status && b.note === undefined) return json(400, { error: 'nothing to update' });

      const sets = [];
      const params = [];
      if (b.status) {
        params.push(b.status); sets.push(`status = $${params.length}`);
        sets.push(`decided_at = NOW()`);
      }
      if (b.note !== undefined) { params.push(b.note); sets.push(`note = $${params.length}`); }
      params.push(id);

      const { rows } = await client.query(
        `UPDATE agent_queue SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!rows[0]) return json(404, { error: 'not found' });
      return json(200, { item: rows[0] });
    }

    return json(405, { error: 'method not allowed' });
  });
};
