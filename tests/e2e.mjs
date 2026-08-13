/**
 * End-to-end test against the Firebase emulators, driving the real UI in
 * Chromium. This exercises the actual passwordless email-link flow by reading
 * the sign-in code out of the Auth emulator, exactly as a student's mail
 * client would deliver it.
 *
 * Prereq: npm run emul   (auth + firestore + hosting on 5000/8080/9099)
 * Run:    node tests/e2e.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = 'http://127.0.0.1:5000';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-src/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099';
const SHOTS = '/tmp/claude-0/-home-user-SRC/342cf67d-7082-5bd2-aa65-f3ca8d5d6ca1/scratchpad/shots';
mkdirSync(SHOTS, { recursive: true });

const TEACHER = 'ms.jones@education.nsw.gov.au';
const STUDENT = 'john.smith2@education.nsw.gov.au';
const STUDENT2 = 'sarah.lee14@education.nsw.gov.au';

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ---- emulator helpers ---------------------------------------------------- */

async function seedRoster(email, role) {
  const r = await fetch(`${FS}/roster/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        email: { stringValue: email },
        role: { stringValue: role },
        invitedAt: { integerValue: '1' },
      },
    }),
  });
  if (!r.ok) throw new Error(`seed roster failed: ${r.status} ${await r.text()}`);
}

async function clearFirestore() {
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-src/databases/(default)/documents',
    { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
}
async function clearAuth() {
  await fetch(`${AUTH}/emulator/v1/projects/demo-src/accounts`,
    { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
}

/** Pull the most recent sign-in link the Auth emulator "sent" to an address. */
async function latestSignInLink(email) {
  const r = await fetch(`${AUTH}/emulator/v1/projects/demo-src/oobCodes`);
  const { oobCodes = [] } = await r.json();
  const mine = oobCodes.filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN');
  if (!mine.length) throw new Error(`no sign-in code for ${email}`);
  const code = mine[mine.length - 1];
  // Reproduce what the real action handler does: redirect to continueUrl with
  // the mode/oobCode params appended.
  return `${APP}/?signin=1&mode=signIn&oobCode=${encodeURIComponent(code.oobCode)}&apiKey=fake-api-key`;
}

/** Full magic-link sign-in for `email`, ending on the onboarding or feed page. */
async function signInViaLink(page, email) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 20000 });
  await page.fill('#email', email);
  await page.click('#sendBtn');
  await page.waitForSelector('text=Check your email', { timeout: 15000 });
  const link = await latestSignInLink(email);
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
}

/**
 * Toggle a .switch by clicking its label. The real <input> is visually hidden
 * (opacity:0) so it stays keyboard- and screen-reader-accessible while the
 * styled track is what users actually see and tap.
 */
async function toggle(page, id, want) {
  const cur = await page.isChecked(id);
  if (cur !== want) {
    await page.click(`label.switch:has(${id})`);
    await page.waitForTimeout(150);
  }
  const now = await page.isChecked(id);
  if (now !== want) throw new Error(`could not set ${id} to ${want}`);
}

async function onboard(page, name, year) {
  await page.waitForSelector('#onbForm', { timeout: 15000 });
  await page.fill('#nm', name);
  await page.selectOption('#yr', year);
  await page.click('#onbGo');
  await page.waitForTimeout(1800);
}

/* ---- the run ------------------------------------------------------------- */

// Use the Chromium already present in this environment rather than
// downloading one (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set here).
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const errors = [];

async function newPage(mobile = true) {
  const ctx = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}
  );
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return page;
}

try {
  await clearFirestore();
  await clearAuth();
  await seedRoster(TEACHER, 'teacher');
  await seedRoster(STUDENT, 'student');
  await seedRoster(STUDENT2, 'student');

  /* ---- 1. signed-out state ---------------------------------------------- */
  const anon = await newPage();
  await anon.goto(APP, { waitUntil: 'domcontentloaded' });
  await anon.waitForSelector('#linkForm', { timeout: 20000 });
  check('sign-in screen renders', await anon.isVisible('#linkForm'));
  check('no content visible while signed out',
    !(await anon.isVisible('text=Announcements')));
  await anon.screenshot({ path: `${SHOTS}/01-signin.png` });

  // The domain-append hint is a spec requirement; verify it live.
  await anon.fill('#email', 'john.smith2');
  await anon.waitForTimeout(200);
  const hint = await anon.textContent('#emailHint');
  check('bare name previews the full school address',
    hint.includes('john.smith2@education.nsw.gov.au'), hint);
  await anon.screenshot({ path: `${SHOTS}/02-email-hint.png` });

  /* ---- 2. teacher signs in via magic link -------------------------------- */
  const t = await newPage();
  await signInViaLink(t, TEACHER);
  check('teacher reached onboarding after email link', await t.isVisible('#onbForm'));
  const warn = await t.textContent('.note.warn').catch(() => '');
  check('real-name warning is shown at onboarding',
    warn.includes('real name') && warn.includes('fake name'), warn.slice(0, 80));
  await t.screenshot({ path: `${SHOTS}/03-onboarding.png` });

  await onboard(t, 'Ms Jones', 'Staff');
  check('teacher sees the Admin tab', await t.isVisible('[data-route="admin"]'));

  /* ---- 3. teacher posts an announcement with a form ---------------------- */
  await t.click('#newPost');
  await t.waitForSelector('#cTitle');
  await t.fill('#cTitle', 'SRC meeting moved to Thursday');
  await t.fill('#cBody', 'Bring your **ideas**.\n\n- Fundraiser\n- Uniform survey\n\nDetails: [the plan](https://example.com/plan)');
  await toggle(t, '#cAttach', true);
  await t.waitForSelector('#fbTitle');
  await t.fill('#fbTitle', 'Are you coming?');
  await t.fill('.fieldcard [data-label]', 'Will you attend?');
  await t.selectOption('.fieldcard select', 'yesno');
  await t.waitForTimeout(300);
  await t.click('#fbAdd');
  await t.waitForTimeout(300);
  const cards = await t.$$('.fieldcard');
  await cards[1].$eval('[data-label]', (e) => { e.value = 'Any dietary needs?'; e.dispatchEvent(new Event('input')); });
  await t.screenshot({ path: `${SHOTS}/04-composer.png`, fullPage: true });
  await t.click('#cSave');
  await t.waitForTimeout(2500);
  check('announcement appears in the feed',
    await t.isVisible('text=SRC meeting moved to Thursday'));
  check('markdown bold rendered', await t.isVisible('.body strong'));
  check('markdown list rendered', await t.isVisible('.body ul li'));
  check('markdown link rendered', await t.isVisible('.body a[href="https://example.com/plan"]'));
  await t.screenshot({ path: `${SHOTS}/05-feed-teacher.png`, fullPage: true });

  // Teacher controls sit behind the Manage toggle so the card stays readable.
  check('teacher management controls are collapsed by default',
    !(await t.isVisible('button:has-text("Delete")')));
  await t.click('button:has-text("Manage")');
  await t.waitForTimeout(300);
  check('Manage reveals edit/pin/close/delete',
    await t.isVisible('button:has-text("Edit")')
    && await t.isVisible('button:has-text("Pin")')
    && await t.isVisible('button:has-text("Delete")'));
  await t.click('button:has-text("Manage")');
  await t.waitForTimeout(200);

  /* ---- 4. teacher adds a student with the chip input --------------------- */
  await t.click('[data-route="admin"]');
  await t.waitForSelector('#chipMount input');
  await t.click('#chipMount input');
  await t.type('#chipMount input', 'peter.nguyen3,');
  await t.waitForTimeout(300);
  const chip1 = await t.textContent('.chip .txt');
  check('typing a bare name + comma makes a full-address chip',
    chip1 === 'peter.nguyen3@education.nsw.gov.au', chip1);

  // Paste a mixed list, including an already-complete address.
  await t.evaluate(() => {
    const input = document.querySelector('#chipMount input');
    const dt = new DataTransfer();
    dt.setData('text', 'amy.wong, ben.hall9@education.nsw.gov.au\nchris.day; peter.nguyen3');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await t.waitForTimeout(300);
  const chipTexts = await t.$$eval('.chip .txt', (ns) => ns.map((n) => n.textContent));
  check('paste splits on comma/semicolon/newline',
    chipTexts.includes('amy.wong@education.nsw.gov.au')
    && chipTexts.includes('chris.day@education.nsw.gov.au'), chipTexts.join('|'));
  check('full address in paste is not double-domained',
    chipTexts.includes('ben.hall9@education.nsw.gov.au')
    && !chipTexts.some((c) => (c.match(/@/g) || []).length > 1), chipTexts.join('|'));
  check('duplicate in the same paste is dropped silently',
    chipTexts.filter((c) => c === 'peter.nguyen3@education.nsw.gov.au').length === 1);
  await t.screenshot({ path: `${SHOTS}/06-chips.png`, fullPage: true });

  // Add them without sending invites (no Brevo key in the emulator).
  await toggle(t, '#sendInvite', false);
  await t.click('#addBtn');
  await t.waitForTimeout(2000);
  check('roster shows the invited students',
    await t.isVisible('text=amy.wong@education.nsw.gov.au'));
  check('roster distinguishes signed-in from not-yet',
    await t.isVisible('text=Not yet'));
  await t.screenshot({ path: `${SHOTS}/07-roster.png`, fullPage: true });

  /* ---- 5. student signs in, comments, submits the form ------------------- */
  const s = await newPage();
  await signInViaLink(s, STUDENT);
  await onboard(s, 'John Smith', 'Year 10');
  check('student sees the announcement',
    await s.isVisible('text=SRC meeting moved to Thursday'));
  check('student does NOT see the Admin tab',
    !(await s.isVisible('[data-route="admin"]')));
  check('student sees no New announcement button',
    !(await s.isVisible('#newPost')));

  // Inline form
  await s.waitForSelector('.src-form', { timeout: 10000 });
  check('form renders inline under the announcement', await s.isVisible('.src-form'));
  await s.check('.src-form input[type=radio][value="Yes"]');
  await s.fill('.src-form input[type=text]', 'Vegetarian');
  await s.screenshot({ path: `${SHOTS}/08-student-form.png`, fullPage: true });
  await s.click('.src-form button[type=submit]');
  await s.waitForTimeout(2000);
  check('student sees a submitted confirmation', await s.isVisible('text=Submitted'));
  check('student sees what they submitted', await s.isVisible('text=Vegetarian'));

  // Comments
  await s.click('button:has-text("Comments")');
  await s.waitForSelector('#ctext');
  await s.fill('#ctext', 'Sounds good, I can help set up.');
  await s.click('.comment, form button:has-text("Post")');
  await s.waitForTimeout(1800);
  check('comment posted and shown with the real name',
    await s.isVisible('text=Sounds good, I can help set up.'));
  const who = await s.textContent('.comment .who').catch(() => '');
  check('comment attributed to the student\'s real name', who === 'John Smith', who);
  await s.screenshot({ path: `${SHOTS}/09-student-comment.png`, fullPage: true });

  /* ---- 6. a second student cannot see the first one's response ----------- */
  const s2 = await newPage();
  await signInViaLink(s2, STUDENT2);
  await onboard(s2, 'Sarah Lee', 'Year 11');
  await s2.waitForSelector('.src-form', { timeout: 10000 });
  const leak = await s2.evaluate(() => document.body.innerText.includes('Vegetarian'));
  check('second student cannot see the first student\'s answer in the UI', !leak);

  // And prove it at the data layer, not just the UI.
  const denied = await s2.evaluate(async () => {
    const { db, collection, getDocs, getDocs: g } = await import('/js/fb.js');
    const { doc, getDoc } = await import('/vendor/firebase.js');
    const out = {};
    try {
      const forms = await getDocs(collection(db, 'forms'));
      const formId = forms.docs[0]?.id;
      out.formId = formId;
      try {
        await getDocs(collection(db, 'forms', formId, 'responses'));
        out.listResponses = 'ALLOWED';
      } catch (e) { out.listResponses = e.code; }
      try {
        await getDocs(collection(db, 'roster'));
        out.listRoster = 'ALLOWED';
      } catch (e) { out.listRoster = e.code; }
      try {
        await getDocs(collection(db, 'users'));
        out.listUsers = 'ALLOWED';
      } catch (e) { out.listUsers = e.code; }
    } catch (e) { out.error = String(e); }
    return out;
  });
  check('student list of form responses is denied in the browser',
    denied.listResponses === 'permission-denied', JSON.stringify(denied));
  check('student list of roster is denied in the browser',
    denied.listRoster === 'permission-denied', JSON.stringify(denied));
  check('student list of users is denied in the browser',
    denied.listUsers === 'permission-denied', JSON.stringify(denied));

  /* ---- 7. teacher sees responses + CSV ----------------------------------- */
  await t.click('[data-route="feed"]');
  await t.waitForTimeout(1500);
  await t.click('button:has-text("Responses")');
  await t.waitForTimeout(2000);
  check('teacher sees the student response', await t.isVisible('text=Vegetarian'));
  check('teacher sees a response count', await t.isVisible('text=/responded/'));
  await t.screenshot({ path: `${SHOTS}/10-responses.png`, fullPage: true });

  const csv = await t.evaluate(async () => {
    const { buildCsv } = await import('/js/forms.js');
    const { db } = await import('/js/fb.js');
    const { collection, getDocs, doc, getDoc } = await import('/vendor/firebase.js');
    const forms = await getDocs(collection(db, 'forms'));
    const fd = forms.docs[0];
    const rs = await getDocs(collection(db, 'forms', fd.id, 'responses'));
    return buildCsv(fd.data(), rs.docs.map((d) => d.data()));
  });
  check('CSV contains a header and the answer',
    csv.includes('Name') && csv.includes('Vegetarian'), csv.slice(0, 120));

  /* ---- 8. teacher moderation + closing comments -------------------------- */
  await t.click('button:has-text("Comments")');
  await t.waitForTimeout(1200);
  check('teacher can see the student comment', await t.isVisible('text=Sounds good'));
  check('teacher gets a delete control on a student comment',
    await t.isVisible('.comment button:has-text("Delete")'));

  /* ---- 9. dark mode ------------------------------------------------------ */
  const dark = await newPage();
  await dark.emulateMedia({ colorScheme: 'dark' });
  await dark.goto(APP, { waitUntil: 'domcontentloaded' });
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark mode paints a dark background', bg === 'rgb(6, 19, 16)', bg);
  await dark.screenshot({ path: `${SHOTS}/11-dark-signin.png` });

  const darkFeed = await newPage();
  await darkFeed.emulateMedia({ colorScheme: 'dark' });
  await signInViaLink(darkFeed, STUDENT);
  await darkFeed.waitForTimeout(2000);
  await darkFeed.screenshot({ path: `${SHOTS}/12-dark-feed.png`, fullPage: true });

  /* ---- 10. no horizontal scroll on a phone ------------------------------- */
  const overflow = await s.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal overflow at 390px', overflow <= 1, `overflow=${overflow}px`);

} catch (e) {
  fail++;
  results.push(`  FAIL  harness threw — ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
}

console.log('\n=== E2E results ===');
console.log(results.join('\n'));
if (errors.length) {
  console.log('\n--- browser errors ---');
  console.log([...new Set(errors)].slice(0, 25).join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
