// Firebase bootstrap.
//
// The web config is NOT a secret (it identifies the project; security comes
// from Firestore rules). Firebase Hosting serves it automatically at
// /__/firebase/init.json, so there is no config file for anyone to fill in
// after deploying. We fall back to a local file for non-Hosting dev.

import {
  initializeApp,
  getAuth, connectAuthEmulator,
  getFirestore, connectFirestoreEmulator,
  getFunctions, connectFunctionsEmulator,
} from '/vendor/firebase.js';

export const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);

async function loadConfig() {
  try {
    const r = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg?.projectId) return cfg;
    }
  } catch { /* fall through */ }

  if (isLocal) {
    // Emulator-only fallback so `npm run emul` works with no real project.
    return { apiKey: 'demo-key', projectId: 'demo-src', authDomain: 'localhost' };
  }
  throw new Error('Could not load Firebase config from /__/firebase/init.json');
}

export const config = await loadConfig();

const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
// MUST match setGlobalOptions({ region }) in functions/index.js. If these
// drift, every callable fails with the opaque code "internal", because the
// request goes to a region where the function does not exist.
// tests/region.test.js asserts they stay in sync.
export const FUNCTIONS_REGION = 'australia-southeast1';
export const fns = getFunctions(app, FUNCTIONS_REGION);

if (isLocal) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  console.info('[SRC] Using local Firebase emulators.');
}

export * from '/vendor/firebase.js';
