const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const FROM = 'Funky Monkey Events <bookings@funkymonkeyevents.com>';

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

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
        from: FROM,
        to,
        subject: '🐒 Funky Monkey — Resend Test Email',
        html: '<p>If you received this, Resend is configured correctly.</p>',
      }),
    });
    const data = await res.json();
    if (data.error) return json(500, { ok: false, resend_error: data.error });
    return json(200, { ok: true, message: `Test email sent to ${to}`, resend_id: data.id });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
