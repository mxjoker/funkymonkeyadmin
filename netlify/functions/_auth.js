// Shared authentication for all Netlify functions.
//
// Model:
//   - POST /api/auth with a secret issues an opaque session token (stored
//     hashed in the sessions table, 7-day expiry, sliding last_used_at).
//   - Every protected endpoint sends "Authorization: Bearer <token>".
//   - Admin secret = ADMIN_PASSWORD env var OR the scrypt hash stored in
//     admin_settings under 'admin_password_hash' (seeded by
//     scripts/migrate-auth.js so a missing env var can never lock the
//     owner out).
//   - Staff secrets = per-person access codes (word-word-word-NN), stored
//     as scrypt hashes on staff.access_code_hash. PIN login is retired.
//
// Usage inside a function handler:
//   const { CORS, requireAuth, unauthorized } = require('./_auth');
//   const auth = await requireAuth(event);            // any valid session
//   const auth = await requireAuth(event, ['admin']); // admin only
//   if (!auth) return unauthorized();
//   // auth = { role: 'admin'|'staff', staffId, tokenHash }
//
// Staff-scoped endpoints must additionally check that the requested
// staff_id equals auth.staffId unless auth.role === 'admin'.

const crypto = require('crypto');
const { getPool } = require('./_db');

// Same-origin pages don't need CORS at all; restrict cross-origin use to
// the deployed site URL. Netlify sets URL in prod and netlify dev.
const ORIGIN = process.env.URL || '*';
const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

const SESSION_DAYS = 7;
const RATE_LIMIT_MAX = 10;       // attempts
const RATE_LIMIT_WINDOW_MIN = 15;

// Passwords burned by appearing in source code / git history.
const BANNED_PASSWORDS = ['funkymonkey2024'];

let tablesReady;
function ensureAuthTables(client) {
  if (!tablesReady) {
    tablesReady = (async () => {
      await client.query(`CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        role VARCHAR(16) NOT NULL,
        staff_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS login_attempts (
        id SERIAL PRIMARY KEY,
        ip VARCHAR(64),
        success BOOLEAN DEFAULT FALSE,
        attempted_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS admin_settings (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    })().catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

// ── secret hashing (scrypt, no native deps) ────────────────────────────────
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, n, salt, hex] = parts;
  try {
    const candidate = crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN, {
      N: parseInt(n, 10), r: SCRYPT_R, p: SCRYPT_P,
    });
    const expected = Buffer.from(hex, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing roughly constant
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ── access codes ────────────────────────────────────────────────────────────
const WORDS = ('amber,apple,aspen,badge,bagel,banjo,basil,beach,berry,birch,bison,blaze,bloom,bluff,brave,breeze,brick,brook,bubble,cabin,candy,canoe,cedar,chant,cherry,chess,chime,cider,clover,cobalt,comet,coral,cozy,crane,creek,crisp,daisy,dandy,dawn,delta,denim,disco,dove,dune,eagle,ember,fable,falcon,fern,fiesta,flame,flute,foam,forest,fox,frost,fudge,galaxy,gecko,gem,ginger,glade,gleam,glow,gourd,grape,grove,gull,gusto,harbor,hazel,heron,hilltop,honey,husky,igloo,indigo,iris,ivory,jade,jazz,jolly,jungle,juniper,kayak,kelp,kiwi,koala,lagoon,lantern,laurel,lemon,lilac,lily,lotus,lunar,lyric,mango,maple,marble,meadow,melon,mesa,mint,mirth,mocha,monkey,moose,moss,myrtle,nectar,nimbus,noble,nutmeg,oasis,ocean,olive,onyx,opal,orbit,orchid,otter,owl,palm,panda,peach,pebble,pecan,penny,peony,pepper,pine,pixel,plum,pond,poppy,prairie,prism,pumpkin,quartz,quill,raven,reef,ripple,river,robin,rocket,rose,ruby,rustic,saffron,sage,salsa,sandy,scout,sequoia,shell,sierra,silver,sketch,sleek,slope,sorbet,sparrow,spruce,star,stone,storm,sunny,swift,taffy,tango,teal,tempo,thyme,tiger,topaz,torch,trail,tulip,tundra,turtle,velvet,violet,vista,wagon,walnut,waver,willow,winter,wren,zebra,zenith,zest,zinnia').split(',');

function generateAccessCode() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const num = String(crypto.randomInt(10, 100));
  return `${pick()}-${pick()}-${pick()}-${num}`;
}

// ── sessions ────────────────────────────────────────────────────────────────
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createSession(client, { role, staffId = null }) {
  await ensureAuthTables(client);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await client.query(
    'INSERT INTO sessions (token_hash, role, staff_id, expires_at) VALUES ($1,$2,$3,$4)',
    [hashToken(token), role, staffId, expires]
  );
  // opportunistic cleanup of expired sessions
  client.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {});
  return { token, expiresAt: expires.toISOString() };
}

function bearerToken(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

// Validates the request's bearer token. Returns
// { role, staffId, tokenHash } or null. `roles` restricts which roles pass.
async function requireAuth(event, roles = ['admin', 'staff']) {
  const token = bearerToken(event);
  if (!token) return null;
  // Long-lived agent token (Booked Solid / Otto): set AGENT_API_TOKEN in the
  // Netlify env to enable. Admin role, no session row, no expiry. Min-length
  // guard so a short or mis-set var can never match. Unset = disabled.
  const agentToken = process.env.AGENT_API_TOKEN;
  if (agentToken && agentToken.length >= 32 && safeEqual(token, agentToken)) {
    return roles.includes('admin') ? { role: 'admin', staffId: null, tokenHash: null } : null;
  }
  const tokenHash = hashToken(token);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureAuthTables(client);
    const { rows } = await client.query(
      'SELECT role, staff_id FROM sessions WHERE token_hash=$1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (!rows.length) return null;
    const session = rows[0];
    if (!roles.includes(session.role)) return null;
    client.query('UPDATE sessions SET last_used_at=NOW() WHERE token_hash=$1', [tokenHash]).catch(() => {});
    return { role: session.role, staffId: session.staff_id, tokenHash };
  } finally {
    client.release();
  }
}

async function destroySession(client, tokenHash) {
  await client.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
}

// ── rate limiting (per IP, login attempts) ─────────────────────────────────
function clientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  ).slice(0, 64);
}

async function checkAndRecordAttempt(client, ip) {
  await ensureAuthTables(client);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM login_attempts
     WHERE ip=$1 AND success=FALSE AND attempted_at > NOW() - INTERVAL '${RATE_LIMIT_WINDOW_MIN} minutes'`,
    [ip]
  );
  if (rows[0].n >= RATE_LIMIT_MAX) return false;
  await client.query('INSERT INTO login_attempts (ip) VALUES ($1)', [ip]);
  client.query("DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'").catch(() => {});
  return true;
}

async function markAttemptSuccess(client, ip) {
  await client.query(
    'UPDATE login_attempts SET success=TRUE WHERE id = (SELECT id FROM login_attempts WHERE ip=$1 ORDER BY attempted_at DESC LIMIT 1)',
    [ip]
  );
}

// ── admin password resolution ──────────────────────────────────────────────
async function verifyAdminPassword(client, password) {
  if (!password || BANNED_PASSWORDS.includes(password)) return false;
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw && !BANNED_PASSWORDS.includes(envPw) && safeEqual(password, envPw)) return true;
  await ensureAuthTables(client);
  const { rows } = await client.query(
    "SELECT value FROM admin_settings WHERE key='admin_password_hash'"
  );
  return rows.length ? verifySecret(password, rows[0].value) : false;
}

async function setAdminPassword(client, newPassword) {
  await ensureAuthTables(client);
  await client.query(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES ('admin_password_hash', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
    [hashSecret(newPassword)]
  );
}

// ── canned responses ────────────────────────────────────────────────────────
const unauthorized = () => ({ statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required' }) });
const forbidden = () => ({ statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not allowed' }) });
const preflight = (event) => (event.httpMethod === 'OPTIONS' ? { statusCode: 204, headers: CORS, body: '' } : null);

module.exports = {
  CORS,
  requireAuth,
  createSession,
  destroySession,
  bearerToken,
  hashToken,
  hashSecret,
  verifySecret,
  safeEqual,
  generateAccessCode,
  verifyAdminPassword,
  setAdminPassword,
  checkAndRecordAttempt,
  markAttemptSuccess,
  clientIp,
  ensureAuthTables,
  unauthorized,
  forbidden,
  preflight,
};
