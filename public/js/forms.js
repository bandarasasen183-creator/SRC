// Forms: the teacher's builder, the student's inline renderer, the teacher's
// response viewer, and CSV export (done entirely in the browser).

import {
  db, doc, collection, getDoc, getDocs, setDoc, updateDoc, serverTimestamp,
} from './fb.js';
import { esc, h, $, $$, toast, busy, friendlyError, confirmDialog, fmtWhen, icon } from './ui.js';

export const FIELD_TYPES = [
  { v: 'short_text',  label: 'Short text' },
  { v: 'long_text',   label: 'Long text / paragraph' },
  { v: 'choice_one',  label: 'Multiple choice (pick one)' },
  { v: 'choice_many', label: 'Checkboxes (pick many)' },
  { v: 'dropdown',    label: 'Dropdown' },
  { v: 'number',      label: 'Number' },
  { v: 'date',        label: 'Date' },
  { v: 'yesno',       label: 'Yes / no' },
];

const NEEDS_OPTIONS = new Set(['choice_one', 'choice_many', 'dropdown']);
const uid = () => 'f' + Math.random().toString(36).slice(2, 9);

export function blankField(type = 'short_text') {
  return {
    id: uid(), type, label: '', help: '', required: false,
    options: NEEDS_OPTIONS.has(type) ? ['Option 1', 'Option 2'] : [],
  };
}

/* =============================================================================
   Builder
   ========================================================================== */

/**
 * Mount the form builder. Returns { getForm, hasFields }.
 * `initial` may be an existing form object to edit.
 */
export function formBuilder(mount, initial = null) {
  let fields = initial?.fields?.map((f) => ({ ...f, options: [...(f.options || [])] })) || [blankField()];
  let allowMultiple = initial?.allowMultiple ?? false;
  let title = initial?.title || '';

  mount.replaceChildren(h(`
    <div>
      <label class="field">
        <span class="lbl">Form title</span>
        <input type="text" id="fbTitle" placeholder="e.g. Year 10 camp preferences" maxlength="120">
      </label>

      <label class="switch">
        <input type="checkbox" id="fbMulti">
        <span class="track"></span>
        <span class="sw-label">Allow more than one submission
          <span class="sw-sub">Off: each student answers once and it locks. On: they can change their answer later.</span>
        </span>
      </label>

      <h3 style="margin-top:18px">Questions</h3>
      <div id="fbFields"></div>
      <div class="btn-row">
        <button type="button" class="btn subtle sm" id="fbAdd">${icon('plus', 14)} Add question</button>
      </div>

      <h3 style="margin-top:22px">Live preview <span class="small muted">— what students see</span></h3>
      <div class="preview" id="fbPreview"></div>
    </div>
  `));

  const titleEl = $('#fbTitle', mount);
  const multiEl = $('#fbMulti', mount);
  const listEl = $('#fbFields', mount);
  const prevEl = $('#fbPreview', mount);

  titleEl.value = title;
  multiEl.checked = allowMultiple;
  titleEl.addEventListener('input', () => { title = titleEl.value; refreshPreview(); });
  multiEl.addEventListener('change', () => { allowMultiple = multiEl.checked; });

  $('#fbAdd', mount).onclick = () => { fields.push(blankField()); renderFields(); };

  function renderFields() {
    listEl.replaceChildren(...fields.map((f, i) => fieldCard(f, i)));
    refreshPreview();
  }

  function fieldCard(f, i) {
    const card = h(`
      <div class="fieldcard">
        <div class="fc-top">
          <select aria-label="Question type">
            ${FIELD_TYPES.map((t) => `<option value="${t.v}"${t.v === f.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
          <span class="spacer grow"></span>
          <button type="button" class="btn ghost icon sm" data-up title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up', 15)}</button>
          <button type="button" class="btn ghost icon sm" data-down title="Move down" aria-label="Move down" ${i === fields.length - 1 ? 'disabled' : ''}>${icon('down', 15)}</button>
          <button type="button" class="btn danger icon sm" data-del title="Delete question" aria-label="Delete question">${icon('trash', 14)}</button>
        </div>
        <input type="text" data-label placeholder="Question ${i + 1}" maxlength="200" style="margin-bottom:7px">
        <input type="text" data-help placeholder="Help text (optional)" maxlength="200" style="margin-bottom:7px">
        <div data-options></div>
        <label class="checkline" style="margin:4px 0 0">
          <input type="checkbox" data-req${f.required ? ' checked' : ''}>
          <span class="small">Required</span>
        </label>
      </div>
    `);

    const labelEl = card.querySelector('[data-label]');
    const helpEl = card.querySelector('[data-help]');
    labelEl.value = f.label;
    helpEl.value = f.help;
    labelEl.addEventListener('input', () => { f.label = labelEl.value; refreshPreview(); });
    helpEl.addEventListener('input', () => { f.help = helpEl.value; refreshPreview(); });
    card.querySelector('[data-req]').addEventListener('change', (e) => {
      f.required = e.target.checked; refreshPreview();
    });

    card.querySelector('select').addEventListener('change', (e) => {
      f.type = e.target.value;
      if (NEEDS_OPTIONS.has(f.type) && !f.options.length) f.options = ['Option 1', 'Option 2'];
      renderFields();
    });

    card.querySelector('[data-del]').onclick = () => {
      fields.splice(i, 1);
      if (!fields.length) fields.push(blankField());
      renderFields();
    };
    card.querySelector('[data-up]').onclick = () => {
      [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; renderFields();
    };
    card.querySelector('[data-down]').onclick = () => {
      [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; renderFields();
    };

    if (NEEDS_OPTIONS.has(f.type)) {
      const box = card.querySelector('[data-options]');
      box.appendChild(h('<div class="small muted" style="margin:4px 0 6px">Choices</div>'));
      f.options.forEach((opt, oi) => {
        const row = h(`<div class="opt-row">
          <input type="text" class="grow" maxlength="120">
          <button type="button" class="btn ghost icon sm" title="Remove choice" aria-label="Remove choice">${icon('x', 14)}</button>
        </div>`);
        const inp = row.querySelector('input');
        inp.value = opt;
        inp.addEventListener('input', () => { f.options[oi] = inp.value; refreshPreview(); });
        row.querySelector('button').onclick = () => {
          f.options.splice(oi, 1);
          if (!f.options.length) f.options.push('Option 1');
          renderFields();
        };
        box.appendChild(row);
      });
      const add = h(`<button type="button" class="btn subtle sm">${icon('plus', 13)} Add choice</button>`);
      add.onclick = () => { f.options.push(`Option ${f.options.length + 1}`); renderFields(); };
      box.appendChild(add);
    }

    return card;
  }

  function refreshPreview() {
    prevEl.replaceChildren(renderFormForStudent(
      { title, allowMultiple, fields },
      { preview: true }
    ));
  }

  renderFields();

  return {
    hasFields: () => fields.some((f) => f.label.trim()),
    getForm: () => ({
      title: title.trim() || 'Form',
      allowMultiple,
      fields: fields
        .filter((f) => f.label.trim())
        .map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label.trim(),
          help: f.help.trim(),
          required: !!f.required,
          options: NEEDS_OPTIONS.has(f.type)
            ? f.options.map((o) => o.trim()).filter(Boolean)
            : [],
        })),
    }),
  };
}

/* =============================================================================
   Student-facing renderer
   ========================================================================== */

/** Build the input control(s) for one field. */
function fieldControl(f, name) {
  const req = f.required ? ' required' : '';
  switch (f.type) {
    case 'long_text':
      return `<textarea data-f="${esc(f.id)}"${req}></textarea>`;
    case 'number':
      return `<input type="number" data-f="${esc(f.id)}" inputmode="decimal"${req}>`;
    case 'date':
      return `<input type="date" data-f="${esc(f.id)}"${req}>`;
    case 'dropdown':
      return `<select data-f="${esc(f.id)}"${req}>
        <option value="">Choose…</option>
        ${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>`;
    case 'choice_one':
      return f.options.map((o, i) => `
        <label class="checkline">
          <input type="radio" name="${esc(name)}" data-f="${esc(f.id)}" value="${esc(o)}"${req && i === 0 ? ' required' : ''}>
          <span>${esc(o)}</span>
        </label>`).join('');
    case 'choice_many':
      return f.options.map((o) => `
        <label class="checkline">
          <input type="checkbox" data-f="${esc(f.id)}" value="${esc(o)}">
          <span>${esc(o)}</span>
        </label>`).join('');
    case 'yesno':
      return ['Yes', 'No'].map((o, i) => `
        <label class="checkline">
          <input type="radio" name="${esc(name)}" data-f="${esc(f.id)}" value="${o}"${req && i === 0 ? ' required' : ''}>
          <span>${o}</span>
        </label>`).join('');
    default:
      return `<input type="text" data-f="${esc(f.id)}" maxlength="500"${req}>`;
  }
}

/** Render a form. In preview mode nothing is submittable. */
export function renderFormForStudent(form, { preview = false } = {}) {
  const fields = form.fields || [];
  if (!fields.length) {
    return h('<p class="muted small">Add a question to see the preview.</p>');
  }
  const seed = Math.random().toString(36).slice(2, 7);

  return h(`
    <form class="src-form" novalidate>
      ${form.title ? `<h3>${esc(form.title)}</h3>` : ''}
      ${fields.map((f) => `
        <div class="field">
          <span class="lbl">${esc(f.label)}${f.required ? '<span class="req">*</span>' : ''}</span>
          ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}
          ${fieldControl(f, `${seed}_${f.id}`)}
        </div>`).join('')}
      ${preview
        ? '<button class="btn" type="button" disabled>Submit</button>'
        : '<button class="btn" type="submit">Submit</button>'}
    </form>
  `);
}

/** Pull answers out of a rendered form. Returns { answers } or { error }. */
export function collectAnswers(formEl, form) {
  const answers = {};
  for (const f of form.fields) {
    const nodes = $$(`[data-f="${CSS.escape(f.id)}"]`, formEl);
    let val;

    if (f.type === 'choice_many') {
      val = nodes.filter((n) => n.checked).map((n) => n.value);
      if (f.required && !val.length) return { error: `"${f.label}" needs at least one choice.` };
    } else if (f.type === 'choice_one' || f.type === 'yesno') {
      val = nodes.find((n) => n.checked)?.value ?? '';
      if (f.required && !val) return { error: `"${f.label}" is required.` };
    } else {
      val = (nodes[0]?.value ?? '').trim();
      if (f.required && !val) return { error: `"${f.label}" is required.` };
      if (f.type === 'number' && val !== '' && Number.isNaN(Number(val))) {
        return { error: `"${f.label}" must be a number.` };
      }
    }
    answers[f.id] = val;
  }
  return { answers };
}

/** Read-only view of what a student submitted. */
export function renderSubmitted(form, answers) {
  return h(`
    <div>
      ${form.fields.map((f) => {
        const a = answers[f.id];
        const shown = Array.isArray(a) ? (a.join(', ') || '—') : (a === '' || a == null ? '—' : a);
        return `<div style="margin-bottom:10px">
          <div class="small muted">${esc(f.label)}</div>
          <div>${esc(shown)}</div>
        </div>`;
      }).join('')}
    </div>
  `);
}

/* =============================================================================
   Submitting
   ========================================================================== */

export async function submitResponse(formId, form, answers, user, profile) {
  const ref = doc(db, 'forms', formId, 'responses', user.uid);
  const payload = {
    uid: user.uid,
    name: profile.name,
    email: profile.email,
    yearClass: profile.yearClass || '',
    answers,
    submittedAt: serverTimestamp(),
  };
  const existing = await getDoc(ref);
  if (existing.exists()) {
    if (!form.allowMultiple) throw Object.assign(new Error('already'), { code: 'already' });
    await updateDoc(ref, { ...payload, updatedAt: serverTimestamp() });
  } else {
    await setDoc(ref, payload);
  }
}

export async function getMyResponse(formId, uidStr) {
  const snap = await getDoc(doc(db, 'forms', formId, 'responses', uidStr));
  return snap.exists() ? snap.data() : null;
}

/* =============================================================================
   Teacher: responses + CSV
   ========================================================================== */

export async function loadResponses(formId) {
  const snap = await getDocs(collection(db, 'forms', formId, 'responses'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function csvCell(v) {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  // Guard against spreadsheet formula injection from student-typed text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildCsv(form, responses) {
  const header = ['Name', 'Email', 'Year/Class', 'Submitted at', ...form.fields.map((f) => f.label)];
  const rows = responses.map((r) => [
    r.name || '',
    r.email || '',
    r.yearClass || '',
    r.submittedAt?.toDate ? r.submittedAt.toDate().toISOString() : '',
    ...form.fields.map((f) => r.answers?.[f.id] ?? ''),
  ]);
  // BOM so Excel opens UTF-8 names correctly.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * At-a-glance counts for every choice-style question, as label + bar + count.
 * Free-text answers stay in the table; there is nothing sensible to chart.
 */
function summaryHtml(form, responses) {
  if (!responses.length) return '';
  const choiceFields = (form.fields || []).filter((f) =>
    ['choice_one', 'choice_many', 'dropdown', 'yesno'].includes(f.type));
  if (!choiceFields.length) return '';

  const blocks = choiceFields.map((f) => {
    const options = f.type === 'yesno' ? ['Yes', 'No'] : (f.options || []);
    if (!options.length) return '';
    const counts = new Map(options.map((o) => [o, 0]));
    for (const r of responses) {
      const a = r.answers?.[f.id];
      const vals = Array.isArray(a) ? a : (a == null || a === '' ? [] : [a]);
      for (const v of vals) if (counts.has(v)) counts.set(v, counts.get(v) + 1);
    }
    const max = Math.max(1, ...counts.values());
    return `<div class="sumfield">
      <span class="lbl">${esc(f.label)}</span>
      ${options.map((o) => `
        <div class="sumrow">
          <span class="lab" title="${esc(o)}">${esc(o)}</span>
          <span class="bar"><i style="width:${Math.round((counts.get(o) / max) * 100)}%"></i></span>
          <span class="n">${counts.get(o)}</span>
        </div>`).join('')}
    </div>`;
  }).join('');

  if (!blocks) return '';
  return `<div style="margin-top:14px">
    <div class="row small muted" style="gap:6px;margin-bottom:8px">${icon('chart', 14)} <strong>At a glance</strong></div>
    ${blocks}
  </div>`;
}

/** Teacher view: responses table, who's missing, CSV button. */
export async function renderResponsesView(mount, formId, rosterEmails = []) {
  mount.replaceChildren(h('<div class="spinner"></div>'));
  try {
    const formSnap = await getDoc(doc(db, 'forms', formId));
    if (!formSnap.exists()) { mount.replaceChildren(h('<p class="muted">Form not found.</p>')); return; }
    const form = formSnap.data();
    const responses = await loadResponses(formId);

    const responded = new Set(responses.map((r) => (r.email || '').toLowerCase()));
    const missing = rosterEmails.filter((e) => !responded.has(e));
    const pct = rosterEmails.length
      ? Math.round((responded.size / rosterEmails.length) * 100) : 0;

    const el = h(`
      <div>
        <div class="row" style="margin-bottom:6px">
          <strong class="grow">${esc(form.title || 'Form')}</strong>
          <button class="btn subtle sm" id="csv">${icon('download', 14)} Export CSV</button>
        </div>
        ${rosterEmails.length ? `
          <div class="bar" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div>
          <div class="small muted">${responded.size} of ${rosterEmails.length} students responded (${pct}%)</div>
        ` : `<div class="small muted">${responses.length} response${responses.length === 1 ? '' : 's'}</div>`}

        ${summaryHtml(form, responses)}
        ${responses.length ? `
          <div class="tablewrap" style="margin-top:14px">
            <table>
              <thead><tr>
                <th>Name</th><th>Year/Class</th><th>When</th>
                ${form.fields.map((f) => `<th>${esc(f.label)}</th>`).join('')}
              </tr></thead>
              <tbody>
                ${responses.map((r) => `<tr>
                  <td>${esc(r.name || '—')}</td>
                  <td>${esc(r.yearClass || '—')}</td>
                  <td>${esc(fmtWhen(r.submittedAt))}</td>
                  ${form.fields.map((f) => {
                    const a = r.answers?.[f.id];
                    return `<td>${esc(Array.isArray(a) ? a.join(', ') : (a ?? ''))}</td>`;
                  }).join('')}
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="muted" style="margin-top:14px">No responses yet.</p>'}

        ${missing.length ? `
          <details style="margin-top:14px">
            <summary class="small muted" style="cursor:pointer">
              ${missing.length} student${missing.length === 1 ? '' : 's'} haven't responded
            </summary>
            <div class="small muted" style="margin-top:8px;line-height:1.8">
              ${missing.map((e) => `<span class="chip">${esc(e)}</span>`).join(' ')}
            </div>
          </details>` : ''}
      </div>
    `);

    el.querySelector('#csv').onclick = () => {
      const safe = (form.title || 'form').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      downloadCsv(`${safe}-responses.csv`, buildCsv(form, responses));
    };
    mount.replaceChildren(el);
  } catch (e) {
    console.error(e);
    mount.replaceChildren(h(`<p class="note bad">${esc(friendlyError(e))}</p>`));
  }
}
