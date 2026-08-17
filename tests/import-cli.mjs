/**
 * End-to-end test of `npm run import` against the Firebase emulators.
 *
 * This runs the real script as a subprocess — same sign-in, same rules, same
 * writes — because the point of the script is that it works when a person types
 * one command, and only running it proves that.
 *
 * Prereq: npm run emul
 * Run:    node tests/import-cli.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const run = promisify(execFile);

const FS = 'http://127.0.0.1:8080/v1/projects/demo-src/databases/(default)/documents';
const FS_ADMIN = 'http://127.0.0.1:8080/emulator/v1/projects/demo-src/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099';
const KEY = 'fake-api-key';

const TEACHER = 'ms.jones@education.nsw.gov.au';
const STUDENT = 'john.smith2@education.nsw.gov.au';
const PASSWORD = 'test-password-123';

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const owner = { Authorization: 'Bearer owner', 'content-type': 'application/json' };

async function reset() {
  await fetch(FS_ADMIN, { method: 'DELETE', headers: owner });
  await fetch(`${AUTH}/emulator/v1/projects/demo-src/accounts`, { method: 'DELETE', headers: owner });
}

/** Create a password account in the Auth emulator and return its uid. */
async function makeAccount(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`signUp failed: ${JSON.stringify(body)}`);
  return body.localId;
}

async function seedProfile(uid, email, name, role) {
  const res = await fetch(`${FS}/users/${uid}`, {
    method: 'PATCH',
    headers: owner,
    body: JSON.stringify({
      fields: {
        email: { stringValue: email },
        name: { stringValue: name },
        yearClass: { stringValue: role === 'teacher' ? 'Staff' : '10B' },
        role: { stringValue: role },
      },
    }),
  });
  if (!res.ok) throw new Error(`seed profile failed: ${await res.text()}`);
}

async function listAnnouncements() {
  const res = await fetch(`${FS}/announcements?pageSize=300`, { headers: owner });
  const body = await res.json();
  return body.documents || [];
}

/** Run the import script. Never throws — the exit code is part of the result. */
async function importCli(extraArgs = [], env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [
      'scripts/import-classroom.mjs', '--emulator', ...extraArgs,
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, SRC_IMPORT_PASSWORD: PASSWORD, ...env },
      timeout: 120000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/**
 * The newest unused sign-in link the Auth emulator has "sent" to an address.
 * This is exactly the URL a real email would carry.
 */
async function latestSignInLink(email) {
  const res = await fetch(`${AUTH}/emulator/v1/projects/demo-src/oobCodes`);
  const { oobCodes = [] } = await res.json();
  const mine = oobCodes.filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN');
  if (!mine.length) throw new Error(`no sign-in link was sent to ${email}`);
  return mine[mine.length - 1].oobLink;
}

/**
 * Run the import in link mode. The script sends the link and then waits for a
 * paste, so feed it the code the emulator captured — the same thing a person
 * does when they copy the link out of their inbox.
 */
async function importViaLink(email) {
  // Send first, in a throwaway run, so a link exists to hand back.
  await importCli(['--email', email, '--link'],
    { SRC_IMPORT_PASSWORD: '', SRC_IMPORT_LINK: 'not-a-link' });
  const link = await latestSignInLink(email);
  const result = await importCli(['--email', email, '--link'],
    { SRC_IMPORT_PASSWORD: '', SRC_IMPORT_LINK: link });
  // Hand back the link that was actually consumed. Asking for "the latest"
  // afterwards would return the fresh one this run also sent, which is not
  // spent at all — that mistake made the reuse test pass for the wrong reason.
  return { ...result, usedLink: link };
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

try {
  const archive = JSON.parse(readFileSync(new URL('../docs/classroom-import.json', import.meta.url), 'utf8'));

  /* ---- 1. a teacher can import ------------------------------------------- */
  await reset();
  const teacherUid = await makeAccount(TEACHER);
  await seedProfile(teacherUid, TEACHER, 'Ms Jones', 'teacher');

  const first = await importCli(['--email', TEACHER]);
  const out1 = strip(first.out);
  check('the import script exits cleanly', first.code === 0, `exit ${first.code}\n${out1.slice(-500)}`);
  check('it reports the account it signed in as', out1.includes('Ms Jones — teacher'));

  const after = await listAnnouncements();
  check('every post in the archive was written',
    after.length === archive.length, `${after.length} of ${archive.length}`);
  check(`it says it imported ${archive.length}`, new RegExp(`imported\\s+${archive.length}`).test(out1));

  /* ---- 2. the writes are correct ----------------------------------------- */
  const byTitle = new Map(after.map((d) => [d.fields.title.stringValue, d]));

  const expo = byTitle.get('Community Connect Expo');
  check('a post kept its original author',
    expo?.fields.authorName?.stringValue === 'Rachel Visser',
    expo?.fields.authorName?.stringValue);
  check('a post is marked as imported',
    expo?.fields.importedFrom?.stringValue === 'Google Classroom');
  check('archived comments came across',
    expo?.fields.importedComments?.arrayValue?.values?.length === 10,
    String(expo?.fields.importedComments?.arrayValue?.values?.length));

  // The single most important property: an import must not email 50 students.
  const notified = after.filter((d) => d.fields.notify?.booleanValue === true);
  check('NOTHING is flagged for notification', notified.length === 0,
    `${notified.length} posts would have emailed the roster`);

  const dated = after.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.fields.date?.stringValue || ''));
  check('every post kept its original date', dated.length === archive.length);

  /* ---- 3. running it twice is safe --------------------------------------- */
  const second = await importCli(['--email', TEACHER]);
  const out2 = strip(second.out);
  check('a second run exits cleanly', second.code === 0, `exit ${second.code}`);
  check('a second run skips everything',
    new RegExp(`already there\\s+${archive.length}`).test(out2), out2.slice(-300));

  const afterTwice = await listAnnouncements();
  check('a second run creates no duplicates',
    afterTwice.length === archive.length, `${afterTwice.length} posts after two runs`);

  /* ---- 4. a student is refused ------------------------------------------- */
  await reset();
  const studentUid = await makeAccount(STUDENT);
  await seedProfile(studentUid, STUDENT, 'John Smith', 'student');

  const asStudent = await importCli(['--email', STUDENT]);
  const out4 = strip(asStudent.out);
  check('a student cannot import', asStudent.code !== 0, `exit ${asStudent.code}`);
  check('it explains why', /only teachers can post/i.test(out4), out4.slice(-200));
  check('and it wrote nothing', (await listAnnouncements()).length === 0);

  /* ---- 5. a wrong password is refused ------------------------------------ */
  const badPass = await importCli(['--email', STUDENT], { SRC_IMPORT_PASSWORD: 'wrong-password' });
  const out5 = strip(badPass.out);
  check('a wrong password is refused', badPass.code !== 0);
  check('and it says so in plain words', /Wrong email or password/.test(out5), out5.slice(-200));

  /* ---- 6. a bad file is refused before signing in ------------------------ */
  const badFile = await importCli(['--email', TEACHER, '--file', 'package.json']);
  const out6 = strip(badFile.out);
  check('a file that is not a post array is refused', badFile.code !== 0);
  check('it names the problem', /array of posts/i.test(out6), out6.slice(-200));
  check('it refuses BEFORE asking for a password', !out6.includes('Signing in'));

  /* ---- 6b. signing in with an emailed link, no password at all ----------- */
  // The app signs people in with links by default, so requiring a password
  // here would mean setting one just to run an import.
  await reset();
  const linkUid = await makeAccount(TEACHER);
  await seedProfile(linkUid, TEACHER, 'Ms Jones', 'teacher');

  const viaLink = await importViaLink(TEACHER);
  const out6b = strip(viaLink.out);
  check('a pasted sign-in link works with no password',
    viaLink.code === 0, `exit ${viaLink.code}\n${out6b.slice(-600)}`);
  check('link mode imports the whole archive',
    (await listAnnouncements()).length === archive.length);
  check('link mode tells you to copy rather than open the link',
    /COPY the link/i.test(out6b));

  // A link that has already been used must not quietly half-work.
  const reused = await importCli(['--email', TEACHER, '--link'],
    { SRC_IMPORT_PASSWORD: '', SRC_IMPORT_LINK: viaLink.usedLink });
  const out6c = strip(reused.out);
  check('a spent link is refused with an explanation',
    reused.code !== 0 && /expired or was already used/i.test(out6c), out6c.slice(-300));

  const notALink = await importCli(['--email', TEACHER, '--link'],
    { SRC_IMPORT_PASSWORD: '', SRC_IMPORT_LINK: 'https://example.com/nope' });
  check('pasting something that is not a link is refused',
    notALink.code !== 0 && /does not look like a sign-in link/i.test(strip(notALink.out)));

  /* ---- 6d. working out which project to use ------------------------------ */
  // `firebase use <id>` writes to firebase-tools' own config, not .firebaserc,
  // so the script must look in both — and must never silently target the
  // emulator placeholder when asked to write to a real project.
  const rcPath = new URL('../.firebaserc', import.meta.url).pathname;
  const rcBefore = readFileSync(rcPath, 'utf8');
  try {
    writeFileSync(rcPath, JSON.stringify({ projects: { default: 'demo-src' } }));
    const noProject = await run(process.execPath, ['scripts/import-classroom.mjs', '--dry-run'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HOME: '/nonexistent-home-for-this-test' },
    }).then(() => ({ code: 0, out: '' }), (e) => ({ code: e.code ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }));
    check('demo-src is not accepted as a real project',
      noProject.code !== 0, `exit ${noProject.code}`);
    check('and it says exactly how to pass one',
      /--project your-project-id/.test(strip(noProject.out)), strip(noProject.out).slice(-200));

    writeFileSync(rcPath, JSON.stringify({ projects: { default: 'src-uhs' } }));
    const fromRc = await run(process.execPath, ['scripts/import-classroom.mjs', '--dry-run'], {
      cwd: new URL('..', import.meta.url).pathname,
    });
    check('a real .firebaserc default is picked up',
      /project src-uhs/.test(strip(fromRc.stdout)), strip(fromRc.stdout).slice(0, 200));
  } finally {
    writeFileSync(rcPath, rcBefore);
  }

  /* ---- 7. dry run writes nothing ---------------------------------------- */
  await reset();
  const teacher2 = await makeAccount(TEACHER);
  await seedProfile(teacher2, TEACHER, 'Ms Jones', 'teacher');
  const dry = await importCli(['--email', TEACHER, '--dry-run']);
  check('--dry-run exits cleanly', dry.code === 0);
  check('--dry-run writes nothing', (await listAnnouncements()).length === 0);
  check('--dry-run says so', /nothing was written/i.test(strip(dry.out)));
} catch (e) {
  fail++;
  results.push(`  FAIL  harness threw — ${e.message}`);
}

console.log('\n--- import CLI ---');
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
