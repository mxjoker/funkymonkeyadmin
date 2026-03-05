const { Client } = require("pg");

const db = () => new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";
const FROM = "onboarding@resend.dev";

const ensureTable = async (c) => {
  await c.query(`CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY, booking_id TEXT,
    client TEXT, phone TEXT, email TEXT, event_type TEXT, guests INTEGER, referral TEXT,
    service_id TEXT, service TEXT, date TEXT, time TEXT, zip TEXT, location TEXT, notes TEXT,
    addons JSONB DEFAULT '[]', mileage_fee NUMERIC DEFAULT 0, miles NUMERIC DEFAULT 0,
    total NUMERIC DEFAULT 0, deposit_due NUMERIC DEFAULT 0, deposit NUMERIC DEFAULT 0,
    payment_method TEXT DEFAULT 'pending', status TEXT DEFAULT 'review',
    staff_id INTEGER, contract_signed BOOLEAN DEFAULT false,
    stripe_payment_link TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await c.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_link TEXT DEFAULT ''`).catch(()=>{});
};

const sendEmail = async (to, subject, html) => {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
  } catch(e) { console.error("Email error:", e.message); }
};

const wrap = (body) => `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0F0A1E;color:#F3E8FF;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#FF6B00,#FFD600);padding:20px 24px"><div style="font-size:22px;font-weight:900;color:#0F0A1E">🐒 Funky Monkey Events</div></div>
  <div style="padding:24px">${body}</div></div>`;

const row = (k,v) => `<tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:130px;vertical-align:top">${k}</td><td style="padding:7px 0;color:#F3E8FF;font-weight:600">${v}</td></tr>`;

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Content-Type":"application/json" };
  if (event.httpMethod==="OPTIONS") return { statusCode:200, headers:h, body:"" };

  const c = db();
  try {
    await c.connect();
    await ensureTable(c);

    if (event.httpMethod==="GET") {
      const r = await c.query("SELECT * FROM bookings ORDER BY created_at DESC");
      return { statusCode:200, headers:h, body:JSON.stringify(r.rows) };
    }

    if (event.httpMethod==="POST") {
      const d = JSON.parse(event.body);
      const bid = "FM-" + Date.now().toString().slice(-6);
      const r = await c.query(
        `INSERT INTO bookings (booking_id,client,phone,email,event_type,guests,referral,service_id,service,date,time,zip,location,notes,addons,mileage_fee,miles,total,deposit_due,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'review') RETURNING *`,
        [bid,d.client,d.phone,d.email,d.eventType,d.guests||0,d.referral,d.serviceId,d.service,d.date,d.time,d.zip,d.location,d.notes,JSON.stringify(d.addons||[]),d.mileageFee||0,d.miles||0,d.total||0,d.depositDue||0]
      );
      const b = r.rows[0];
      const grand = (+b.total + +b.mileage_fee).toFixed(2);
      const dep = Math.round((+b.total + +b.mileage_fee) * 0.5);

      // Admin alert
      await sendEmail(NOTIFY, `🐒 New Booking: ${b.service} — ${b.client}`,
        wrap(`<p style="margin-bottom:16px;font-size:15px;font-weight:700;color:#FFD600">New booking request just came in!</p>
          <table style="width:100%;border-collapse:collapse">
            ${row("Booking ID", b.booking_id)}
            ${row("Client", b.client)}
            ${row("Phone", `<a href="tel:${b.phone}" style="color:#06B6D4">${b.phone}</a>`)}
            ${row("Email", `<a href="mailto:${b.email}" style="color:#06B6D4">${b.email}</a>`)}
            ${row("Service", b.service)}
            ${row("Date & Time", `${b.date} at ${b.time}`)}
            ${row("Location", b.location)}
            ${row("Event Type", `${b.event_type} · ${b.guests} guests`)}
            ${b.notes ? row("Notes", b.notes) : ""}
            ${row("Total", `<span style="color:#10B981;font-size:18px;font-weight:900">$${grand}</span>`)}
            ${row("Deposit", `<span style="color:#FFD600;font-weight:700">$${dep}</span>`)}
          </table>
          <div style="margin-top:22px;text-align:center">
            <a href="https://funkymonkeyadmin.netlify.app/admin.html" style="background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">Review in Dashboard →</a>
          </div>`));

      // Client confirmation
      await sendEmail(b.email, `We got your request! 🎉 — Funky Monkey Events`,
        wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${b.client}</strong>! 👋</p>
          <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We received your booking request and can't wait to make your event amazing!</p>
          <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
            <table style="width:100%;border-collapse:collapse">
              ${row("Booking ID", `<span style="color:#FFD600">${b.booking_id}</span>`)}
              ${row("Service", b.service)}
              ${row("Date & Time", `${b.date} at ${b.time}`)}
              ${row("Location", b.location)}
              ${row("Est. Total", `<span style="color:#10B981;font-size:18px;font-weight:900">$${grand}</span>`)}
            </table>
          </div>
          <div style="background:#064E3B22;border:1px solid #10B98133;border-radius:12px;padding:16px;margin-bottom:20px">
            <p style="font-weight:800;margin-bottom:10px;color:#6EE7B7">What happens next?</p>
            ${["We review your request within 24 hours","You'll receive a booking confirmation email","Sign your digital contract","Pay the 50% deposit to lock in your date 🔒","We'll send a reminder 48 hours before your event!"].map((x,i)=>`<div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start"><div style="width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#FF6B00,#FFD600);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#0F0A1E;flex-shrink:0">${i+1}</div><span style="font-size:13px;color:#A78BCA">${x}</span></div>`).join("")}
          </div>
          <p style="font-size:13px;color:#A78BCA;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));

      return { statusCode:201, headers:h, body:JSON.stringify(b) };
    }

    return { statusCode:405, headers:h, body:JSON.stringify({error:"Method not allowed"}) };
  } catch(e) {
    console.error(e);
    return { statusCode:500, headers:h, body:JSON.stringify({error:e.message}) };
  } finally { await c.end(); }
};
