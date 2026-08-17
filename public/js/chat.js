// Community chat: one shared room for the whole SRC.
//
// COST SAFETY (this project is on Blaze, which has no hard spending cap):
//   * The listener is hard-capped at MSG_LIMIT documents. A runaway room
//     cannot turn into a runaway read bill.
//   * stopChat() detaches on leaving the tab, so a backgrounded phone is not
//     holding an open stream.
//   * Nothing polls and nothing retries in a loop. A failed send reports and
//     stops.
//   * Rough worst case with 50 students: opening the tab costs up to 60 reads,
//     then one read per new message per open tab. 50 people × 100 messages a
//     day ≈ 5,000 reads — around a tenth of the 50,000/day free allowance.

import {
  db, collection, addDoc, deleteDoc, updateDoc, doc,
  onSnapshot, query, orderBy, limit, serverTimestamp,
} from './fb.js';
import {
  esc, h, $, toast, friendlyError, confirmDialog, fmtWhen, icon, renderBody, avatar, skeleton,
} from './ui.js';
import { state, isTeacher } from './state.js';

/** Never stream more than this. The cap is the cost guard. */
const MSG_LIMIT = 60;

/** Ignore a second send inside this window — a stuck button, not a message. */
const MIN_SEND_GAP_MS = 500;

let unsub = null;
let lastSentAt = 0;

export function stopChat() {
  unsub?.();
  unsub = null;
}

export function renderChat(mount) {
  stopChat();

  mount.replaceChildren(h(`
    <div class="wrap chat-wrap">
      <div class="chat-intro small muted">
        Everyone on the SRC can see this, and every message shows your real name.
        Teachers can remove anything.
      </div>
      <div id="chatList" class="chat-list">${skeleton(2)}</div>
      <form class="chat-compose" id="chatForm">
        <textarea id="chatText" rows="1" maxlength="2000" placeholder="Message the SRC…"
                  aria-label="Message"></textarea>
        <button class="btn icon" id="chatSend" type="submit"
                aria-label="Send">${icon('send', 16)}</button>
      </form>
    </div>
  `));

  const listEl = $('#chatList', mount);
  const textEl = $('#chatText', mount);
  const formEl = $('#chatForm', mount);

  // Grow the box with the message rather than making people scroll a one-liner.
  const autosize = () => {
    textEl.style.height = 'auto';
    textEl.style.height = `${Math.min(textEl.scrollHeight, 160)}px`;
  };
  textEl.addEventListener('input', autosize);

  // Enter sends, Shift+Enter makes a new line — but not on a phone, where
  // Enter is the only way to get a line break and there is a visible button.
  textEl.addEventListener('keydown', (e) => {
    const phone = window.matchMedia('(max-width: 640px)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !phone) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) return;
    if (Date.now() - lastSentAt < MIN_SEND_GAP_MS) return;
    lastSentAt = Date.now();

    // Clear optimistically; the listener will paint it a moment later. Put it
    // back if the write fails, so nobody loses what they typed.
    textEl.value = '';
    autosize();
    try {
      await addDoc(collection(db, 'messages'), {
        text,
        authorUid: state.user.uid,
        authorName: state.profile.name,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error(err);
      textEl.value = text;
      autosize();
      toast(friendlyError(err), true);
    }
  });

  const q = query(collection(db, 'messages'), orderBy('createdAt', 'desc'), limit(MSG_LIMIT));
  unsub = onSnapshot(q, (snap) => {
    // Query descending so the cap keeps the NEWEST messages, then flip for
    // display. Ascending + limit would pin the room to its oldest 60 forever.
    const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();

    if (!msgs.length) {
      listEl.replaceChildren(h(`
        <div class="empty">
          <div class="icirc">${icon('comment', 24)}</div>
          <h2>No messages yet</h2>
          <p>Say hello — everyone on the SRC will see it.</p>
        </div>`));
      return;
    }

    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
    listEl.replaceChildren(...msgs.map((m, i) => bubble(m, msgs[i - 1])));
    // Only auto-scroll if they were already at the bottom; yanking the view
    // away while someone reads back through the room is infuriating.
    if (atBottom) listEl.scrollTop = listEl.scrollHeight;
  }, (err) => {
    console.error(err);
    listEl.replaceChildren(h(`<div class="note bad">${esc(friendlyError(err))}</div>`));
  });
}

function bubble(m, prev) {
  const mine = m.authorUid === state.user.uid;
  // Consecutive messages from the same person are grouped: one name, not five.
  const grouped = prev && prev.authorUid === m.authorUid;

  const el = h(`
    <div class="msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}">
      ${grouped ? '' : `<div class="msg-who">
        ${mine ? '' : avatar(m.authorName, 22)}
        <span class="who">${esc(m.authorName || 'Unknown')}</span>
        <span class="when">${esc(fmtWhen(m.createdAt))}</span>
      </div>`}
      <div class="msg-row">
        <div class="bubble">
          <div class="body">${renderBody(m.text)}</div>
          ${m.editedAt ? '<span class="small muted">edited</span>' : ''}
        </div>
        <div class="msg-tools" data-tools></div>
      </div>
    </div>`);

  const tools = el.querySelector('[data-tools]');

  if (mine) {
    const ed = h(`<button class="btn ghost icon sm" aria-label="Edit">${icon('edit', 13)}</button>`);
    ed.onclick = () => startEdit(el, m);
    tools.appendChild(ed);
  }
  if (mine || isTeacher()) {
    const del = h(`<button class="btn ghost icon sm" aria-label="Delete">${icon('trash', 13)}</button>`);
    del.onclick = async () => {
      const ok = await confirmDialog(
        'Delete this message?',
        mine ? 'It will disappear for everyone.' : `This removes ${m.authorName}'s message.`,
        { danger: true, okLabel: 'Delete' }
      );
      if (!ok) return;
      try { await deleteDoc(doc(db, 'messages', m.id)); }
      catch (e) { toast(friendlyError(e), true); }
    };
    tools.appendChild(del);
  }

  return el;
}

function startEdit(el, m) {
  const body = el.querySelector('.bubble');
  const box = h(`
    <div class="msg-edit">
      <textarea rows="2" maxlength="2000"></textarea>
      <div class="btn-row" style="margin-top:6px">
        <button class="btn sm" data-save>Save</button>
        <button class="btn ghost sm" data-cancel>Cancel</button>
      </div>
    </div>`);
  const ta = box.querySelector('textarea');
  ta.value = m.text;

  body.replaceWith(box);
  ta.focus();

  box.querySelector('[data-cancel]').onclick = () => box.replaceWith(body);
  box.querySelector('[data-save]').onclick = async () => {
    const text = ta.value.trim();
    if (!text) { toast('A message cannot be empty.', true); return; }
    try {
      await updateDoc(doc(db, 'messages', m.id), { text, editedAt: serverTimestamp() });
    } catch (e) {
      toast(friendlyError(e), true);
      box.replaceWith(body);
    }
  };
}
