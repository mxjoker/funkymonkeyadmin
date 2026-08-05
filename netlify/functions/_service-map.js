// Legacy service_name → catalogue service_id.
//
// Why this exists: staff_slots, service_time_templates and the availability
// lookup are all keyed on services.service_id. PPM only ever supplied free-text
// package names, so a booking that carries a name but no id joins to zero staff
// slots and reports "no staff requirements" for a service whose roles are
// configured correctly. Two consumers need the same mapping — import-bookings.js
// at intake and scripts/backfill-service-ids.js for rows already in the table —
// so it lives here rather than being written twice and drifting.
//
// Confident matches only. Names that could mean more than one catalogue entry
// ("Custom Event", "Library Show", "Magic Show", "Show", one-off show titles)
// are deliberately absent: guessing links a booking to the wrong roles and the
// wrong time template, which is worse than leaving it unlinked and visible.
const NAME_TO_SERVICE = {
  'story doodles': 'lib_doodles',
  'magic show - library': 'lib_magic',
  'balloon workshop - library': 'lib_balloon',
  'foam party - library': 'lib_foam',
  'corporate magic show': 'corporate_magic',
  'deluxe magic birthday show': 'deluxe_magic',
  'deluxe birthday package': 'deluxe_magic',
  'magic birthday show': 'basic_magic',
  'school show': 'school_asm',
  'walk around magic': 'wedding_magic',
  'face painting': 'face_paint',
  'airbrush tattoos': 'airbrush',
  'glitter tattoos': 'glitter',
  'live spun cotton candy': 'cotton_candy',
  'cotton candy - 2 hours special': 'cotton_candy',
  '45 minute snow party': 'snow_45',
  '90 minute snow party': 'snow_90',
  'professor buckets bubble show - science theme': 'bubble_show',
  'professor buckets bubbles show and bubble party': 'bubble_show',
  'a la carte bubble party': 'bubble_show',
  'funky monkey magic camp': 'lib_workshop',
  'up to 40 kids': 'balloon_40',
  '40-60 kids': 'balloon_60',
  // Owner's call, 2026-08-05: every foam booking → foam_single. foam_single and
  // foam_double require identical staff (2× Foam Party + 1 Driver), so the
  // choice only decides which time template autoCalcTimes reads.
  'foam party experience': 'foam_single',
  '90 minute foam party': 'foam_single',
  // Owner's call, 2026-08-05: the generic "Library Show" is the magic show.
  'library show': 'lib_magic',
};

// Imported names carry inconsistent dashes and spacing ("Magic Show - Library",
// "Magic Show — Library"), so match on a flattened form rather than verbatim.
const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‐-―]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const NORMALISED = Object.fromEntries(
  Object.entries(NAME_TO_SERVICE).map(([k, v]) => [norm(k), v])
);

// Returns the catalogue service_id for a free-text service name, or '' when the
// name is unknown or ambiguous. Empty string rather than null: bookings.service_id
// is VARCHAR and rollupItems() already uses '' for "no catalogue link".
const resolveServiceId = (serviceName) => NORMALISED[norm(serviceName)] || '';

module.exports = { NAME_TO_SERVICE, resolveServiceId, norm };
