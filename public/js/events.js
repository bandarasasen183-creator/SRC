// Events: a month calendar of SRC events with sign-ups.
//
// Teachers create events. Everyone sees them on the calendar. If a teacher
// turns sign-ups on for an event, students can put their name down (and take
// it off again), and the teacher sees who's coming.
//
// Data:
//   events/{id}                  the event
//   events/{id}/signups/{uid}    one doc per signed-up person (teacher-listable
//                                only — same privacy shape as form responses)
//   users/{uid}/mySignups/{id}   private per-user mirror, written by the user
//                                at signup time, so "Mine" filtering costs one
//                                small query instead of a read per event.
//
// No listeners here — plain getDocs on tab open and after writes, so the
// events tab adds no standing read load.

import {
  db, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp,
} from './fb.js';
import {
  esc, h, $, toast, busy, friendlyError, confirmDialog, modal, renderBody,
  todayISO, fmtDate, icon, downloadFile, avatarChip, skeleton,
} from './ui.js';
import { richEditor } from './editor.js';
import { state, isTeacher } from './state.js';
import { csvCell, downloadCsv } from './forms.js';

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Module-level view state so revisiting the tab keeps your place.
const now = new Date();
let cur = { y: now.getFullYear(), m: now.getMonth() };
let selectedDate = null;      // 'YYYY-MM-DD' or null = whole month
let filterMine = false;

let monthEvents = [];         // events for the shown month
let mySet = new Set();        // event ids the current user signed up for

function fmtTime(t) {
  if (!t) return '';
  const [H, M] = String(t).split(':').map(Number);
  if (Number.isNaN(H)) return '';
  const h12 = ((H + 11) % 12) + 1;
  return `${h12}:${pad(M || 0)}${H < 12 ? 'am' : 'pm'}`;
}

/**
 * "today" / "tomorrow" / "in 4 days". A date on its own makes you count; this
 * is the bit people actually want to know.
 */
function countdown(dateStr) {
  const today = new Date(`${todayISO()}T12:00:00`);
  const then = new Date(`${dateStr}T12:00:00`);
  const days = Math.round((then - today) / 86400000);
  if (days === 0) return { text: 'Today', cls: 'now' };
  if (days === 1) return { text: 'Tomorrow', cls: 'soon' };
  if (days === -1) return { text: 'Yesterday', cls: 'past' };
  if (days < 0) return { text: `${-days} days ago`, cls: 'past' };
  if (days <= 7) return { text: `In ${days} days`, cls: 'soon' };
  return { text: `In ${days} days`, cls: '' };
}

/** "3 of 10 — 7 more needed", or null when the event has no target. */
function volunteerStatus(ev, count) {
  const needed = Number(ev.needed) || 0;
  if (!needed) return null;
  const have = Number.isFinite(count) ? count : null;
  if (have === null) return { text: `${needed} volunteers needed`, pct: 0, short: needed };
  const short = Math.max(0, needed - have);
  return {
    text: short ? `${have} of ${needed} — ${short} more needed` : `Full: ${have} of ${needed}`,
    pct: Math.min(100, Math.round((have / needed) * 100)),
    short,
  };
}

function timeAndPlace(ev) {
  const t = ev.startTime
    ? fmtTime(ev.startTime) + (ev.endTime ? `–${fmtTime(ev.endTime)}` : '')
    : '';
  return [t, ev.location].filter(Boolean).join(' · ');
}

/* =============================================================================
   Loading
   ========================================================================== */

async function loadMonth() {
  const start = `${cur.y}-${pad(cur.m + 1)}-01`;
  const end = `${cur.y}-${pad(cur.m + 1)}-31`;
  const snap = await getDocs(query(
    collection(db, 'events'),
    where('date', '>=', start), where('date', '<=', end),
    orderBy('date'), limit(200)
  ));
  monthEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  monthEvents.sort((a, b) =>
    a.date === b.date
      ? String(a.startTime || '99').localeCompare(String(b.startTime || '99'))
      : a.date.localeCompare(b.date));
}

async function loadMySignups() {
  const snap = await getDocs(collection(db, 'users', state.user.uid, 'mySignups'));
  mySet = new Set(snap.docs.map((d) => d.id));
}

/* =============================================================================
   The tab
   ========================================================================== */

export async function renderEvents(mount) {
  mount.replaceChildren(h(`
    <div class="wrap">
      <div class="row" style="margin:16px 0 12px">
        <div class="seg" role="group" aria-label="Which events">
          <button data-f="all" aria-pressed="${!filterMine}">All</button>
          <button data-f="mine" aria-pressed="${filterMine}">Mine</button>
        </div>
        <span class="grow"></span>
        ${isTeacher() ? `<button class="btn sm" id="newEvent">${icon('calendar-plus', 15)} New event</button>` : ''}
      </div>

      <div class="cal">
        <div class="cal-head">
          <button class="btn ghost icon sm" id="calPrev" aria-label="Previous month">${icon('left', 16)}</button>
          <strong class="grow center" id="calTitle"></strong>
          <button class="btn ghost icon sm" id="calNext" aria-label="Next month">${icon('right', 16)}</button>
        </div>
        <div class="cal-grid" id="calGrid"></div>
      </div>

      <div id="evList" style="margin-top:14px"><div class="spinner"></div></div>
    </div>
  `));

  $('#calPrev', mount).onclick = () => { shiftMonth(-1, mount); };
  $('#calNext', mount).onclick = () => { shiftMonth(1, mount); };
  if (isTeacher()) {
    $('#newEvent', mount).onclick = () =>
      openEventComposer(null, () => refresh(mount));
  }
  mount.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => {
      filterMine = b.dataset.f === 'mine';
      mount.querySelectorAll('.seg button').forEach((x) =>
        x.setAttribute('aria-pressed', String((x.dataset.f === 'mine') === filterMine)));
      drawList(mount);
    };
  });

  await refresh(mount);
}

function shiftMonth(dir, mount) {
  cur.m += dir;
  if (cur.m < 0) { cur.m = 11; cur.y--; }
  if (cur.m > 11) { cur.m = 0; cur.y++; }
  selectedDate = null;
  refresh(mount);
}

async function refresh(mount) {
  const listEl = $('#evList', mount);
  if (!listEl) return;
  listEl.replaceChildren(h(`<div>${skeleton(2)}</div>`));
  try {
    await Promise.all([loadMonth(), loadMySignups()]);
    drawGrid(mount);
    drawList(mount);
  } catch (e) {
    console.error(e);
    listEl.replaceChildren(h(`<div class="note bad">${esc(friendlyError(e))}</div>`));
  }
}

/* ---- calendar grid -------------------------------------------------------- */

function drawGrid(mount) {
  const title = $('#calTitle', mount);
  const grid = $('#calGrid', mount);
  if (!grid) return;

  title.textContent = `${MONTHS[cur.m]} ${cur.y}`;

  const byDate = new Set(monthEvents.map((e) => e.date));
  const today = todayISO();
  const lead = (new Date(cur.y, cur.m, 1).getDay() + 6) % 7; // Monday-first
  const days = new Date(cur.y, cur.m + 1, 0).getDate();

  const cells = [];
  for (const d of DOW) cells.push(`<div class="cal-dow">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= days; d++) {
    const date = `${cur.y}-${pad(cur.m + 1)}-${pad(d)}`;
    const has = byDate.has(date);
    const cls = [
      'cal-cell',
      has ? 'has-ev' : '',
      date === today ? 'today' : '',
      date === selectedDate ? 'selected' : '',
    ].filter(Boolean).join(' ');
    cells.push(`
      <button type="button" class="${cls}" data-date="${date}"
        aria-label="${d} ${MONTHS[cur.m]}${has ? ', has events' : ''}">
        <span class="num">${d}</span>
        <span class="evdot"></span>
      </button>`);
  }
  grid.innerHTML = cells.join('');

  grid.querySelectorAll('.cal-cell[data-date]').forEach((c) => {
    c.onclick = () => {
      selectedDate = selectedDate === c.dataset.date ? null : c.dataset.date;
      drawGrid(mount);
      drawList(mount);
    };
  });
}

/* ---- event list ----------------------------------------------------------- */

function drawList(mount) {
  const listEl = $('#evList', mount);
  if (!listEl) return;

  let items = monthEvents;
  if (selectedDate) items = items.filter((e) => e.date === selectedDate);
  if (filterMine) items = items.filter((e) => mySet.has(e.id));

  if (!items.length) {
    const what = filterMine
      ? "You haven't signed up to anything " + (selectedDate ? 'on this day.' : 'this month.')
      : selectedDate
        ? 'Nothing on this day.'
        : 'No events this month yet.';
    listEl.replaceChildren(h(`
      <div class="empty" style="padding:28px 20px">
        <div class="icirc">${icon('calendar', 24)}</div>
        <p>${esc(what)}</p>
        ${selectedDate ? '<button class="btn ghost sm" id="clearDay">Show the whole month</button>' : ''}
      </div>`));
    const clear = $('#clearDay', listEl);
    if (clear) clear.onclick = () => { selectedDate = null; drawGrid(mount); drawList(mount); };
    return;
  }

  const box = h('<div class="card" style="padding:6px 20px"></div>');
  for (const ev of items) {
    const day = Number(ev.date.slice(8, 10));
    const dow = DOW[(new Date(ev.date + 'T12:00:00').getDay() + 6) % 7];
    const cd = countdown(ev.date);
    const need = volunteerStatus(ev, null);
    const row = h(`
      <div class="event-row" role="button" tabindex="0" aria-label="${esc(ev.title)}">
        <div class="event-date"><div class="d">${day}</div><div class="w">${dow}</div></div>
        <div class="grow">
          <div style="font-weight:600">${esc(ev.title)}</div>
          ${timeAndPlace(ev) ? `<div class="small muted">${esc(timeAndPlace(ev))}</div>` : ''}
          <div class="event-tags">
            <span class="when-pill ${cd.cls}">${esc(cd.text)}</span>
            ${need ? `<span class="need-pill${need.short ? '' : ' done'}">${icon('users', 11)} ${esc(need.text)}</span>` : ''}
          </div>
        </div>
        ${mySet.has(ev.id) ? `<span class="pill pin">${icon('check', 12)} Going</span>`
          : (ev.signupOpen ? `<span class="pill off">${icon('user-plus', 12)} Sign-up open</span>` : '')}
      </div>`);
    const open = () => openEvent(ev, mount);
    row.onclick = open;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    box.appendChild(row);
  }
  listEl.replaceChildren(box);
}

/* =============================================================================
   Event detail
   ========================================================================== */

async function openEvent(ev, mount) {
  const times = ev.startTime
    ? fmtTime(ev.startTime) + (ev.endTime ? `–${fmtTime(ev.endTime)}` : '')
    : '';
  const m = modal(`
    <h2>${esc(ev.title)}</h2>
    <div class="meta" style="margin-bottom:12px">
      <span>${icon('calendar', 13)} ${esc(fmtDate(ev.date))}</span>
      ${times ? `<span>${icon('clock', 13)} ${esc(times)}</span>` : ''}
      ${ev.location ? `<span>${icon('place', 13)} ${esc(ev.location)}</span>` : ''}
    </div>
    ${ev.description ? `<div class="body">${renderBody(ev.description)}</div>` : ''}
    <div style="margin-top:14px">
      <button class="btn ghost sm" id="evIcs">${icon('download', 14)} Add to my calendar</button>
    </div>
    <div id="evAttendees"></div>
    <div id="evSignupBox" style="margin-top:14px"></div>
    <div id="evTeacherBox"></div>
  `);

  m.root.querySelector('#evIcs').onclick = () => {
    const safe = (ev.title || 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadFile(`${safe}.ics`, buildIcs(ev), 'text/calendar');
    toast('Calendar file downloaded — open it to add the event.');
  };

  const signupBox = m.root.querySelector('#evSignupBox');

  // ---- who's coming -------------------------------------------------------
  // Only when the teacher opted this event in. Otherwise the rules refuse the
  // list and there is nothing to show, which is the intended default.
  if (ev.attendeesVisible && !isTeacher()) {
    const box = m.root.querySelector('#evAttendees');
    try {
      const snap = await getDocs(collection(db, 'events', ev.id, 'signups'));
      const names = snap.docs.map((d) => d.data().name).filter(Boolean);
      const need = volunteerStatus(ev, names.length);
      box.replaceChildren(h(`
        <div class="attendees">
          <div class="row" style="margin-bottom:6px">
            <strong class="grow small">${names.length ? `${names.length} coming` : 'Nobody yet'}</strong>
            ${need ? `<span class="small ${need.short ? 'muted' : 'ok'}">${esc(need.text)}</span>` : ''}
          </div>
          ${need ? `<div class="meter"><i style="width:${need.pct}%"></i></div>` : ''}
          <div class="who-chips">${names.map((n) => avatarChip(n)).join('')}</div>
        </div>`));
    } catch (e) {
      console.error(e);
      box.replaceChildren();
    }
  }

  // ---- my signup state ----------------------------------------------------
  if (ev.signupOpen) {
    const drawMine = (signedUp) => {
      if (signedUp) {
        signupBox.replaceChildren(h(`
          <div>
            <div class="note" style="margin-bottom:10px"><strong>${icon('check', 14)} You're signed up.</strong></div>
            <button class="btn ghost sm" id="evCancelSignup">${icon('x', 14)} Remove my signup</button>
          </div>`));
        signupBox.querySelector('#evCancelSignup').onclick = async (e) => {
          const btn = e.currentTarget;
          busy(btn, true, '…');
          try {
            await deleteDoc(doc(db, 'events', ev.id, 'signups', state.user.uid));
            await deleteDoc(doc(db, 'users', state.user.uid, 'mySignups', ev.id));
            mySet.delete(ev.id);
            toast('Taken off the list.');
            drawMine(false);
            drawList(mount);
          } catch (err) { toast(friendlyError(err), true); busy(btn, false); }
        };
      } else {
        signupBox.replaceChildren(h(`
          <button class="btn block" id="evSignup">${icon('check', 16)} Sign up for this</button>`));
        signupBox.querySelector('#evSignup').onclick = async (e) => {
          const btn = e.currentTarget;
          busy(btn, true, 'Signing up…');
          try {
            await setDoc(doc(db, 'events', ev.id, 'signups', state.user.uid), {
              uid: state.user.uid,
              name: state.profile.name,
              email: state.profile.email,
              yearClass: state.profile.yearClass || '',
              signedUpAt: serverTimestamp(),
            });
            await setDoc(doc(db, 'users', state.user.uid, 'mySignups', ev.id), {
              eventId: ev.id, date: ev.date, signedUpAt: serverTimestamp(),
            });
            mySet.add(ev.id);
            toast("You're on the list.");
            drawMine(true);
            drawList(mount);
          } catch (err) { toast(friendlyError(err), true); busy(btn, false); }
        };
      }
    };
    drawMine(mySet.has(ev.id));
    // The mirror is a hint; confirm against the real signup doc quietly.
    getDoc(doc(db, 'events', ev.id, 'signups', state.user.uid))
      .then((s) => { if (s.exists() !== mySet.has(ev.id)) drawMine(s.exists()); })
      .catch(() => {});
  } else if (!isTeacher()) {
    signupBox.replaceChildren(h('<p class="small muted">No sign-up needed for this one — just come along.</p>'));
  }

  // ---- teacher tools ------------------------------------------------------
  if (isTeacher()) {
    const tbox = m.root.querySelector('#evTeacherBox');
    tbox.replaceChildren(h('<div><hr class="divider"><div class="spinner"></div></div>'));
    try {
      const snap = await getDocs(collection(db, 'events', ev.id, 'signups'));
      const people = snap.docs.map((d) => d.data());
      const inner = h(`
        <div>
          <div class="row" style="margin-bottom:8px">
            <strong class="grow">${people.length} signed up${
              ev.needed ? ` of ${Number(ev.needed)}` : ''}</strong>
            ${people.length ? `<button class="btn subtle sm" id="evCsv">${icon('download', 14)} Export CSV</button>` : ''}
          </div>
          ${(() => { const n = volunteerStatus(ev, people.length);
            return n ? `<div class="meter" style="margin-bottom:10px"><i style="width:${n.pct}%"></i></div>
              <p class="small ${n.short ? 'muted' : 'ok'}" style="margin:0 0 10px">${esc(n.text)}</p>` : ''; })()}
          ${people.length ? `
            <div class="tablewrap"><table>
              <thead><tr><th>Name</th><th>Year/Class</th></tr></thead>
              <tbody>${people.map((p) => `
                <tr><td>${esc(p.name || '—')}</td><td>${esc(p.yearClass || '—')}</td></tr>`).join('')}
              </tbody>
            </table></div>` : ev.signupOpen ? '' : '<p class="small muted">Sign-ups are off for this event.</p>'}
          <div class="btn-row" style="margin-top:12px">
            <button class="btn ghost sm" id="evEdit">${icon('edit', 14)} Edit</button>
            <button class="btn danger sm" id="evDelete">${icon('trash', 14)} Delete</button>
          </div>
        </div>`);

      const csvBtn = inner.querySelector('#evCsv');
      if (csvBtn) csvBtn.onclick = () => {
        const rows = [['Name', 'Email', 'Year/Class'],
          ...people.map((p) => [p.name || '', p.email || '', p.yearClass || ''])];
        const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
        const safe = (ev.title || 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        downloadCsv(`${safe}-signups.csv`, csv);
      };

      inner.querySelector('#evEdit').onclick = () => {
        m.close();
        openEventComposer(ev, () => refresh(mount));
      };
      inner.querySelector('#evDelete').onclick = async () => {
        const ok = await confirmDialog('Delete this event?',
          `"${ev.title}" and its ${people.length} signup${people.length === 1 ? '' : 's'} will be removed.`);
        if (!ok) return;
        try {
          await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
          await deleteDoc(doc(db, 'events', ev.id));
          toast('Event deleted.');
          m.close();
          refresh(mount);
        } catch (err) { toast(friendlyError(err), true); }
      };

      tbox.replaceChildren(h('<hr class="divider">'), inner);
    } catch (e) {
      console.error(e);
      tbox.replaceChildren(h(`<div class="note bad">${esc(friendlyError(e))}</div>`));
    }
  }
}

/* =============================================================================
   Teacher: create / edit
   ========================================================================== */

function openEventComposer(existing, onSaved) {
  const editing = !!existing;
  const m = modal(`
    <h2>${editing ? 'Edit event' : 'New event'}</h2>

    <label class="field">
      <span class="lbl">What is it? <span class="req">*</span></span>
      <input type="text" id="evTitle" maxlength="200" placeholder="e.g. SRC movie night">
    </label>

    <label class="field">
      <span class="lbl">Date <span class="req">*</span></span>
      <input type="date" id="evDate">
    </label>

    <div class="row">
      <label class="field grow">
        <span class="lbl">Starts <span class="muted small">(optional)</span></span>
        <input type="time" id="evStart">
      </label>
      <label class="field grow">
        <span class="lbl">Ends <span class="muted small">(optional)</span></span>
        <input type="time" id="evEnd">
      </label>
    </div>

    <label class="field">
      <span class="lbl">Where <span class="muted small">(optional)</span></span>
      <input type="text" id="evLoc" maxlength="120" placeholder="e.g. School hall">
    </label>

    <div class="field">
      <span class="lbl">Details</span>
      <div id="evDescMount"></div>
    </div>

    <div class="row">
      <label class="field grow">
        <span class="lbl">Volunteers needed <span class="muted small">(optional)</span></span>
        <input type="number" id="evNeeded" min="0" max="999" placeholder="e.g. 10">
      </label>
    </div>

    <label class="switch">
      <input type="checkbox" id="evVisible">
      <span class="track"></span>
      <span class="sw-label">Show who's coming
        <span class="sw-sub">Everyone sees the names. Off by default — turn it on for
          volunteer jobs, so people can see how many more are needed.</span></span>
    </label>

    <label class="switch">
      <input type="checkbox" id="evOpen" checked>
      <span class="track"></span>
      <span class="sw-label">Students can sign up
        <span class="sw-sub">You'll see who's coming, with names.</span></span>
    </label>

    <div class="btn-row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="evCancel">Cancel</button>
      <button class="btn" id="evSave">${editing ? 'Save changes' : 'Add event'}</button>
    </div>
  `);

  const r = m.root;
  const desc = richEditor(existing?.description || '', {
    placeholder: 'What should people know?',
    renderMarkdown: renderBody,
  });
  $('#evDescMount', r).appendChild(desc.el);

  $('#evDate', r).value = existing?.date || selectedDate || todayISO();
  if (editing) {
    $('#evTitle', r).value = existing.title || '';
    $('#evStart', r).value = existing.startTime || '';
    $('#evEnd', r).value = existing.endTime || '';
    $('#evLoc', r).value = existing.location || '';
    $('#evOpen', r).checked = existing.signupOpen !== false;
    $('#evVisible', r).checked = existing.attendeesVisible === true;
    if (existing.needed) $('#evNeeded', r).value = String(existing.needed);
  }

  $('#evCancel', r).onclick = m.close;
  $('#evSave', r).onclick = async (e) => {
    const btn = e.currentTarget;
    const title = $('#evTitle', r).value.trim();
    const date = $('#evDate', r).value;
    if (!title) { toast('Give the event a name.', true); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Pick a date.', true); return; }

    const payload = {
      title,
      date,
      startTime: $('#evStart', r).value || '',
      endTime: $('#evEnd', r).value || '',
      location: $('#evLoc', r).value.trim(),
      description: desc.getMarkdown(),
      signupOpen: $('#evOpen', r).checked,
      attendeesVisible: $('#evVisible', r).checked,
      // Must be an int for the rules; an empty box means no target.
      needed: Math.max(0, Math.min(999, parseInt($('#evNeeded', r).value, 10) || 0)),
    };

    busy(btn, true, 'Saving…');
    try {
      if (editing) {
        await updateDoc(doc(db, 'events', existing.id), {
          ...payload, updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'events'), {
          ...payload,
          createdBy: state.user.uid,
          createdByName: state.profile.name,
          createdAt: serverTimestamp(),
        });
      }
      // Jump the calendar to the event's month so it's visible immediately.
      cur = { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) - 1 };
      selectedDate = null;
      m.close();
      toast(editing ? 'Event updated.' : 'Event added.');
      onSaved?.();
    } catch (err) {
      busy(btn, false);
      toast(friendlyError(err), true);
    }
  };
}

/* =============================================================================
   iCalendar export — pure client, so "Add to my calendar" needs no server.
   ========================================================================== */

function icsEscape(v) {
  return String(v ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n');
}

function buildIcs(ev) {
  const d = ev.date.replaceAll('-', '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');

  let dtstart, dtend;
  if (ev.startTime) {
    // Floating local time: correct for a school where everyone shares a zone.
    const st = ev.startTime.replace(':', '') + '00';
    dtstart = `DTSTART:${d}T${st}`;
    if (ev.endTime) {
      dtend = `DTEND:${d}T${ev.endTime.replace(':', '')}00`;
    } else {
      const endH = String(Math.min(23, Number(ev.startTime.slice(0, 2)) + 1)).padStart(2, '0');
      dtend = `DTEND:${d}T${endH}${ev.startTime.slice(3, 5)}00`;
    }
  } else {
    const next = new Date(ev.date + 'T12:00:00');
    next.setDate(next.getDate() + 1);
    const n = `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
    dtstart = `DTSTART;VALUE=DATE:${d}`;
    dtend = `DTEND;VALUE=DATE:${n}`;
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SRC//Events//EN',
    'BEGIN:VEVENT',
    `UID:${ev.id}@src`,
    `DTSTAMP:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${icsEscape(ev.title)}`,
    ev.location ? `LOCATION:${icsEscape(ev.location)}` : null,
    ev.description ? `DESCRIPTION:${icsEscape(ev.description)}` : null,
    `URL:${location.origin}/#/events`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}
