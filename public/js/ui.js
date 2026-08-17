// Small DOM + rendering helpers. No framework.

const FONT = 'system-ui,Roboto,Arial,sans-serif';

let logoCount = 0;

/**
 * The SRC badge, redrawn as SVG from the official logo: green-to-teal circle,
 * mountain silhouette, dotted waves, SRC wordmark. `full` adds the circular
 * rim text (readable from ~96px up); the small variant drops it so the badge
 * stays legible in the top bar and favicon.
 *
 * The wave rows carry classes w1–w4 so CSS can drift them like water.
 */
function drawnBadge(size = 28, { full = false } = {}) {
  const u = `lg${++logoCount}`;
  const R = full ? 79 : 90;

  const rows = full
    ? [
        { y: 112, fill: '#ffffff', op: .95, ph: 0.0, cls: 'w1' },
        { y: 124, fill: '#3fae66', op: .9, ph: 1.4, cls: 'w2' },
        { y: 136, fill: '#ffffff', op: .95, ph: 2.2, cls: 'w3' },
        { y: 148, fill: '#3fae66', op: .8, ph: 0.7, cls: 'w4' },
      ]
    : [
        { y: 118, fill: '#ffffff', op: .95, ph: 0.0, cls: 'w1' },
        { y: 132, fill: '#3fae66', op: .9, ph: 1.4, cls: 'w2' },
        { y: 146, fill: '#ffffff', op: .95, ph: 2.2, cls: 'w3' },
      ];
  const dots = rows.map((row) => {
    let c = '';
    for (let x = 16; x <= 184; x += 11) {
      const y = row.y + 6 * Math.sin(((x - 16) / 168) * Math.PI * 2.2 + row.ph);
      c += `<circle cx="${x}" cy="${y.toFixed(1)}" r="${full ? 3.6 : 4.6}" fill="${row.fill}" opacity="${row.op}"/>`;
    }
    return `<g class="${row.cls}">${c}</g>`;
  }).join('');

  const rim = full ? `
    <circle cx="100" cy="100" r="95.5" fill="none" stroke="#fff" stroke-width="1.4" opacity=".9"/>
    <circle cx="100" cy="100" r="${R}" fill="none" stroke="#fff" stroke-width="2.4"/>
    <defs>
      <path id="${u}-top" d="M 20.2 85.9 A 81 81 0 0 1 179.8 85.9"/>
      <path id="${u}-bot" d="M 14.3 115.1 A 87 87 0 0 0 185.7 115.1"/>
    </defs>
    <text font-family="${FONT}" font-size="11.5" font-weight="700" fill="#fff">
      <textPath href="#${u}-top" startOffset="50%" text-anchor="middle" textLength="211" lengthAdjust="spacingAndGlyphs">STUDENT REPRESENTATIVE COUNCIL</textPath>
    </text>
    <text font-family="${FONT}" font-size="10.8" font-weight="700" fill="#fff">
      <textPath href="#${u}-bot" startOffset="50%" text-anchor="middle" textLength="222" lengthAdjust="spacingAndGlyphs">LEADERSHIP · UNITY · REPRESENTATION</textPath>
    </text>`
    : `<circle cx="100" cy="100" r="${R}" fill="none" stroke="#fff" stroke-width="3"/>`;

  const mtnBase = full ? 128 : 132;
  const mtnBot = full ? 152 : 158;

  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" class="logo-badge" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" style="display:block;flex:none">
    <defs>
      <linearGradient id="${u}-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1e9e4c"/>
        <stop offset=".48" stop-color="#1d8f55"/>
        <stop offset="1" stop-color="#19698a"/>
      </linearGradient>
      <clipPath id="${u}-c"><circle cx="100" cy="100" r="${R - 1}"/></clipPath>
    </defs>
    <circle cx="100" cy="100" r="98" fill="url(#${u}-bg)"/>
    <g clip-path="url(#${u}-c)">
      <path fill="#175339" d="M8 ${mtnBase} C30 ${mtnBase - 16} 50 104 66 76 C74 62 82 50 90 44 C96 39 104 39 110 46 C120 58 130 76 142 90 C156 106 172 114 192 120 L192 ${mtnBot} L8 ${mtnBot} Z"/>
      ${dots}
    </g>
    <text x="100" y="${full ? 158 : 156}" font-family="${FONT}" font-size="${full ? 30 : 46}" font-weight="800" letter-spacing="${full ? 7 : 5}" fill="#fff" text-anchor="middle">SRC</text>
    ${rim}
  </svg>`;
}

/**
 * The logo as used in the UI.
 *
 * If public/img/logo.png exists it is shown; if that request 404s the <img>
 * hides itself and the drawn SVG badge underneath shows through. That means
 * dropping in the official artwork is a file copy — no code change, and no
 * broken image if the file is ever missing.
 */
export function logoSvg(size = 28, opts = {}) {
  // On success the drawn badge is REMOVED, not just covered. The real logo is
  // a circular badge with transparent corners, so leaving the fallback
  // underneath would show green through those corners.
  return `<span class="logo-wrap" style="width:${size}px;height:${size}px">
    <img src="/img/logo.png" alt="" width="${size}" height="${size}" class="logo-img"
         onload="this.nextElementSibling && this.nextElementSibling.remove()"
         onerror="this.remove()">
    ${drawnBadge(size, opts)}
  </span>`;
}

/* ---- icons ----------------------------------------------------------------
   A small stroke-icon set (feather-style, 24×24, currentColor) so the UI
   never needs emoji. Add to ICONS as needed.
--------------------------------------------------------------------------- */

const ICONS = {
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6l-4 4H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8"/><path d="M18 5a9 9 0 0 1 0 14"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  'calendar-plus': '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="13.5" x2="12" y2="17.5"/><line x1="10" y1="15.5" x2="14" y2="15.5"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  'user-x': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>',
  comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  place: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3"/>',
  contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  eraser: '<path d="M20 20H8.5L3 14.5a2 2 0 0 1 0-2.8l7.7-7.7a2 2 0 0 1 2.8 0l6.5 6.5a2 2 0 0 1 0 2.8L13 20"/><line x1="18" y1="20" x2="20" y2="20"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  'list-ol': '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3a1 1 0 0 0-2 0"/>',
};

/** Inline stroke icon. Always use this instead of an emoji. */
export function icon(name, size = 18, cls = '') {
  const d = ICONS[name] || ICONS.alert;
  return `<svg class="ic${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/**
 * A grey placeholder shaped like the thing that is loading. Reads far better
 * than a spinner floating in space, because the page does not jump when the
 * real content lands.
 */
export function skeleton(rows = 3) {
  return Array.from({ length: rows }, () => `
    <div class="skel-card">
      <div class="skel skel-line title"></div>
      <div class="skel skel-line"></div>
      <div class="skel skel-line"></div>
      <div class="skel skel-line short"></div>
    </div>`).join('');
}

/* ---- people ----------------------------------------------------------------
   Initial-avatars. No uploads, no storage, no cost — just a coloured circle so
   a wall of names becomes scannable.
--------------------------------------------------------------------------- */

// Deliberately muted and all legible against white text. A name always gets
// the same colour, so people become recognisable at a glance.
const AVATAR_HUES = [
  '#1a73e8', '#188038', '#b06000', '#a8367f', '#5f6368',
  '#0b8043', '#c5221f', '#7b4fb5', '#00796b', '#8d6e63',
];

export function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarColour(name) {
  const s = String(name || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

/** A round initial-avatar. `size` in px. */
export function avatar(name, size = 28) {
  return `<span class="avatar" title="${esc(name || '')}" aria-hidden="true"
    style="width:${size}px;height:${size}px;background:${avatarColour(name)};
           font-size:${Math.round(size * 0.4)}px">${esc(initialsOf(name))}</span>`;
}

/** Avatar + name, for lists of people. */
export function avatarChip(name) {
  return `<span class="who-chip">${avatar(name, 22)}<span>${esc(name || 'Someone')}</span></span>`;
}

/** Trigger a client-side file download. */
export function downloadFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  // Only the first element is returned, so a second sibling root would vanish
  // without a trace. That has already cost one silently-missing list; say so
  // loudly rather than letting it happen again.
  if (t.content.children.length > 1) {
    console.error('h(): got %d root elements, all but the first are dropped. ' +
      'Wrap them in one container.', t.content.children.length, html.slice(0, 120));
  }
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

export function safeUrl(url) {
  const u = String(url).trim();
  // Only http(s). Blocks javascript:, data:, vbscript: and friends.
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

// Stand-in for a backslash-escaped character while the formatters run, so a
// literal asterisk the writer typed cannot be mistaken for emphasis. The editor
// escapes these on the way out; text written before it existed has no
// backslashes and so is unaffected.
const HOLD = '\u0000';

function inline(escaped) {
  let s = escaped;

  // Park \* \[ \] \\ out of reach of every rule below, and restore them last.
  s = s.replace(/\\([\\*[\]])/g, (m, ch) => `${HOLD}${ch.codePointAt(0)}${HOLD}`);

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

  // Restore the escaped characters as themselves. Safe to do last: all four are
  // plain punctuation, and esc() already neutralised anything HTML-special.
  s = s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (m, code) => String.fromCodePoint(+code));
  return s;
}

/** Render a restricted markdown subset to safe HTML. */
export function renderBody(text) {
  // Strip the placeholder codepoint so nobody can smuggle one in and interfere
  // with the escape handling in inline().
  const lines = esc(String(text ?? '').replaceAll(HOLD, '')).split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; }
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{2,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (heading) {
      flushPara(); closeList();
      // Only two levels are offered, and everything deeper folds into the
      // smaller one — a notice board does not need six.
      const tag = heading[1].length === 2 ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
    } else if (bullet) {
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
  // A null element here is nearly always event.currentTarget read after an
  // await, where the browser has already reset it. That used to throw from
  // inside a catch block, so the error handler died and the button stayed
  // disabled on "Saving…" forever. Complain, but do not take the handler down.
  if (!btn) {
    console.error('busy(): no element. Capture the button before any await — '
      + 'event.currentTarget is null once the event has finished dispatching.');
    return;
  }
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
    // Callable-function codes. Without these a teacher sees a bare
    // "internal", which tells them nothing.
    'functions/internal': "Couldn't reach the email service. It may still be deploying — try again in a minute.",
    'internal': "Couldn't reach the email service. It may still be deploying — try again in a minute.",
    'functions/unauthenticated': 'Sign in again and retry.',
    'functions/permission-denied': 'Teachers only.',
    'functions/failed-precondition': 'The email service is not set up yet. See README section 4.',
    'functions/resource-exhausted': 'Too many requests. Wait a minute and try again.',
    'functions/unavailable': 'The email service is unreachable right now. Try again shortly.',
    'functions/deadline-exceeded': 'That took too long. It may still have worked — check before retrying.',
    'functions/not-found': 'The email service is not deployed. Run: firebase deploy --only functions',
  };
  if (map[code]) return map[code];
  const msg = e?.message;
  // A bare code as the message ("internal") is not an explanation.
  if (!msg || msg === code || msg.length < 12) return 'Something went wrong. Try again.';
  return msg;
}
