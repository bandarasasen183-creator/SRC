/**
 * Tests for the email layer and the idempotency guard.
 *
 * The Firestore part needs the emulator running (npm run emul).
 * Run: node --test tests/functions.test.js
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMany, sendOne, announcementEmail, inviteEmail, bodyExtract,
} from '../functions/email.js';

/* ---- fetch mock ---------------------------------------------------------- */

let calls = [];
let responder = () => ({ ok: true, status: 201 });

const realFetch = globalThis.fetch;

const recordingFetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, at: Date.now(), to: body.to[0].email, headers: opts.headers, body });
  const r = responder(body);
  return {
    ok: r.ok,
    status: r.status,
    text: async () => r.text ?? '',
    json: async () => ({}),
  };
};

// Reinstate the recording mock before every test — one test below swaps in its
// own fetch to measure concurrency, and must not leak into the others.
beforeEach(() => {
  calls = [];
  responder = () => ({ ok: true, status: 201 });
  globalThis.fetch = recordingFetch;
});

const people = (n) => Array.from({ length: n }, (_, i) => ({ email: `s${i}@education.nsw.gov.au` }));
const msg = () => ({ subject: 'x', html: '<p>x</p>', text: 'x' });

/* ---- templates ----------------------------------------------------------- */

describe('announcement email', () => {
  const e = announcementEmail({
    title: 'Meeting moved to Thursday',
    body: 'Bring your **ideas**.\n\n- Fundraiser\n\n[the plan](https://example.com/p)',
    appUrl: 'https://src-demo.web.app',
    announcementId: 'a1',
    hasForm: true,
  });

  test('subject starts with the recognisable "SRC update"', () => {
    assert.ok(e.subject.startsWith('SRC update'), e.subject);
  });

  test('subject includes the announcement title', () => {
    assert.ok(e.subject.includes('Meeting moved to Thursday'), e.subject);
  });

  test('contains a readable extract of the body, not raw markdown', () => {
    assert.ok(e.text.includes('Bring your ideas'), e.text);
    assert.ok(!e.text.includes('**'), 'markdown asterisks leaked into the email');
    assert.ok(e.text.includes('the plan'), 'link text should survive');
  });

  test('links back into the site', () => {
    assert.ok(e.html.includes('https://src-demo.web.app/#/feed'));
    assert.ok(e.text.includes('https://src-demo.web.app/#/feed'));
  });

  test('NEVER uses a mailto: link', () => {
    assert.ok(!/mailto:/i.test(e.html), 'mailto: found in HTML');
    assert.ok(!/mailto:/i.test(e.text), 'mailto: found in text');
  });

  test('mentions the attached form when there is one', () => {
    assert.ok(/form/i.test(e.text));
  });

  test('says the app is the source of truth, not the email', () => {
    assert.ok(/always/i.test(e.text) && /app/i.test(e.text), e.text);
  });

  test('escapes HTML in a hostile title', () => {
    const bad = announcementEmail({
      title: '<script>alert(1)</script>', body: 'x',
      appUrl: 'https://x.web.app', announcementId: 'a', hasForm: false,
    });
    assert.ok(!bad.html.includes('<script>'), 'unescaped script tag in email HTML');
    assert.ok(bad.html.includes('&lt;script&gt;'));
  });

  test('subject stays within a sane length', () => {
    const long = announcementEmail({
      title: 'T'.repeat(500), body: '', appUrl: 'https://x.web.app',
      announcementId: 'a', hasForm: false,
    });
    assert.ok(long.subject.length <= 180, long.subject.length);
  });
});

describe('invite email', () => {
  const e = inviteEmail({
    signInLink: 'https://src-demo.web.app/?signin=1&oobCode=abc',
    appUrl: 'https://src-demo.web.app',
    invitedBy: 'Ms Jones',
  });

  test('contains the sign-in link', () => {
    assert.ok(e.html.includes('oobCode=abc'));
    assert.ok(e.text.includes('oobCode=abc'));
  });
  test('never uses mailto:', () => {
    assert.ok(!/mailto:/i.test(e.html) && !/mailto:/i.test(e.text));
  });
  test('says no password is needed', () => {
    assert.ok(/password/i.test(e.html));
  });
});

describe('bodyExtract', () => {
  test('truncates long bodies with an ellipsis', () => {
    const out = bodyExtract('x'.repeat(1000), 100);
    assert.ok(out.length <= 100, out.length);
    assert.ok(out.endsWith('…'));
  });
  test('turns bullets into readable text', () => {
    assert.ok(bodyExtract('- one\n- two').includes('• one'));
  });
});

/* ---- batching and rate limiting ------------------------------------------ */

describe('sendMany', () => {
  test('sends to everyone', async () => {
    const { sent, failed } = await sendMany(people(50), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, batchSize: 8, pauseMs: 1,
    });
    assert.equal(sent.length, 50);
    assert.equal(failed.length, 0);
    assert.equal(calls.length, 50);
  });

  test('never fires all 50 requests simultaneously', async () => {
    let inFlight = 0, peak = 0;
    globalThis.fetch = async (url, opts) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    };
    await sendMany(people(50), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, batchSize: 8, pauseMs: 1,
    });
    assert.ok(peak <= 8, `peak concurrency was ${peak}, expected <= 8`);
  });

  test('pauses between batches so the provider is not hammered', async () => {
    const started = Date.now();
    await sendMany(people(24), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, batchSize: 8, pauseMs: 60,
    });
    // 3 batches => 2 pauses => at least ~120ms
    assert.ok(Date.now() - started >= 110, `finished too fast: ${Date.now() - started}ms`);
  });

  test('sends the API key as a header, never in the message body', async () => {
    await sendMany(people(1), msg, { apiKey: 'SECRET_KEY', sender: { email: 'a@b.c' }, pauseMs: 1 });
    assert.equal(calls[0].headers['api-key'], 'SECRET_KEY');
    assert.ok(!JSON.stringify(calls[0].body).includes('SECRET_KEY'));
  });

  test('one bad address does not stop the rest', async () => {
    responder = (body) => body.to[0].email === 's3@education.nsw.gov.au'
      ? { ok: false, status: 400, text: 'invalid recipient' }
      : { ok: true, status: 201 };
    const { sent, failed } = await sendMany(people(10), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, batchSize: 4, pauseMs: 1,
    });
    assert.equal(sent.length, 9);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].email, 's3@education.nsw.gov.au');
  });

  test('a 4xx is NOT retried (retrying a bad address wastes quota)', async () => {
    responder = () => ({ ok: false, status: 400, text: 'bad address' });
    await sendMany(people(1), msg, { apiKey: 'k', sender: { email: 'a@b.c' }, pauseMs: 1, maxAttempts: 3 });
    assert.equal(calls.length, 1, `expected 1 attempt, got ${calls.length}`);
  });

  test('a 5xx IS retried, but only up to maxAttempts', async () => {
    responder = () => ({ ok: false, status: 503, text: 'upstream down' });
    const { failed } = await sendMany(people(1), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, pauseMs: 1, maxAttempts: 2,
    });
    assert.equal(calls.length, 2, `expected exactly 2 attempts, got ${calls.length}`);
    assert.equal(failed.length, 1);
  });

  test('a 429 is treated as retryable, not permanent', async () => {
    responder = () => ({ ok: false, status: 429, text: 'rate limited' });
    await sendMany(people(1), msg, { apiKey: 'k', sender: { email: 'a@b.c' }, pauseMs: 1, maxAttempts: 2 });
    assert.equal(calls.length, 2);
  });

  test('never throws, even when every send fails', async () => {
    responder = () => ({ ok: false, status: 500, text: 'boom' });
    const res = await sendMany(people(5), msg, {
      apiKey: 'k', sender: { email: 'a@b.c' }, pauseMs: 1, maxAttempts: 1,
    });
    assert.equal(res.sent.length, 0);
    assert.equal(res.failed.length, 5);
  });
});

/* ---- idempotency guard --------------------------------------------------- */
// The function guards against duplicate mailouts with a create() on
// mailLog/{announcementId}, which fails if the document already exists.
// This verifies that guarantee against the real Firestore emulator.

const FS = 'http://127.0.0.1:8080/v1/projects/demo-src/databases/(default)/documents';

async function emulatorUp() {
  try {
    const r = await realFetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch { return false; }
}

describe('mailLog idempotency guard', { skip: !(await emulatorUp()) && 'Firestore emulator not running' }, () => {
  test('creating the same mailLog doc twice fails the second time', async () => {
    const id = `idem-test-${Math.floor(Math.random() * 1e9)}`;
    const create = () => realFetch(`${FS}/mailLog?documentId=${id}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: 'sending' } } }),
    });

    const first = await create();
    assert.equal(first.status, 200, `first create should succeed, got ${first.status}`);

    const second = await create();
    assert.equal(second.status, 409,
      `second create must be rejected as ALREADY_EXISTS, got ${second.status}`);
  });
});
