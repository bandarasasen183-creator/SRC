// Cloud Functions for the SRC app.
//
// There are exactly two: one that emails the roster when a teacher posts an
// announcement, and one callable that emails sign-in links to invited students.
//
// COST SAFETY (this project is on Blaze, which has no hard spending cap):
//   * Both functions set maxInstances, so a burst can never fan out.
//   * The Firestore trigger is onCreate only, and writes its bookkeeping to a
//     SEPARATE collection (mailLog), so it can never re-trigger itself. There
//     is no write-loop possible here.
//   * retry is explicitly disabled — a failing send is recorded, not retried
//     forever. Infinite retries on a failing function are the classic way a
//     Firebase bill runs away.
//   * Per-send retries are capped at 2 attempts and 4xx errors are never
//     retried.
//   * Recipient counts are hard-capped.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import * as logger from 'firebase-functions/logger';

import { sendMany, announcementEmail, inviteEmail } from './email.js';

initializeApp();
const db = getFirestore();

// ---- configuration ---------------------------------------------------------

/** Brevo API key. A SECRET — never shipped to the browser. */
const BREVO_API_KEY = defineSecret('BREVO_API_KEY');

/** e.g. "SRC <src@src.recallschool.com>" pieces. */
const SENDER_EMAIL = defineString('SENDER_EMAIL', { default: 'src@src.recallschool.com' });
const SENDER_NAME = defineString('SENDER_NAME', { default: 'SRC' });

/** Public site URL, e.g. https://your-project.web.app */
const APP_URL = defineString('APP_URL', { default: '' });

/** Never email more than this many people from one trigger. */
const MAX_RECIPIENTS = 400;

setGlobalOptions({ region: 'australia-southeast1', maxInstances: 3 });

function appUrl() {
  const configured = APP_URL.value();
  if (configured) return configured.replace(/\/+$/, '');
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
  return `https://${project}.web.app`;
}

function sender() {
  return { email: SENDER_EMAIL.value(), name: SENDER_NAME.value() };
}

/** Roster addresses to notify. Teachers are included; they're on it too. */
async function rosterRecipients() {
  const snap = await db.collection('roster').get();
  const out = [];
  for (const d of snap.docs) {
    const r = d.data();
    const email = String(r.email || d.id).toLowerCase().trim();
    if (!email.includes('@')) continue;
    // Skip addresses a previous send hard-bounced on. Emailing known-dead
    // addresses is what destroys a sender reputation.
    if (r.bounced === true) continue;
    out.push({ email });
  }
  return out;
}

/* =============================================================================
   1. Announcement created -> notify the roster
   ========================================================================== */

export const onAnnouncementCreated = onDocumentCreated(
  {
    document: 'announcements/{announcementId}',
    secrets: [BREVO_API_KEY],
    retry: false,            // never retry forever
    timeoutSeconds: 300,
    memory: '256MiB',
    maxInstances: 3,
  },
  async (event) => {
    const id = event.params.announcementId;
    const data = event.data?.data();
    if (!data) return;

    const logRef = db.doc(`mailLog/${id}`);

    // ---- idempotency guard ------------------------------------------------
    // create() fails with ALREADY_EXISTS if this announcement was already
    // processed. This is what makes a duplicate delivery of the event, or a
    // manual re-run, a no-op rather than a second mailout.
    try {
      await logRef.create({
        announcementId: id,
        status: 'sending',
        startedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.info(`mailLog/${id} already exists — not sending again.`, { code: e.code });
      return;
    }

    // ---- teacher opted out ------------------------------------------------
    if (data.notify !== true) {
      await logRef.set({
        status: 'skipped', reason: 'notify toggle off',
        finishedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    const key = BREVO_API_KEY.value();
    if (!key) {
      logger.error('BREVO_API_KEY is not set — cannot send.');
      await logRef.set({
        status: 'error', error: 'Email provider key not configured.',
        finishedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    try {
      let recipients = await rosterRecipients();
      let capped = false;
      if (recipients.length > MAX_RECIPIENTS) {
        capped = true;
        logger.warn(`Roster has ${recipients.length}; capping at ${MAX_RECIPIENTS}.`);
        recipients = recipients.slice(0, MAX_RECIPIENTS);
      }

      if (!recipients.length) {
        await logRef.set({
          status: 'sent', sent: 0, failed: 0, note: 'roster empty',
          finishedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }

      const msg = announcementEmail({
        title: data.title || 'SRC update',
        body: data.body || '',
        appUrl: appUrl(),
        announcementId: id,
        hasForm: !!data.formId,
      });

      const { sent, failed } = await sendMany(recipients, () => msg, {
        apiKey: key,
        sender: sender(),
        batchSize: 8,
        pauseMs: 400,
        maxAttempts: 2,
      });

      // Mark hard-bounced addresses so we stop mailing them next time.
      const hardFails = failed.filter((f) => /\b(400|invalid|blocked|unknown)\b/i.test(f.error));
      if (hardFails.length) {
        const batch = db.batch();
        for (const f of hardFails.slice(0, 400)) {
          batch.set(db.doc(`roster/${f.email}`), {
            lastSendError: f.error,
            lastSendErrorAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await batch.commit().catch((e) => logger.warn('bounce marking failed', e));
      }

      await logRef.set({
        status: failed.length && !sent.length ? 'error' : 'sent',
        sent: sent.length,
        failed: failed.length,
        capped,
        failedEmails: failed.slice(0, 25).map((f) => f.email),
        error: failed.length ? failed[0].error : null,
        finishedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // Record notifiedAt on the announcement itself. This is an UPDATE, and
      // this function only triggers on CREATE, so it cannot re-fire.
      await db.doc(`announcements/${id}`).set({
        notifiedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logger.info(`Announcement ${id}: ${sent.length} sent, ${failed.length} failed.`);
    } catch (e) {
      // Swallow the error deliberately: throwing would ask the platform to
      // retry, and a repeatedly-retried mailout is both a cost risk and a
      // duplicate-email risk.
      logger.error(`Announcement ${id} mailout failed`, e);
      await logRef.set({
        status: 'error',
        error: String(e?.message || e).slice(0, 400),
        finishedAt: FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
  }
);

/* =============================================================================
   2. Callable: email sign-in links to invited students
   ========================================================================== */

export const sendInvites = onCall(
  {
    secrets: [BREVO_API_KEY],
    timeoutSeconds: 300,
    memory: '256MiB',
    maxInstances: 2,
    enforceAppCheck: false,
  },
  async (req) => {
    // ---- authorisation ----------------------------------------------------
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

    const callerSnap = await db.doc(`users/${req.auth.uid}`).get();
    if (!callerSnap.exists || callerSnap.data().role !== 'teacher') {
      throw new HttpsError('permission-denied', 'Teachers only.');
    }
    const invitedBy = callerSnap.data().name || '';

    // ---- input validation -------------------------------------------------
    const raw = Array.isArray(req.data?.emails) ? req.data.emails : [];
    const emails = [...new Set(
      raw.map((e) => String(e || '').toLowerCase().trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e))
    )];

    if (!emails.length) throw new HttpsError('invalid-argument', 'No valid addresses.');
    if (emails.length > MAX_RECIPIENTS) {
      throw new HttpsError('invalid-argument', `At most ${MAX_RECIPIENTS} at a time.`);
    }

    const key = BREVO_API_KEY.value();
    if (!key) {
      throw new HttpsError('failed-precondition',
        'Email provider key is not configured. Set the BREVO_API_KEY secret.');
    }

    // ---- only invite people actually on the roster ------------------------
    const onRoster = [];
    const reads = await db.getAll(...emails.map((e) => db.doc(`roster/${e}`)));
    reads.forEach((snap, i) => { if (snap.exists) onRoster.push(emails[i]); });

    if (!onRoster.length) {
      throw new HttpsError('failed-precondition', 'None of those are on the roster yet.');
    }

    const base = appUrl();
    const auth = getAuth();

    // Build a per-recipient sign-in link with the Admin SDK, then deliver it
    // ourselves through Brevo so invitations come from the same sender as
    // announcements.
    const withLinks = [];
    const linkFailures = [];
    for (const email of onRoster) {
      try {
        const signInLink = await auth.generateSignInWithEmailLink(email, {
          url: `${base}/?signin=1`,
          handleCodeInApp: true,
        });
        withLinks.push({ email, signInLink });
      } catch (e) {
        logger.error(`Could not generate link for ${email}`, e);
        linkFailures.push({ email, error: String(e?.message || e).slice(0, 200) });
      }
    }

    const { sent, failed } = await sendMany(
      withLinks,
      (r) => inviteEmail({ signInLink: r.signInLink, appUrl: base, invitedBy }),
      { apiKey: key, sender: sender(), batchSize: 8, pauseMs: 400, maxAttempts: 2 }
    );

    const allFailed = [...failed, ...linkFailures];
    logger.info(`Invites: ${sent.length} sent, ${allFailed.length} failed.`);

    return {
      sent: sent.length,
      failed: allFailed.length,
      failedEmails: allFailed.slice(0, 25).map((f) => f.email),
      skipped: emails.length - onRoster.length,
    };
  }
);
