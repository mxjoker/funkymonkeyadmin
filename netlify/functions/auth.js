const { withClient } = require('./_db');
const {
  CORS, preflight, requireAuth, createSession, destroySession,
  verifyAdminPassword, setAdminPassword, verifySecret,
  checkAndRecordAttempt, markAttemptSuccess, clientIp,
  ensureAuthTables, unauthorized,
} = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  try {
    // ── logout ──────────────────────────────────────────────────────────
    if (body.action === 'logout') {
      const auth = await requireAuth(event);
      if (auth) await withClient((c) => destroySession(c, auth.tokenHash));
      return json(200, { success: true });
    }

    // ── token check (used on page load to restore a session) ───────────
    if (body.action === 'check') {
      const auth = await requireAuth(event);
      if (!auth) return unauthorized();
      if (auth.role === 'staff' && auth.staffId) {
        const staff = await withClient(async (c) => {
          const { rows } = await c.query(
            'SELECT id, name, preferred_name, color FROM staff WHERE id=$1 AND active=TRUE',
            [auth.staffId]
          );
          return rows[0] || null;
        });
        if (!staff) return unauthorized();
        return json(200, {
          success: true, role: 'staff', staffId: staff.id,
          staffName: staff.preferred_name || staff.name,
          staffColor: staff.color || '#7c3aed',
        });
      }
      return json(200, { success: true, role: auth.role });
    }

    // ── send a test email to diagnose Resend configuration ────────────
    if (body.action === 'test_email') {
      const auth = await requireAuth(event, ['admin']);
      if (!auth) return unauthorized();
      const key = process.env.RESEND_API_KEY;
      if (!key) return json(500, { ok: false, error: 'RESEND_API_KEY env var is not set in Netlify' });
      const to = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Funky Monkey Events <bookings@funkymonkeyevents.com>',
            to,
            subject: '🐒 Funky Monkey — Resend Test Email',
            html: '<p>If you received this, Resend is configured correctly.</p>',
          }),
        });
        const data = await res.json();
        if (!res.ok || data.statusCode || data.name) return json(500, { ok: false, resend_error: data });
        return json(200, { ok: true, message: `Test email sent to ${to}`, resend_id: data.id });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    }

    // ── change admin password (requires a valid admin session) ─────────
    if (body.action === 'set_admin_password') {
      const auth = await requireAuth(event, ['admin']);
      if (!auth) return unauthorized();
      const pw = String(body.new_password || '');
      if (pw.length < 10) return json(400, { error: 'Password must be at least 10 characters' });
      await withClient((c) => setAdminPassword(c, pw));
      return json(200, { success: true });
    }

    // ── login ───────────────────────────────────────────────────────────
    const password = String(body.password || '');
    if (!password) return json(400, { error: 'Password required' });

    return await withClient(async (client) => {
      await ensureAuthTables(client);

      const ip = clientIp(event);
      if (!(await checkAndRecordAttempt(client, ip))) {
        return json(429, { error: 'Too many attempts. Try again in 15 minutes.' });
      }

      // admin first
      if (await verifyAdminPassword(client, password)) {
        const { token, expiresAt } = await createSession(client, { role: 'admin' });
        await markAttemptSuccess(client, ip);
        return json(200, { success: true, role: 'admin', token, expiresAt });
      }

      // staff access codes (scrypt scan over active staff — small table).
      // Tolerate a missing table/column (pre-migration DB): no match, not a 500.
      let rows = [];
      try {
        ({ rows } = await client.query(
          `SELECT id, name, preferred_name, color, access_code_hash
           FROM staff WHERE active=TRUE AND access_code_hash IS NOT NULL`
        ));
      } catch (e) {
        console.error('staff access-code lookup unavailable:', e.message);
      }
      const normalized = password.trim().toLowerCase();
      for (const staff of rows) {
        if (verifySecret(normalized, staff.access_code_hash)) {
          const { token, expiresAt } = await createSession(client, { role: 'staff', staffId: staff.id });
          await markAttemptSuccess(client, ip);
          return json(200, {
            success: true, role: 'staff', token, expiresAt,
            staffId: staff.id,
            staffName: staff.preferred_name || staff.name,
            staffColor: staff.color || '#7c3aed',
          });
        }
      }

      return json(401, { success: false });
    });
  } catch (e) {
    console.error('auth error:', e.message);
    return json(500, { error: 'Auth service error' });
  }
};
