// A small rich-text editor: you see bold text, not `**bold**`.
//
// WHY IT STILL STORES MARKDOWN
// The editing surface is contenteditable, but what gets saved is markdown, and
// what gets displayed is still built by renderBody(), which escapes everything
// before it formats anything. So no HTML a person can produce — typed, pasted,
// or poked in with devtools — is ever stored or rendered as markup. A rich
// editor that saves innerHTML is the usual way an app like this grows an XSS
// hole, and student data is behind this login.
//
// Keeping markdown as the storage format also means announcements written
// before this editor existed still render, and the notification emails (which
// strip markdown to plain text) need no changes.

import { h, icon, safeUrl } from './ui.js';

/* ---- markdown out of the DOM --------------------------------------------- */

/** Escape the characters that would otherwise be read back as formatting. */
function escapeMd(text) {
  return String(text)
    // contenteditable pads with non-breaking spaces; markdown wants plain ones.
    .replace(/ /g, ' ')
    .replace(/([\\*[\]])/g, '\\$1');
}

const INLINE_WRAP = {
  b: '**', strong: '**',
  i: '*', em: '*',
};

/** Markdown for the inline content of a node (text, bold, italic, links). */
function inlineMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeMd(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.nodeName.toLowerCase();
  const inner = childrenMd(node);

  if (tag === 'br') return '\n';

  if (INLINE_WRAP[tag]) {
    // Don't emit ** ** around nothing — it would render as literal asterisks.
    if (!inner.trim()) return inner;
    const mark = INLINE_WRAP[tag];
    // Markdown can't carry the marker across the surrounding spaces, so hoist
    // them out: " **bold** " rather than "** bold **", which does not format.
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return `${lead}${mark}${core}${mark}${tail}`;
  }

  if (tag === 'a') {
    const href = safeUrl(node.getAttribute('href') || '');
    return href && inner.trim() ? `[${inner}](${href})` : inner;
  }

  // span, font, or anything pasted in that we don't model: keep the words,
  // drop the markup. This is the whitelist doing its job.
  return inner;
}

function childrenMd(node) {
  return Array.from(node.childNodes).map(inlineMd).join('');
}

const BLOCK_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote']);
const isBlock = (n) => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.nodeName.toLowerCase());

function blockMd(node, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = escapeMd(node.nodeValue);
    if (t.trim()) out.push(t);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.nodeName.toLowerCase();

  if (tag === 'h1' || tag === 'h2') { out.push(`## ${childrenMd(node)}`.trimEnd()); return; }
  if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    out.push(`### ${childrenMd(node)}`.trimEnd());
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    let n = 1;
    for (const li of Array.from(node.children)) {
      if (li.nodeName.toLowerCase() !== 'li') continue;
      const text = childrenMd(li).trim();
      out.push(tag === 'ul' ? `- ${text}` : `${n++}. ${text}`);
    }
    return;
  }

  if (tag === 'br') { out.push(''); return; }

  if (tag === 'div' || tag === 'p' || tag === 'blockquote') {
    // An empty wrapper is the blank line you get from pressing Enter twice.
    if (!node.textContent.trim() && !node.querySelector('ul, ol, h1, h2, h3, h4, h5, h6')) {
      out.push('');
      return;
    }
    blocksFrom(node, out);
    return;
  }

  out.push(inlineMd(node));
}

/**
 * Walk a parent's children, gathering consecutive INLINE siblings into a single
 * line and letting block elements break it.
 *
 * The grouping is the whole point. "Bring your <b>ideas</b> today" is three
 * sibling nodes; handling them one at a time emitted three separate lines and
 * split the sentence apart wherever a bold word appeared.
 */
function blocksFrom(parent, out) {
  let run = [];

  const flush = () => {
    if (!run.length) return;
    const line = run.join('').replace(/\s+$/, '');
    if (line.trim()) out.push(line);
    run = [];
  };

  for (const child of Array.from(parent.childNodes)) {
    const tag = child.nodeType === Node.ELEMENT_NODE ? child.nodeName.toLowerCase() : '';

    if (tag === 'br') {
      // A line break inside a block ends the line but does not open a gap:
      // adjacent lines render as <br>, a blank line between them as a new
      // paragraph. Those are different things and users mean different things.
      flush();
      continue;
    }
    if (isBlock(child)) { flush(); blockMd(child, out); continue; }
    run.push(inlineMd(child));
  }

  flush();
}

/** Serialise an editor's DOM to the markdown we store. Exported for tests. */
export function domToMarkdown(root) {
  const out = [];
  blocksFrom(root, out);
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse runs of blank lines
    .trim();
}

/* ---- the editor ----------------------------------------------------------- */

const TOOLS = [
  { cmd: 'formatBlock', arg: 'h2', ic: 'type', label: 'Title' },
  { cmd: 'formatBlock', arg: 'h3', ic: 'type', label: 'Subtitle', small: true },
  { sep: true },
  { cmd: 'bold', ic: 'bold', label: 'Bold' },
  { cmd: 'italic', ic: 'italic', label: 'Italic' },
  { cmd: 'createLink', ic: 'link', label: 'Link' },
  { sep: true },
  { cmd: 'insertUnorderedList', ic: 'list', label: 'Bullet list' },
  { cmd: 'insertOrderedList', ic: 'list-ol', label: 'Numbered list' },
  { sep: true },
  { cmd: 'removeFormat', ic: 'eraser', label: 'Clear formatting' },
];

/**
 * Build a rich-text editor.
 *
 * @param {string} initialMarkdown  existing body, rendered into the surface
 * @param {object} opts             { placeholder, onChange }
 * @returns {{ el, getMarkdown, setMarkdown, focus }}
 */
export function richEditor(initialMarkdown = '', opts = {}) {
  const { placeholder = 'Write something…', onChange, renderMarkdown } = opts;

  const wrap = h(`
    <div class="rte">
      <div class="rte-bar" role="toolbar" aria-label="Formatting">
        ${TOOLS.map((t) => (t.sep
    ? '<span class="rte-sep" aria-hidden="true"></span>'
    : `<button type="button" class="rte-btn${t.small ? ' sm' : ''}"
                 data-cmd="${t.cmd}" ${t.arg ? `data-arg="${t.arg}"` : ''}
                 title="${t.label}" aria-label="${t.label}" aria-pressed="false"
                 >${icon(t.ic, t.small ? 13 : 16)}</button>`)).join('')}
      </div>
      <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true"
           data-placeholder="${placeholder}"></div>
    </div>
  `);

  const area = wrap.querySelector('.rte-area');

  // Seed the surface from markdown using the same renderer the feed uses, so
  // what you edit is literally what readers will see.
  if (renderMarkdown) area.innerHTML = initialMarkdown ? renderMarkdown(initialMarkdown) : '';

  // Emit <b>/<i> rather than <span style>, which serialises far more cleanly.
  try { document.execCommand('styleWithCSS', false, false); } catch { /* not supported */ }

  const syncPlaceholder = () => {
    wrap.classList.toggle('is-empty', !area.textContent.trim() && !area.querySelector('li, h2, h3'));
  };
  syncPlaceholder();

  const changed = () => { syncPlaceholder(); onChange?.(); };
  area.addEventListener('input', changed);

  // Paste as plain text. Pasting from Word or Docs otherwise drags in a pile of
  // markup; we would throw it away at save time anyway, so drop it up front
  // where the person can see what they actually got.
  area.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Same for drag-and-drop, which is a second route to the same problem.
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    const text = e.dataTransfer?.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });

  /** Reflect the caret's current formatting on the toolbar. */
  const refresh = () => {
    if (!area.isConnected) return;
    for (const btn of wrap.querySelectorAll('[data-cmd]')) {
      const { cmd, arg } = btn.dataset;
      let on = false;
      try {
        on = arg
          ? document.queryCommandValue('formatBlock').toLowerCase() === arg
          : document.queryCommandState(cmd);
      } catch { on = false; }
      btn.setAttribute('aria-pressed', String(on));
    }
  };
  document.addEventListener('selectionchange', () => {
    if (area.contains(document.getSelection()?.anchorNode)) refresh();
  });

  for (const btn of wrap.querySelectorAll('[data-cmd]')) {
    // mousedown, not click: click fires after the editor has already lost the
    // selection, and every command needs that selection.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const { cmd, arg } = btn.dataset;
      area.focus();

      if (cmd === 'createLink') {
        const url = (window.prompt('Link address', 'https://') || '').trim();
        if (!url) return;
        const safe = safeUrl(url);
        if (!safe) { window.alert('Links must start with http:// or https://'); return; }
        document.execCommand('createLink', false, safe);
      } else if (cmd === 'formatBlock') {
        // Pressing Title on a line that is already a Title turns it back off.
        const current = (() => {
          try { return document.queryCommandValue('formatBlock').toLowerCase(); } catch { return ''; }
        })();
        document.execCommand('formatBlock', false, current === arg ? 'div' : arg);
      } else {
        document.execCommand(cmd, false, null);
      }

      refresh();
      changed();
    });
  }

  return {
    el: wrap,
    focus: () => area.focus(),
    getMarkdown: () => domToMarkdown(area),
    setMarkdown: (md) => {
      area.innerHTML = md && renderMarkdown ? renderMarkdown(md) : '';
      syncPlaceholder();
    },
  };
}
