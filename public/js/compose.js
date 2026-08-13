// The teacher's announcement composer, including the attached form builder
// and the "notify students" toggle.

import {
  db, doc, collection, getDoc, addDoc, setDoc, updateDoc, serverTimestamp,
} from './fb.js';
import {
  esc, h, $, toast, busy, friendlyError, modal, renderBody, todayISO,
} from './ui.js';
import { state } from './state.js';
import { formBuilder } from './forms.js';

/**
 * Open the composer. `existing` = announcement object to edit, or null for new.
 *
 * Editing deliberately cannot re-trigger the notification email: the Cloud
 * Function fires on document *create* only, and the rules block clients from
 * touching notifiedAt.
 */
export function openComposer(existing, onSaved) {
  const editing = !!existing;

  const m = modal(`
    <h2>${editing ? 'Edit announcement' : 'New announcement'}</h2>

    <label class="field">
      <span class="lbl">Title <span class="req">*</span></span>
      <input type="text" id="cTitle" maxlength="200" placeholder="e.g. SRC meeting moved to Thursday">
    </label>

    <div class="field">
      <span class="lbl">Body</span>
      <div class="btn-row" style="margin-bottom:6px">
        <button type="button" class="btn subtle sm" data-md="bold"><strong>B</strong></button>
        <button type="button" class="btn subtle sm" data-md="italic"><em>I</em></button>
        <button type="button" class="btn subtle sm" data-md="link">Link</button>
        <button type="button" class="btn subtle sm" data-md="bullet">• List</button>
        <button type="button" class="btn subtle sm" data-md="number">1. List</button>
      </div>
      <textarea id="cBody" rows="7" maxlength="20000"
        placeholder="What's happening?&#10;&#10;**bold**, *italic*, [link text](https://…), - bullets"></textarea>
      <span class="help">Formatting: <code>**bold**</code>, <code>*italic*</code>,
        <code>[text](https://…)</code>, <code>- bullet</code>, <code>1. numbered</code></span>
    </div>

    <details style="margin-bottom:14px">
      <summary class="small muted" style="cursor:pointer">Preview</summary>
      <div class="preview body" id="cPreview" style="margin-top:8px"></div>
    </details>

    <label class="field">
      <span class="lbl">Date shown on the post</span>
      <input type="date" id="cDate">
    </label>

    <hr class="divider">

    <label class="switch">
      <input type="checkbox" id="cPinned">
      <span class="track"></span>
      <span class="sw-label">Pin to the top</span>
    </label>

    <label class="switch">
      <input type="checkbox" id="cComments" checked>
      <span class="track"></span>
      <span class="sw-label">Allow comments
        <span class="sw-sub">Students can reply with their real name attached.</span></span>
    </label>

    <label class="switch" id="cNotifyWrap">
      <input type="checkbox" id="cNotify" checked>
      <span class="track"></span>
      <span class="sw-label">Email students about this
        <span class="sw-sub">Sends once, when you post. Editing later never re-emails.</span></span>
    </label>

    <label class="switch">
      <input type="checkbox" id="cAttach">
      <span class="track"></span>
      <span class="sw-label">Attach a form
        <span class="sw-sub">Students fill it in inside the announcement.</span></span>
    </label>

    <div id="cBuilder" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)"></div>

    <div class="btn-row" style="justify-content:flex-end;margin-top:20px">
      <button class="btn ghost" id="cCancel">Cancel</button>
      <button class="btn" id="cSave">${editing ? 'Save changes' : 'Post announcement'}</button>
    </div>
  `);

  const r = m.root;
  const titleEl = $('#cTitle', r);
  const bodyEl = $('#cBody', r);
  const dateEl = $('#cDate', r);
  const pinEl = $('#cPinned', r);
  const comEl = $('#cComments', r);
  const notifyEl = $('#cNotify', r);
  const attachEl = $('#cAttach', r);
  const builderBox = $('#cBuilder', r);
  const previewEl = $('#cPreview', r);

  let builder = null;

  // ---- populate ----------------------------------------------------------
  dateEl.value = todayISO();
  if (editing) {
    titleEl.value = existing.title || '';
    bodyEl.value = existing.body || '';
    dateEl.value = existing.date || todayISO();
    pinEl.checked = !!existing.pinned;
    comEl.checked = !!existing.commentsOpen;
    // Notification already happened (or was declined) at create time.
    $('#cNotifyWrap', r).hidden = true;
    if (existing.formId) {
      attachEl.checked = true;
      builderBox.hidden = false;
      getDoc(doc(db, 'forms', existing.formId)).then((s) => {
        builder = formBuilder(builderBox, s.exists() ? s.data() : null);
      });
    }
  }

  const updatePreview = () => { previewEl.innerHTML = renderBody(bodyEl.value); };
  bodyEl.addEventListener('input', updatePreview);
  updatePreview();

  // ---- markdown toolbar --------------------------------------------------
  r.querySelectorAll('[data-md]').forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.md;
      const s = bodyEl.selectionStart, e = bodyEl.selectionEnd;
      const sel = bodyEl.value.slice(s, e);
      let out, caret;
      if (kind === 'bold') { out = `**${sel || 'bold text'}**`; caret = s + 2; }
      else if (kind === 'italic') { out = `*${sel || 'italic text'}*`; caret = s + 1; }
      else if (kind === 'link') { out = `[${sel || 'link text'}](https://)`; caret = s + (sel || 'link text').length + 3; }
      else if (kind === 'bullet') { out = (sel || 'item').split('\n').map((l) => `- ${l}`).join('\n'); caret = s + 2; }
      else { out = (sel || 'item').split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n'); caret = s + 3; }
      bodyEl.setRangeText(out, s, e, 'end');
      if (!sel) bodyEl.setSelectionRange(caret, caret + (kind === 'bold' ? 9 : kind === 'italic' ? 11 : 0));
      bodyEl.focus();
      updatePreview();
    };
  });

  // ---- attach form toggle ------------------------------------------------
  attachEl.addEventListener('change', () => {
    builderBox.hidden = !attachEl.checked;
    if (attachEl.checked && !builder) builder = formBuilder(builderBox, null);
  });

  $('#cCancel', r).onclick = m.close;

  // ---- save --------------------------------------------------------------
  $('#cSave', r).onclick = async (ev) => {
    const btn = ev.currentTarget;
    const title = titleEl.value.trim();
    const body = bodyEl.value;

    if (!title) { toast('Give the announcement a title.', true); titleEl.focus(); return; }

    let formPayload = null;
    if (attachEl.checked && builder) {
      if (!builder.hasFields()) {
        toast('Add at least one question, or turn the form off.', true);
        return;
      }
      formPayload = builder.getForm();
    }

    busy(btn, true, editing ? 'Saving…' : 'Posting…');
    try {
      if (editing) {
        let formId = existing.formId || null;
        if (formPayload) {
          if (formId) {
            await updateDoc(doc(db, 'forms', formId), { ...formPayload, updatedAt: serverTimestamp() });
          } else {
            const ref = await addDoc(collection(db, 'forms'), {
              ...formPayload, createdBy: state.user.uid, createdAt: serverTimestamp(),
            });
            formId = ref.id;
          }
        } else if (!attachEl.checked) {
          // Detach but keep the form doc and its responses.
          formId = null;
        }

        await updateDoc(doc(db, 'announcements', existing.id), {
          title, body, date: dateEl.value || todayISO(),
          pinned: pinEl.checked, commentsOpen: comEl.checked,
          formId, editedAt: serverTimestamp(),
        });
      } else {
        // Create the form first so the announcement can reference it, and so
        // the notification function sees a complete post.
        let formId = null;
        if (formPayload) {
          const ref = await addDoc(collection(db, 'forms'), {
            ...formPayload, createdBy: state.user.uid, createdAt: serverTimestamp(),
          });
          formId = ref.id;
        }

        await addDoc(collection(db, 'announcements'), {
          title, body,
          date: dateEl.value || todayISO(),
          pinned: pinEl.checked,
          commentsOpen: comEl.checked,
          notify: notifyEl.checked,
          formId,
          authorUid: state.user.uid,
          authorName: state.profile.name,
          createdAt: serverTimestamp(),
        });
      }
      m.close();
      onSaved?.();
    } catch (err) {
      console.error(err);
      busy(btn, false);
      toast(friendlyError(err), true);
    }
  };
}
