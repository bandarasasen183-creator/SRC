// Entry point for the vendored Firebase bundle.
//
// We bundle the SDK into public/vendor/firebase.js rather than loading it from
// gstatic.com at runtime. Two reasons:
//   1. School networks sometimes block or slow third-party CDNs; this keeps the
//      whole app on the one *.web.app origin.
//   2. The version is pinned in package-lock.json, so the app cannot break
//      because a CDN moved.
//
// Rebuild with: npm run build:vendor
// The output is committed, so `firebase deploy` needs no build step.

export { initializeApp } from 'firebase/app';

export {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signOut,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  sendPasswordResetEmail,
  fetchSignInMethodsForEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
} from 'firebase/auth';

export {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';

export {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions';
