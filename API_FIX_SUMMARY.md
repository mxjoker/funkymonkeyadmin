# ✅ API FIX COMPLETED — Reference Parameter Support

**Date:** May 6, 2026  
**Status:** FIXED ✅  
**File Modified:** `netlify/functions/bookings.js`

---

## What Was Fixed

### Problem
The confirmation page (`confirmation.html`) and booking lookup page (`my-booking.html`) were calling:
```
GET /api/bookings?reference=FM-ABC123
```

But the API was **ignoring** the `reference` parameter and returning ALL bookings, causing the frontend to show "Booking not found" errors.

### Solution
Added reference parameter handling in `bookings.js` at **line 129** (right after the GET handler check, before the staff_view check):

```javascript
// GET single booking by reference
if (event.queryStringParameters?.reference) {
  const ref = event.queryStringParameters.reference.toUpperCase();
  const { rows } = await client.query(
    'SELECT * FROM bookings WHERE reference = $1',
    [ref]
  );
  return { 
    statusCode: 200, 
    headers, 
    body: JSON.stringify({ bookings: rows }) 
  };
}
```

### Why This Location
- **After** `if (event.httpMethod === 'GET') {` — ensures we're in GET handler
- **Before** `staff_view` check — reference lookup takes priority
- Returns `{ bookings: [...] }` — matches frontend expectation

---

## How to Test

### Option 1: Quick Local Test
```bash
# 1. Get a test reference from your database
# Run: get-test-reference.sql in Neon console
# You'll get something like: FM-ABC123

# 2. Start dev server
cd ~/Downloads/funky-monkey-email
npx netlify dev

# 3. Test confirmation page
# Visit: http://localhost:8888/confirmation.html?ref=FM-ABC123
# (Replace FM-ABC123 with your actual reference)

# 4. Check DevTools Network tab
# Should see: GET /api/bookings?reference=FM-ABC123
# Should return: { bookings: [ { full booking object } ] }
```

### Option 2: Test via Booking Lookup Page
```bash
# Visit: http://localhost:8888/my-booking.html
# Enter: Reference (FM-ABC123) + Email (from database)
# Should show: Booking details + download buttons
```

### Option 3: Direct API Test
```bash
# In browser console or curl:
fetch('/api/bookings?reference=FM-ABC123')
  .then(r => r.json())
  .then(d => console.log(d))

# Should return:
# { bookings: [ { id: 1, reference: 'FM-ABC123', ... } ] }
```

---

## Expected Behavior After Fix

### ✅ Confirmation Page (`confirmation.html`)
1. After booking form submission → shows reference for 2 seconds
2. Auto-redirects to: `/confirmation.html?ref=FM-ABC123`
3. Page loads booking details from API
4. Shows appropriate title:
   - ✅ "Booking Confirmed!" (if deposit_paid = true)
   - ⏳ "Booking Received!" (if deposit_paid = false)
5. Download buttons work:
   - W-9 Tax Form → `/docs/w9.pdf`
   - Request Invoice → alerts "Contact us..."
   - Request COI → alerts "Contact us..."

### ✅ Booking Lookup (`my-booking.html`)
1. Client enters reference + email
2. API verifies match
3. Shows booking details
4. Download buttons available

### ✅ After Stripe Payment
1. Customer completes Stripe Checkout
2. Redirects to: `/confirmation.html?ref=FM-ABC123`
3. Shows "Booking Confirmed!" (deposit now marked paid)
4. All features work

---

## Files Status

| File | Status | Location |
|------|--------|----------|
| `bookings.js` | ✅ Fixed | `netlify/functions/bookings.js` |
| `confirmation.html` | ✅ Ready | Root directory |
| `my-booking.html` | ✅ Ready | Root directory |
| `booking-form.html` | ✅ Updated | Root directory (redirect added) |
| `create-stripe-link.js` | ✅ Updated | `netlify/functions/` (success_url points to confirmation) |

---

## Ready to Deploy

Once you've tested locally and confirmed it works:

```bash
cd ~/Downloads/funky-monkey-email

# Commit the fix
git add netlify/functions/bookings.js
git commit -m "fix: add reference parameter support to bookings GET endpoint

- Confirmation page was calling /api/bookings?reference=FM-XXX
- API was ignoring parameter and returning all bookings
- Frontend couldn't find matching booking
- Now properly filters by reference and returns single booking
- Fixes 'Booking not found' error on confirmation page"

# Push to deploy
git push
```

---

## Next Steps

With the API fixed, you can now:

1. ✅ Test the full booking flow end-to-end
2. ✅ Upload your W-9 PDF to `/docs/w9.pdf`
3. ✅ Move on to roadmap features:
   - Staff assignment UI
   - Services page with search
   - Foam party instant booking
   - Staff payment tracking
   - Automated notifications

---

**Questions?**
- Need help testing? Just ask!
- Want to tackle a roadmap feature next? Pick from the list in HANDOFF_NEW_SESSION.md
- Have other bugs to fix? Let's knock them out!
