const { Client } = require("pg");

const client = () => new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, PATCH, DELETE, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Extract ID from path: /api/booking/123
  const id = event.path.split("/").pop();
  if (!id || isNaN(parseInt(id))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid booking ID" }) };
  }

  const db = client();
  try {
    await db.connect();

    // PATCH — update specific fields
    if (event.httpMethod === "PATCH") {
      const updates = JSON.parse(event.body);

      // Map camelCase from frontend to snake_case columns
      const colMap = {
        status:          "status",
        deposit:         "deposit",
        paymentMethod:   "payment_method",
        contractSigned:  "contract_signed",
        staffId:         "staff_id",
        notes:           "notes",
      };

      const setClauses = [];
      const values = [];
      let idx = 1;

      for (const [key, col] of Object.entries(colMap)) {
        if (updates[key] !== undefined) {
          setClauses.push(`${col} = $${idx}`);
          values.push(updates[key]);
          idx++;
        }
      }

      if (setClauses.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No valid fields to update" }) };
      }

      values.push(parseInt(id));
      const result = await db.query(
        `UPDATE bookings SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "Booking not found" }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify(result.rows[0]) };
    }

    // DELETE — remove a booking
    if (event.httpMethod === "DELETE") {
      await db.query("DELETE FROM bookings WHERE id = $1", [parseInt(id)]);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    console.error("DB error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    await db.end();
  }
};
