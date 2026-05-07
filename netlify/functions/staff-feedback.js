// netlify/functions/staff-feedback.js
// Handles per-gig feedback, Google Review linking, and bonus tracking

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json'
};

// Ensure feedback tables exist
async function ensureTables(client) {
  // Per-assignment feedback (Joe → staff for specific gigs)
  await client.query(`
    CREATE TABLE IF NOT EXISTS assignment_feedback (
      id SERIAL PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES staff_assignments(id) ON DELETE CASCADE,
      booking_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      admin_notes TEXT,
      visible_to_staff BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(assignment_id)
    )
  `);

  // Google Review tracking
  await client.query(`
    CREATE TABLE IF NOT EXISTS google_reviews (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      review_url TEXT NOT NULL,
      review_date DATE,
      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      review_text TEXT,
      client_name TEXT,
      staff_mentioned TEXT[],
      bonuses_awarded BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Bonus tracking
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_bonuses (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      review_id INTEGER REFERENCES google_reviews(id) ON DELETE SET NULL,
      bonus_type VARCHAR(50) NOT NULL,
      amount NUMERIC(10,2),
      reason TEXT,
      awarded_at TIMESTAMPTZ DEFAULT NOW(),
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMPTZ,
      payroll_run_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const client = await pool.connect();
  try {
    await ensureTables(client);

    // ──────────────────────────────────────────────────────────
    // ASSIGNMENT FEEDBACK
    // ──────────────────────────────────────────────────────────

    // GET /api/staff-feedback/assignment/:assignment_id
    if (event.httpMethod === 'GET' && event.path.includes('/assignment/')) {
      const assignmentId = event.path.split('/assignment/')[1];
      
      const result = await client.query(
        `SELECT af.*, sa.staff_id, sa.booking_id, sa.tag_filled,
                s.name as staff_name, s.preferred_name
         FROM assignment_feedback af
         JOIN staff_assignments sa ON sa.id = af.assignment_id
         JOIN staff s ON s.id = sa.staff_id
         WHERE af.assignment_id = $1`,
        [assignmentId]
      );

      if (result.rows.length === 0) {
        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify({ feedback: null })
        };
      }

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ feedback: result.rows[0] })
      };
    }

    // GET /api/staff-feedback/booking/:booking_id
    if (event.httpMethod === 'GET' && event.path.includes('/booking/')) {
      const bookingId = event.path.split('/booking/')[1];
      
      const result = await client.query(
        `SELECT af.*, sa.staff_id, sa.tag_filled,
                s.name as staff_name, s.preferred_name
         FROM assignment_feedback af
         JOIN staff_assignments sa ON sa.id = af.assignment_id
         JOIN staff s ON s.id = sa.staff_id
         WHERE af.booking_id = $1
         ORDER BY af.created_at DESC`,
        [bookingId]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ feedback: result.rows })
      };
    }

    // POST /api/staff-feedback/assignment
    if (event.httpMethod === 'POST' && event.path.includes('/assignment')) {
      const { assignment_id, booking_id, staff_id, admin_notes, visible_to_staff } = JSON.parse(event.body || '{}');

      if (!assignment_id || !booking_id || !staff_id) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'assignment_id, booking_id, and staff_id are required' })
        };
      }

      const result = await client.query(
        `INSERT INTO assignment_feedback (assignment_id, booking_id, staff_id, admin_notes, visible_to_staff)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (assignment_id)
         DO UPDATE SET
           admin_notes = EXCLUDED.admin_notes,
           visible_to_staff = EXCLUDED.visible_to_staff,
           updated_at = NOW()
         RETURNING *`,
        [assignment_id, booking_id, staff_id, admin_notes || '', visible_to_staff !== false]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, feedback: result.rows[0] })
      };
    }

    // ──────────────────────────────────────────────────────────
    // GOOGLE REVIEWS
    // ──────────────────────────────────────────────────────────

    // GET /api/staff-feedback/reviews?booking_id=X or ?all=true
    if (event.httpMethod === 'GET' && event.path.includes('/reviews')) {
      const bookingId = event.queryStringParameters?.booking_id;
      const all = event.queryStringParameters?.all === 'true';

      let query, params;
      
      if (bookingId) {
        query = 'SELECT * FROM google_reviews WHERE booking_id = $1 ORDER BY review_date DESC';
        params = [bookingId];
      } else if (all) {
        query = 'SELECT * FROM google_reviews ORDER BY review_date DESC LIMIT 100';
        params = [];
      } else {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'booking_id or all=true required' })
        };
      }

      const result = await client.query(query, params);

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ reviews: result.rows })
      };
    }

    // POST /api/staff-feedback/reviews
    if (event.httpMethod === 'POST' && event.path.includes('/reviews')) {
      const {
        booking_id,
        review_url,
        review_date,
        rating,
        review_text,
        client_name,
        staff_mentioned,
        notes
      } = JSON.parse(event.body || '{}');

      if (!review_url) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'review_url is required' })
        };
      }

      const result = await client.query(
        `INSERT INTO google_reviews 
          (booking_id, review_url, review_date, rating, review_text, client_name, staff_mentioned, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          booking_id || null,
          review_url,
          review_date || null,
          rating || null,
          review_text || '',
          client_name || '',
          staff_mentioned || [],
          notes || ''
        ]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, review: result.rows[0] })
      };
    }

    // PATCH /api/staff-feedback/reviews/:id
    if (event.httpMethod === 'PATCH' && event.path.match(/\/reviews\/\d+$/)) {
      const reviewId = event.path.split('/').pop();
      const updates = JSON.parse(event.body || '{}');

      const fields = [];
      const values = [];
      let idx = 1;

      const allowed = ['review_url', 'review_date', 'rating', 'review_text', 'client_name', 'staff_mentioned', 'notes', 'bonuses_awarded'];
      
      for (const key of allowed) {
        if (updates[key] !== undefined) {
          fields.push(`${key} = $${idx++}`);
          values.push(updates[key]);
        }
      }

      if (fields.length === 0) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'No valid fields to update' })
        };
      }

      fields.push(`updated_at = NOW()`);
      values.push(reviewId);

      const result = await client.query(
        `UPDATE google_reviews SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        return {
          statusCode: 404,
          headers: HEADERS,
          body: JSON.stringify({ error: 'Review not found' })
        };
      }

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, review: result.rows[0] })
      };
    }

    // ──────────────────────────────────────────────────────────
    // BONUSES
    // ──────────────────────────────────────────────────────────

    // GET /api/staff-feedback/bonuses?staff_id=X or ?booking_id=X or ?unpaid=true
    if (event.httpMethod === 'GET' && event.path.includes('/bonuses')) {
      const staffId = event.queryStringParameters?.staff_id;
      const bookingId = event.queryStringParameters?.booking_id;
      const unpaid = event.queryStringParameters?.unpaid === 'true';

      let query = `
        SELECT sb.*, s.name as staff_name, s.preferred_name,
               b.reference as booking_reference
        FROM staff_bonuses sb
        JOIN staff s ON s.id = sb.staff_id
        LEFT JOIN bookings b ON b.id = sb.booking_id
        WHERE 1=1
      `;
      const params = [];

      if (staffId) {
        params.push(staffId);
        query += ` AND sb.staff_id = $${params.length}`;
      }

      if (bookingId) {
        params.push(bookingId);
        query += ` AND sb.booking_id = $${params.length}`;
      }

      if (unpaid) {
        query += ` AND sb.paid = FALSE`;
      }

      query += ' ORDER BY sb.awarded_at DESC';

      const result = await client.query(query, params);

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ bonuses: result.rows })
      };
    }

    // POST /api/staff-feedback/bonuses
    if (event.httpMethod === 'POST' && event.path.includes('/bonuses')) {
      const {
        staff_id,
        booking_id,
        review_id,
        bonus_type,
        amount,
        reason
      } = JSON.parse(event.body || '{}');

      if (!staff_id || !bonus_type) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'staff_id and bonus_type are required' })
        };
      }

      const result = await client.query(
        `INSERT INTO staff_bonuses
          (staff_id, booking_id, review_id, bonus_type, amount, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [staff_id, booking_id || null, review_id || null, bonus_type, amount || null, reason || '']
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, bonus: result.rows[0] })
      };
    }

    // PATCH /api/staff-feedback/bonuses/:id
    if (event.httpMethod === 'PATCH' && event.path.match(/\/bonuses\/\d+$/)) {
      const bonusId = event.path.split('/').pop();
      const updates = JSON.parse(event.body || '{}');

      const fields = [];
      const values = [];
      let idx = 1;

      if (updates.paid !== undefined) {
        fields.push(`paid = $${idx++}`);
        values.push(updates.paid);
        
        if (updates.paid) {
          fields.push(`paid_at = NOW()`);
        } else {
          fields.push(`paid_at = NULL`);
        }
      }

      if (updates.amount !== undefined) {
        fields.push(`amount = $${idx++}`);
        values.push(updates.amount);
      }

      if (updates.reason !== undefined) {
        fields.push(`reason = $${idx++}`);
        values.push(updates.reason);
      }

      if (updates.payroll_run_id !== undefined) {
        fields.push(`payroll_run_id = $${idx++}`);
        values.push(updates.payroll_run_id);
      }

      if (fields.length === 0) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: 'No valid fields to update' })
        };
      }

      values.push(bonusId);

      const result = await client.query(
        `UPDATE staff_bonuses SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        return {
          statusCode: 404,
          headers: HEADERS,
          body: JSON.stringify({ error: 'Bonus not found' })
        };
      }

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, bonus: result.rows[0] })
      };
    }

    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' })
    };

  } catch (err) {
    console.error('Staff feedback error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    client.release();
  }
};
