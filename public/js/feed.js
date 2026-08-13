// The announcement feed, plus comments and the inline form under each post.

import {
  db, auth,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp,
} from './fb.js';
import {
  esc, h, $, toast, busy, friendlyError, confirmDialog, renderBody, fmtDate, fmtWhen,
} from './ui.js';
import { state, isTeacher } from './state.js';
import {
  renderFormForStudent, collectAnswers, submitResponse, getMyResponse,
  renderSubmitted, renderResponsesView,
} from './forms.js';
import { openComposer } from './compose.js';

// One listener for the whole feed, hard-capped at 50 documents.
const FEED_LIMIT = 50;

let unsubFeed = null;
const openCommentThreads = new Map(); // announcementId -> unsubscribe

export function stopFeed() {
  unsubFeed?.();
  unsubFeed = null;
  for (const un of openCommentThreads.values()) un();
  openCommentThreads.clear();
}

export function renderFeed(mount) {
  stopFeed();

  mount.replaceChildren(h(`
    <div class="wrap">
      ${isTeacher() ? `
        <div class="btn-row" style="margin:16px 0">
          <button class="btn" id="newPost">+ New announcement</button>
        </div>` : '<div style="height:16px"></div>'}
      <div id="feedList"><div class="spinner"></div></div>
    </div>
  `));

  if (isTeacher()) {
    $('#newPost', mount).onclick = () => openComposer(null, () => toast('Announcement posted.'));
  }

  const listEl = $('#feedList', mount);

  const q = query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(FEED_LIMIT));
  unsubFeed = onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Pinned first, then newest. Done here so no composite index is needed.
    items.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });

    if (!items.length) {
      listEl.replaceChildren(h(`
        <div class="empty">
          <div class="big">🌱</div>
          <h2>Nothing here yet</h2>
          <p>${isTeacher()
            ? 'Post the first announcement to get things started.'
            : 'Your SRC teachers haven\'t posted anything yet. Check back soon.'}</p>
        </div>`));
      return;
    }
    listEl.replaceChildren(...items.map(card));
  }, (err) => {
    console.error(err);
    listEl.replaceChildren(h(`<div class="note bad">${esc(friendlyError(err))}</div>`));
  });
}

/* ---- one announcement ---------------------------------------------------- */

function card(a) {
  const mine = a.authorUid === state.user.uid;
  const el = h(`
    <article class="card${a.pinned ? ' pinned' : ''}">
      <div class="card-head">
        <h2>${esc(a.title)}</h2>
        ${a.pinned ? '<span class="pill pin">Pinned</span>' : ''}
      </div>
      <div class="meta" style="margin-bottom:10px">
        <span>${esc(a.authorName || 'SRC')}</span>
        <span class="dot">•</span>
        <span>${esc(a.date ? fmtDate(a.date) : fmtWhen(a.createdAt))}</span>
        ${a.editedAt ? '<span class="dot">•</span><span>edited</span>' : ''}
      </div>
      <div class="body">${renderBody(a.body)}</div>
      <div data-form></div>
      <div data-actions style="margin-top:14px"></div>
      <div data-comments></div>
    </article>
  `);

  // ---- attached form -----------------------------------------------------
  if (a.formId) mountForm(el.querySelector('[data-form]'), a.formId);

  // ---- action row --------------------------------------------------------
  const actions = el.querySelector('[data-actions]');
  const row = h('<div class="btn-row"></div>');

  if (a.commentsOpen || a.commentCount) {
    const cbtn = h(`<button class="btn subtle sm">${a.commentsOpen ? 'Comments' : 'View comments'}</button>`);
    cbtn.onclick = () => toggleComments(el, a, cbtn);
    row.appendChild(cbtn);
  } else {
    row.appendChild(h('<span class="pill off">Comments off</span>'));
  }

  if (isTeacher() && a.formId) {
    const resp = h('<button class="btn subtle sm">Responses</button>');
    resp.onclick = () => {
      const box = el.querySelector('[data-responses]') || h('<div data-responses style="margin-top:14px"></div>');
      if (!box.isConnected) actions.appendChild(box);
      renderResponsesView(box, a.formId, state.rosterEmails);
    };
    row.appendChild(resp);
  }

  if (isTeacher() && mine) {
    // Teacher controls live behind one toggle so the card stays readable on a
    // phone — six buttons in a row wraps into a wall.
    const manageRow = h('<div class="btn-row" style="margin-top:8px" hidden></div>');
    const manageBtn = h('<button class="btn ghost sm" aria-expanded="false">⋯ Manage</button>');
    manageBtn.onclick = () => {
      const show = manageRow.hidden;
      manageRow.hidden = !show;
      manageBtn.setAttribute('aria-expanded', String(show));
    };
    row.appendChild(manageBtn);

    const edit = h('<button class="btn ghost sm">Edit</button>');
    edit.onclick = () => openComposer(a, () => toast('Announcement updated.'));

    const pin = h(`<button class="btn ghost sm">${a.pinned ? 'Unpin' : 'Pin'}</button>`);
    pin.onclick = async (e) => {
      busy(e.currentTarget, true, '…');
      try { await updateDoc(doc(db, 'announcements', a.id), { pinned: !a.pinned }); }
      catch (err) { toast(friendlyError(err), true); busy(e.currentTarget, false); }
    };

    const close = h(`<button class="btn ghost sm">${a.commentsOpen ? 'Close comments' : 'Open comments'}</button>`);
    close.onclick = async (e) => {
      busy(e.currentTarget, true, '…');
      try { await updateDoc(doc(db, 'announcements', a.id), { commentsOpen: !a.commentsOpen }); }
      catch (err) { toast(friendlyError(err), true); busy(e.currentTarget, false); }
    };

    const del = h('<button class="btn danger sm">Delete</button>');
    del.onclick = async () => {
      const ok = await confirmDialog('Delete this announcement?',
        'The post and its comments will be removed. This cannot be undone.');
      if (!ok) return;
      try {
        // Remove comments first so they don't linger as orphans.
        const cs = await getDocs(collection(db, 'announcements', a.id, 'comments'));
        await Promise.all(cs.docs.map((c) => deleteDoc(c.ref)));
        await deleteDoc(doc(db, 'announcements', a.id));
        toast('Deleted.');
      } catch (err) { toast(friendlyError(err), true); }
    };

    manageRow.append(edit, pin, close, del);
    actions.appendChild(row);
    actions.appendChild(manageRow);
  } else {
    actions.appendChild(row);
  }

  // Delivery failure surfaced to the teacher who posted it.
  if (isTeacher() && mine && a.notify) showMailStatus(actions, a.id);

  return el;
}

async function showMailStatus(mount, announcementId) {
  try {
    const snap = await getDoc(doc(db, 'mailLog', announcementId));
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'sent' && !d.failed) {
      mount.prepend(h(`<div class="small muted" style="margin-bottom:8px">
        ✓ Emailed ${Number(d.sent) || 0} student${d.sent === 1 ? '' : 's'}</div>`));
    } else if (d.status === 'skipped') {
      mount.prepend(h('<div class="small muted" style="margin-bottom:8px">No email sent for this post.</div>'));
    } else {
      mount.prepend(h(`<div class="note bad small" style="margin-bottom:8px">
        <strong>Email problem:</strong> ${esc(d.error || 'some messages failed')}.
        ${Number(d.failed) ? `${Number(d.failed)} address(es) failed.` : ''}
        Students can still read this in the app.</div>`));
    }
  } catch { /* mailLog is teacher-only; ignore quietly */ }
}

/* ---- inline form --------------------------------------------------------- */

async function mountForm(mount, formId) {
  mount.replaceChildren(h('<div class="small muted" style="margin-top:12px">Loading form…</div>'));
  try {
    const snap = await getDoc(doc(db, 'forms', formId));
    if (!snap.exists()) { mount.replaceChildren(); return; }
    const form = snap.data();
    const mine = await getMyResponse(formId, state.user.uid);

    const box = h('<div class="card" style="margin:14px 0 0;background:var(--surface-2)"></div>');

    const showSubmitted = (answers) => {
      box.replaceChildren(h(`
        <div>
          <div class="row" style="margin-bottom:8px">
            <span class="pill">✓ Submitted</span>
            <span class="grow"></span>
          </div>
          <p class="small muted">${form.allowMultiple
            ? 'You can change your answer any time.'
            : 'This form takes one response per student, so this is locked in.'}</p>
        </div>`));
      box.appendChild(renderSubmitted(form, answers));
      if (form.allowMultiple) {
        const again = h('<button class="btn ghost sm" style="margin-top:10px">Change my answer</button>');
        again.onclick = () => showForm(answers);
        box.appendChild(again);
      }
    };

    const showForm = (prefill = null) => {
      box.replaceChildren();
      if (form.allowMultiple && prefill) {
        box.appendChild(h('<p class="small muted">Update your answer and submit again.</p>'));
      } else {
        box.appendChild(h(`<p class="small muted">${form.allowMultiple
          ? 'You can change this later.'
          : 'You can only submit this once, so check it before you send.'}</p>`));
      }
      const formEl = renderFormForStudent(form);
      box.appendChild(formEl);

      // Prefill when re-submitting.
      if (prefill) {
        for (const f of form.fields) {
          const v = prefill[f.id];
          const nodes = [...formEl.querySelectorAll(`[data-f="${CSS.escape(f.id)}"]`)];
          if (f.type === 'choice_many') {
            nodes.forEach((n) => { n.checked = Array.isArray(v) && v.includes(n.value); });
          } else if (f.type === 'choice_one' || f.type === 'yesno') {
            nodes.forEach((n) => { n.checked = n.value === v; });
          } else if (nodes[0]) {
            nodes[0].value = v ?? '';
          }
        }
      }

      formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = formEl.querySelector('button[type=submit]');
        const { answers, error } = collectAnswers(formEl, form);
        if (error) { toast(error, true); return; }
        busy(btn, true, 'Sending…');
        try {
          await submitResponse(formId, form, answers, state.user, state.profile);
          toast('Submitted. Thanks!');
          showSubmitted(answers);
        } catch (err) {
          busy(btn, false);
          if (err?.code === 'already') toast('You have already submitted this form.', true);
          else toast(friendlyError(err), true);
        }
      });
    };

    if (mine) showSubmitted(mine.answers || {}); else showForm();
    mount.replaceChildren(box);
  } catch (e) {
    console.error(e);
    mount.replaceChildren(h(`<div class="note bad">${esc(friendlyError(e))}</div>`));
  }
}

/* ---- comments ------------------------------------------------------------ */

function toggleComments(cardEl, a, btn) {
  const box = cardEl.querySelector('[data-comments]');
  if (openCommentThreads.has(a.id)) {
    openCommentThreads.get(a.id)();
    openCommentThreads.delete(a.id);
    box.replaceChildren();
    btn.textContent = a.commentsOpen ? 'Comments' : 'View comments';
    return;
  }
  btn.textContent = 'Hide comments';
  box.replaceChildren(h('<hr class="divider"><div class="spinner"></div>'));

  const listEl = h('<div></div>');
  const wrap = h('<div style="margin-top:14px"></div>');
  wrap.append(h('<hr class="divider">'), listEl);

  if (a.commentsOpen) {
    const composer = h(`
      <form style="margin-top:10px">
        <textarea id="ctext" rows="2" maxlength="2000"
          placeholder="Add a comment as ${esc(state.profile.name)}…"
          style="min-height:64px"></textarea>
        <div class="row" style="margin-top:8px">
          <span class="small muted grow">Posting as <strong>${esc(state.profile.name)}</strong> — teachers can see who wrote it.</span>
          <button class="btn sm" type="submit">Post</button>
        </div>
      </form>`);
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = composer.querySelector('#ctext');
      const text = ta.value.trim();
      if (!text) return;
      const btn2 = composer.querySelector('button');
      busy(btn2, true, 'Posting…');
      try {
        await addDoc(collection(db, 'announcements', a.id, 'comments'), {
          authorUid: state.user.uid,
          authorName: state.profile.name,
          text,
          createdAt: serverTimestamp(),
        });
        ta.value = '';
      } catch (err) { toast(friendlyError(err), true); }
      finally { busy(btn2, false); }
    });
    wrap.appendChild(composer);
  } else {
    wrap.appendChild(h('<p class="small muted" style="margin-top:10px">Comments are closed on this post.</p>'));
  }

  box.replaceChildren(wrap);

  const q = query(
    collection(db, 'announcements', a.id, 'comments'),
    orderBy('createdAt', 'asc'), limit(200)
  );
  const un = onSnapshot(q, (snap) => {
    if (snap.empty) {
      listEl.replaceChildren(h('<p class="small muted">No comments yet.</p>'));
      return;
    }
    listEl.replaceChildren(...snap.docs.map((d) => commentEl(a, { id: d.id, ...d.data() })));
  }, (err) => {
    listEl.replaceChildren(h(`<div class="note bad">${esc(friendlyError(err))}</div>`));
  });
  openCommentThreads.set(a.id, un);
}

function commentEl(a, c) {
  const mine = c.authorUid === state.user.uid;
  const el = h(`
    <div class="comment">
      <div class="row">
        <span class="who grow">${esc(c.authorName || 'Unknown')}</span>
        <span class="small muted">${esc(fmtWhen(c.createdAt))}${c.editedAt ? ' · edited' : ''}</span>
      </div>
      <div class="text"></div>
      <div class="btn-row" data-cactions></div>
    </div>`);
  el.querySelector('.text').textContent = c.text;

  const acts = el.querySelector('[data-cactions]');

  if (mine && a.commentsOpen) {
    const ed = h('<button class="btn ghost sm">Edit</button>');
    ed.onclick = () => {
      const ta = h(`<textarea maxlength="2000" style="min-height:64px"></textarea>`);
      ta.value = c.text;
      const save = h('<button class="btn sm">Save</button>');
      const cancel = h('<button class="btn ghost sm">Cancel</button>');
      const editRow = h('<div class="btn-row" style="margin-top:8px"></div>');
      editRow.append(save, cancel);
      el.querySelector('.text').replaceWith(ta);
      acts.replaceChildren(editRow);
      save.onclick = async () => {
        const t = ta.value.trim();
        if (!t) return;
        busy(save, true, 'Saving…');
        try {
          await updateDoc(doc(db, 'announcements', a.id, 'comments', c.id), {
            text: t, editedAt: serverTimestamp(),
          });
        } catch (err) { toast(friendlyError(err), true); busy(save, false); }
      };
      cancel.onclick = () => { /* snapshot will redraw */ ta.replaceWith(h('<div class="text"></div>')); acts.replaceChildren(); };
    };
    acts.appendChild(ed);
  }

  if (mine || isTeacher()) {
    const del = h('<button class="btn danger sm">Delete</button>');
    del.onclick = async () => {
      const ok = await confirmDialog('Delete this comment?',
        mine ? 'Your comment will be removed.' : `This will remove ${c.authorName}'s comment.`,
        { okLabel: 'Delete' });
      if (!ok) return;
      try { await deleteDoc(doc(db, 'announcements', a.id, 'comments', c.id)); }
      catch (err) { toast(friendlyError(err), true); }
    };
    acts.appendChild(del);
  }

  return el;
}
