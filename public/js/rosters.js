// Duty rosters — the morning toast roster, event set-up, and anything else
// that runs on "who can do Tuesday?".
//
// This replaces the Classroom pattern of asking people to comment their name
// and a day, then transcribing 30 comments into a table by hand.
//
// Data:
//   rosters/{id}                              title, description, slots[]
//   rosters/{id}/claims/{slotId}/people/{uid} one doc per person per slot
//
// Claims are readable by every member on purpose — the point of a roster is
// that everyone can see who has Tuesday. That is the opposite of form
// responses, which are private, and the rules say so explicitly.
//
// No listeners: plain reads on tab open and after a change, so an open roster
// tab costs nothing while it sits there.

import {
  db, collection, doc, getDocs, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp,
} from './fb.js';
import {
  esc, h, $, toast, busy, friendlyError, confirmDialog, modal, icon, downloadFile,
} from './ui.js';
import { state, isTeacher } from './state.js';
import { csvCell } from './forms.js';

/** Bound the shape of a roster so one cannot become thousands of reads. */
const MAX_SLOTS = 40;

let rosters = [];

export async function renderRosters(mount) {
  mount.replaceChildren(h(`
    <div class="wrap">
      <div class="row" style="margin:16px 0 12px">
        <span class="grow"></span>
        ${isTeacher()
          ? `<button class="btn sm" id="newRoster">${icon('plus', 15)} New roster</button>`
          : ''}
      </div>
      <div id="rosterList"><div class="spinner"></div></div>
    </div>
  `));

  if (isTeacher()) {
    $('#newRoster', mount).onclick = () => openRosterEditor(null, () => refresh(mount));
  }
  await refresh(mount);
}

async function refresh(mount) {
  const listEl = $('#rosterList', mount);
  if (!listEl) return;
  listEl.replaceChildren(h('<div class="spinner"></div>'));

  try {
    const snap = await getDocs(collection(db, 'rosters'));
    rosters = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rosters.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

    if (!rosters.length) {
      listEl.replaceChildren(h(`
        <div class="empty">
          <div class="icirc">${icon('clipboard', 24)}</div>
          <h2>No rosters yet</h2>
          <p>${isTeacher()
            ? 'Make one for the toast roster, or event set-up.'
            : 'When a teacher sets up a roster you can put your name down here.'}</p>
        </div>`));
      return;
    }

    const cards = await Promise.all(rosters.map((r) => rosterCard(r, mount)));
    listEl.replaceChildren(...cards);
  } catch (e) {
    console.error(e);
    listEl.replaceChildren(h(`<div class="note bad">${esc(friendlyError(e))}</div>`));
  }
}

/** Read every slot's people in parallel — one small query per slot. */
async function loadClaims(rosterId, slots) {
  const entries = await Promise.all(slots.map(async (s) => {
    const snap = await getDocs(collection(db, 'rosters', rosterId, 'claims', s.id, 'people'));
    return [s.id, snap.docs.map((d) => ({ uid: d.id, ...d.data() }))];
  }));
  return Object.fromEntries(entries);
}

async function rosterCard(r, mount) {
  const slots = Array.isArray(r.slots) ? r.slots : [];
  const claims = await loadClaims(r.id, slots);

  const mineCount = slots.filter((s) =>
    (claims[s.id] || []).some((p) => p.uid === state.user.uid)).length;

  const el = h(`
    <div class="card">
      <div class="row">
        <div class="grow">
          <h2 style="margin:0">${esc(r.title || 'Roster')}</h2>
          ${r.description ? `<p class="small muted" style="margin:4px 0 0">${esc(r.description)}</p>` : ''}
        </div>
        ${mineCount ? `<span class="pill on">${icon('check', 12)} You're on ${mineCount}</span>` : ''}
      </div>
      <div class="slots" data-slots></div>
      <div class="btn-row" style="margin-top:12px" data-admin></div>
    </div>`);

  const slotBox = el.querySelector('[data-slots]');
  for (const s of slots) slotBox.appendChild(slotRow(r, s, claims[s.id] || [], mount));

  if (isTeacher()) {
    const admin = el.querySelector('[data-admin]');
    const edit = h(`<button class="btn ghost sm">${icon('edit', 14)} Edit</button>`);
    edit.onclick = () => openRosterEditor(r, () => refresh(mount));

    const csv = h(`<button class="btn ghost sm">${icon('download', 14)} CSV</button>`);
    csv.onclick = () => exportCsv(r, slots, claims);

    const del = h(`<button class="btn danger sm">${icon('trash', 14)} Delete</button>`);
    del.onclick = async () => {
      const ok = await confirmDialog('Delete this roster?',
        `"${r.title}" and everyone's names on it will be removed.`,
        { danger: true, okLabel: 'Delete' });
      if (!ok) return;
      try {
        // Remove the people first: deleting the parent alone would orphan the
        // subcollections, and they would reappear if the id were reused.
        for (const s of slots) {
          for (const p of claims[s.id] || []) {
            await deleteDoc(doc(db, 'rosters', r.id, 'claims', s.id, 'people', p.uid));
          }
        }
        await deleteDoc(doc(db, 'rosters', r.id));
        toast('Roster deleted.');
        refresh(mount);
      } catch (e) { toast(friendlyError(e), true); }
    };

    admin.append(edit, csv, del);
  }

  return el;
}

function slotRow(r, slot, people, mount) {
  const cap = Number(slot.capacity) || 0;
  const mine = people.some((p) => p.uid === state.user.uid);
  const full = cap > 0 && people.length >= cap && !mine;

  const row = h(`
    <div class="slot${mine ? ' mine' : ''}${full ? ' full' : ''}">
      <div class="slot-main">
        <div class="slot-label">${esc(slot.label || slot.id)}</div>
        <div class="slot-people">${
          people.length
            ? people.map((p) => `<span class="chip static">${esc(p.name || 'Someone')}</span>`).join('')
            : '<span class="small muted">Nobody yet</span>'
        }</div>
      </div>
      <div class="slot-side">
        ${cap ? `<span class="small muted">${people.length}/${cap}</span>` : ''}
        <span data-btn></span>
      </div>
    </div>`);

  const btn = h(`<button class="btn ${mine ? 'ghost' : 'subtle'} sm">
    ${mine ? `${icon('x', 13)} Take me off` : `${icon('plus', 13)} I'll do it`}
  </button>`);
  btn.disabled = full;
  if (full) btn.title = 'This slot is full';

  btn.onclick = async (e) => {
    busy(e.currentTarget, true, '…');
    const ref = doc(db, 'rosters', r.id, 'claims', slot.id, 'people', state.user.uid);
    try {
      if (mine) {
        await deleteDoc(ref);
      } else {
        await setDoc(ref, {
          uid: state.user.uid,
          name: state.profile.name,
          slotId: slot.id,
          createdAt: serverTimestamp(),
        });
      }
      await refresh(mount);
    } catch (err) {
      console.error(err);
      busy(e.currentTarget, false);
      toast(friendlyError(err), true);
    }
  };

  row.querySelector('[data-btn]').appendChild(btn);
  return row;
}

function exportCsv(r, slots, claims) {
  const rows = [['Slot', 'Name']];
  for (const s of slots) {
    const people = claims[s.id] || [];
    if (!people.length) rows.push([s.label || s.id, '']);
    for (const p of people) rows.push([s.label || s.id, p.name || '']);
  }
  const csv = rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n');
  const safe = String(r.title || 'roster').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  downloadFile(`${safe}.csv`, csv, 'text/csv');
}

/* =============================================================================
   Teacher editor
   ========================================================================== */

/** Mon–Fri over a two-week cycle, which is how the school timetable runs. */
const WEEK_A_B = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  .flatMap((d) => [`${d} (Week A)`, `${d} (Week B)`])
  .sort((a, b) => (a.includes('Week A') === b.includes('Week A') ? 0 : a.includes('Week A') ? -1 : 1));

function openRosterEditor(existing, onSaved) {
  const editing = !!existing;
  let slots = editing && Array.isArray(existing.slots)
    ? existing.slots.map((s) => ({ ...s }))
    : [];

  const m = modal(`
    <h2>${editing ? 'Edit roster' : 'New roster'}</h2>

    <label class="field">
      <span class="lbl">Name <span class="req">*</span></span>
      <input type="text" id="roTitle" maxlength="120" placeholder="e.g. Morning toast">
    </label>

    <label class="field">
      <span class="lbl">Notes <span class="muted small">(optional)</span></span>
      <input type="text" id="roDesc" maxlength="300" placeholder="e.g. Arrive 8:00, set up the toast station">
    </label>

    <div class="field">
      <span class="lbl">Slots</span>
      <span class="help">One per shift. People put their own names down.</span>
      <div id="roSlots"></div>
      <div class="btn-row" style="margin-top:8px">
        <button type="button" class="btn subtle sm" id="roAdd">${icon('plus', 14)} Add slot</button>
        <button type="button" class="btn ghost sm" id="roWeek">Mon–Fri, Weeks A & B</button>
      </div>
    </div>

    <div class="btn-row" style="justify-content:flex-end;margin-top:18px">
      <button class="btn ghost" id="roCancel">Cancel</button>
      <button class="btn" id="roSave">${editing ? 'Save changes' : 'Create roster'}</button>
    </div>
  `);

  const r = m.root;
  const slotBox = $('#roSlots', r);

  if (editing) {
    $('#roTitle', r).value = existing.title || '';
    $('#roDesc', r).value = existing.description || '';
  }

  const draw = () => {
    if (!slots.length) {
      slotBox.replaceChildren(h('<p class="small muted" style="margin:6px 0">No slots yet.</p>'));
      return;
    }
    slotBox.replaceChildren(...slots.map((s, i) => {
      const row = h(`
        <div class="row" style="margin-bottom:6px">
          <input type="text" class="grow" value="${esc(s.label)}" maxlength="80" aria-label="Slot name">
          <input type="number" min="0" max="99" value="${Number(s.capacity) || 0}"
                 style="width:74px" aria-label="How many people" title="How many people (0 = no limit)">
          <button type="button" class="btn danger icon sm" aria-label="Remove slot">${icon('trash', 13)}</button>
        </div>`);
      const [label, cap] = row.querySelectorAll('input');
      label.oninput = () => { slots[i].label = label.value; };
      cap.oninput = () => { slots[i].capacity = Number(cap.value) || 0; };
      row.querySelector('button').onclick = () => { slots.splice(i, 1); draw(); };
      return row;
    }));
  };
  draw();

  /** Stable, readable slot ids. Reused across edits so claims survive. */
  const idFor = (label, i) =>
    `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'slot'}-${i}`;

  $('#roAdd', r).onclick = () => {
    if (slots.length >= MAX_SLOTS) { toast(`${MAX_SLOTS} slots is the limit.`, true); return; }
    slots.push({ id: idFor('slot', slots.length), label: '', capacity: 2 });
    draw();
  };

  $('#roWeek', r).onclick = () => {
    if (slots.length) { toast('Clear the existing slots first.', true); return; }
    slots = WEEK_A_B.map((label, i) => ({ id: idFor(label, i), label, capacity: 2 }));
    draw();
  };

  $('#roCancel', r).onclick = m.close;

  $('#roSave', r).onclick = async (ev) => {
    const btn = ev.currentTarget;
    const title = $('#roTitle', r).value.trim();
    if (!title) { toast('Give the roster a name.', true); return; }

    const clean = slots
      .map((s, i) => ({
        // Keep an existing id so people already on the slot stay on it. A new
        // id would silently empty the slot while looking unchanged.
        id: s.id || idFor(s.label || 'slot', i),
        label: String(s.label || '').trim() || `Slot ${i + 1}`,
        capacity: Math.max(0, Math.min(99, Number(s.capacity) || 0)),
      }));

    if (!clean.length) { toast('Add at least one slot.', true); return; }

    busy(btn, true, 'Saving…');
    try {
      if (editing) {
        await updateDoc(doc(db, 'rosters', existing.id), {
          title, description: $('#roDesc', r).value.trim(), slots: clean,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'rosters'), {
          title, description: $('#roDesc', r).value.trim(), slots: clean,
          createdBy: state.user.uid, createdByName: state.profile.name,
          createdAt: serverTimestamp(),
        });
      }
      m.close();
      toast(editing ? 'Roster updated.' : 'Roster created.');
      onSaved?.();
    } catch (e) {
      console.error(e);
      busy(btn, false);
      toast(friendlyError(e), true);
    }
  };
}
