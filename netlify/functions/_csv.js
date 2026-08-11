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

// Splits a whole CSV into rows of fields, scanning CHARACTERS rather than
// lines.
//
// This is the part that cannot be done per-line. The real PPM export puts
// newlines inside quoted fields — an address or an enquiry note runs across
// several lines — so splitting on \n first tears one booking into fragments.
// Measured on the 2026-08-10 final export: 1070 physical lines, 236 of them
// with an unbalanced quote, which a line-based parser turned into 1007 "rows"
// of which only 702 had a reference. The other ~305 were shrapnel. The 29-row
// sample had no multi-line fields, which is why this survived until the export
// that mattered.
//
// Also handles the RFC 4180 escape for a literal quote: "" inside a quoted
// field. PPM emits those in notes containing dialogue.
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += ch;                              // newlines included
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  // Trailing content with no final newline is still a row.
  if (field !== '' || row.length) endRow();

  // Drop rows that are entirely empty — a trailing newline produces one.
  return rows.filter((r) => r.some((f) => f !== ''));
}

// Parses a whole export into header-keyed objects. Short rows are padded with
// '' rather than left undefined, matching this schema's DEFAULT '' convention —
// see the silent-failure note about IS NOT NULL being a dead test here.
function parseCSV(text) {
  const rows = parseRows(text);
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0];
  const mapped = rows.slice(1).map((fields) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] !== undefined ? fields[i] : ''; });
    return obj;
  });

  return { headers, rows: mapped };
}

module.exports = { parseCSVLine, parseCSV, parseRows };
