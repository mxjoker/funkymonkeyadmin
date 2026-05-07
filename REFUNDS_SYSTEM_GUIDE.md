# Refunds System — Complete Guide

## Overview

Complete refund processing system with Stripe integration. Handles deposit refunds, full refunds, and custom amounts with proper tracking and client notifications.

---

## Features

### Refund Types
1. **Deposit Refund** — Return deposit only
2. **Full Refund** — Return entire booking amount
3. **Custom Amount** — Specify exact refund amount

### Payment Methods
- **Stripe Payments** — Automatic refund through Stripe API
- **Manual Payments** — Log refund for external processing (check, Venmo, cash)

### Tracking & Logging
- Refunds table tracks all refunds
- Activity log shows refund in booking history
- Email confirmation sent to client
- Stripe refund ID stored for reconciliation

---

## Files Created

**Backend:** `netlify/functions/refund.js` (283 lines)
- Stripe refund processing
- Manual refund logging
- Email notifications
- Database tracking

**Frontend:** `admin.html` (processRefund function)
- Refund button in booking modal
- Multi-step refund workflow
- Validation and confirmations

**Config:** `netlify.toml`
- Route: `/api/refund` → `/.netlify/functions/refund`

---

## Database

### `refunds` Table
```sql
CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  stripe_refund_id VARCHAR(255),
  amount NUMERIC(10,2) NOT NULL,
  reason VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  refunded_by VARCHAR(100) DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
)
```

**Fields:**
- `stripe_refund_id` — Stripe's refund ID (null for manual)
- `amount` — Refund amount in dollars
- `reason` — Admin-entered reason
- `status` — 'pending', 'succeeded', 'failed', 'manual'
- `refunded_by` — Who processed it (default: 'admin')

---

## Workflow

### From Admin Dashboard

1. **Open Booking** — Click any booking to open modal

2. **Process Refund Button** — Appears only if:
   - Deposit has been paid, OR
   - Stripe payment exists

3. **Choose Refund Type:**
   ```
   Process refund for Sarah Johnson?
   
   Booking: Magic Show on 2026-06-15
   Total Price: $500.00
   Deposit: $100.00
   Balance Due: $400.00
   
   Choose refund type:
   1 = Deposit only ($100.00)
   2 = Full refund ($500.00)
   3 = Custom amount
   ```

4. **Enter Details:**
   - **Option 1 (Deposit):** System prompts for reason
   - **Option 2 (Full):** System prompts for reason
   - **Option 3 (Custom):** Prompts for amount, then reason

5. **Confirm:**
   ```
   Confirm refund of $100.00?
   
   This will process through Stripe
   (funds return in 5-10 business days)
   ```
   
   OR (for manual payments):
   ```
   This is a MANUAL payment - you must process
   the refund outside the system (check, Venmo, etc.)
   ```

6. **Processing:**
   - Stripe refunds → Automatic via API
   - Manual payments → Logged only

7. **Confirmation:**
   ```
   ✓ Refund of $100.00 processed successfully!
   
   Refund of $100.00 processed via Stripe
   ```

8. **Client Email Sent:**
   Automatic confirmation email with refund details

---

## API Endpoint

### POST /api/refund

**Request Body:**
```json
{
  "booking_id": 123,
  "amount": 100.00,
  "reason": "Event cancelled by client",
  "refund_type": "deposit"
}
```

**Parameters:**
- `booking_id` (required) — Booking to refund
- `amount` (required) — Amount in dollars
- `reason` (optional) — Text reason for refund
- `refund_type` (optional) — 'deposit', 'full', or 'partial'

**Success Response:**
```json
{
  "success": true,
  "refund": {
    "id": 1,
    "booking_id": 123,
    "stripe_refund_id": "re_1234567890",
    "amount": 100.00,
    "status": "succeeded"
  },
  "stripe_refund": {
    "id": "re_1234567890",
    "status": "succeeded",
    "amount": 10000
  },
  "message": "Refund of $100.00 processed successfully via Stripe"
}
```

**Manual Payment Response:**
```json
{
  "success": true,
  "refund": {
    "id": 1,
    "booking_id": 123,
    "amount": 100.00,
    "status": "manual"
  },
  "type": "manual",
  "message": "Manual refund logged. Process refund outside of system (check, Venmo, etc.)"
}
```

**Error Response:**
```json
{
  "error": "Refund amount ($600.00) exceeds maximum allowed ($500.00)"
}
```

---

## Validation Rules

### Amount Limits
- **Deposit refund:** Cannot exceed `deposit_amount`
- **Full refund:** Cannot exceed `total_price`
- **Custom refund:** Cannot exceed `total_price`
- Minimum: $0.01

### Prerequisites
- Booking must exist
- At least one of:
  - `deposit_paid = true`, OR
  - `stripe_payment_intent_id` exists

### Stripe Requirements
- Valid `STRIPE_SECRET_KEY` environment variable
- Valid `stripe_payment_intent_id` in booking
- Payment Intent must be chargeable

---

## Email Notification

Sent automatically after successful refund:

**Subject:** `Refund Processed - [BOOKING_REFERENCE]`

**Body:**
```
Hi [Client Name],

Your refund has been processed:

• Amount: $100.00
• Booking: Magic Show on June 15, 2026
• Reference: FME-2026-0123

The refund should appear in your account within
5-10 business days.

If you have any questions, please don't hesitate
to contact us.

Thank you,
Funky Monkey Events
```

---

## Stripe Integration

### Refund API Call
```javascript
POST https://api.stripe.com/v1/refunds
Authorization: Bearer sk_live_...
Content-Type: application/x-www-form-urlencoded

payment_intent=pi_1234567890&
amount=10000&
reason=requested_by_customer
```

### Refund Statuses
- **succeeded** — Refund completed
- **pending** — Processing (rare, usually instant)
- **failed** — Refund failed
- **canceled** — Refund was canceled

### Refund Reasons (Stripe)
- `duplicate` — Duplicate charge
- `fraudulent` — Fraudulent charge
- `requested_by_customer` — Customer requested (default)

---

## Testing

### Test Stripe Refund (Sandbox)
```javascript
// 1. Create test booking with Stripe payment
// 2. Process refund via UI
// 3. Check Stripe Dashboard → Refunds
// 4. Verify refund appears in test mode
```

### Test Manual Refund
```javascript
// 1. Create booking with manual payment
// 2. Mark deposit as paid
// 3. Process refund via UI
// 4. Verify refund logged in database
// 5. Manually process external refund (check, Venmo)
```

### Database Queries
```sql
-- View all refunds
SELECT r.*, b.reference, b.client_name, b.service_name
FROM refunds r
JOIN bookings b ON b.id = r.booking_id
ORDER BY r.created_at DESC;

-- Refunds by status
SELECT status, COUNT(*), SUM(amount)
FROM refunds
GROUP BY status;

-- Recent refunds
SELECT * FROM refunds
WHERE created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```

---

## Security Considerations

### Authorization
- **Admin only** — Refund button only shows for admin users
- No public refund endpoint
- All refunds logged with `refunded_by` field

### Fraud Prevention
- Amount validation prevents over-refunding
- Requires explicit confirmation before processing
- Refund ID stored for reconciliation
- Email confirmation sent to client

### Audit Trail
- All refunds logged to `refunds` table
- Activity log shows in booking history
- Email log tracks confirmation send

---

## Common Scenarios

### Scenario 1: Event Cancelled (Full Refund)
```
1. Client calls to cancel
2. Joe opens booking in admin
3. Clicks "Process Refund"
4. Selects option 2 (Full refund)
5. Enters reason: "Event cancelled by client"
6. Confirms
7. Stripe processes automatically
8. Client receives email confirmation
```

### Scenario 2: Client Found Another Vendor (Deposit Refund)
```
1. Client books elsewhere
2. Joe offers deposit refund as goodwill
3. Selects option 1 (Deposit only)
4. Enters reason: "Booked with another vendor"
5. $100 returned via Stripe
6. Booking remains in system for records
```

### Scenario 3: Partial Refund (Custom Amount)
```
1. Service quality issue
2. Joe offers 50% refund
3. Selects option 3 (Custom)
4. Enters amount: $250
5. Enters reason: "Service quality issue - partial refund"
6. Stripe processes $250
7. Client keeps remaining booking
```

### Scenario 4: Cash Payment Refund
```
1. Original payment was cash
2. No stripe_payment_intent_id
3. Process refund via UI
4. System logs as "manual"
5. Joe physically returns cash/check
6. Refund record kept for accounting
```

---

## Reporting

### Monthly Refund Report
```sql
SELECT 
  DATE_TRUNC('month', created_at) as month,
  COUNT(*) as total_refunds,
  SUM(amount) as total_amount,
  AVG(amount) as avg_amount
FROM refunds
WHERE status IN ('succeeded', 'manual')
GROUP BY month
ORDER BY month DESC;
```

### Refund Rate by Service
```sql
SELECT 
  b.service_name,
  COUNT(DISTINCT b.id) as total_bookings,
  COUNT(r.id) as refunds,
  ROUND(COUNT(r.id)::numeric / COUNT(DISTINCT b.id) * 100, 2) as refund_rate_pct
FROM bookings b
LEFT JOIN refunds r ON r.booking_id = b.id
GROUP BY b.service_name
ORDER BY refund_rate_pct DESC;
```

---

## Future Enhancements

### Partial Refunds with Tracking
- Track remaining balance after partial refund
- Allow multiple partial refunds
- Show refund history in booking modal

### Automated Refund Policies
- Auto-approve refunds X days before event
- Tiered refund amounts based on cancellation timing
- Refund policy display on booking form

### Refund Analytics
- Dashboard widget showing refund metrics
- Trend analysis over time
- Refund reasons categorization

### Client Self-Service
- Client portal refund request
- Auto-approval for qualifying refunds
- Email notification workflow

---

## Summary

The refunds system provides:

✅ **Stripe Integration** — Automatic refunds via API  
✅ **Manual Support** — Log refunds processed externally  
✅ **Flexible Amounts** — Deposit, full, or custom  
✅ **Validation** — Prevent over-refunding  
✅ **Tracking** — Complete audit trail  
✅ **Notifications** — Auto-email to clients  
✅ **Security** — Admin-only with confirmations  

**Cost:** $0 (uses existing Stripe account)  
**Setup Time:** 0 minutes (code ready to deploy)  
**User-Friendly:** 3-click process in admin UI

---

**Status:** ✅ PRODUCTION READY

**Next Step:** Deploy to Netlify (code already written!)
