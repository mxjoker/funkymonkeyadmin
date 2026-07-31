// health.js — GET /api/health (admin only)
// Standing answer to "is it actually working". Otto's nightly briefing reads
// this so a broken webhook surfaces in the briefing, not in an angry client email.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { inspectConfig } = require('./_health');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const config = inspectConfig(process.env);
  const checks = [...config.checks];

  // Live probes — things config alone cannot tell us.
  //
  // Each probe below is wrapped in its OWN try/catch inside the connection
  // callback (rather than one catch around the whole thing). A cold database
  // that is missing automation_rules or email_log — e.g. a migration hasn't
  // run yet — must not be reported as "database unreachable": that hides the
  // real problem (a missing table) behind a misleading one (no connection).
  // `pg` runs each client.query() as its own implicit transaction when not
  // inside an explicit BEGIN, so one failed query does not poison the
  // connection for the probes that follow it on the same client.
  try {
    await withClient(async (c) => {
      await c.query('SELECT 1');
      checks.push({ name: 'database', ok: true, detail: 'reachable' });

      try {
        const { rows: rules } = await c.query(
          'SELECT id, name FROM automation_rules WHERE active = true ORDER BY id'
        );
        checks.push({
          name: 'active_automation_rules',
          ok: true,
          detail: rules.length
            ? rules.map(r => `#${r.id} ${r.name}`).join('; ')
            : 'none active'
        });
      } catch (e) {
        checks.push({ name: 'active_automation_rules', ok: false, detail: `query failed — ${e.message}` });
      }

      try {
        const { rows: lastOk } = await c.query(
          "SELECT sent_at, recipient_email FROM email_log WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1"
        );
        checks.push({
          name: 'last_successful_email',
          ok: lastOk.length > 0,
          detail: lastOk.length
            ? `${lastOk[0].sent_at.toISOString()} to ${lastOk[0].recipient_email}`
            : 'NEVER — no successful send has ever been recorded'
        });

        const { rows: fails } = await c.query(
          "SELECT COUNT(*)::int AS n FROM email_log WHERE status = 'failed' AND sent_at > NOW() - INTERVAL '7 days'"
        );
        checks.push({
          name: 'failed_emails_7d',
          ok: fails[0].n === 0,
          detail: `${fails[0].n} failed send(s) in the last 7 days`
        });
      } catch (e) {
        checks.push({ name: 'last_successful_email', ok: false, detail: `query failed — ${e.message}` });
        checks.push({ name: 'failed_emails_7d', ok: false, detail: `query failed — ${e.message}` });
      }
    });
  } catch (e) {
    checks.push({ name: 'database', ok: false, detail: `UNREACHABLE — ${e.message}` });
  }

  const ok = checks.every(c => c.ok);
  return json(ok ? 200 : 503, { ok, checked_at: new Date().toISOString(), checks });
};
