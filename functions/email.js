// Transactional email: provider transports + message templates.
//
// Provider is selected by the EMAIL_PROVIDER param ('resend' by default).
// Both transports present the same sendMany() interface, so switching is a
// config change, not a code change — which matters here, because Resend's
// free tier caps at 100 emails/DAY and you may outgrow it (see README §3).

/** Escape for safe interpolation into the HTML email body. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Strip our markdown subset down to a readable plain-text extract. */
export function bodyExtract(text, max = 320) {
  const plain = String(text ?? '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fromHeader(sender) {
  return sender.name ? `${sender.name} <${sender.email}>` : sender.email;
}

async function postJson(url, headers, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      // Resend returns 429 both for the per-second rate limit and for the
      // daily quota. Surface the daily case distinctly — a teacher needs to
      // know "we're out of emails today", not "try again in a second".
      if (res.status === 429 && /daily|quota/i.test(detail)) err.dailyQuota = true;
      throw err;
    }
    return res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/* =============================================================================
   Resend
   ========================================================================== */

const RESEND_SEND = 'https://api.resend.com/emails';
const RESEND_BATCH = 'https://api.resend.com/emails/batch';

/** Resend's batch endpoint takes up to 100 messages and costs ONE rate unit. */
const RESEND_BATCH_MAX = 100;

function resendPayload(from, to, msg) {
  return { from, to: [to], subject: msg.subject, html: msg.html, text: msg.text };
}

const resendTransport = {
  name: 'resend',
  // Resend's documented default is 2 requests/second. One batch call covers
  // 100 recipients, so 50 students is a single request.
  batchSize: RESEND_BATCH_MAX,
  pauseMs: 600,

  async sendChunk({ apiKey, sender, chunk, buildMessage }) {
    const from = fromHeader(sender);
    const headers = { authorization: `Bearer ${apiKey}` };
    const payload = chunk.map((r) => resendPayload(from, r.email, buildMessage(r)));

    await postJson(RESEND_BATCH, headers, payload);
    return chunk.map((r) => r.email);
  },

  async sendSingle({ apiKey, sender, recipient, buildMessage }) {
    const from = fromHeader(sender);
    const headers = { authorization: `Bearer ${apiKey}` };
    await postJson(RESEND_SEND, headers, resendPayload(from, recipient.email, buildMessage(recipient)));
  },
};

/* =============================================================================
   Brevo (kept as a drop-in alternative — 300/day vs Resend's 100/day)
   ========================================================================== */

const BREVO_SEND = 'https://api.brevo.com/v3/smtp/email';

const brevoTransport = {
  name: 'brevo',
  batchSize: 8,      // Brevo has no batch endpoint; send individually
  pauseMs: 400,

  async sendChunk({ apiKey, sender, chunk, buildMessage }) {
    // No batch endpoint — signal that the caller should send individually.
    throw Object.assign(new Error('no batch endpoint'), { noBatch: true });
  },

  async sendSingle({ apiKey, sender, recipient, buildMessage }) {
    const msg = buildMessage(recipient);
    await postJson(BREVO_SEND, { 'api-key': apiKey, accept: 'application/json' }, {
      sender,
      to: [{ email: recipient.email }],
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
    });
  },
};

export const TRANSPORTS = { resend: resendTransport, brevo: brevoTransport };

export function getTransport(name) {
  const t = TRANSPORTS[String(name || 'resend').toLowerCase()];
  if (!t) throw new Error(`Unknown email provider: ${name}`);
  return t;
}

/* =============================================================================
   sendMany — the one interface the functions use
   ========================================================================== */

const isPermanent = (e) => e.status >= 400 && e.status < 500 && e.status !== 429;

/**
 * Deliver `buildMessage(recipient)` to every recipient.
 *
 * Never throws. Returns { sent: [email], failed: [{email, error}], dailyQuota }.
 *
 * Where the provider supports batching (Resend), a chunk goes out in one
 * request. If that request fails, the chunk is retried ONE AT A TIME so a
 * single malformed address costs only itself instead of taking the whole
 * mailout down with it.
 */
export async function sendMany(recipients, buildMessage, {
  apiKey, sender, provider = 'resend', maxAttempts = 2,
  batchSize: batchSizeOverride, pauseMs: pauseOverride,
} = {}) {
  const transport = getTransport(provider);
  const batchSize = batchSizeOverride ?? transport.batchSize;
  const pauseMs = pauseOverride ?? transport.pauseMs;

  const sent = [];
  const failed = [];
  let dailyQuota = false;

  const sendOneWithRetry = async (r) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await transport.sendSingle({ apiKey, sender, recipient: r, buildMessage });
        sent.push(r.email);
        return;
      } catch (e) {
        if (e.dailyQuota) dailyQuota = true;
        // A 4xx is a permanent error (bad address, bad key). Retrying those
        // burns quota and reputation for no benefit.
        if (isPermanent(e) || attempt === maxAttempts) {
          failed.push({ email: r.email, error: String(e.message || e).slice(0, 200) });
          return;
        }
        await sleep(500 * attempt);
      }
    }
  };

  for (let i = 0; i < recipients.length; i += batchSize) {
    const chunk = recipients.slice(i, i + batchSize);
    let batched = false;

    try {
      const ok = await transport.sendChunk({ apiKey, sender, chunk, buildMessage });
      sent.push(...ok);
      batched = true;
    } catch (e) {
      if (e.dailyQuota) dailyQuota = true;
      if (!e.noBatch) {
        // Batch failed as a unit — fall back so one bad address doesn't
        // silently cost the other 49 theirs.
        console.warn(`batch of ${chunk.length} failed (${e.message}); retrying individually`);
      }
    }

    if (!batched) {
      // Bounded concurrency: never fire the whole chunk simultaneously.
      const lane = Math.min(8, chunk.length);
      for (let j = 0; j < chunk.length; j += lane) {
        await Promise.all(chunk.slice(j, j + lane).map(sendOneWithRetry));
        if (j + lane < chunk.length) await sleep(pauseMs);
      }
    }

    if (i + batchSize < recipients.length) await sleep(pauseMs);
  }

  return { sent, failed, dailyQuota };
}

/* =============================================================================
   Templates
   ========================================================================== */

const SHELL = (inner) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#f2f9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a1a12">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f9f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #d5e8dd">
<tr><td style="background:#0f5a3a;padding:18px 24px">
  <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-.02em">SRC</span>
  <span style="color:#b6f0ce;font-size:13px;margin-left:8px">Student Representative Council</span>
</td></tr>
${inner}
</table>
</td></tr></table>
</body></html>`;

/** Announcement notification. Subject is always "SRC update …". */
export function announcementEmail({ title, body, appUrl, hasForm }) {
  const link = `${appUrl}/#/feed`;
  const extract = bodyExtract(body);

  const html = SHELL(`
<tr><td style="padding:24px">
  <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#4d6a5b;font-weight:700">New announcement</p>
  <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:#0a1a12">${esc(title)}</h1>
  <div style="font-size:15px;line-height:1.6;color:#2b4438;white-space:pre-line">${esc(extract)}</div>
  ${hasForm ? `<p style="margin:16px 0 0;font-size:14px;color:#0f5a3a;font-weight:600">📋 There's a form to fill in with this one.</p>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px">
    <tr><td style="background:#0f5a3a;border-radius:999px">
      <a href="${esc(link)}" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">Open the SRC site</a>
    </td></tr>
  </table>
  <p style="margin:14px 0 0;font-size:13px;color:#7b9488">
    Everything is always available in the app, whether or not this email reaches you:<br>
    <a href="${esc(link)}" style="color:#0f5a3a">${esc(appUrl)}</a>
  </p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f1fcf6;border-top:1px solid #d5e8dd;font-size:12px;color:#7b9488">
  You're getting this because you're on the SRC roster. Talk to your SRC teacher to be removed.
</td></tr>`);

  const text = [
    `SRC update: ${title}`, '', extract, '',
    hasForm ? 'There is a form to fill in with this announcement.' : '',
    `Open the SRC site: ${link}`, '',
    "Everything is always in the app, whether or not this email reaches you.",
  ].filter(Boolean).join('\n');

  return {
    // "SRC update" first so it's the recognisable part in an inbox list.
    subject: `SRC update — ${title}`.slice(0, 180),
    html,
    text,
  };
}

/** Invitation containing a sign-in link. */
export function inviteEmail({ signInLink, appUrl, invitedBy }) {
  const html = SHELL(`
<tr><td style="padding:24px">
  <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:#0a1a12">You've been added to the SRC site</h1>
  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#2b4438">
    ${invitedBy ? `${esc(invitedBy)} added you.` : 'Your SRC teacher added you.'}
    Tap the button to sign in — there's no password to create or remember.
  </p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px">
    <tr><td style="background:#0f5a3a;border-radius:999px">
      <a href="${esc(signInLink)}" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">Sign in to SRC</a>
    </td></tr>
  </table>
  <p style="margin:0;font-size:13px;color:#7b9488">
    This link signs you in on the device you open it on, and expires after a while.
    If it stops working, go to <a href="${esc(appUrl)}" style="color:#0f5a3a">${esc(appUrl)}</a>
    and ask for a new one.
  </p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f1fcf6;border-top:1px solid #d5e8dd;font-size:12px;color:#7b9488">
  If you weren't expecting this, you can ignore it — nothing happens until you tap the link.
</td></tr>`);

  const text = [
    "You've been added to the SRC site.",
    invitedBy ? `${invitedBy} added you.` : '',
    '', 'Sign in (no password needed):', signInLink, '',
    `Or go to ${appUrl} and ask for a new link.`,
  ].filter(Boolean).join('\n');

  return { subject: 'Your SRC sign-in link', html, text };
}
