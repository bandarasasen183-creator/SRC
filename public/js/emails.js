// Email normalising + the chip/tag input teachers use to add students.
//
// The parsing functions are pure and are covered by tests/emails.test.js.

export const DEFAULT_DOMAIN = 'education.nsw.gov.au';

// Deliberately permissive: we are not trying to police what a valid address
// looks like, only to catch obvious typos like a double @ or a missing TLD.
const SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/**
 * Normalise one token into an address.
 *   'john.smith'                        -> john.smith@education.nsw.gov.au
 *   'john.smith2'                       -> john.smith2@education.nsw.gov.au
 *   'John.Smith '                       -> john.smith@education.nsw.gov.au
 *   'john.smith@education.nsw.gov.au'   -> unchanged (domain NOT appended twice)
 *   'someone@otherschool.edu'           -> unchanged (different domain kept)
 *   'John Smith <j.s@x.com>'            -> j.s@x.com
 * Returns { email, valid, raw }.
 */
export function normaliseEmail(raw, domain = DEFAULT_DOMAIN) {
  let t = String(raw ?? '').trim();

  // "Display Name <addr@host>" — common when pasting out of Outlook/Sheets.
  const angled = /<([^>]+)>/.exec(t);
  if (angled) t = angled[1].trim();

  // Strip stray wrapping quotes and trailing punctuation from spreadsheet cells.
  t = t.replace(/^["']+|["']+$/g, '').replace(/[.,;]+$/, '').trim();

  if (!t) return { email: '', valid: false, raw };

  // Already an address? Leave the domain exactly as the teacher typed it —
  // some staff addresses are on a different domain.
  const email = (t.includes('@') ? t : `${t}@${domain}`).toLowerCase();

  return { email, valid: SHAPE.test(email), raw };
}

/**
 * Split a pasted blob into tokens. Handles comma, semicolon, newline, tab and
 * space separation, mixed bare names and full addresses, in one paste.
 */
export function splitTokens(text) {
  const s = String(text ?? '');
  const tokens = [];

  // Pull out "Name <addr>" groups first, so the space inside them does not
  // split the name away from the address.
  const rest = s.replace(/[^<>,;\n\r\t]*<[^>]+>/g, (m) => {
    tokens.push(m);
    return ' ';
  });

  for (const part of rest.split(/[,;\n\r\t ]+/)) {
    if (part.trim()) tokens.push(part);
  }
  return tokens;
}

/**
 * Parse a blob into a deduplicated list of results, preserving order.
 * Duplicates are dropped silently, as specified.
 */
export function parseEmailList(text, domain = DEFAULT_DOMAIN, existing = []) {
  const seen = new Set(existing.map((e) => e.toLowerCase()));
  const out = [];
  for (const tok of splitTokens(text)) {
    const r = normaliseEmail(tok, domain);
    if (!r.email || seen.has(r.email)) continue;
    seen.add(r.email);
    out.push(r);
  }
  return out;
}

/* ---- the chip input component -------------------------------------------- */

/**
 * Mount a chip input into `mount`.
 * Returns { getValid, getAll, clear, focus, count }.
 */
export function chipInput(mount, { placeholder = 'name, name, …', domain = DEFAULT_DOMAIN } = {}) {
  const box = document.createElement('div');
  box.className = 'chipbox';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', 'Student email addresses');
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.spellcheck = false;
  box.appendChild(input);
  mount.replaceChildren(box);

  /** @type {{email:string, valid:boolean}[]} */
  let items = [];

  function render() {
    // Remove existing chips, keep the input node.
    [...box.querySelectorAll('.chip')].forEach((c) => c.remove());
    for (const it of items) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (it.valid ? '' : ' bad');
      if (!it.valid) chip.title = "That doesn't look like a valid address";

      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = it.email;
      chip.appendChild(txt);

      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${it.email}`);
      x.onclick = () => { items = items.filter((v) => v !== it); render(); };
      chip.appendChild(x);

      box.insertBefore(chip, input);
    }
    mount.dispatchEvent(new CustomEvent('chipchange', { detail: { count: items.length } }));
  }

  function addFrom(text) {
    const added = parseEmailList(text, domain, items.map((i) => i.email));
    if (added.length) { items.push(...added); render(); }
    return added.length;
  }

  function commitTyped() {
    if (!input.value.trim()) return false;
    const n = addFrom(input.value);
    input.value = '';
    return n > 0;
  }

  input.addEventListener('keydown', (e) => {
    // Comma is the primary commit key, per spec; Enter and Tab also work.
    if (e.key === ',' || e.key === 'Enter' || e.key === 'Tab') {
      if (!input.value.trim()) {
        if (e.key === ',') e.preventDefault();
        return; // let Tab move focus normally when there is nothing to commit
      }
      e.preventDefault();
      commitTyped();
    } else if (e.key === 'Backspace' && input.value === '' && items.length) {
      items.pop();
      render();
    }
  });

  // Some mobile keyboards insert the comma without a keydown we can cancel.
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) {
      const text = input.value;
      input.value = '';
      addFrom(text);
    }
  });

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    addFrom(text);
  });

  input.addEventListener('blur', () => { commitTyped(); box.classList.remove('focus'); });
  input.addEventListener('focus', () => box.classList.add('focus'));
  box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });

  return {
    getValid: () => { commitTyped(); return items.filter((i) => i.valid).map((i) => i.email); },
    getAll: () => { commitTyped(); return items.slice(); },
    getInvalid: () => items.filter((i) => !i.valid).map((i) => i.email),
    clear: () => { items = []; input.value = ''; render(); },
    focus: () => input.focus(),
    count: () => items.length,
  };
}
