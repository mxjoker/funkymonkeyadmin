const { Client } = require("pg");

const db = () => new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const FROM = "onboarding@resend.dev";
const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";
const SITE = "https://funkymonkeyadmin.netlify.app";

const sendEmail = async (to, subject, html) => {
  if (!process.env.RESEND_API_KEY || !to) return;
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

// Generate Stripe Payment Link for exact deposit amount
const createStripeLink = async (booking, depositAmount) => {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const res = await fetch("https://api.stripe.com/v1/payment_links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][product_data][name]": `${booking.service} — Deposit`,
        "line_items[0][price_data][product_data][description]": `50% deposit · ${booking.date} at ${booking.location}`,
        "line_items[0][price_data][unit_amount]": Math.round(depositAmount * 100),
        "line_items[0][quantity]": "1",
        "metadata[booking_id]": booking.booking_id,
        "after_completion[type]": "redirect",
        "after_completion[redirect][url]": `${SITE}/booking-form.html?paid=1`,
        "customer_creation": "always",
      }).toString()
    });
    const data = await res.json();
    return data.url || null;
  } catch(e) {
    console.error("Stripe link error:", e.message);
    return null;
  }
};

const statusEmail = async (b, newStatus, stripeLink) => {
  if (!b.email) return;
  const grand = (+b.total + +b.mileage_fee);
  const deposit = Math.round(grand * 0.5);
  const balance = Math.max(0, grand - (+b.deposit || 0)).toFixed(2);

  const tpl = {
    confirmed: {
      subject: "Your booking is CONFIRMED! 🎊 — Funky Monkey Events",
      body: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>${b.client}</strong>! 🎉</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Great news — your Funky Monkey Event is officially <strong style="color:#10B981">CONFIRMED!</strong> To lock in your date, please pay your deposit below.</p>
        <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
          <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${b.service}</span></div>
          <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date & Time</span><br><span style="font-weight:600">${b.date} at ${b.time}</span></div>
          <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Location</span><br><span style="font-weight:600">${b.location}</span></div>
          <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Due (50%)</span><br><span style="color:#FFD600;font-weight:900;font-size:22px">$${deposit}</span></div>
          <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due Day of Event</span><br><span style="color:#F3E8FF;font-weight:700">$${balance}</span></div>
        </div>
        ${stripeLink ? `<div style="text-align:center;margin-bottom:20px">
          <a href="${stripeLink}" style="background:linear-gradient(135deg,#10B981,#06B6D4);color:#fff;padding:16px 36px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">💳 Pay Deposit Now — $${deposit}</a>
          <p style="color:#A78BCA;font-size:11px;margin-top:8px">Secure payment via Stripe · All major cards, Apple Pay & Google Pay accepted</p>
        </div>` : ""}
        <p style="font-size:13px;color:#A78BCA;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`
    },
    cancelled: {
      subject: "Booking update — Funky Monkey Events",
      body: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>${b.client}</strong>,</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Unfortunately we weren't able to confirm your booking for <strong>${b.service}</strong> on <strong>${b.date}</strong>. We're sorry for any inconvenience!</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We'd love to find a date that works — please give us a call or submit a new request.</p>
        <div style="text-align:center"><a href="${SITE}/booking-form.html" style="background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">Request a New Date →</a></div>
        <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:20px"><a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`
    },
    completed: {
      subject: "How did we do? 🌟 — Funky Monkey Events",
      body: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>${b.client}</strong>! 🎉</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you SO much for choosing Funky Monkey Events! We hope everyone had an absolutely <strong style="color:#FFD600">AMAZING</strong> time!</p>
        <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">A quick review means the world to us:</p>
        <div style="text-align:center;margin-bottom:24px"><a href="https://funkymonkeyevents.com" style="background:linear-gradient(135deg,#FF6B00,#FFD600);color:#0F0A1E;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px">⭐ Leave a Review</a></div>
        <div style="background:#064E3B22;border:1px solid #10B98133;border-radius:12px;padding:14px;text-align:center">
          <p style="color:#6EE7B7;font-weight:800;margin-bottom:4px">Come back and save! 🐒</p>
          <p style="color:#A78BCA;font-size:13px">Returning clients get <strong style="color:#10B981">10% off</strong> their next booking.</p>
        </div>`
    }
  };

  const t = tpl[newStatus];
  if (!t) return;
  await sendEmail(b.email, t.subject, wrap(t.body));
};

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,PATCH,DELETE,OPTIONS","Content-Type":"application/json" };
  if (event.httpMethod==="OPTIONS") return { statusCode:200, headers:h, body:"" };

  const id = event.path.split("/").pop();
  if (!id || isNaN(parseInt(id))) return { statusCode:400, headers:h, body:JSON.stringify({error:"Invalid ID"}) };

  const c = db();
  try {
    await c.connect();

    if (event.httpMethod==="PATCH") {
      const u = JSON.parse(event.body);
      const colMap = {
        status: "status",
        deposit: "deposit",
        paymentMethod: "payment_method",
        contractSigned: "contract_signed",
        staffId: "staff_id",
        notes: "notes",
        stripePaymentLink: "stripe_payment_link"
      };
      const sets=[], vals=[];
      let idx=1;
      for(const [k,col] of Object.entries(colMap)){
        if(u[k]!==undefined){ sets.push(`${col}=$${idx}`); vals.push(u[k]); idx++; }
      }
      if(!sets.length) return { statusCode:400, headers:h, body:JSON.stringify({error:"No fields to update"}) };
      vals.push(parseInt(id));
      const r = await c.query(`UPDATE bookings SET ${sets.join(",")} WHERE id=$${idx} RETURNING *`, vals);
      if(!r.rows.length) return { statusCode:404, headers:h, body:JSON.stringify({error:"Not found"}) };

      let updated = r.rows[0];
      let stripeLink = null;

      // When approving (confirmed), auto-generate Stripe payment link
      if (u.status === "confirmed") {
        const grand = (+updated.total + +updated.mileage_fee);
        const deposit = Math.round(grand * 0.5);
        stripeLink = await createStripeLink(updated, deposit);

        // Save the Stripe link back to the booking
        if (stripeLink) {
          const r2 = await c.query(
            `UPDATE bookings SET stripe_payment_link=$1 WHERE id=$2 RETURNING *`,
            [stripeLink, parseInt(id)]
          );
          updated = r2.rows[0];
        }
      }

      // Send status email with Stripe link included if confirmed
      if (u.status && ["confirmed","cancelled","completed"].includes(u.status)) {
        await statusEmail(updated, u.status, stripeLink);
      }

      return { statusCode:200, headers:h, body:JSON.stringify(updated) };
    }

    if (event.httpMethod==="DELETE") {
      await c.query("DELETE FROM bookings WHERE id=$1", [parseInt(id)]);
      return { statusCode:200, headers:h, body:JSON.stringify({success:true}) };
    }

    return { statusCode:405, headers:h, body:JSON.stringify({error:"Method not allowed"}) };
  } catch(e) {
    console.error(e);
    return { statusCode:500, headers:h, body:JSON.stringify({error:e.message}) };
  } finally { await c.end(); }
};
