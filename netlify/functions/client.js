const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const FROM   = "Funky Monkey Events <bookings@funkymonkeyevents.com>";
const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";
const SITE   = process.env.SITE_URL || "https://funkymonkeyadmin.netlify.app";

// Run ensureTables only once per function instance (avoids concurrent migration conflicts)
let tablesReady = false;

// ── Email helper ─────────────────────────────────────────────────────────────
const sendEmail = async (to, subject, html) => {
  if (!process.env.RESEND_API_KEY || !to) return { ok: false, error: "No API key or recipient" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    const data = await res.json();
    if (data.error) { console.error("Resend error:", JSON.stringify(data)); return { ok: false, error: data.error.message || "Resend error" }; }
    console.log("Email sent to:", to, "id:", data.id);
    return { ok: true, id: data.id };
  } catch(e) { console.error("Email error:", e.message); return { ok: false, error: e.message }; }
};

const wrap = (body) => `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px"><div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div></div>
  <div style="padding:24px">${body}</div>
  <div style="padding:14px 24px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;color:#6b5a8e;text-align:center">
    Funky Monkey Events · OKC · (405) 431-6625
  </div>
</div>`;

// ── DB setup ──────────────────────────────────────────────────────────────────
async function ensureTables(c) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS clients (
      id             SERIAL PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      name           TEXT,
      notes          TEXT,
      tags           JSONB    DEFAULT '[]',
      birthday       DATE,
      follow_up_date DATE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_profile  JSONB DEFAULT '{}'`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS annual_event_month INTEGER`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS annual_event_note  TEXT`,
    `CREATE TABLE IF NOT EXISTS client_interactions (
      id           SERIAL PRIMARY KEY,
      client_email TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'note',
      note         TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ci_email ON client_interactions(client_email)`,
  ];
  for (const sql of ddl) {
    try { await c.query(sql); } catch(e) { /* already exists or concurrent create — safe to ignore */ }
  }
}

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PATCH,POST,DELETE,OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  // Extract email from wherever it arrives:
  //   GET  → query param ?email=  OR last path segment (old redirect style)
  //   PATCH/POST/DELETE → JSON body .email field
  function extractEmail(raw) {
    if (!raw) return "";
    try { return decodeURIComponent(raw).trim(); } catch(e) { return raw.trim(); }
  }

  let email = "";
  if (event.httpMethod === "GET") {
    // Try query param first, then fall back to last path segment
    const fromQuery = extractEmail((event.queryStringParameters && event.queryStringParameters.email) || "");
    const pathParts = (event.path || "").split("/");
    const fromPath  = extractEmail(pathParts[pathParts.length - 1] || "");
    email = fromQuery.includes("@") ? fromQuery : fromPath;
  } else {
    try {
      const b = JSON.parse(event.body || "{}");
      email = extractEmail(b.email || "");
      // Fallback: check path (shouldn't be needed but safe)
      if (!email.includes("@")) {
        const pathParts = (event.path || "").split("/");
        email = extractEmail(pathParts[pathParts.length - 1] || "");
      }
    } catch(e) { email = ""; }
  }

  console.log("client.js", event.httpMethod, "path:", event.path, "email:", JSON.stringify(email));
  if (!email || !email.includes("@")) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Valid email required — got: " + JSON.stringify(email) + " path: " + event.path }) };
  }

  const c = await pool.connect();
  try {
    if (!tablesReady) {
      await ensureTables(c);
      tablesReady = true;
    }

    // GET
    if (event.httpMethod === "GET") {
      const upsert = await c.query(`
        INSERT INTO clients (email) VALUES ($1)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING *
      `, [email]);
      const clientRec = upsert.rows[0];

      const bkRes = await c.query(`
        SELECT id, reference, status, service_name, event_date, event_time,
               event_location, event_type, guest_count, total_price,
               deposit_paid, deposit_amount, balance_due, payment_method,
               notes, admin_notes, referral_source, client_name, created_at
        FROM bookings
        WHERE LOWER(client_email) = LOWER($1)
        ORDER BY event_date DESC NULLS LAST
      `, [email]);

      const intRes = await c.query(`
        SELECT id, type, note, created_at
        FROM client_interactions
        WHERE LOWER(client_email) = LOWER($1)
        ORDER BY created_at DESC LIMIT 100
      `, [email]);

      const name = clientRec.name || (bkRes.rows[0] && bkRes.rows[0].client_name) || null;
      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({ ...clientRec, name, bookings: bkRes.rows, interactions: intRes.rows })
      };
    }

    // PATCH
    if (event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const allowed = ["notes","tags","birthday","follow_up_date","name","preferred_profile","annual_event_month","annual_event_note"];
      // Convert empty strings to null for DATE and INTEGER columns — Postgres rejects ""
      // Only sanitize fields actually present in the body (don't inject new null keys)
      const dateFields = ["birthday","follow_up_date"];
      const intFields  = ["annual_event_month"];
      dateFields.forEach(f => { if (f in body && body[f] === "") body[f] = null; });
      intFields.forEach(f => { if (f in body) body[f] = (body[f] === "" ? null : (parseInt(body[f],10) || null)); });
      const sets = [], vals = [];
      let idx = 1;
      for (const field of allowed) {
        if (body[field] !== undefined) { sets.push(field + "=$" + idx); vals.push(body[field]); idx++; }
      }
      if (!sets.length) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "No fields to update" }) };
      sets.push("updated_at=NOW()");
      vals.push(email.toLowerCase());
      await c.query(`INSERT INTO clients (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email.toLowerCase()]);
      const r = await c.query("UPDATE clients SET " + sets.join(",") + " WHERE LOWER(email)=$" + idx + " RETURNING *", vals);
      if (!r.rows.length) return { statusCode: 404, headers: h, body: JSON.stringify({ error: "Client not found for: " + email }) };
      return { statusCode: 200, headers: h, body: JSON.stringify(r.rows[0]) };
    }

    // POST
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");

      // log_interaction action
      if (body.action === "log_interaction") {
        const { type: logType, note } = body;
        if (!note || !note.trim()) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "note required" }) };
        const r = await c.query(
          "INSERT INTO client_interactions (client_email, type, note) VALUES ($1, $2, $3) RETURNING *",
          [email.toLowerCase(), logType || "note", note.trim()]
        );
        return { statusCode: 200, headers: h, body: JSON.stringify(r.rows[0]) };
      }

      // send email
      const { type, subject, message, clientName, lastService, lastDate } = body;
      let finalSubject = subject;
      let htmlBody;

      if (type === "rebook") {
        const name    = clientName || "there";
        const svc     = lastService || "your last event";
        const dateStr = lastDate ? new Date(lastDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
        finalSubject  = "We'd love to see you again! 🐒 — Funky Monkey Events";
        htmlBody = wrap(
          "<p style=\"font-size:16px;margin-bottom:16px\">Hi <strong>" + name + "</strong>! 🎉</p>" +
          "<p style=\"color:#A78BCA;line-height:1.7;margin-bottom:20px\">We had such an amazing time at <strong>" + svc + "</strong>" + (dateStr ? " back in <strong>" + dateStr + "</strong>" : "") + " and wanted to reach out!</p>" +
          "<p style=\"color:#A78BCA;line-height:1.7;margin-bottom:20px\">Planning another event? <strong style=\"color:#FFD600\">Returning clients get 10% off</strong> their next booking — just mention this email when you book!</p>" +
          "<div style=\"text-align:center;margin-bottom:24px\"><a href=\"https://funkymonkeyevents.com/booking-form.html\" style=\"background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px\">Book Your Next Event →</a></div>" +
          "<p style=\"font-size:13px;color:#A78BCA;text-align:center\">Questions? <a href=\"tel:4054316625\" style=\"color:#06B6D4;font-weight:700\">(405) 431-6625</a></p>"
        );
      } else if (type === "custom") {
        if (!subject || !message) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "subject and message required" }) };
        const name = clientName || "there";
        htmlBody = wrap(
          "<p style=\"font-size:16px;margin-bottom:16px\">Hi <strong>" + name + "</strong>,</p>" +
          "<div style=\"color:#A78BCA;line-height:1.8;margin-bottom:20px;white-space:pre-wrap\">" + message.replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</div>" +
          "<p style=\"font-size:13px;color:#A78BCA;text-align:center;margin-top:24px\">— Joe Coover, Funky Monkey Events<br><a href=\"tel:4054316625\" style=\"color:#06B6D4;font-weight:700\">(405) 431-6625</a></p>"
        );
      } else {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown POST type" }) };
      }

      const result = await sendEmail(email, finalSubject, htmlBody);
      if (!result.ok) return { statusCode: 500, headers: h, body: JSON.stringify({ error: result.error }) };

      const logNote = type === "rebook" ? "Rebooking email sent" : "Custom email sent — Subject: " + finalSubject;
      await c.query("INSERT INTO client_interactions (client_email, type, note) VALUES ($1, $2, $3)",
        [email.toLowerCase(), type === "rebook" ? "email_rebook" : "email_custom", logNote]);
      await c.query("UPDATE clients SET updated_at=NOW() WHERE LOWER(email)=$1", [email.toLowerCase()]);
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    // DELETE
    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      const { interaction_id } = body;
      if (!interaction_id) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "interaction_id required" }) };
      await c.query("DELETE FROM client_interactions WHERE id=$1 AND LOWER(client_email)=LOWER($2)", [interaction_id, email]);
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch(e) {
    console.error("client.js error:", e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  } finally {
    c.release();
  }
};
