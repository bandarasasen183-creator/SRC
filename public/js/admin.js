// Teacher admin: add students (single + bulk), roster status, access requests.

import {
  db, fns, httpsCallable,
  doc, collection, getDocs, setDoc, deleteDoc, updateDoc, serverTimestamp, writeBatch,
} from './fb.js';
import {
  esc, h, $, toast, busy, friendlyError, confirmDialog, fmtWhen, icon, downloadFile,
} from './ui.js';
import { chipInput, DEFAULT_DOMAIN } from './emails.js';
import { csvCell } from './forms.js';
import { state } from './state.js';
import { openImporter } from './import.js';

/** Max addresses accepted in one go. Guards against a runaway paste. */
const MAX_PER_BATCH = 300;

export async function renderAdmin(mount) {
  mount.replaceChildren(h(`
    <div class="wrap">
      <h1 style="margin-top:18px">Admin</h1>

      <div class="card">
        <h2>Add students</h2>
        <p class="small muted">Type just the name part — <strong>@${esc(DEFAULT_DOMAIN)}</strong>
          is added for you. Press <kbd>,</kbd> (or Enter) after each one. You can paste a whole
          class list from a spreadsheet.</p>
        <div id="chipMount" style="margin:12px 0"></div>
        <div class="row" style="margin-bottom:12px">
          <label class="switch grow">
            <input type="checkbox" id="asTeacher">
            <span class="track"></span>
            <span class="sw-label">Add as teachers
              <span class="sw-sub">Teachers get the admin panel. Leave off for students.</span></span>
          </label>
        </div>
        <label class="switch">
          <input type="checkbox" id="sendInvite" checked>
          <span class="track"></span>
          <span class="sw-label">Email them a sign-in link now
            <span class="sw-sub">That email is the invitation.</span></span>
        </label>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn" id="addBtn">${icon('user-plus', 16)} Add to roster</button>
          <button class="btn ghost" id="clearBtn">${icon('x', 15)} Clear</button>
        </div>
        <div id="addResult"></div>
      </div>

      <div class="card">
        <div class="row">
          <div class="grow">
            <h2 style="margin:0">Import announcements</h2>
            <p class="small muted" style="margin:4px 0 0">Bring an existing Classroom
              stream across. Nobody is emailed.</p>
          </div>
          <button class="btn ghost sm" id="importBtn">${icon('download', 14)} Import</button>
        </div>
      </div>

      <div id="requestsCard"></div>

      <div class="card">
        <div class="row" style="margin-bottom:4px">
          <h2 class="grow" style="margin:0">Roster</h2>
          <button class="btn ghost sm" id="rosterCsv">${icon('download', 14)} CSV</button>
          <button class="btn ghost sm" id="refresh">${icon('refresh', 14)} Refresh</button>
        </div>
        <label class="searchbox" style="margin:10px 0 4px">
          ${icon('search', 15)}
          <input type="text" id="rosterSearch" class="grow" placeholder="Search name or email"
                 autocomplete="off" aria-label="Search the roster">
        </label>
        <div id="rosterBox"><div class="spinner"></div></div>
      </div>
    </div>
  `));

  const chips = chipInput($('#chipMount', mount), {
    placeholder: 'john.smith, sarah.lee14, …',
  });

  $('#clearBtn', mount).onclick = () => chips.clear();

  $('#importBtn', mount).onclick = () => openImporter(() => {
    toast('Open the Announcements tab to see them.');
  });

  $('#addBtn', mount).onclick = async (e) => {
    const btn = e.currentTarget;
    const emails = chips.getValid();
    const bad = chips.getInvalid();
    const resultBox = $('#addResult', mount);

    if (bad.length) {
      resultBox.replaceChildren(h(`<div class="note bad" style="margin-top:12px">
        Fix or remove these first: ${bad.map((b) => esc(b)).join(', ')}</div>`));
      return;
    }
    if (!emails.length) { toast('Add at least one address.', true); chips.focus(); return; }
    if (emails.length > MAX_PER_BATCH) {
      toast(`That's ${emails.length} addresses. Add at most ${MAX_PER_BATCH} at a time.`, true);
      return;
    }

    const role = $('#asTeacher', mount).checked ? 'teacher' : 'student';
    const invite = $('#sendInvite', mount).checked;

    if (role === 'teacher') {
      const ok = await confirmDialog(
        `Add ${emails.length} teacher${emails.length === 1 ? '' : 's'}?`,
        'Teachers can post announcements, read every form response and see the whole roster.',
        { danger: false, okLabel: 'Add as teachers' }
      );
      if (!ok) return;
    }

    busy(btn, true, 'Adding…');
    resultBox.replaceChildren();
    try {
      // Firestore batches cap at 500 writes.
      for (let i = 0; i < emails.length; i += 400) {
        const batch = writeBatch(db);
        for (const email of emails.slice(i, i + 400)) {
          batch.set(doc(db, 'roster', email), {
            email, role,
            invitedAt: serverTimestamp(),
            invitedBy: state.profile.name,
          }, { merge: true });
        }
        await batch.commit();
      }

      let inviteMsg = '';
      if (invite) {
        try {
          const call = httpsCallable(fns, 'sendInvites');
          const res = await call({ emails });
          const d = res.data || {};
          inviteMsg = `Invitations sent: ${d.sent ?? 0}.` +
            (d.failed ? ` ${d.failed} failed — see the list below.` : '');
          if (d.failedEmails?.length) {
            inviteMsg += ` (${d.failedEmails.slice(0, 5).join(', ')}${d.failedEmails.length > 5 ? '…' : ''})`;
          }
        } catch (err) {
          console.error(err);
          inviteMsg = `Added to the roster, but the invitation email failed: ${friendlyError(err)}. ` +
            `They can still sign in themselves at ${location.origin}.`;
        }
      }

      resultBox.replaceChildren(h(`<div class="note" style="margin-top:12px">
        <strong>Added ${emails.length} to the roster.</strong> ${esc(inviteMsg)}</div>`));
      chips.clear();
      loadRoster(mount);
    } catch (err) {
      console.error(err);
      resultBox.replaceChildren(h(`<div class="note bad" style="margin-top:12px">${esc(friendlyError(err))}</div>`));
    } finally {
      busy(btn, false);
    }
  };

  $('#refresh', mount).onclick = () => { loadRoster(mount); loadRequests(mount); };

  $('#rosterCsv', mount).onclick = () => {
    if (!lastRosterRows.length) { toast('Load the roster first.', true); return; }
    const rows = [
      ['Email', 'Name', 'Year/Class', 'Role', 'Status'],
      ...lastRosterRows.map((r) => [
        r.email, r.user?.name || '', r.user?.yearClass || '', r.role || 'student',
        r.user ? 'Signed in' : 'Invited, not signed in',
      ]),
    ];
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    downloadFile('src-roster.csv', csv, 'text/csv');
  };

  loadRoster(mount);
  loadRequests(mount);
}

/** Last loaded roster, kept for the CSV export. */
let lastRosterRows = [];

/* ---- roster -------------------------------------------------------------- */

async function loadRoster(mount) {
  const box = $('#rosterBox', mount);
  if (!box) return;
  box.replaceChildren(h('<div class="spinner"></div>'));
  try {
    const [rosterSnap, usersSnap] = await Promise.all([
      getDocs(collection(db, 'roster')),
      getDocs(collection(db, 'users')),
    ]);

    const users = new Map();
    usersSnap.docs.forEach((d) => {
      const u = d.data();
      if (u.email) users.set(u.email.toLowerCase(), { id: d.id, ...u });
    });

    const rows = rosterSnap.docs
      .map((d) => {
        const r = d.data();
        const email = (r.email || d.id).toLowerCase();
        return { ...r, email, user: users.get(email) || null };
      })
      .sort((a, b) => {
        // Not-yet-signed-in first: those are the people to chase.
        if (!!a.user !== !!b.user) return a.user ? 1 : -1;
        return a.email.localeCompare(b.email);
      });

    state.rosterEmails = rows.filter((r) => r.role !== 'teacher').map((r) => r.email);
    lastRosterRows = rows;

    const signedIn = rows.filter((r) => r.user).length;
    const pending = rows.length - signedIn;

    box.replaceChildren(h(`
      <div>
        <div class="row small muted" style="margin-bottom:10px;gap:14px;flex-wrap:wrap">
          <span><strong>${rows.length}</strong> invited</span>
          <span><strong style="color:var(--brand)">${signedIn}</strong> signed in</span>
          <span><strong style="color:var(--warn)">${pending}</strong> haven't yet</span>
          <span class="grow"></span>
          ${pending ? `<button class="btn subtle sm" id="remindAll">${icon('send', 13)} Remind all ${pending}</button>` : ''}
        </div>
        <div class="tablewrap">
          <table>
            <thead><tr>
              <th>Email</th><th>Name</th><th>Year/Class</th><th>Role</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr data-email="${esc(r.email)}">
                  <td>${esc(r.email)}</td>
                  <td>${esc(r.user?.name || '—')}</td>
                  <td>${esc(r.user?.yearClass || '—')}</td>
                  <td>${r.role === 'teacher' ? '<span class="pill">Teacher</span>' : 'Student'}</td>
                  <td>${r.user
                    ? `<span class="pill pin">${icon('check', 12)} Signed in</span>`
                    : `<span class="pill off">${icon('clock', 12)} Not yet</span>`}</td>
                  <td>
                    <button class="btn ghost sm" data-resend>${icon('send', 13)} Resend</button>
                    <button class="btn danger sm" data-remove>${icon('trash', 13)} Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${rows.length ? '' : '<p class="muted">Nobody on the roster yet.</p>'}
      </div>
    `));

    // ---- search: filter rows in place, no refetch ----
    const searchEl = $('#rosterSearch', mount);
    if (searchEl) {
      const applyFilter = () => {
        const term = searchEl.value.trim().toLowerCase();
        let shown = 0;
        box.querySelectorAll('tbody tr').forEach((tr) => {
          const hit = !term || tr.textContent.toLowerCase().includes(term);
          tr.hidden = !hit;
          if (hit) shown++;
        });
        let note = box.querySelector('#rosterNone');
        if (!shown) {
          if (!note) {
            note = h('<p class="muted small" id="rosterNone">Nobody matches that search.</p>');
            box.appendChild(note);
          }
        } else if (note) note.remove();
      };
      searchEl.oninput = applyFilter;
      if (searchEl.value) applyFilter();
    }

    // ---- remind everyone who hasn't signed in ----
    const remindBtn = box.querySelector('#remindAll');
    if (remindBtn) {
      remindBtn.onclick = async () => {
        const chase = rows.filter((r) => !r.user).map((r) => r.email);
        const ok = await confirmDialog(
          `Email ${chase.length} student${chase.length === 1 ? '' : 's'} again?`,
          `This resends the sign-in link to everyone who hasn't signed in yet. `
          + `It uses ${chase.length} of your daily email allowance.`,
          { danger: false, okLabel: `Send ${chase.length}` }
        );
        if (!ok) return;
        busy(remindBtn, true, 'Sending…');
        try {
          const res = await httpsCallable(fns, 'sendInvites')({ emails: chase });
          const d = res.data || {};
          toast(d.failed
            ? `Sent ${d.sent}, ${d.failed} failed.`
            : `Reminder sent to ${d.sent}.`, !!d.failed);
        } catch (err) {
          toast(friendlyError(err), true);
        } finally { busy(remindBtn, false); }
      };
    }

    box.querySelectorAll('[data-resend]').forEach((b) => {
      b.onclick = async () => {
        const email = b.closest('tr').dataset.email;
        busy(b, true, '…');
        try {
          const res = await httpsCallable(fns, 'sendInvites')({ emails: [email] });
          toast(res.data?.sent ? 'Invitation resent.' : 'Send failed — check the mail log.', !res.data?.sent);
        } catch (err) { toast(friendlyError(err), true); }
        finally { busy(b, false); }
      };
    });

    box.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = async () => {
        const email = b.closest('tr').dataset.email;
        const ok = await confirmDialog('Remove from the roster?',
          `${email} will lose access. Their existing comments and responses stay.`);
        if (!ok) return;
        try {
          await deleteDoc(doc(db, 'roster', email));
          toast('Removed.');
          loadRoster(mount);
        } catch (err) { toast(friendlyError(err), true); }
      };
    });
  } catch (e) {
    console.error(e);
    box.replaceChildren(h(`<div class="note bad">${esc(friendlyError(e))}</div>`));
  }
}

/* ---- access requests ----------------------------------------------------- */

async function loadRequests(mount) {
  const box = $('#requestsCard', mount);
  if (!box) return;
  try {
    const snap = await getDocs(collection(db, 'accessRequests'));
    if (snap.empty) { box.replaceChildren(); return; }

    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    box.replaceChildren(h(`
      <div class="card">
        <h2>Access requests <span class="pill">${rows.length}</span></h2>
        <p class="small muted">These people signed in but aren't on the roster.</p>
        <div class="tablewrap">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Year</th><th>When</th><th></th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr data-id="${esc(r.id)}">
                  <td>${esc(r.email)}</td>
                  <td>${esc(r.name || '—')}</td>
                  <td>${esc(r.yearClass || '—')}</td>
                  <td>${esc(fmtWhen(r.requestedAt))}</td>
                  <td>
                    <button class="btn sm" data-approve>${icon('check', 14)} Approve</button>
                    <button class="btn ghost sm" data-deny>${icon('x', 14)} Dismiss</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `));

    box.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        const id = b.closest('tr').dataset.id;
        busy(b, true, '…');
        try {
          await setDoc(doc(db, 'roster', id), {
            email: id, role: 'student',
            invitedAt: serverTimestamp(), invitedBy: state.profile.name,
          }, { merge: true });
          await deleteDoc(doc(db, 'accessRequests', id));
          toast('Approved. They can sign in now.');
          loadRequests(mount); loadRoster(mount);
        } catch (err) { toast(friendlyError(err), true); busy(b, false); }
      };
    });

    box.querySelectorAll('[data-deny]').forEach((b) => {
      b.onclick = async () => {
        const id = b.closest('tr').dataset.id;
        try {
          await deleteDoc(doc(db, 'accessRequests', id));
          loadRequests(mount);
        } catch (err) { toast(friendlyError(err), true); }
      };
    });
  } catch (e) {
    console.error(e);
  }
}
