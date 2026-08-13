// Sign-in, first-run onboarding, and the "not on the roster" path.
//
// Default is passwordless email-link. Passwords exist only as an opt-in for
// staff who prefer them, and are never required of anyone.

import {
  auth, db,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updatePassword,
  doc, getDoc, setDoc, serverTimestamp,
} from './fb.js';
import { esc, h, $, toast, busy, friendlyError, modal, logoSvg } from './ui.js';
import { normaliseEmail } from './emails.js';

const PENDING_EMAIL_KEY = 'src.pendingEmail';

function actionCodeSettings() {
  return {
    // Land back on the site itself. Deliberately NOT a mailto: anything —
    // this is a normal https link into the app.
    url: `${location.origin}/?signin=1`,
    handleCodeInApp: true,
  };
}

/* ---- sign-in screen ------------------------------------------------------ */

export function renderSignIn(mountEl) {
  mountEl.replaceChildren(h(`
    <div class="wrap">
      <div class="auth-hero">
        <div class="hero-logo">${logoSvg(56)}</div>
        <h1>Student Representative Council</h1>
        <p>Sign in with your school email. No password needed — we'll email you a link.</p>
      </div>

      <div class="card">
        <form id="linkForm" novalidate>
          <label class="field">
            <span class="lbl">School email</span>
            <input type="email" id="email" inputmode="email" autocomplete="email"
                   autocapitalize="none" spellcheck="false"
                   placeholder="john.smith@education.nsw.gov.au" required>
            <span class="help" id="emailHint">Type just <strong>john.smith</strong> and we'll add
              <strong>@education.nsw.gov.au</strong> for you.</span>
          </label>
          <button class="btn block" type="submit" id="sendBtn">Email me a sign-in link</button>
        </form>

        <hr class="divider">
        <details id="pwDetails">
          <summary class="small muted" style="cursor:pointer">Staff: sign in with a password instead</summary>
          <form id="pwForm" style="margin-top:12px" novalidate>
            <label class="field">
              <span class="lbl">Email</span>
              <input type="email" id="pwEmail" inputmode="email" autocomplete="email"
                     autocapitalize="none" spellcheck="false">
            </label>
            <label class="field">
              <span class="lbl">Password</span>
              <input type="password" id="pwPass" autocomplete="current-password">
            </label>
            <button class="btn ghost block" type="submit">Sign in with password</button>
            <p class="small muted" style="margin:10px 0 0">
              Passwords are optional. You can set one from Settings after signing in with a link.
            </p>
          </form>
        </details>
      </div>

      <p class="small muted center" style="margin-top:18px">
        Can't find the email? Check your junk or spam folder — and tell your SRC teacher,
        because the school mail filter may need to allow our sender.
      </p>
    </div>
  `));

  const emailInput = $('#email', mountEl);
  const hint = $('#emailHint', mountEl);

  // Live preview of what we'll actually send to, so a mistake is visible early.
  emailInput.addEventListener('input', () => {
    const v = emailInput.value.trim();
    if (!v) {
      hint.innerHTML = 'Type just <strong>john.smith</strong> and we\'ll add <strong>@education.nsw.gov.au</strong> for you.';
      return;
    }
    const r = normaliseEmail(v);
    hint.innerHTML = r.valid
      ? `We'll send the link to <strong>${esc(r.email)}</strong>`
      : `<span style="color:var(--danger)">That doesn't look like a valid address yet.</span>`;
  });

  $('#linkForm', mountEl).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#sendBtn', mountEl);
    const r = normaliseEmail(emailInput.value);
    if (!r.valid) { toast('Check the email address.', true); emailInput.focus(); return; }

    busy(btn, true, 'Sending…');
    try {
      await sendSignInLinkToEmail(auth, r.email, actionCodeSettings());
      localStorage.setItem(PENDING_EMAIL_KEY, r.email);
      showLinkSent(mountEl, r.email);
    } catch (err) {
      console.error(err);
      toast(friendlyError(err), true);
      busy(btn, false);
    }
  });

  $('#pwForm', mountEl).addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = normaliseEmail($('#pwEmail', mountEl).value).email;
    const pass = $('#pwPass', mountEl).value;
    if (!email || !pass) { toast('Enter your email and password.', true); return; }
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (err) {
      toast(friendlyError(err), true);
    }
  });
}

function showLinkSent(mountEl, email) {
  mountEl.replaceChildren(h(`
    <div class="wrap">
      <div class="auth-hero">
        <div class="logo-mark">✓</div>
        <h1>Check your email</h1>
        <p>We sent a sign-in link to <strong>${esc(email)}</strong>. Open it on this device.</p>
      </div>
      <div class="note warn">
        <strong>Not there after a minute?</strong> Look in your junk/spam folder. School mail
        filters sometimes hold messages from new senders. If it isn't there either, tell your
        SRC teacher so they can get the sender allowed.
      </div>
      <button class="btn ghost block" id="back">Use a different email</button>
    </div>
  `));
  $('#back', mountEl).onclick = () => renderSignIn(mountEl);
}

/* ---- completing an email-link sign-in ------------------------------------ */

/** Returns true if the current URL was an email sign-in link we consumed. */
export async function completeEmailLinkIfPresent() {
  if (!isSignInWithEmailLink(auth, location.href)) return false;

  let email = localStorage.getItem(PENDING_EMAIL_KEY);
  if (!email) {
    // Link opened on a different device/browser than it was requested from.
    email = await askForEmail();
    if (!email) return false;
  }

  try {
    await signInWithEmailLink(auth, email, location.href);
    localStorage.removeItem(PENDING_EMAIL_KEY);
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    // Always strip the credential out of the address bar.
    history.replaceState({}, '', location.pathname);
  }
  return true;
}

function askForEmail() {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(`
      <h2>Confirm your email</h2>
      <p class="muted">You opened the link on a different device, so we need your address again
        to finish signing in.</p>
      <label class="field">
        <span class="lbl">School email</span>
        <input type="email" id="cEmail" inputmode="email" autocapitalize="none" spellcheck="false">
      </label>
      <button class="btn block" id="cGo">Continue</button>
    `, { onClose: () => { if (!done) resolve(null); } });
    const go = () => {
      const r = normaliseEmail(m.root.querySelector('#cEmail').value);
      if (!r.valid) { toast('Check the email address.', true); return; }
      done = true; m.close(); resolve(r.email);
    };
    m.root.querySelector('#cGo').onclick = go;
    m.root.querySelector('#cEmail').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
  });
}

/* ---- first-run onboarding ------------------------------------------------ */

/**
 * Load the signed-in user's profile, creating it on first sign-in.
 * Returns { profile } or { blocked: 'not-on-roster' }.
 */
export async function loadOrCreateProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return { profile: { id: user.uid, ...snap.data() } };
  return { needsOnboarding: true };
}

/**
 * Ask for real name + year/roll class, then attempt to create the profile.
 * The create is rejected by rules unless the address is on the roster, which
 * is how we detect the not-invited case without letting students read it.
 */
export function renderOnboarding(mountEl, user, onDone) {
  const email = (user.email || '').toLowerCase();

  mountEl.replaceChildren(h(`
    <div class="wrap">
      <div class="auth-hero">
        <div class="hero-logo">${logoSvg(56)}</div>
        <h1>One quick thing</h1>
        <p>Signed in as <strong>${esc(email)}</strong></p>
      </div>
      <div class="card">
        <div class="note warn">
          <strong>Use your real name.</strong> Teachers can see who wrote every comment, and
          anything posted under a fake name gets removed.
        </div>
        <form id="onbForm" novalidate>
          <label class="field">
            <span class="lbl">Your full name <span class="req">*</span></span>
            <input type="text" id="nm" autocomplete="name" placeholder="John Smith" required>
          </label>
          <label class="field">
            <span class="lbl">Year <span class="req">*</span></span>
            <select id="yr" required>
              <option value="">Choose…</option>
              ${[7, 8, 9, 10, 11, 12].map((y) => `<option value="Year ${y}">Year ${y}</option>`).join('')}
              <option value="Staff">Staff</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl">Roll class <span class="muted small">(optional)</span></span>
            <input type="text" id="rc" placeholder="10B" maxlength="12">
          </label>
          <button class="btn block" type="submit" id="onbGo">Continue</button>
        </form>
      </div>
    </div>
  `));

  $('#onbForm', mountEl).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#onbGo', mountEl);
    const name = $('#nm', mountEl).value.trim().replace(/\s+/g, ' ');
    const year = $('#yr', mountEl).value;
    const roll = $('#rc', mountEl).value.trim();

    if (name.length < 2) { toast('Enter your full name.', true); return; }
    if (!/[a-z]/i.test(name)) { toast('Enter your real name.', true); return; }
    if (!year) { toast('Choose your year.', true); return; }

    const yearClass = roll ? `${year} · ${roll}` : year;

    busy(btn, true, 'Setting up…');
    try {
      // role is read from the roster by the rules; we send what the roster says
      // by trying 'student' first and falling back to 'teacher'. A student
      // cannot benefit from this: the rules compare against the roster row.
      await createProfile(user, email, name, yearClass);
      onDone();
    } catch (err) {
      busy(btn, false);
      if (err?.code === 'permission-denied') {
        renderNotOnRoster(mountEl, user, name, yearClass);
      } else {
        console.error(err);
        toast(friendlyError(err), true);
      }
    }
  });
}

async function createProfile(user, email, name, yearClass) {
  const ref = doc(db, 'users', user.uid);
  const base = { email, name, yearClass, createdAt: serverTimestamp() };

  // The rules require role to equal the roster row's role. We don't know it
  // (students can't read the roster), so try student then teacher. Both are
  // validated server-side, so guessing gains an attacker nothing.
  try {
    await setDoc(ref, { ...base, role: 'student' });
  } catch (e) {
    if (e?.code !== 'permission-denied') throw e;
    await setDoc(ref, { ...base, role: 'teacher' });
  }
}

/* ---- not on the roster --------------------------------------------------- */

function renderNotOnRoster(mountEl, user, name, yearClass) {
  const email = (user.email || '').toLowerCase();
  mountEl.replaceChildren(h(`
    <div class="wrap">
      <div class="auth-hero">
        <div class="logo-mark">?</div>
        <h1>You're not on the roster yet</h1>
        <p><strong>${esc(email)}</strong> hasn't been added by an SRC teacher.</p>
      </div>
      <div class="card">
        <p>Ask your SRC teacher to add you, or send a request now and they'll see it in their
           admin panel.</p>
        <button class="btn block" id="reqBtn">Request access</button>
        <button class="btn ghost block" id="outBtn" style="margin-top:10px">Sign out</button>
      </div>
    </div>
  `));

  $('#reqBtn', mountEl).onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Sending…');
    try {
      await setDoc(doc(db, 'accessRequests', email), {
        email, name, yearClass, requestedAt: serverTimestamp(),
      });
      btn.replaceWith(h(`<div class="note"><strong>Request sent.</strong> Your SRC teacher will
        see it. You'll be able to sign in once they add you.</div>`));
    } catch (err) {
      busy(btn, false);
      toast(friendlyError(err), true);
    }
  };
  $('#outBtn', mountEl).onclick = () => import('./fb.js').then((m) => m.signOut(m.auth));
}

/* ---- optional password for staff ----------------------------------------- */

export function openSetPassword() {
  const m = modal(`
    <h2>Set a password</h2>
    <p class="muted">Optional. You can always keep using the emailed link instead.</p>
    <label class="field">
      <span class="lbl">New password</span>
      <input type="password" id="p1" autocomplete="new-password" minlength="6">
      <span class="help">At least 6 characters.</span>
    </label>
    <label class="field">
      <span class="lbl">Repeat it</span>
      <input type="password" id="p2" autocomplete="new-password">
    </label>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn ghost" id="pCancel">Cancel</button>
      <button class="btn" id="pSave">Save password</button>
    </div>
  `);
  m.root.querySelector('#pCancel').onclick = m.close;
  m.root.querySelector('#pSave').onclick = async (e) => {
    const p1 = m.root.querySelector('#p1').value;
    const p2 = m.root.querySelector('#p2').value;
    if (p1.length < 6) { toast('Use at least 6 characters.', true); return; }
    if (p1 !== p2) { toast("Those two passwords don't match.", true); return; }
    busy(e.currentTarget, true, 'Saving…');
    try {
      await updatePassword(auth.currentUser, p1);
      m.close();
      toast('Password set. You can still use the email link too.');
    } catch (err) {
      busy(e.currentTarget, false);
      // Firebase requires a recent sign-in for this.
      if (err?.code === 'auth/requires-recent-login') {
        toast('For security, sign in again with a fresh email link, then set the password.', true);
      } else {
        toast(friendlyError(err), true);
      }
    }
  };
}
