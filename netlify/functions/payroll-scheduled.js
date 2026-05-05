const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Get the Sunday for a given date (week ending)
function getSunday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// Get the Monday for the week (6 days before Sunday)
function getMonday(sundayDate) {
  const d = new Date(sundayDate);
  d.setDate(d.getDate() - 6);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  console.log('🕐 Scheduled payroll generation triggered');

  const client = await pool.connect();
  try {
    // Get the Sunday for the week that just ended (yesterday since this runs Saturday midnight)
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1); // Friday
    
    const weekEnd = getSunday(yesterday); // Should be the previous Sunday
    const weekStart = getMonday(weekEnd);

    console.log(`Generating payroll for week: ${weekStart} to ${weekEnd}`);

    // Check if run already exists
    const { rows: existing } = await client.query(
      'SELECT * FROM payroll_runs WHERE week_ending = $1',
      [weekEnd]
    );
    
    if (existing.length > 0) {
      console.log(`Payroll run already exists for week ending ${weekEnd}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Payroll run already exists', run: existing[0] })
      };
    }

    // Find unpaid payments for this week
    const { rows: unpaidPayments } = await client.query(`
      SELECT sp.*, b.event_date
      FROM staff_payments sp
      JOIN bookings b ON b.id = sp.booking_id
      WHERE sp.paid = false
        AND b.event_date >= $1
        AND b.event_date <= $2
    `, [weekStart, weekEnd]);

    if (unpaidPayments.length === 0) {
      console.log('No unpaid payments for this week');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No unpaid payments for this week' })
      };
    }

    // Calculate total
    const totalAmount = unpaidPayments.reduce((sum, p) => sum + Number(p.amount), 0);

    // Create payroll run
    const { rows: [run] } = await client.query(`
      INSERT INTO payroll_runs (week_ending, status, total_amount, created_by)
      VALUES ($1, 'draft', $2, 'Auto-generated')
      RETURNING *
    `, [weekEnd, totalAmount]);

    // Create line items
    for (const payment of unpaidPayments) {
      await client.query(`
        INSERT INTO payroll_line_items (payroll_run_id, staff_payment_id, staff_id, amount)
        VALUES ($1, $2, $3, $4)
      `, [run.id, payment.id, payment.staff_id, payment.amount]);
    }

    console.log(`✅ Created payroll run ${run.id} for week ending ${weekEnd}`);
    console.log(`   ${unpaidPayments.length} payments totaling $${totalAmount.toFixed(2)}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Payroll run created',
        run,
        count: unpaidPayments.length,
        total: totalAmount
      })
    };

  } catch (err) {
    console.error('❌ Scheduled payroll generation failed:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    client.release();
  }
};
