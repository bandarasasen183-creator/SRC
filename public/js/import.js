// The teacher-facing importer UI. The validation it relies on lives in
// import-parse.js, which has no Firebase import and so can be unit tested.

import { db, collection, addDoc, serverTimestamp } from './fb.js';
import { esc, h, $, toast, busy, friendlyError, modal, icon, fmtDate } from './ui.js';
import { state } from './state.js';
import { parseImport } from './import-parse.js';

/** Open the importer. `onDone` runs after a successful import. */
export function openImporter(onDone) {
  const m = modal(`
    <h2>${icon('download', 18)} Import announcements</h2>
    <p class="small muted">Paste a JSON array of posts — for example an export of your
      Google Classroom stream. Existing posts are not touched.</p>

    <div class="note" style="margin-bottom:12px">
      <strong>No emails are sent.</strong> Every imported post is written with
      notifications off, so nobody's inbox gets a dozen messages at once.
      Posts are created oldest-first so the feed reads in the right order.
    </div>

    <div class="field">
      <span class="lbl">Posts (JSON)</span>
      <textarea id="impJson" rows="9" spellcheck="false"
        placeholder='[ { "title": "SRC meeting", "body": "Monday, Q10.", "date": "2026-08-03", "authorName": "Ms Visser" } ]'></textarea>
    </div>

    <div class="btn-row">
      <button class="btn ghost" id="impCheck">${icon('check', 15)} Check</button>
      <span class="grow"></span>
      <button class="btn ghost" id="impCancel">Cancel</button>
      <button class="btn" id="impGo" disabled>Import</button>
    </div>

    <div id="impOut" style="margin-top:14px"></div>
  `);

  const r = m.root;
  const jsonEl = $('#impJson', r);
  const outEl = $('#impOut', r);
  const goBtn = $('#impGo', r);
  let ready = [];

  const check = () => {
    const { posts, errors } = parseImport(jsonEl.value);
    ready = errors.length ? [] : posts;
    goBtn.disabled = !ready.length;

    if (errors.length) {
      outEl.replaceChildren(h(`<div class="note bad">
        <strong>${errors.length} problem${errors.length > 1 ? 's' : ''}:</strong>
        <ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`));
      return;
    }
    if (!posts.length) {
      outEl.replaceChildren(h('<div class="note">Nothing to import yet.</div>'));
      return;
    }

    // One root element: h() returns firstElementChild, so a second sibling here
    // would be silently dropped.
    outEl.replaceChildren(h(`
      <div>
      <div class="note">
        <strong>${posts.length} post${posts.length > 1 ? 's' : ''} ready</strong>, oldest first.
      </div>
      <ol class="small" style="margin:10px 0 0;padding-left:20px">
        ${posts.map((p) => `<li style="margin-bottom:6px">
          <strong>${esc(p.title)}</strong>
          ${p.date ? `<span class="muted"> — ${esc(fmtDate(p.date))}</span>` : ''}
          ${p.authorName ? `<span class="muted"> · ${esc(p.authorName)}</span>` : ''}
        </li>`).join('')}
      </ol>
      </div>`));
  };

  $('#impCheck', r).onclick = check;
  jsonEl.addEventListener('input', () => { goBtn.disabled = true; });
  $('#impCancel', r).onclick = m.close;

  goBtn.onclick = async (ev) => {
    const btn = ev.currentTarget;
    busy(btn, true, 'Importing…');
    let done = 0;
    const failed = [];

    // Sequential on purpose: order is the point, and a dozen writes needs no
    // parallelism. Firing them at once would also land them out of order.
    for (const p of ready) {
      try {
        await addDoc(collection(db, 'announcements'), {
          title: p.title,
          body: p.body,
          date: p.date || '',
          pinned: p.pinned,
          commentsOpen: p.commentsOpen,
          notify: false,               // never email an import
          formId: null,
          authorUid: state.user.uid,   // required by the rules: you own it
          authorName: p.authorName || state.profile.name,
          importedFrom: 'Google Classroom',
          importedBy: state.profile.name,
          createdAt: serverTimestamp(),
        });
        done++;
        busy(btn, true, `Importing ${done}/${ready.length}…`);
      } catch (e) {
        console.error(e);
        failed.push(`${p.title}: ${friendlyError(e)}`);
      }
    }

    busy(btn, false);
    if (failed.length) {
      outEl.replaceChildren(h(`<div class="note bad">
        <strong>Imported ${done}, ${failed.length} failed.</strong>
        <ul>${failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`));
      return;
    }
    m.close();
    toast(`Imported ${done} announcement${done > 1 ? 's' : ''}. No emails were sent.`);
    onDone?.();
  };
}
