// The three brand tiers, and the only place that decides what a brand value
// means.
//
// FME is the company; JCM is Joe's premium service; FMMS takes lower-paid magic
// work so it does not erode JCM's rates. Misattributing a booking between tiers
// is a revenue error, and both previous implementations made it silently:
//
//   bookings.js:412       b.brand === 'jcm' ? 'jcm' : 'fme'
//   create-bookings.js:95 BRANDS.has(String(b.brand)) ? b.brand : 'fme'
//
// The first turned every unrecognised value into 'fme'. The second kept its own
// two-value set, so the admin direct-entry path would have rejected 'fmms'
// outright while the public path silently swallowed it. Two copies of a rule
// drift; this is one copy.
const BRANDS = new Set(['fme', 'jcm', 'fmms']);

// Returns the canonical brand, or throws. Empty/absent defaults to 'fme',
// matching the column default and every legacy row.
function normaliseBrand(input) {
  const b = String(input == null ? '' : input).trim().toLowerCase();
  if (b === '') return 'fme';
  if (!BRANDS.has(b)) throw new Error(`unknown brand: ${b}`);
  return b;
}

module.exports = { BRANDS, normaliseBrand };
