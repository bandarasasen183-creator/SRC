/**
 * Tests for the email layer and the idempotency guard.
 *
 * The Firestore part needs the emulator running (npm run emul).
 * Run: node --test tests/functions.test.js
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMany, announcementEmail, inviteEmail, bodyExtract, getTransport,
} from '../functions/email.js';
import { explained, HttpsError } from '../functions/callable.js';

/* ---- fetch mock ---------------------------------------------------------- */

let calls = [];
let responder = () => ({ ok: true, status: 201 });

const realFetch = globalThis.fetch;

// Understands both shapes: Resend's batch array, Resend/Brevo single objects.
function recipientsOf(body) {
  if (Array.isArray(body)) return body.flatMap((m) => m.to);
  if (Array.isArray(body.to)) {
    return body.to.map((t) => (typeof t === 'string' ? t : t.email));
  }
  return [];
}

const recordingFetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const to = recipientsOf(body);
  calls.push({ url, at: Date.now(), to, count: to.length, headers: opts.headers, body });
  const r = responder(body, to);
  return {
    ok: r.ok,
    status: r.status,
    text: async () => r.text ?? '',
    json: async () => r.json ?? {},
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

describe('sendMany — Resend transport', () => {
  const opts = { apiKey: 'k', sender: { email: 'src@src.recallschool.com', name: 'SRC' }, provider: 'resend' };

  test('50 students go out in ONE batch request', async () => {
    const { sent, failed } = await sendMany(people(50), msg, opts);
    assert.equal(sent.length, 50);
    assert.equal(failed.length, 0);
    assert.equal(calls.length, 1, `expected 1 batch call, got ${calls.length}`);
    assert.ok(calls[0].url.endsWith('/emails/batch'));
    assert.equal(calls[0].count, 50);
  });

  test('chunks at 100, which is Resend\'s batch maximum', async () => {
    await sendMany(people(250), msg, opts);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.count), [100, 100, 50]);
  });

  test('uses a Bearer token header, never the key in the body', async () => {
    await sendMany(people(3), msg, { ...opts, apiKey: 'SECRET_KEY' });
    assert.equal(calls[0].headers.authorization, 'Bearer SECRET_KEY');
    assert.ok(!JSON.stringify(calls[0].body).includes('SECRET_KEY'));
  });

  test('sends a properly formatted From with the display name', async () => {
    await sendMany(people(1), msg, opts);
    assert.equal(calls[0].body[0].from, 'SRC <src@src.recallschool.com>');
  });

  test('a failed batch falls back to individual sends, so one bad address only costs itself', async () => {
    let first = true;
    responder = (body, to) => {
      if (Array.isArray(body) && first) { first = false; return { ok: false, status: 422, text: 'invalid `to` field' }; }
      if (to.includes('s3@education.nsw.gov.au')) return { ok: false, status: 422, text: 'invalid recipient' };
      return { ok: true, status: 200 };
    };
    const { sent, failed } = await sendMany(people(10), msg, opts);
    assert.equal(sent.length, 9, `expected 9 delivered, got ${sent.length}`);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].email, 's3@education.nsw.gov.au');
  });

  test('individual fallback never fires all requests at once', async () => {
    let inFlight = 0, peak = 0, firstBatch = true;
    globalThis.fetch = async (url, o) => {
      const body = JSON.parse(o.body);
      if (Array.isArray(body) && firstBatch) { firstBatch = false; return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }; }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    };
    await sendMany(people(40), msg, { ...opts, pauseMs: 1 });
    assert.ok(peak <= 8, `peak concurrency was ${peak}, expected <= 8`);
  });

  test('a 4xx is NOT retried on the individual path', async () => {
    responder = (body) => Array.isArray(body)
      ? { ok: false, status: 422, text: 'bad batch' }
      : { ok: false, status: 422, text: 'bad address' };
    await sendMany(people(1), msg, { ...opts, maxAttempts: 3, pauseMs: 1 });
    // 1 batch attempt + exactly 1 individual attempt (no retry on 4xx)
    assert.equal(calls.length, 2, `expected 2 calls, got ${calls.length}`);
  });

  test('a 5xx IS retried, but only up to maxAttempts', async () => {
    responder = () => ({ ok: false, status: 503, text: 'upstream down' });
    const { failed } = await sendMany(people(1), msg, { ...opts, maxAttempts: 2, pauseMs: 1 });
    // 1 batch + 2 individual attempts
    assert.equal(calls.length, 3, `expected 3 calls, got ${calls.length}`);
    assert.equal(failed.length, 1);
  });

  test('flags the daily quota distinctly from a per-second rate limit', async () => {
    responder = () => ({ ok: false, status: 429, text: 'You have reached your daily quota' });
    const r = await sendMany(people(2), msg, { ...opts, maxAttempts: 1, pauseMs: 1 });
    assert.equal(r.dailyQuota, true, 'daily quota should be flagged so a teacher can be told');
    assert.equal(r.sent.length, 0);
  });

  test('a plain 429 is not mistaken for the daily quota', async () => {
    responder = () => ({ ok: false, status: 429, text: 'Too many requests' });
    const r = await sendMany(people(1), msg, { ...opts, maxAttempts: 1, pauseMs: 1 });
    assert.equal(r.dailyQuota, false);
  });

  test('never throws, even when everything fails', async () => {
    responder = () => ({ ok: false, status: 500, text: 'boom' });
    const r = await sendMany(people(5), msg, { ...opts, maxAttempts: 1, pauseMs: 1 });
    assert.equal(r.sent.length, 0);
    assert.equal(r.failed.length, 5);
  });
});

describe('sendMany — Brevo transport still works', () => {
  const opts = { apiKey: 'k', sender: { email: 'src@src.recallschool.com', name: 'SRC' }, provider: 'brevo', pauseMs: 1 };

  test('sends individually (Brevo has no batch endpoint)', async () => {
    const { sent } = await sendMany(people(12), msg, opts);
    assert.equal(sent.length, 12);
    assert.equal(calls.length, 12);
    assert.ok(calls[0].url.includes('brevo.com'));
  });

  test('uses the api-key header, not Bearer', async () => {
    await sendMany(people(1), msg, { ...opts, apiKey: 'SECRET_KEY' });
    assert.equal(calls[0].headers['api-key'], 'SECRET_KEY');
  });

  test('never fires all requests simultaneously', async () => {
    let inFlight = 0, peak = 0;
    globalThis.fetch = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 8));
      inFlight--;
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    };
    await sendMany(people(50), msg, opts);
    assert.ok(peak <= 8, `peak concurrency was ${peak}`);
  });
});

describe('provider selection', () => {
  test('defaults to resend', () => {
    assert.equal(getTransport(undefined).name, 'resend');
  });
  test('rejects an unknown provider loudly', () => {
    assert.throws(() => getTransport('sendgrid'), /Unknown email provider/);
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

/* ---- callable error translation ------------------------------------------ */

// The client SDK reports the bare code "internal" for two very different
// situations: the function crashed, or the request never arrived. Those need
// opposite fixes. explained() removes the first case, so a bare "internal" in
// the browser can only mean the second.
describe('explained() — no callable failure surfaces as bare "internal"', () => {
  test('an unexpected throw becomes a message a teacher can act on', async () => {
    const wrapped = explained(async () => { throw new TypeError('sender is not a function'); });

    await assert.rejects(wrapped({}), (e) => {
      // Must be a real HttpsError, not the raw throw leaking through — that is
      // the case the browser renders as the useless bare code.
      assert.ok(e instanceof HttpsError, `expected HttpsError, got ${e?.constructor?.name}`);
      assert.equal(e.code, 'unknown');
      assert.notEqual(e.code, 'internal');
      assert.match(e.message, /Server error/);
      assert.match(e.message, /sender is not a function/);
      return true;
    });
  });

  test('a deliberate HttpsError passes through untouched', async () => {
    const original = new HttpsError('permission-denied', 'Teachers only.');
    const wrapped = explained(async () => { throw original; });

    await assert.rejects(wrapped({}), (e) => {
      assert.equal(e, original);
      assert.equal(e.message, 'Teachers only.');
      return true;
    });
  });

  test('a successful handler is returned unchanged', async () => {
    assert.deepEqual(await explained(async () => ({ sent: 3 }))({}), { sent: 3 });
  });

  test('a non-Error throw still yields a readable message', async () => {
    const wrapped = explained(async () => { throw 'plain string blew up'; });
    await assert.rejects(wrapped({}), (e) => {
      assert.ok(e instanceof HttpsError);
      assert.match(e.message, /plain string blew up/);
      return true;
    });
  });
});
