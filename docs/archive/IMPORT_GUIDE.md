# 📥 Party Enquiry Tracker Import Guide

## 📊 Data Analysis

**Source:** Party Enquiry Tracker CSV Export  
**Total rows:** 982 bookings (983 lines including header)  
**File size:** 374 KB

### Column Mapping

| Old System Column | → | Funky Monkey Column | Notes |
|-------------------|---|---------------------|-------|
| **Event status** | → | `status` | Maps: Confirmed→confirmed, Unprocessed→review, Processing→pending |
| **Client name** | → | `client_name` | Direct copy |
| **Phone number** | → | `client_phone` | Remove leading apostrophe |
| **Email** | → | `client_email` | Direct copy |
| **Child name 1** | → | `child_name` | Primary child name |
| **Event date** | → | `event_date` | Parse "DD MMM YYYY" format |
| **Event time** | → | `event_time` | Direct copy |
| **Venue** | → | `event_location` | Combine with address if empty |
| **Addr. line 1** | → | `event_location` | Fallback if Venue empty |
| **Town** | → | `event_zip` | Map to Oklahoma City ZIP codes |
| **Postcode** | → | `event_zip` | Use if available |
| **Customer type** | → | `customer_type` | Direct copy (Private/Organization) |
| **Package** | → | `service_name` | Map to service catalog |
| **Ref.** | → | `reference` | Keep old reference (26-XXX format) |
| **Enq. text** | → | `notes` | Inquiry/notes field |
| **Heard about us** | → | `referral_source` | Direct copy |
| **No. children** | → | `guest_count` | Parse as integer |
| **Party price** | → | `service_price` | Parse as decimal |
| **Price of extras** | → | `addon_total` | Parse as decimal |
| **Travel fee** | → | `mileage_cost` | Parse as decimal |
| **Tot. price** | → | `total_price` | Parse as decimal |
| **Deposit** | → | `deposit_amount` | Parse as decimal |
| **Deposit paid** | → | `deposit_paid` | Convert to boolean |
| **Admin notes** | → | `admin_notes` | Direct copy |

### Status Mapping

```javascript
const statusMap = {
  'Confirmed': 'confirmed',
  'Processing': 'pending',
  'Unprocessed': 'review',
  'Cancelled': 'cancelled',
  'Completed': 'completed'
};
```

### Service Name Mapping

```javascript
const serviceMap = {
  // Magic Shows
  'Deluxe Birthday Package': 'Deluxe Magic Birthday Show',
  'Basic Birthday Show': 'Magic Birthday Show',
  'Stage Show': 'Stage Magic Show',
  'Corporate Magic': 'Corporate Magic Show',
  
  // Foam Parties
  '45 Minute Foam Party': 'Foam Party Experience',
  '90 Minute Foam Party': 'Foam Party Experience',
  
  // Add more mappings as needed
};
```

---

## 🚀 Import Script

**Location:** `netlify/functions/import-bookings.js`

### Features

- ✅ **Dry run mode** — Preview what will be imported
- ✅ **Batch processing** — Import in chunks of 50
- ✅ **Duplicate detection** — Skip existing references
- ✅ **Error handling** — Continue on individual row errors
- ✅ **Progress tracking** — Real-time import status
- ✅ **Validation** — Check required fields before importing

### Usage

**Step 1: Upload CSV to server**
```bash
# Place CSV in project root
cp ~/Downloads/party-tracker-export.csv /Users/joecoover2022/Downloads/funky-monkey-email/import-data.csv
```

**Step 2: Run dry-run first**
```bash
curl "https://funkymonkeyadmin.netlify.app/api/import-bookings?dryrun=true"
```

Expected output:
```json
{
  "dryRun": true,
  "summary": {
    "total": 982,
    "valid": 950,
    "skipped": 20,
    "errors": 12
  },
  "preview": [ /* first 10 rows */ ]
}
```

**Step 3: Run actual import**
```bash
curl "https://funkymonkeyadmin.netlify.app/api/import-bookings"
```

**Step 4: Monitor progress**
Check Netlify function logs for real-time progress:
```
✅ Imported 50/982 rows...
✅ Imported 100/982 rows...
✅ Imported 150/982 rows...
```

---

## ⚠️ Important Notes

### Before Importing

1. **Backup your database**
   ```sql
   -- Run this in Neon SQL editor
   CREATE TABLE bookings_backup AS SELECT * FROM bookings;
   ```

2. **Test with dry run** — Always run `?dryrun=true` first

3. **Check service mappings** — Verify package names map correctly

4. **Review status mappings** — Ensure statuses are correct

### Data Quality Issues to Handle

Based on the sample data, watch for:

- **Phone numbers with apostrophes** — Strip leading `'` character
- **Empty venues** — Fallback to address line 1
- **Missing postcodes** — Use town name to infer ZIP
- **Empty event times** — Default to "TBD"
- **Zero/empty prices** — Mark as custom quote
- **Missing packages** — Skip or mark as "Custom Event"

### What Gets Skipped

- Rows with no client name
- Rows with no event date
- Rows with existing references (duplicates)
- Rows with invalid/unparseable dates

---

## 📝 Import Script Details

### Date Parsing

The CSV uses "DD MMM YYYY" format:
```javascript
// "09 May 2026" → "2026-05-09"
const parseDate = (str) => {
  const months = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  };
  const [day, month, year] = str.trim().split(' ');
  return `${year}-${months[month]}-${day.padStart(2, '0')}`;
};
```

### ZIP Code Inference

When postcode is empty, infer from town:
```javascript
const oklahomaZips = {
  'Oklahoma City': '73132',
  'Edmond': '73013',
  'Norman': '73069',
  'Piedmont': '73078',
  'Yukon': '73099',
  'Moore': '73160'
};
```

### Reference Handling

Keep old references for continuity:
```javascript
// Old: "26-247" → Keep as-is
// If duplicate, append suffix: "26-247-IMPORT"
```

---

## 🎯 Expected Results

### Success Scenario
```json
{
  "success": true,
  "imported": 950,
  "skipped": 20,
  "errors": 12,
  "duration_ms": 45000,
  "errors_detail": [
    { "row": 123, "reason": "Missing client name" },
    { "row": 456, "reason": "Invalid date format" }
  ]
}
```

### What You'll See in Database

- **982 new bookings** (minus duplicates/errors)
- **Old references preserved** (26-XXX format)
- **Statuses mapped correctly**
- **Services matched to catalog**
- **All financial data imported**
- **Client info populated**
- **Event details captured**

---

## 🔧 Troubleshooting

### "Duplicate reference" errors
**Normal!** If you've already imported some bookings with these references, they'll be skipped.

### "Service not found" warnings
**Expected.** Some old package names may not exist in new catalog. These will:
- Use `service_name` as-is (descriptive text)
- Mark `service_id` as NULL
- You can manually map them later in admin

### Import times out
**Solution:** The function processes in batches. If it times out:
1. Note which row it stopped at (check logs)
2. Modify script to start from that row
3. Re-run to complete remaining rows

### Date parsing errors
**Check format.** If dates don't match "DD MMM YYYY":
- Script will skip those rows
- Check `errors_detail` in response
- Manually fix in CSV and re-import those rows

---

## ✅ Post-Import Checklist

After import completes:

- [ ] Check total booking count in admin dashboard
- [ ] Verify a few random bookings look correct
- [ ] Check that old references are preserved (26-XXX)
- [ ] Verify confirmed bookings have correct status
- [ ] Spot-check financial data (prices, deposits)
- [ ] Review any error rows in import response
- [ ] Manually fix any service mappings that failed
- [ ] Delete `import-data.csv` from server (cleanup)

---

## 📚 Next Steps

1. **I'll write the import script** (`import-bookings.js`)
2. **You upload the CSV** to project folder
3. **Deploy the function** (`git push`)
4. **Run dry-run** to preview
5. **Run actual import** when ready
6. **Review results** in admin

---

**Ready to proceed?** Let me know when you want me to write the full import script!
