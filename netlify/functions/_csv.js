// Extracted from import-bookings.js so the importer and
// scripts/reconcile-ppm-export.js parse the PPM export identically. A second
// implementation would make a reconciliation diff meaningless: it could report
// drift that is really just two parsers disagreeing — and that diff is the last
// gate before the Wix button moves.

// Splits one CSV line, honouring double-quoted fields that contain commas.
// Trailing empty fields are preserved: PPM pads its 80-column export with them,
// and dropping them shifts every later column.
//
// Moved verbatim from import-bookings.js. Its trimming and quote handling are
// what the existing 668-row import was built against, so "improving" it here
// would silently change how already-imported data would parse today.
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

// Parses a whole export into header-keyed objects. Short rows are padded with
// '' rather than left undefined, matching this schema's DEFAULT '' convention —
// see the silent-failure note about IS NOT NULL being a dead test here.
function parseCSV(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const fields = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] !== undefined ? fields[i] : ''; });
    return obj;
  });

  return { headers, rows };
}

module.exports = { parseCSVLine, parseCSV };
