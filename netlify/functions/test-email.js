const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { sendEmail } = require('./_email');

const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const key = process.env.RESEND_API_KEY;
  if (!key) return json(500, { ok: false, error: 'RESEND_API_KEY env var is not set in Netlify' });

  const to = process.env.NOTIFY_EMAIL || 'Joe.Coover@gmail.com';

  // Uses the shared sender so this diagnostic exercises the real path
  // (EMAIL_ALLOWLIST + Resend error detection) rather than a parallel one.
  try {
    const data = await sendEmail(
      to,
      '🐒 Funky Monkey — Resend Test Email',
      '<p>If you received this, Resend is configured correctly.</p>'
    );
    if (data && data.suppressed) {
      return json(200, { ok: true, suppressed: true, message: `Suppressed by EMAIL_ALLOWLIST — ${to} is not on the list, so nothing was sent` });
    }
    return json(200, { ok: true, message: `Test email sent to ${to}`, resend_id: data && data.id });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
