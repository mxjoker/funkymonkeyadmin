exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const { password } = JSON.parse(event.body || "{}");
    const correct = process.env.ADMIN_PASSWORD || "funkymonkey2024";
    if (password === correct) {
      const token = Buffer.from(`fm-admin:${Date.now()}:${correct.length}`).toString("base64");
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, token }) };
    }
    return { statusCode: 401, headers: h, body: JSON.stringify({ success: false }) };
  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
