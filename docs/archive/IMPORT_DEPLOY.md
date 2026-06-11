# 🚀 Quick Import Deployment

## ✅ What's Ready

- ✅ Import script written (`import-bookings.js`)
- ✅ Route added to `netlify.toml`
- ✅ Full documentation (`IMPORT_GUIDE.md`)
- ✅ 982 bookings ready to import from CSV

---

## 📦 Deploy Steps (5 minutes)

### 1. Add CSV to Project

```bash
cd ~/Downloads/funky-monkey-email

# Copy your CSV export (rename to import-data.csv)
cp ~/path/to/your/export.csv import-data.csv
```

### 2. Deploy Code

```bash
git add netlify/functions/import-bookings.js
git add netlify.toml
git add IMPORT_GUIDE.md
git add import-data.csv
git commit -m "feat: add Party Enquiry Tracker import function"
git push
```

### 3. Wait for Deployment (~2 minutes)

Watch: https://app.netlify.com/sites/funkymonkeyadmin/deploys

### 4. Run Dry-Run First

```bash
curl "https://funkymonkeyadmin.netlify.app/api/import-bookings?dryrun=true"
```

**Expected output:**
```json
{
  "success": true,
  "dryRun": true,
  "summary": {
    "total": 982,
    "imported": 950,
    "skipped": 0,
    "errors": 32
  },
  "errorDetails": [ /* rows with issues */ ],
  "message": "📋 Dry run complete - 950 rows ready to import"
}
```

### 5. Review Errors

Check `errorDetails` array for:
- Missing client names
- Invalid dates
- Missing references

Fix these in CSV if critical, or proceed if minor.

### 6. Run Actual Import

```bash
curl "https://funkymonkeyadmin.netlify.app/api/import-bookings"
```

**This will:**
- Import ~950 bookings
- Skip duplicates (existing references)
- Take ~30-60 seconds
- Show progress in Netlify logs

---

## 🎯 What Gets Imported

| Field | Source | Notes |
|-------|--------|-------|
| Client name | Direct copy | ✅ |
| Phone | Strips `'` prefix | ✅ |
| Email | Direct copy | ✅ |
| Event date | Parsed "DD MMM YYYY" | ✅ |
| Event time | Direct copy | ✅ |
| Location | Venue or Address 1 | ✅ |
| ZIP | Postcode or Town map | ✅ |
| Status | Mapped (Confirmed→confirmed) | ✅ |
| Service | Mapped where possible | ⚠️ Some may be generic |
| Prices | All financial fields | ✅ |
| Deposit | Amount + paid status | ✅ |
| Reference | Old ref (26-XXX) | ✅ Preserved! |
| Notes | Inquiry text | ✅ |
| Admin notes | Direct copy | ✅ |

---

## ⚠️ Important

### Before Running
- [ ] **Backup database** (see IMPORT_GUIDE.md)
- [ ] **Run dry-run first** (`?dryrun=true`)
- [ ] **Review error count** (should be <50)
- [ ] **Check you have import-data.csv** in project root

### After Import
- [ ] Check booking count in admin
- [ ] Spot-check a few random bookings
- [ ] Verify old references preserved
- [ ] Check that statuses mapped correctly
- [ ] Review any error rows manually

---

## 🆘 Troubleshooting

**"CSV file not found"**
→ You forgot to add `import-data.csv` to project root and deploy it

**"Duplicate reference" (many skips)**
→ You've already imported these! Check admin for existing 26-XXX references

**Many errors in dry-run**
→ Check `errorDetails` — usually missing names or bad dates

**Import times out**
→ Function will process what it can. Check Netlify logs for how many rows completed, then resume from that point

---

## ✅ Success!

After import completes, you should see:
- **~950 bookings in admin dashboard**
- **Old references preserved** (26-XXX format)
- **All client/event data migrated**
- **Financial data intact**
- **Statuses mapped correctly**

---

**Time estimate:** 5 minutes to deploy, 1 minute to import

**Ready when you are!** 🚀
