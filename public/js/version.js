// Which build is this page actually running?
//
// A deployed site looks identical whether it is serving today's code or last
// week's, which makes "is the fix live yet?" unanswerable. scripts/stamp-version.mjs
// writes public/version.json at deploy time; this module reads it back.

let loaded = null;

/** The build this page loaded with, or null if version.json was unavailable. */
export function currentVersion() { return loaded; }

async function fetchVersion() {
  try {
    // cache: 'no-store' — asking the network "what is deployed right now?" is
    // the entire point, so a cached answer is a wrong answer.
    const r = await fetch('/version.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Read the running build and log it. Never throws; never blocks boot. */
export async function initVersion() {
  loaded = await fetchVersion();
  if (loaded) {
    console.info(
      `SRC build ${loaded.sha}${loaded.dirty ? '+dirty' : ''} ` +
      `(${loaded.branch}) deployed ${loaded.builtAt} — ${loaded.subject}`
    );
  } else {
    console.info('SRC build: unknown (no version.json — running locally?)');
  }
  return loaded;
}

/** Human-readable one-liner for the account dialog. */
export function versionLabel() {
  if (!loaded) return 'Version unknown';
  const when = new Date(loaded.builtAt);
  const stamp = Number.isNaN(when.getTime())
    ? loaded.builtAt
    : when.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  return `Version ${loaded.sha}${loaded.dirty ? '+dirty' : ''} · updated ${stamp}`;
}

/**
 * Notice when a newer build has been deployed under a tab that is still open,
 * and hand it to `onNew`.
 *
 * Checked when the tab is brought back to the foreground, throttled to once
 * every five minutes. Deliberately NOT a setInterval: a timer firing forever
 * in every open tab is exactly the kind of unbounded background work that
 * quietly runs up a bill. This costs one ~200-byte conditional GET against
 * Hosting, which is a 304 with an empty body whenever nothing has changed.
 */
export function watchForUpdate(onNew) {
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (Date.now() - lastCheck < 5 * 60 * 1000) return;
    lastCheck = Date.now();

    const fresh = await fetchVersion();
    if (fresh && loaded && fresh.sha !== loaded.sha) onNew(fresh);
  });
}
