#!/usr/bin/env node
// One-time auth migration. Idempotent — safe to re-run.
//   - Creates sessions / login_attempts / admin_settings tables
//   - Adds staff.access_code_hash and generates an access code for every
//     active staff member that doesn't have one yet
//   - Seeds a generated admin password (only if none is stored yet)
//
// Prints all newly generated credentials to stdout ONCE. They are stored
// only as hashes — copy them somewhere safe before closing the terminal.
//
// Usage: node scripts/migrate-auth.js   (reads DATABASE_URL from .env or env)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// minimal .env loader (no dotenv dependency)
const envPath = path.join(__dirname, '..', '.env');
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { getPool } = require('../netlify/functions/_db');
const {
  ensureAuthTables, hashSecret, generateAccessCode, setAdminPassword,
} = require('../netlify/functions/_auth');

function generateAdminPassword() {
  return 'FM-' + crypto.randomBytes(9).toString('base64url');
}

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureAuthTables(client);
    await client.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_code_hash TEXT');

    const { rows: staff } = await client.query(
      `SELECT id, name, preferred_name FROM staff
       WHERE active=TRUE AND access_code_hash IS NULL ORDER BY name`
    );

    const issued = [];
    for (const s of staff) {
      const code = generateAccessCode();
      await client.query('UPDATE staff SET access_code_hash=$1 WHERE id=$2', [hashSecret(code), s.id]);
      issued.push({ id: s.id, name: s.preferred_name || s.name, code });
    }

    const { rows: existing } = await client.query(
      "SELECT 1 FROM admin_settings WHERE key='admin_password_hash'"
    );
    let adminPassword = null;
    if (!existing.length) {
      adminPassword = generateAdminPassword();
      await setAdminPassword(client, adminPassword);
    }

    console.log('=== AUTH MIGRATION COMPLETE ===');
    if (adminPassword) {
      console.log(`ADMIN PASSWORD (new, save this): ${adminPassword}`);
      console.log('(Your ADMIN_PASSWORD env var, if set in Netlify, also still works.)');
    } else {
      console.log('Admin password: already seeded, unchanged.');
    }
    if (issued.length) {
      console.log('\nSTAFF ACCESS CODES (give each person their code):');
      for (const s of issued) console.log(`  ${s.name} (id ${s.id}): ${s.code}`);
    } else {
      console.log('Staff access codes: all active staff already have codes.');
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
