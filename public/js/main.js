// App shell: auth state, nav, routing.

import { auth, db, onAuthStateChanged, signOut, doc, getDoc } from './fb.js';
import { esc, h, $, toast, friendlyError, modal, logoSvg } from './ui.js';
import { state, isTeacher } from './state.js';
import {
  renderSignIn, completeEmailLinkIfPresent, renderOnboarding,
  loadOrCreateProfile, openSetPassword,
} from './auth.js';
import { renderFeed, stopFeed } from './feed.js';
import { renderAdmin } from './admin.js';
import { renderEvents } from './events.js';

const appEl = $('#app');

/* ---- theme --------------------------------------------------------------- */

const THEME_KEY = 'src.theme';
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
}
applyTheme(localStorage.getItem(THEME_KEY) || 'system');

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = localStorage.getItem(THEME_KEY) || 'system';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
}

/* ---- routing ------------------------------------------------------------- */

const ROUTES = { feed: 'Announcements', events: 'Events', admin: 'Admin' };

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '') || 'feed';
  if (r === 'admin' && !isTeacher()) return 'feed';
  return ROUTES[r] ? r : 'feed';
}

function shell() {
  const route = currentRoute();
  const wrap = h(`
    <div>
      <header class="topbar">
        <div class="topbar-in">
          <a class="logo" href="#/feed">
            ${logoSvg(30)}
            <span>SRC</span>
          </a>
          <span class="spacer"></span>
          <button class="btn ghost sm" id="themeBtn" title="Change theme" aria-label="Change theme">◐</button>
          <button class="btn ghost sm" id="meBtn">${esc(firstName(state.profile.name))}</button>
        </div>
        <nav class="tabs" style="padding-bottom:8px">
          ${Object.entries(ROUTES)
            .filter(([k]) => k !== 'admin' || isTeacher())
            .map(([k, label]) => `<button class="tab" data-route="${k}"
              ${k === route ? 'aria-current="page"' : ''}>${esc(label)}</button>`).join('')}
        </nav>
      </header>
      <main id="view"></main>
    </div>
  `);

  wrap.querySelectorAll('[data-route]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.route}`; };
  });
  $('#themeBtn', wrap).onclick = cycleTheme;
  $('#meBtn', wrap).onclick = openMe;

  appEl.replaceChildren(wrap);
  const view = $('#view', wrap);

  stopFeed();
  if (route === 'admin') renderAdmin(view);
  else if (route === 'events') renderEvents(view);
  else renderFeed(view);
}

function firstName(n) { return String(n || 'Me').split(' ')[0]; }

function openMe() {
  const p = state.profile;
  const m = modal(`
    <h2>${esc(p.name)}</h2>
    <p class="muted small">${esc(p.email)}<br>${esc(p.yearClass || '')}
      ${p.role === 'teacher' ? '<span class="pill" style="margin-left:6px">Teacher</span>' : ''}</p>
    <hr class="divider">
    <div class="stack">
      <button class="btn ghost block" id="mPass">Set or change a password</button>
      <p class="small muted" style="margin:0">Optional — the emailed sign-in link always works.</p>
      <button class="btn danger block" id="mOut">Sign out</button>
    </div>
  `);
  m.root.querySelector('#mPass').onclick = () => { m.close(); openSetPassword(); };
  m.root.querySelector('#mOut').onclick = async () => {
    m.close();
    stopFeed();
    await signOut(auth);
  };
}

window.addEventListener('hashchange', () => { if (state.profile) shell(); });

/* ---- boot ---------------------------------------------------------------- */

function showSpinner() {
  appEl.replaceChildren(h('<div class="spinner" role="status" aria-label="Loading"></div>'));
}

async function boot() {
  showSpinner();

  // If this page load came from an emailed sign-in link, consume it first so
  // onAuthStateChanged fires with the signed-in user.
  try {
    await completeEmailLinkIfPresent();
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), true);
  }

  onAuthStateChanged(auth, async (user) => {
    stopFeed();
    state.user = user;
    state.profile = null;

    if (!user) { renderSignIn(appEl); return; }

    showSpinner();
    try {
      const res = await loadOrCreateProfile(user);
      if (res.needsOnboarding) {
        renderOnboarding(appEl, user, async () => {
          const again = await loadOrCreateProfile(user);
          if (again.profile) { state.profile = again.profile; shell(); }
        });
        return;
      }
      state.profile = res.profile;
      shell();
    } catch (e) {
      console.error(e);
      appEl.replaceChildren(h(`
        <div class="wrap"><div class="note bad" style="margin-top:40px">
          <strong>Couldn't load your account.</strong><br>${esc(friendlyError(e))}
        </div>
        <button class="btn ghost block" id="retryOut">Sign out</button></div>`));
      $('#retryOut', appEl).onclick = () => signOut(auth);
    }
  });
}

boot();
