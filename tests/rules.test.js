/**
 * Firestore security rules tests.
 *
 * These are adversarial: most of the assertions below are `assertFails`,
 * i.e. we actively attempt the forbidden read/write as a student (or as a
 * signed-out stranger) and require that Firestore rejects it.
 *
 * Run with:  npm run test:rules
 */

import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  addDoc,
  setLogLevel,
} from 'firebase/firestore';

setLogLevel('error');

const PROJECT_ID = 'src-rules-test';

const TEACHER_UID = 'uid_teacher';
const TEACHER_EMAIL = 'ms.jones@education.nsw.gov.au';
const STUDENT_UID = 'uid_student';
const STUDENT_EMAIL = 'john.smith2@education.nsw.gov.au';
const OTHER_UID = 'uid_other';
const OTHER_EMAIL = 'sarah.lee14@education.nsw.gov.au';
const UNINVITED_UID = 'uid_uninvited';
const UNINVITED_EMAIL = 'random.person@education.nsw.gov.au';

let testEnv;

/** Authenticated context carrying a verified email claim, like real Auth. */
function as(uid, email) {
  return testEnv.authenticatedContext(uid, { email, email_verified: true }).firestore();
}
function signedOut() {
  return testEnv.unauthenticatedContext().firestore();
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

/** Seed baseline data with rules disabled. */
async function seed() {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'roster', TEACHER_EMAIL), {
      email: TEACHER_EMAIL, role: 'teacher', invitedAt: 1,
    });
    await setDoc(doc(db, 'roster', STUDENT_EMAIL), {
      email: STUDENT_EMAIL, role: 'student', invitedAt: 1,
    });
    await setDoc(doc(db, 'roster', OTHER_EMAIL), {
      email: OTHER_EMAIL, role: 'student', invitedAt: 1,
    });

    await setDoc(doc(db, 'users', TEACHER_UID), {
      email: TEACHER_EMAIL, name: 'Ms Jones', yearClass: 'Staff', role: 'teacher',
    });
    await setDoc(doc(db, 'users', STUDENT_UID), {
      email: STUDENT_EMAIL, name: 'John Smith', yearClass: '10B', role: 'student',
    });
    await setDoc(doc(db, 'users', OTHER_UID), {
      email: OTHER_EMAIL, name: 'Sarah Lee', yearClass: '11A', role: 'student',
    });

    await setDoc(doc(db, 'announcements', 'ann_open'), {
      title: 'Open thread', body: 'hello', authorUid: TEACHER_UID,
      authorName: 'Ms Jones', pinned: false, commentsOpen: true,
      date: '2026-08-13', createdAt: 1,
    });
    await setDoc(doc(db, 'announcements', 'ann_closed'), {
      title: 'Closed thread', body: 'hello', authorUid: TEACHER_UID,
      authorName: 'Ms Jones', pinned: false, commentsOpen: false,
      date: '2026-08-13', createdAt: 1,
    });
    await setDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_student'), {
      authorUid: STUDENT_UID, authorName: 'John Smith', text: 'mine', createdAt: 1,
    });
    await setDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_other'), {
      authorUid: OTHER_UID, authorName: 'Sarah Lee', text: 'theirs', createdAt: 1,
    });

    await setDoc(doc(db, 'messages', 'm_student'), {
      authorUid: STUDENT_UID, authorName: 'John Smith', text: 'mine', createdAt: 1,
    });
    await setDoc(doc(db, 'messages', 'm_other'), {
      authorUid: OTHER_UID, authorName: 'Sarah Lee', text: 'theirs', createdAt: 1,
    });

    await setDoc(doc(db, 'rosters', 'toast'), {
      title: 'Morning toast', slots: [{ id: 'monA', label: 'Mon (Week A)', capacity: 2 }],
      createdBy: TEACHER_UID, createdAt: 1,
    });
    await setDoc(doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID), {
      uid: OTHER_UID, name: 'Sarah Lee', slotId: 'monA', createdAt: 1,
    });

    await setDoc(doc(db, 'forms', 'form_once'), {
      title: 'Camp form', allowMultiple: false, fields: [], createdAt: 1,
    });
    await setDoc(doc(db, 'forms', 'form_multi'), {
      title: 'Feedback', allowMultiple: true, fields: [], createdAt: 1,
    });
    await setDoc(doc(db, 'forms', 'form_once', 'responses', OTHER_UID), {
      uid: OTHER_UID, name: 'Sarah Lee', answers: { q1: 'private answer' }, submittedAt: 1,
    });
    await setDoc(doc(db, 'forms', 'form_multi', 'responses', STUDENT_UID), {
      uid: STUDENT_UID, name: 'John Smith', answers: { q1: 'a' }, submittedAt: 1,
    });

    await setDoc(doc(db, 'mailLog', 'ann_open'), { status: 'sent', sent: 50 });

    await setDoc(doc(db, 'events', 'ev_open'), {
      title: 'Movie night', date: '2026-08-20', description: '',
      signupOpen: true, createdBy: TEACHER_UID, createdAt: 1,
    });
    await setDoc(doc(db, 'events', 'ev_closed'), {
      title: 'Staff-run stall', date: '2026-08-22', description: '',
      signupOpen: false, createdBy: TEACHER_UID, createdAt: 1,
    });
    await setDoc(doc(db, 'events', 'ev_open', 'signups', OTHER_UID), {
      uid: OTHER_UID, name: 'Sarah Lee', email: OTHER_EMAIL, signedUpAt: 1,
    });
    await setDoc(doc(db, 'users', OTHER_UID, 'mySignups', 'ev_open'), {
      eventId: 'ev_open', date: '2026-08-20', signedUpAt: 1,
    });
  });
}

// =============================================================================

describe('signed out — nothing is readable', () => {
  before(seed);

  test('cannot read announcements', async () => {
    const db = signedOut();
    await assertFails(getDoc(doc(db, 'announcements', 'ann_open')));
    await assertFails(getDocs(collection(db, 'announcements')));
  });

  test('cannot read users, roster, forms, responses, mailLog', async () => {
    const db = signedOut();
    await assertFails(getDoc(doc(db, 'users', STUDENT_UID)));
    await assertFails(getDocs(collection(db, 'roster')));
    await assertFails(getDocs(collection(db, 'forms')));
    await assertFails(getDocs(collection(db, 'forms', 'form_once', 'responses')));
    await assertFails(getDocs(collection(db, 'mailLog')));
  });

  test('cannot write anything', async () => {
    const db = signedOut();
    await assertFails(setDoc(doc(db, 'announcements', 'evil'), { title: 'x' }));
    await assertFails(setDoc(doc(db, 'users', 'evil'), { role: 'teacher' }));
  });
});

describe('role escalation — a student cannot become a teacher', () => {
  before(seed);

  test('student cannot set role:teacher on their own profile', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'users', STUDENT_UID), { role: 'teacher' }));
  });

  test('student cannot sneak role in alongside a legitimate name change', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      updateDoc(doc(db, 'users', STUDENT_UID), { name: 'John Smith', role: 'teacher' })
    );
  });

  test('student cannot overwrite their whole profile doc with role:teacher', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'users', STUDENT_UID), {
        email: STUDENT_EMAIL, name: 'John Smith', yearClass: '10B', role: 'teacher',
      })
    );
  });

  test('student CAN change their own name and year/class', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      updateDoc(doc(db, 'users', STUDENT_UID), { name: 'John A Smith', yearClass: '10C' })
    );
  });

  test('student cannot edit another student profile', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'users', OTHER_UID), { name: 'hacked' }));
  });

  test('teacher CAN promote a student', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(updateDoc(doc(db, 'users', STUDENT_UID), { role: 'teacher' }));
  });
});

describe('first sign-in — roster gates profile creation', () => {
  before(seed);

  test('an uninvited address cannot create a profile', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(
      setDoc(doc(db, 'users', UNINVITED_UID), {
        email: UNINVITED_EMAIL, name: 'Random Person', yearClass: '9A', role: 'student',
      })
    );
  });

  test('an invited student CAN create their profile as a student', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'users', STUDENT_UID));
    });
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      setDoc(doc(db, 'users', STUDENT_UID), {
        email: STUDENT_EMAIL, name: 'John Smith', yearClass: '10B', role: 'student',
      })
    );
  });

  test('an invited student cannot self-create AS a teacher', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'users', STUDENT_UID));
    });
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'users', STUDENT_UID), {
        email: STUDENT_EMAIL, name: 'John Smith', yearClass: '10B', role: 'teacher',
      })
    );
  });

  test('cannot create a profile claiming someone else\'s email', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(
      setDoc(doc(db, 'users', UNINVITED_UID), {
        email: STUDENT_EMAIL, name: 'Impostor', yearClass: '10B', role: 'student',
      })
    );
  });

  test('cannot create a profile under another uid', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(
      setDoc(doc(db, 'users', 'someone_else'), {
        email: UNINVITED_EMAIL, name: 'Random Person', yearClass: '9A', role: 'student',
      })
    );
  });
});

describe('roster is invisible to students', () => {
  before(seed);

  test('student cannot list the roster', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDocs(collection(db, 'roster')));
  });

  test('student cannot read a single roster row, even their own', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDoc(doc(db, 'roster', STUDENT_EMAIL)));
  });

  test('student cannot add themselves to the roster', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'roster', UNINVITED_EMAIL), {
        email: UNINVITED_EMAIL, role: 'teacher', invitedAt: 2,
      })
    );
  });

  test('student cannot list all user profiles', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDocs(collection(db, 'users')));
  });

  test('teacher CAN read the roster and list users', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'roster')));
    await assertSucceeds(getDocs(collection(db, 'users')));
  });
});

describe('form responses are private to their author', () => {
  before(seed);

  test('student CANNOT read another student\'s response', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDoc(doc(db, 'forms', 'form_once', 'responses', OTHER_UID)));
  });

  test('student CANNOT list the responses collection', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDocs(collection(db, 'forms', 'form_once', 'responses')));
  });

  test('student CAN read their own response', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(getDoc(doc(db, 'forms', 'form_multi', 'responses', STUDENT_UID)));
  });

  test('student cannot submit a response under another uid', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'forms', 'form_once', 'responses', OTHER_UID), {
        uid: OTHER_UID, answers: { q1: 'forged' }, submittedAt: 2,
      })
    );
  });

  test('student CAN submit their own response', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      setDoc(doc(db, 'forms', 'form_once', 'responses', STUDENT_UID), {
        uid: STUDENT_UID, name: 'John Smith', answers: { q1: 'mine' }, submittedAt: 2,
      })
    );
  });

  test('single-submission form: student cannot overwrite after submitting', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      updateDoc(doc(db, 'forms', 'form_once', 'responses', STUDENT_UID), {
        answers: { q1: 'changed my mind' },
      })
    );
  });

  test('multi-submission form: student CAN resubmit', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      updateDoc(doc(db, 'forms', 'form_multi', 'responses', STUDENT_UID), {
        answers: { q1: 'b' },
      })
    );
  });

  test('teacher CAN list all responses', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'forms', 'form_once', 'responses')));
  });

  test('student cannot delete their response to hide it', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(deleteDoc(doc(db, 'forms', 'form_once', 'responses', STUDENT_UID)));
  });
});

describe('announcements — students read, teachers write', () => {
  before(seed);

  test('student CAN read the feed', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'announcements')));
  });

  test('student cannot post an announcement', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'announcements'), {
        title: 'Fake notice', body: 'x', authorUid: STUDENT_UID,
        authorName: 'John Smith', pinned: true, commentsOpen: true,
        date: '2026-08-13', createdAt: 2,
      })
    );
  });

  test('student cannot edit or delete an announcement', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'announcements', 'ann_open'), { title: 'defaced' }));
    await assertFails(deleteDoc(doc(db, 'announcements', 'ann_open')));
  });

  test('student cannot build a form', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'forms'), { title: 'Fake', allowMultiple: true, fields: [] })
    );
  });

  test('teacher CAN post an announcement', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(
      addDoc(collection(db, 'announcements'), {
        title: 'Real notice', body: 'x', authorUid: TEACHER_UID,
        authorName: 'Ms Jones', pinned: false, commentsOpen: true,
        notify: true, date: '2026-08-13', createdAt: 2,
      })
    );
  });

  test('teacher cannot forge notifiedAt (function-owned field)', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertFails(
      addDoc(collection(db, 'announcements'), {
        title: 'Sneaky', body: 'x', authorUid: TEACHER_UID, authorName: 'Ms Jones',
        pinned: false, commentsOpen: true, date: '2026-08-13', createdAt: 2,
        notifiedAt: 999,
      })
    );
  });

  test('nobody can write the mail log from a client', async () => {
    const t = as(TEACHER_UID, TEACHER_EMAIL);
    await assertFails(setDoc(doc(t, 'mailLog', 'ann_open'), { status: 'faked' }));
  });
});

describe('comments', () => {
  before(seed);

  test('student CAN comment on an open thread', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      addDoc(collection(db, 'announcements', 'ann_open', 'comments'), {
        authorUid: STUDENT_UID, authorName: 'John Smith', text: 'good idea', createdAt: 2,
      })
    );
  });

  test('student cannot comment on a CLOSED thread', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'announcements', 'ann_closed', 'comments'), {
        authorUid: STUDENT_UID, authorName: 'John Smith', text: 'sneaking in', createdAt: 2,
      })
    );
  });

  test('student cannot post under a fake name', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'announcements', 'ann_open', 'comments'), {
        authorUid: STUDENT_UID, authorName: 'Anonymous', text: 'hidden', createdAt: 2,
      })
    );
  });

  test('student cannot post under another student\'s uid', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'announcements', 'ann_open', 'comments'), {
        authorUid: OTHER_UID, authorName: 'Sarah Lee', text: 'framed', createdAt: 2,
      })
    );
  });

  test('student CAN edit and delete their own comment', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      updateDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_student'), {
        text: 'edited', editedAt: 3,
      })
    );
    await assertSucceeds(
      deleteDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_student'))
    );
  });

  test('student cannot edit or delete someone else\'s comment', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      updateDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_other'), { text: 'hacked' })
    );
    await assertFails(
      deleteDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_other'))
    );
  });

  test('teacher CAN delete any comment (moderation)', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(
      deleteDoc(doc(db, 'announcements', 'ann_open', 'comments', 'c_other'))
    );
  });
});

describe('access requests', () => {
  before(seed);

  test('an uninvited user CAN lodge a request for their own address', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertSucceeds(
      setDoc(doc(db, 'accessRequests', UNINVITED_EMAIL), {
        email: UNINVITED_EMAIL, name: 'Random Person', yearClass: '9A', requestedAt: 1,
      })
    );
  });

  test('cannot lodge a request for somebody else\'s address', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(
      setDoc(doc(db, 'accessRequests', OTHER_EMAIL), {
        email: OTHER_EMAIL, name: 'Impostor', requestedAt: 1,
      })
    );
  });

  test('an uninvited user cannot list all access requests', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(getDocs(collection(db, 'accessRequests')));
  });

  test('an uninvited user cannot approve themselves by deleting the request', async () => {
    const db = as(UNINVITED_UID, UNINVITED_EMAIL);
    await assertFails(deleteDoc(doc(db, 'accessRequests', UNINVITED_EMAIL)));
  });

  test('teacher CAN list and clear requests', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'accessRequests')));
    await assertSucceeds(deleteDoc(doc(db, 'accessRequests', UNINVITED_EMAIL)));
  });
});

describe('events and sign-ups', () => {
  before(seed);

  test('signed out cannot read events', async () => {
    const db = signedOut();
    await assertFails(getDocs(collection(db, 'events')));
  });

  test('student CAN read the events calendar', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'events')));
  });

  test('student cannot create an event', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      addDoc(collection(db, 'events'), {
        title: 'Fake event', date: '2026-09-01', description: '',
        signupOpen: true, createdBy: STUDENT_UID, createdAt: 2,
      })
    );
  });

  test('student cannot edit or delete an event', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'events', 'ev_open'), { title: 'defaced' }));
    await assertFails(deleteDoc(doc(db, 'events', 'ev_open')));
  });

  test('teacher CAN create an event', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(
      addDoc(collection(db, 'events'), {
        title: 'Fundraiser BBQ', date: '2026-09-05', description: 'Sausages.',
        signupOpen: true, createdBy: TEACHER_UID, createdAt: 2,
      })
    );
  });

  test('any teacher CAN edit an event (shared logistics)', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(updateDoc(doc(db, 'events', 'ev_open'), { title: 'Movie night (new time)' }));
  });

  test('student CAN sign up to an open event as themselves', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      setDoc(doc(db, 'events', 'ev_open', 'signups', STUDENT_UID), {
        uid: STUDENT_UID, name: 'John Smith', email: STUDENT_EMAIL, signedUpAt: 2,
      })
    );
  });

  test('student cannot sign up under another uid', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'events', 'ev_open', 'signups', UNINVITED_UID), {
        uid: UNINVITED_UID, name: 'Random Person', signedUpAt: 2,
      })
    );
  });

  test('student cannot sign up under a fake name', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'events', 'ev_open', 'signups', STUDENT_UID));
    });
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'events', 'ev_open', 'signups', STUDENT_UID), {
        uid: STUDENT_UID, name: 'Anonymous', signedUpAt: 2,
      })
    );
  });

  test('student cannot sign up to a CLOSED event', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(
      setDoc(doc(db, 'events', 'ev_closed', 'signups', STUDENT_UID), {
        uid: STUDENT_UID, name: 'John Smith', signedUpAt: 2,
      })
    );
  });

  test('student cannot LIST who signed up', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDocs(collection(db, 'events', 'ev_open', 'signups')));
  });

  test('student cannot read another student\'s signup', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDoc(doc(db, 'events', 'ev_open', 'signups', OTHER_UID)));
  });

  test('teacher CAN list the signups', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'events', 'ev_open', 'signups')));
  });

  test('student CAN remove their own signup, but not someone else\'s', async () => {
    // Re-create the student signup (the fake-name test deleted it).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'events', 'ev_open', 'signups', STUDENT_UID), {
        uid: STUDENT_UID, name: 'John Smith', signedUpAt: 2,
      });
    });
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(deleteDoc(doc(db, 'events', 'ev_open', 'signups', STUDENT_UID)));
    await assertFails(deleteDoc(doc(db, 'events', 'ev_open', 'signups', OTHER_UID)));
  });

  test('student CAN keep their own mySignups mirror', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(
      setDoc(doc(db, 'users', STUDENT_UID, 'mySignups', 'ev_open'), {
        eventId: 'ev_open', date: '2026-08-20', signedUpAt: 2,
      })
    );
    await assertSucceeds(getDocs(collection(db, 'users', STUDENT_UID, 'mySignups')));
  });

  test('student cannot read or write another user\'s mySignups', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(getDocs(collection(db, 'users', OTHER_UID, 'mySignups')));
    await assertFails(
      setDoc(doc(db, 'users', OTHER_UID, 'mySignups', 'ev_open'), { eventId: 'ev_open' })
    );
  });
});

describe('unknown collections are denied by default', () => {
  before(seed);

  test('teacher cannot write to an unmodelled collection', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertFails(setDoc(doc(db, 'secrets', 'x'), { a: 1 }));
  });
});

/* =============================================================================
   community chat
   ========================================================================== */

describe('community chat', () => {
  before(seed);

  test('signed out cannot read the chat', async () => {
    await assertFails(getDocs(collection(signedOut(), 'messages')));
  });

  test('a member CAN read the room — chat is meant to be seen', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'messages')));
  });

  test('a member CAN post under their own name', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(addDoc(collection(db, 'messages'), {
      authorUid: STUDENT_UID, authorName: 'John Smith', text: 'hi all', createdAt: 2,
    }));
  });

  test('cannot post under a fake name', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(addDoc(collection(db, 'messages'), {
      authorUid: STUDENT_UID, authorName: 'Anonymous', text: 'sneaky', createdAt: 2,
    }));
  });

  test('cannot post as somebody else', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(addDoc(collection(db, 'messages'), {
      authorUid: OTHER_UID, authorName: 'Sarah Lee', text: 'not me', createdAt: 2,
    }));
  });

  test('an empty or oversized message is rejected', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    const base = { authorUid: STUDENT_UID, authorName: 'John Smith', createdAt: 2 };
    await assertFails(addDoc(collection(db, 'messages'), { ...base, text: '' }));
    await assertFails(addDoc(collection(db, 'messages'), { ...base, text: 'x'.repeat(2001) }));
  });

  test('smuggling extra fields into a message is rejected', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(addDoc(collection(db, 'messages'), {
      authorUid: STUDENT_UID, authorName: 'John Smith', text: 'hi',
      createdAt: 2, pinned: true,
    }));
  });

  test('a member CAN edit the wording of their own message', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(updateDoc(doc(db, 'messages', 'm_student'), {
      text: 'edited', editedAt: 3,
    }));
  });

  test('cannot rewrite the attribution on your own message', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'messages', 'm_student'), { authorName: 'Ms Jones' }));
    await assertFails(updateDoc(doc(db, 'messages', 'm_student'), { authorUid: OTHER_UID }));
  });

  test('cannot edit or delete someone else\'s message', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(updateDoc(doc(db, 'messages', 'm_other'), { text: 'hijacked' }));
    await assertFails(deleteDoc(doc(db, 'messages', 'm_other')));
  });

  test('a member CAN delete their own message', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(deleteDoc(doc(db, 'messages', 'm_student')));
  });

  test('a teacher CAN delete anyone\'s message (moderation)', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(deleteDoc(doc(db, 'messages', 'm_other')));
  });
});

/* =============================================================================
   rosters
   ========================================================================== */

describe('rosters', () => {
  before(seed);

  test('signed out cannot read rosters', async () => {
    await assertFails(getDocs(collection(signedOut(), 'rosters')));
    await assertFails(getDoc(doc(signedOut(), 'rosters', 'toast')));
  });

  test('a member CAN read rosters and see who is on', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(getDocs(collection(db, 'rosters')));
    // Deliberately listable, unlike form responses: the point of a roster is
    // that everyone can see who has Tuesday.
    await assertSucceeds(getDocs(collection(db, 'rosters', 'toast', 'claims', 'monA', 'people')));
  });

  test('a student cannot create, edit or delete a roster', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(setDoc(doc(db, 'rosters', 'mine'), { title: 'Mine', slots: [] }));
    await assertFails(updateDoc(doc(db, 'rosters', 'toast'), { title: 'Renamed' }));
    await assertFails(deleteDoc(doc(db, 'rosters', 'toast')));
  });

  test('a teacher CAN create and edit a roster', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(setDoc(doc(db, 'rosters', 'setup'), {
      title: 'Event set-up', slots: [{ id: 's1', label: 'Friday', capacity: 3 }],
      createdBy: TEACHER_UID, createdAt: 1,
    }));
    await assertSucceeds(updateDoc(doc(db, 'rosters', 'toast'), { title: 'Toast roster' }));
  });

  test('a student CAN put their own name down', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertSucceeds(setDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', STUDENT_UID),
      { uid: STUDENT_UID, name: 'John Smith', slotId: 'monA', createdAt: 2 }
    ));
  });

  test('cannot put somebody else down', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(setDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID),
      { uid: OTHER_UID, name: 'Sarah Lee', slotId: 'monA', createdAt: 2 }
    ));
  });

  test('cannot claim under a fake name', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(setDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', STUDENT_UID),
      { uid: STUDENT_UID, name: 'Somebody Else', slotId: 'monA', createdAt: 2 }
    ));
  });

  test('the claim cannot lie about which slot it is in', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(setDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', STUDENT_UID),
      { uid: STUDENT_UID, name: 'John Smith', slotId: 'friB', createdAt: 2 }
    ));
  });

  test('a claim cannot be edited, only made or removed', async () => {
    const db = as(OTHER_UID, OTHER_EMAIL);
    await assertFails(updateDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID),
      { name: 'Renamed' }
    ));
  });

  test('a member CAN take their own name off', async () => {
    const db = as(OTHER_UID, OTHER_EMAIL);
    await assertSucceeds(deleteDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID)
    ));
  });

  test('a student cannot take somebody else off', async () => {
    const db = as(STUDENT_UID, STUDENT_EMAIL);
    await assertFails(deleteDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID)
    ));
  });

  test('a teacher CAN take anyone off, to fix a roster', async () => {
    const db = as(TEACHER_UID, TEACHER_EMAIL);
    await assertSucceeds(deleteDoc(
      doc(db, 'rosters', 'toast', 'claims', 'monA', 'people', OTHER_UID)
    ));
  });
});
