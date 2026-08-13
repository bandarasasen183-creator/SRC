// Brevo transactional email client + templates.
//
// Why Brevo: its free tier is 300 emails/day (~9,000/month) with full
// transactional API access and no card. At 50 students that is 6 announcements
// a day. Resend's free tier caps at 100/day (2 announcements), and MailerSend
// cut its free tier to 500/month in late 2025. See README for the comparison.

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

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

/**
 * Send one transactional email through Brevo.
 * Throws on non-2xx so the caller can record the failure.
 */
export async function sendOne({ apiKey, sender, to, subject, html, text, timeoutMs = 15000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender,
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send to many recipients with bounded concurrency and a pause between
 * batches, so we never fire 50 simultaneous requests at the provider.
 * Never throws — returns a per-address outcome.
 */
export async function sendMany(recipients, buildMessage, {
  apiKey, sender, batchSize = 8, pauseMs = 400, maxAttempts = 2,
}) {
  const sent = [];
  const failed = [];

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    await Promise.all(batch.map(async (r) => {
      const msg = buildMessage(r);
      // Bounded retries. A 4xx is a permanent error (bad address, bad key)
      // and is never retried — retrying those is what burns quota and
      // reputation for no benefit.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await sendOne({ apiKey, sender, to: r.email, ...msg });
          sent.push(r.email);
          return;
        } catch (e) {
          const permanent = e.status >= 400 && e.status < 500 && e.status !== 429;
          if (permanent || attempt === maxAttempts) {
            failed.push({ email: r.email, error: String(e.message || e).slice(0, 200) });
            return;
          }
          await new Promise((res) => setTimeout(res, 500 * attempt));
        }
      }
    }));

    if (i + batchSize < recipients.length) {
      await new Promise((res) => setTimeout(res, pauseMs));
    }
  }
  return { sent, failed };
}

/* ---- templates ----------------------------------------------------------- */

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
export function announcementEmail({ title, body, appUrl, announcementId, hasForm }) {
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
