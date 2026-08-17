#!/usr/bin/env node
/**
 * Import the Classroom archive into the live site from the command line.
 *
 *   npm run import
 *
 * WHY IT SIGNS IN AS YOU RATHER THAN USING A SERVICE ACCOUNT
 * A service-account key is a JSON file that grants full access to the whole
 * project and bypasses every security rule. Downloading one onto a laptop to
 * import a dozen posts is a bad trade. Instead this signs in with your normal
 * teacher account and writes through the ordinary client SDK, so every write is
 * checked by the same rules as the website. If the rules would stop the app
 * doing something, they stop this too.
 *
 * WHY IT IS SAFE TO RUN TWICE
 * Each post gets a document id derived from its date and title, and the script
 * skips ids that already exist. Re-running reports "already there" instead of
 * duplicating the feed.
 *
 * NOBODY IS EMAILED. Every post is written notify:false, so the notification
 * function records "skipped". Twelve posts would otherwise be twelve mailouts.
 *
 * Flags:
 *   --project <id>   Firebase project (default: from .firebaserc)
 *   --file <path>    JSON to import (default: docs/classroom-import.json)
 *   --dry-run        Validate and report, write nothing
 *   --emulator       Talk to the local emulators instead of the live project
 *   --email <addr>   Skip the email prompt
 *   --link           Sign in with an emailed link instead of a password
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, sendSignInLinkToEmail,
  signInWithEmailLink, isSignInWithEmailLink, connectAuthEmulator, signOut,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, serverTimestamp,
} from 'firebase/firestore';

import { parseImport } from '../public/js/import-parse.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[1;36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (s) => console.log(`\n${C.cyan(`==> ${s}`)}`);
const die = (s) => { console.error(`\n${C.red(s)}`); process.exit(1); };

/* ---- arguments ------------------------------------------------------------ */

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DRY = has('dry-run');
const EMU = has('emulator');
const FILE = resolve(root, arg('file', 'docs/classroom-import.json'));

/* ---- project id ----------------------------------------------------------- */

function projectFromRc() {
  try {
    // .firebaserc has no extension, so it must be read and JSON-parsed rather
    // than required — require() would treat it as JavaScript.
    return JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8')).projects?.default || null;
  } catch {
    return null;
  }
}

const PROJECT = arg('project', EMU ? 'demo-src' : projectFromRc());
if (!PROJECT) {
  die('No project. Pass --project <id>, or run scripts/deploy.sh once so .firebaserc exists.');
}
// A project id is never all digits — a number here would fetch config from the
// wrong host and silently do nothing.
if (/^\d+$/.test(PROJECT)) die(`"${PROJECT}" is a project number, not a project ID.`);

/* ---- firebase config ------------------------------------------------------ */

/**
 * Hosting serves the live config at /__/firebase/init.json, so there is no
 * config file to keep in sync and no keys committed to the repo.
 */
async function loadConfig() {
  if (EMU) {
    return {
      apiKey: 'fake-api-key',
      authDomain: `${PROJECT}.firebaseapp.com`,
      projectId: PROJECT,
    };
  }
  const url = `https://${PROJECT}.web.app/__/firebase/init.json`;
  const res = await fetch(url).catch((e) => {
    die(`Could not reach ${url}\n  ${e.message}\n  Is the site deployed?`);
  });
  if (!res.ok) die(`${url} returned ${res.status}. Is hosting deployed for ${PROJECT}?`);
  return res.json();
}

/* ---- prompts -------------------------------------------------------------- */

function ask(question, { hidden = false } = {}) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) {
      rl.question(question, (a) => { rl.close(); res(a.trim()); });
      return;
    }
    // Print the prompt, then swallow the echo so a password is not left sitting
    // in the scrollback of a shared screen.
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      res(a);
    });
  });
}

/* ---- deterministic ids ---------------------------------------------------- */

const slug = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60);

/** Stable per post, so a second run skips instead of duplicating. */
const idFor = (p) => `import-${p.date || 'undated'}-${slug(p.title) || 'post'}`;

/* ---- run ------------------------------------------------------------------ */

console.log(C.cyan('\nSRC — import announcements'));
console.log(C.dim(`  project ${PROJECT}${EMU ? ' (emulator)' : ''}`));
console.log(C.dim(`  file    ${FILE}`));

step('Reading the archive');

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch (e) {
  die(`Cannot read ${FILE}\n  ${e.message}`);
}

const { posts, errors } = parseImport(raw);
if (errors.length) {
  console.error(C.red(`\n${errors.length} problem(s) in ${FILE}:`));
  for (const e of errors) console.error(`  - ${e}`);
  die('Nothing was imported.');
}

const totalComments = posts.reduce((n, p) => n + p.comments.length, 0);
console.log(C.green(`${posts.length} posts, ${totalComments} archived comments, oldest first`));
for (const p of posts) {
  console.log(`  ${p.date || '(undated)'}  ${p.title}${
    p.comments.length ? C.dim(` — ${p.comments.length} comment${p.comments.length > 1 ? 's' : ''}`) : ''}`);
}

if (DRY) {
  console.log(C.yellow('\n--dry-run: nothing was written.'));
  process.exit(0);
}

step('Signing in');
console.log(C.dim('  Your own teacher account. Writes go through the normal security'));
console.log(C.dim('  rules, exactly as they would from the website.'));
console.log('');

const config = await loadConfig();
const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);

if (EMU) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const email = arg('email') || await ask('  Email: ');
if (!email) die('No email given.');

// Two ways in, because a password is not guaranteed to exist. The app signs
// people in with emailed links by default, so requiring a password here would
// mean setting one first just to run an import.
const envPassword = process.env.SRC_IMPORT_PASSWORD;
let mode = has('link') ? 'link' : (envPassword ? 'password' : null);

if (!mode) {
  console.log('');
  console.log('  1) Email me a sign-in link   (no password needed)');
  console.log('  2) I have a password');
  const pick = await ask('  Which? [1] ');
  mode = pick.trim() === '2' ? 'password' : 'link';
}

let user;

if (mode === 'password') {
  const password = envPassword || await ask('  Password: ', { hidden: true });
  if (!password) die('No password given.');
  try {
    ({ user } = await signInWithEmailAndPassword(auth, email, password));
  } catch (e) {
    const code = e?.code || '';
    if (/wrong-password|invalid-credential|user-not-found/.test(code)) {
      die('Wrong email or password.\n'
        + '  No password set? Re-run and choose option 1 — the emailed link needs no password.');
    }
    die(`Could not sign in: ${code || e.message}`);
  }
} else {
  const url = EMU ? 'http://127.0.0.1:5000/?signin=1' : `https://${PROJECT}.web.app/?signin=1`;
  try {
    await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
  } catch (e) {
    die(`Could not send the sign-in link: ${e?.code || e.message}`);
  }

  console.log(C.green(`\n  Sent a sign-in link to ${email}.`));
  console.log('');
  console.log(C.yellow('  COPY the link — do not open it.'));
  console.log(C.dim('  Right-click (or long-press) the button in the email and choose'));
  console.log(C.dim('  "Copy Link Address", then paste it below. Opening it in a browser'));
  console.log(C.dim('  uses the code up, and this needs to use it instead.'));
  console.log(C.dim('  Check your spam folder if it is not there in a minute.'));
  console.log('');

  const link = process.env.SRC_IMPORT_LINK || await ask('  Paste link: ');
  if (!link) die('Nothing pasted.');
  if (!isSignInWithEmailLink(auth, link)) {
    die('That does not look like a sign-in link.\n'
      + '  It should be a long URL containing "oobCode=".');
  }
  try {
    ({ user } = await signInWithEmailLink(auth, email, link));
  } catch (e) {
    const code = e?.code || '';
    if (/invalid-action-code|expired-action-code/.test(code)) {
      die('That link has expired or was already used.\n'
        + '  If you opened it in a browser, the code is spent — re-run and copy the\n'
        + '  link this time instead of opening it.');
    }
    die(`Could not sign in: ${code || e.message}`);
  }
}

console.log(C.green(`  signed in as ${user.email}`));

step('Checking your account');
const meSnap = await getDoc(doc(db, 'users', user.uid));
if (!meSnap.exists()) {
  die('That account has no profile yet. Open the site and finish signing in once first.');
}
const me = meSnap.data();
if (me.role !== 'teacher') {
  die(`${me.name} is a ${me.role}, and only teachers can post announcements.`);
}
console.log(C.green(`  ${me.name} — teacher`));

step(`Importing ${posts.length} posts`);

let created = 0;
let skipped = 0;
const failed = [];

for (const p of posts) {
  const id = idFor(p);
  const ref = doc(db, 'announcements', id);

  try {
    // Skip rather than overwrite. An update would have to leave createdAt
    // alone (the rules forbid changing it), and re-importing is far more
    // likely to be an accidental second run than a deliberate edit.
    if ((await getDoc(ref)).exists()) {
      skipped++;
      console.log(`  ${C.dim('already there')}  ${p.title}`);
      continue;
    }

    await setDoc(ref, {
      title: p.title,
      body: p.body,
      date: p.date || '',
      pinned: p.pinned,
      commentsOpen: p.commentsOpen,
      notify: false,                 // never email an import
      formId: null,
      authorUid: user.uid,           // the rules require this to be you
      authorName: p.authorName || me.name,
      importedFrom: 'Google Classroom',
      importedComments: p.comments,
      importedBy: me.name,
      createdAt: serverTimestamp(),
    });
    created++;
    console.log(`  ${C.green('imported')}      ${p.title}`);
  } catch (e) {
    failed.push({ title: p.title, error: e?.code || e?.message || String(e) });
    console.log(`  ${C.red('failed')}        ${p.title} — ${e?.code || e?.message}`);
  }
}

step('Done');
console.log(`  imported     ${created}`);
console.log(`  already there ${skipped}`);
if (failed.length) console.log(C.red(`  failed       ${failed.length}`));
console.log(C.dim('\n  No emails were sent — every post was written with notifications off.'));
if (!EMU) console.log(`  Open https://${PROJECT}.web.app to see them.\n`);

await signOut(auth).catch(() => {});
process.exit(failed.length ? 1 : 0);
