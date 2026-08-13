// Small DOM + rendering helpers. No framework.

/** Escape text for safe interpolation into HTML. Used on EVERY user string. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Build an element from an HTML string. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function toast(msg, bad = false) {
  const el = h(`<div class="toast${bad ? ' bad' : ''}">${esc(msg)}</div>`);
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, bad ? 5200 : 3000);
}

/**
 * Modal dialog. Returns a { root, close } handle. `onClose` fires for any
 * dismissal path (backdrop, Escape, close()).
 */
export function modal(innerHtml, { onClose } = {}) {
  const bg = h(`<div class="modal-bg" role="dialog" aria-modal="true"><div class="modal">${innerHtml}</div></div>`);
  const close = () => {
    if (!bg.isConnected) return;
    bg.remove();
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(bg);
  const first = bg.querySelector('input,textarea,select,button');
  first?.focus();
  return { root: bg.querySelector('.modal'), close };
}

/** Promise-based confirm dialog (never uses window.confirm). */
export function confirmDialog(title, body, { danger = true, okLabel = 'Delete' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(`
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(body)}</p>
      <div class="btn-row" style="justify-content:flex-end;margin-top:16px">
        <button class="btn ghost" data-no>Cancel</button>
        <button class="btn ${danger ? 'danger' : ''}" data-yes>${esc(okLabel)}</button>
      </div>`, { onClose: () => { if (!done) resolve(false); } });
    m.root.querySelector('[data-no]').onclick = () => { done = true; m.close(); resolve(false); };
    m.root.querySelector('[data-yes]').onclick = () => { done = true; m.close(); resolve(true); };
  });
}

/* ---- lightweight markdown ------------------------------------------------
   Deliberately NOT a full markdown engine and deliberately not contenteditable.
   Input is escaped FIRST, then a small set of patterns is turned into markup,
   so there is no path from a teacher's text to injected HTML.
   Supports: **bold**, *italic*, [text](url), bare urls, - bullets, 1. numbers.
--------------------------------------------------------------------------- */

function safeUrl(url) {
  const u = String(url).trim();
  // Only http(s). Blocks javascript:, data:, vbscript: and friends.
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function inline(escaped) {
  let s = escaped;
  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const safe = safeUrl(url.replaceAll('&amp;', '&'));
    if (!safe) return text;
    return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
  });
  // bare urls not already inside an href
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
    const safe = safeUrl(url.replaceAll('&amp;', '&'));
    if (!safe) return m;
    return `${pre}<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

/** Render a restricted markdown subset to safe HTML. */
export function renderBody(text) {
  const lines = esc(text ?? '').split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; }
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (bullet) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(bullet[1])}</li>`);
    } else if (numbered) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(numbered[1])}</li>`);
    } else if (line.trim() === '') {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  return out.join('') || '<p class="muted">(no text)</p>';
}

/** Plain-text extract of a markdown body, for email previews. */
export function bodyExtract(text, max = 300) {
  const plain = String(text ?? '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

/* ---- dates --------------------------------------------------------------- */

export function fmtDate(d) {
  if (!d) return '';
  const dt = d.toDate ? d.toDate() : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtWhen(ts) {
  if (!ts) return '';
  const dt = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(dt.getTime())) return '';
  const mins = Math.round((Date.now() - dt.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d ago`;
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---- misc ---------------------------------------------------------------- */

export function busy(btn, on, labelWhileBusy = 'Working…') {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = labelWhileBusy;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

/** Turn an error into something a student can read. */
export function friendlyError(e) {
  const code = e?.code || '';
  const map = {
    'permission-denied': "You don't have permission to do that.",
    'auth/invalid-email': 'That email address does not look right.',
    'auth/invalid-action-code': 'That sign-in link has expired or has already been used. Ask for a new one.',
    'auth/expired-action-code': 'That sign-in link has expired. Ask for a new one.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/user-not-found': 'No account for that address.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'auth/weak-password': 'That password is too short — use at least 6 characters.',
    'unavailable': 'Cannot reach the server. Check your connection.',
  };
  return map[code] || e?.message || 'Something went wrong.';
}
