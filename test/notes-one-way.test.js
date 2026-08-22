const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const STAFF_API = read('netlify/functions/staff.js');
const PORTAL = read('staff-portal.html');
const ADMIN = read('admin.html');

// Joe, 2026-08-20: "These should be one way each. Not available for both to
// edit." A box both people could edit meant either could silently overwrite the
// other, with nothing on screen to say whose words they were.
//
//   admin_notes   Joe writes, only Joe reads
//   shared_notes  Joe writes, the staff member reads
//   staff_notes   the staff member writes, Joe reads
const maps = (name) => {
  const start = STAFF_API.indexOf(`const ${name} = {`);
  assert.ok(start !== -1, `${name} is gone from staff.js`);
  return STAFF_API.slice(start, STAFF_API.indexOf('};', start));
};

test('a staff caller cannot write the note Joe wrote to them', () => {
  assert.ok(!/shared_notes/.test(maps('staffColMap')),
    'staff can edit shared_notes again — either of them can now overwrite the other');
});

test('an admin caller cannot write the note a staff member wrote', () => {
  assert.ok(!/staff_notes/.test(maps('adminColMap')),
    'Joe can edit staff_notes again — he would be editing words attributed to someone else');
});

test('each note still has exactly one writer', () => {
  const admin = maps('adminColMap'), staff = maps('staffColMap');
  assert.match(admin, /shared_notes/, 'nobody can write shared_notes any more');
  assert.match(staff, /staff_notes/, 'nobody can write staff_notes any more');
  // admin_notes is Joe's private note about the person and is stripped from
  // every staff read — it must never appear in the staff map.
  assert.match(admin, /admin_notes/);
  assert.ok(!/admin_notes/.test(staff), 'staff can write the notes Joe keeps about them');
});

// The read side of admin_notes, which is a privacy promise rather than an edit
// rule: a staff member must never receive it at all.
test('admin_notes is stripped from what staff can read', () => {
  assert.match(STAFF_API, /const \{ admin_notes, \.\.\.safe \} = rows\[0\]/,
    'the single-record read stopped stripping admin_notes');
  assert.match(STAFF_API, /rows\.map\(\(\{ admin_notes, \.\.\.r \}\) => r\)/,
    'the list read stopped stripping admin_notes');
});

// The UI has to agree, or a staff member types into a box whose contents the
// server silently discards — the worst version of this bug, because it looks
// like it saved.
test('the portal does not offer an editable box for Joe\'s note', () => {
  assert.ok(!/id="pf-shared"/.test(PORTAL),
    'the portal still has a textarea for shared_notes — anything typed there is dropped by the server');
  const save = PORTAL.slice(PORTAL.indexOf('async function savePreferences'),
                            PORTAL.indexOf('async function savePreferences') + 1200);
  assert.ok(!/shared_notes:/.test(save), 'the portal is still sending shared_notes');
  assert.match(save, /staff_notes:/, 'the portal must still send the staff member\'s own note');
});

test('the admin staff editor does not offer an editable box for the staff note', () => {
  const save = ADMIN.slice(ADMIN.indexOf('async function saveStaff'), ADMIN.indexOf('async function saveStaff') + 1400);
  assert.ok(!/staff_notes:/.test(save), 'the admin staff editor is still sending staff_notes');
  assert.match(save, /shared_notes:/, 'Joe must still be able to write his note to them');
});

// Both sides show the other person's note read-only, so the direction is
// visible rather than something you discover by losing a paragraph.
test('each side displays the other\'s note read-only', () => {
  assert.match(PORTAL, /Note from Joe/, 'the portal no longer shows Joe\'s note');
  assert.match(ADMIN, /Notes from /, 'the admin editor no longer shows the staff note');
});
