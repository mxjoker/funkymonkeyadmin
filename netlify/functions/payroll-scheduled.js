const { withClient } = require('./_db');
const { ensureTables } = require('./payroll');

// Get the most recently completed Sunday strictly before `date`.
// e.g. if today is Saturday 2026-06-13, the last completed Sunday is 2026-06-07.
// e.g. if today is Sunday 2026-06-14, the last completed Sunday is 2026-06-07
//      (today's Sunday is the START of the new week, not the end of the old one).
function getLastSunday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days to subtract to reach the previous Sunday (never 0 — we want strictly before today)
  const diff = day === 0 ? 7 : day; // Sunday→go back 7 days; any other day→go back `day` days
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

// Week start = 6 days before week end (Mon–Sun window, matching payroll.js getMonday)
function getWeekStart(sundayDate) {
  const d = new Date(sundayDate);
  d.setDate(d.getDate() - 6);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  console.log('Scheduled payroll generation triggered');

  try {
    return await withClient(async (client) => {
      // Ensure payroll tables exist before querying them
      await ensureTables(client);

      // Determine the most recently completed week (ends on last Sunday before today).
      // This function runs at Saturday 00:00 UTC; "today" is Saturday so
      // last completed Sunday is 6 days prior — which is exactly the Sunday
      // that ended the week we want to pay.
      const today = new Date();
      const weekEnd   = getLastSunday(today);
      const weekStart = getWeekStart(weekEnd);

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

      const totalAmount = unpaidPayments.reduce((sum, p) => sum + Number(p.amount), 0);

      const { rows: [run] } = await client.query(`
        INSERT INTO payroll_runs (week_ending, status, total_amount, notes, created_by)
        VALUES ($1, 'draft', $2, $3, 'Auto-generated')
        RETURNING *
      `, [weekEnd, totalAmount, `Week ending ${weekEnd}`]);

      for (const payment of unpaidPayments) {
        await client.query(`
          INSERT INTO payroll_line_items (payroll_run_id, staff_payment_id, staff_id, amount)
          VALUES ($1, $2, $3, $4)
        `, [run.id, payment.id, payment.staff_id, payment.amount]);
      }

      console.log(`Created payroll run ${run.id} for week ending ${weekEnd}`);
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
    });
  } catch (err) {
    console.error('Scheduled payroll generation failed:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Scheduled payroll generation failed' })
    };
  }
};
