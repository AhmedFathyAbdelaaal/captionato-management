/* ============================================================
   Captionato Task Manager — app.js
   Vanilla JS, no frameworks, no build step.

   Structure:
     1. Tiny helpers (fetch wrapper, escaping, dates)
     2. Dark mode toggle
     3. Auth gate
     4. View switching + rendering
     5. Card actions (claim / done / accept)
     6. Detail popup (full task view + updates thread + delete)
     7. Add Task modal
     8. Polling on tab focus
   ============================================================ */

(function () {
  'use strict';

  // ------------------------------------------------ 1. helpers

  const $ = (sel, root) => (root || document).querySelector(sel);

  /** Escape user-supplied text before injecting into innerHTML. */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** JSON fetch wrapper. Throws on non-2xx; 401 re-shows the gate. */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
    if (res.status === 401) {
      showGate();
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' +
           d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  const STATUS_LABELS = {
    unassigned: 'Unassigned',
    ongoing: 'Ongoing',
    done: 'Done',
    under_review: 'Under review',
  };

  const VIEWS = {
    dashboard:    { title: 'Dashboard',    statuses: ['unassigned', 'ongoing'] },
    unassigned:   { title: 'Unassigned',   statuses: ['unassigned'] },
    ongoing:      { title: 'Ongoing',      statuses: ['ongoing'] },
    done:         { title: 'Done',         statuses: ['done'] },
    under_review: { title: 'Under Review', statuses: ['under_review'] },
  };

  let currentView = 'dashboard';
  let tasksCache = []; // kept fresh on every renderTasks; used by detail popup

  // ------------------------------------------------ 2. dark mode

  const themeBtn = $('#theme-btn');

  (function initTheme() {
    const saved = localStorage.getItem('captionato-theme');
    if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
    syncThemeIcon();
  })();

  function syncThemeIcon() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  themeBtn.addEventListener('click', () => {
    if (document.documentElement.dataset.theme === 'dark') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('captionato-theme');
    } else {
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('captionato-theme', 'dark');
    }
    syncThemeIcon();
  });

  // ------------------------------------------------ 3. auth gate

  const gate = $('#gate');
  const appEl = $('#app');
  const gateInput = $('#gate-passphrase');
  const gateError = $('#gate-error');

  function showGate() {
    appEl.hidden = true;
    gate.hidden = false;
    gateInput.value = '';
    gateInput.focus();
  }

  function showApp() {
    gate.hidden = true;
    gateError.hidden = true;
    appEl.hidden = false;
    refresh();
  }

  async function attemptLogin() {
    const passphrase = gateInput.value;
    if (!passphrase) return;
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        showApp();
      } else {
        gateError.textContent = 'Incorrect passphrase';
        gateError.hidden = false;
        gateInput.select();
      }
    } catch {
      gateError.textContent = 'Could not reach the server';
      gateError.hidden = false;
    }
  }

  $('#gate-submit').addEventListener('click', attemptLogin);
  gateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptLogin();
  });

  $('#lock-btn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* gate shows anyway */ }
    showGate();
  });

  // On load: probe the API. 401 -> gate, otherwise straight in.
  (async function boot() {
    try {
      await api('/api/tasks');
      showApp();
    } catch {
      showGate();
    }
  })();

  // ------------------------------------------------ 4. views + rendering

  const listEl = $('#task-list');
  const emptyEl = $('#empty-state');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentView = tab.dataset.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $('#view-title').textContent = VIEWS[currentView].title;
      refresh();
    });
  });

  async function refresh() {
    if (appEl.hidden) return;
    let tasks;
    try {
      const view = VIEWS[currentView];
      if (view.statuses.length === 1) {
        tasks = await api(`/api/tasks?status=${view.statuses[0]}`);
      } else {
        // Dashboard: fetch all, filter client-side, unassigned first.
        const all = await api('/api/tasks');
        tasks = all.filter((t) => view.statuses.includes(t.status));
        tasks.sort((a, b) => {
          if (a.status !== b.status) return a.status === 'unassigned' ? -1 : 1;
          return (b.created_at || '').localeCompare(a.created_at || '');
        });
      }
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        emptyEl.textContent = 'Could not load tasks. Check the server and try again.';
        emptyEl.hidden = false;
        listEl.innerHTML = '';
      }
      return;
    }
    renderTasks(tasks);
  }

  const EMPTY_COPY = {
    dashboard: 'Nothing on the board. Add a task to get things moving.',
    unassigned: 'No unassigned tasks. Everything has an owner.',
    ongoing: 'No tasks in progress right now.',
    done: 'No completed tasks yet.',
    under_review: 'No tasks waiting for review.',
  };

  function renderTasks(tasks) {
    tasksCache = tasks;
    $('#view-count').textContent = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;

    if (!tasks.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = EMPTY_COPY[currentView];
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      listEl.innerHTML = tasks.map(cardHTML).join('');
    }

    // If the detail popup is open for a task that no longer exists, close it.
    if (!detailBackdrop.hidden) {
      const openId = Number(detailModal.dataset.id);
      if (!tasks.find((t) => t.id === openId)) closeDetailPopup();
    }
  }

  function cardHTML(t) {
    const color = /^#[0-9a-fA-F]{3,8}$/.test(t.category_color || '') ? t.category_color : 'var(--accent-soft)';
    const updatesLabel = t.updates_count === 1 ? '1 update' : `${t.updates_count} updates`;

    const assignee = t.status === 'unassigned'
      ? '<span class="card-assignee is-empty">unclaimed</span>'
      : t.assigned_to
        ? `<span class="card-assignee">→ ${esc(t.assigned_to)}</span>`
        : '';

    const submitted = t.status === 'under_review' && t.submitted_by
      ? `<span>by ${esc(t.submitted_by)}</span>`
      : '';

    const actions = [];
    if (t.status === 'unassigned') {
      actions.push('<button class="btn btn-primary act-claim">Claim</button>');
    }
    if (t.status === 'ongoing') {
      actions.push('<button class="btn btn-primary act-done">Mark Done</button>');
    }
    if (t.status === 'under_review') {
      actions.push('<button class="btn btn-primary act-accept">Accept</button>');
    }
    if (t.updates_count > 0) {
      actions.push(`<button class="updates-link act-view-updates">${updatesLabel}</button>`);
    }

    return `
      <article class="task-card" data-id="${t.id}" data-status="${esc(t.status)}" style="border-left-color:${esc(color)}">
        <div class="card-top">
          <div class="card-name">${esc(t.name)}</div>
          <span class="badge badge-${esc(t.status)}">${STATUS_LABELS[t.status] || esc(t.status)}</span>
        </div>
        <div class="card-meta">
          <span>${fmtDate(t.created_at)}</span>
          ${assignee}
          ${submitted}
        </div>
        ${t.description ? `<p class="card-desc">${esc(t.description)}</p>` : ''}
        <div class="card-actions">${actions.join('')}</div>
        <div class="claim-slot"></div>
      </article>`;
  }

  // ------------------------------------------------ 5. card actions

  listEl.addEventListener('click', async (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const id = Number(card.dataset.id);

    // Inline claim buttons — handle without opening popup
    if (e.target.classList.contains('act-claim')) {
      showClaimPrompt(card, id);
      return;
    }
    if (e.target.classList.contains('act-done')) {
      await patchTask(id, { status: 'done' });
      return;
    }
    if (e.target.classList.contains('act-accept')) {
      await patchTask(id, { status: 'unassigned' });
      return;
    }
    // Claim slot internal interactions (confirm/cancel/input) — don't open popup
    if (e.target.closest('.claim-slot')) {
      return;
    }
    // Everything else: card body, description, updates link → open detail popup
    const focusThread = e.target.classList.contains('act-add-update') ||
                        e.target.classList.contains('act-view-updates');
    await openDetailPopup(id, focusThread);
  });

  async function patchTask(id, body) {
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  // --- claim inline prompt on card

  function showClaimPrompt(card, id) {
    const slot = card.querySelector('.claim-slot');
    if (slot.childElementCount) { slot.querySelector('input').focus(); return; }

    slot.innerHTML = `
      <div class="claim-row">
        <input type="text" placeholder="Your name" maxlength="100" aria-label="Your name">
        <button class="btn btn-primary claim-confirm">Claim</button>
        <button class="btn btn-ghost claim-cancel">Cancel</button>
      </div>`;

    const input = slot.querySelector('input');
    input.focus();

    const confirm = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      await patchTask(id, { status: 'ongoing', assigned_to: name });
    };

    slot.querySelector('.claim-confirm').addEventListener('click', confirm);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirm(); });
    slot.querySelector('.claim-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
  }

  // ------------------------------------------------ 6. detail popup

  const detailBackdrop = $('#detail-backdrop');
  const detailModal = $('#detail-modal');

  async function openDetailPopup(id, focusThread = false) {
    const task = tasksCache.find((t) => t.id === id);
    if (!task) return;

    const color = /^#[0-9a-fA-F]{3,8}$/.test(task.category_color || '')
      ? task.category_color : 'var(--accent-soft)';

    // Title + badge
    detailModal.dataset.id = id;
    $('#detail-modal-title').textContent = task.name;
    $('#detail-badge').innerHTML =
      `<span class="badge badge-${esc(task.status)}">${STATUS_LABELS[task.status] || esc(task.status)}</span>`;

    // Meta row
    const assignee = task.status === 'unassigned'
      ? '<span class="card-assignee is-empty">Unclaimed</span>'
      : task.assigned_to
        ? `<span class="card-assignee">→ ${esc(task.assigned_to)}</span>`
        : '';
    const submitted = task.submitted_by
      ? `<span>Submitted by ${esc(task.submitted_by)}</span>`
      : '';
    const colorMeta = task.category_color
      ? `<span><span class="detail-color-swatch" style="background:${esc(color)}"></span>${esc(task.category_color)}</span>`
      : '';
    $('#detail-meta').innerHTML = `
      <span>${fmtDate(task.created_at)}</span>
      ${assignee}
      ${submitted}
      ${colorMeta}`;

    // Description
    const descEl = $('#detail-description');
    if (task.description) {
      descEl.textContent = task.description;
      descEl.hidden = false;
    } else {
      descEl.textContent = '';
      descEl.hidden = true;
    }

    // Action buttons
    const actions = [];
    if (task.status === 'unassigned') {
      actions.push('<button class="btn btn-primary det-claim">Claim Task</button>');
    }
    if (task.status === 'ongoing') {
      actions.push('<button class="btn btn-primary det-done">Mark as Done</button>');
    }
    if (task.status === 'under_review') {
      actions.push('<button class="btn btn-primary det-accept">Accept</button>');
    }
    if (task.status === 'ongoing' || task.status === 'done') {
      actions.push('<button class="btn btn-ghost det-add-update">Add Update</button>');
    }
    actions.push('<button class="btn btn-danger det-delete">Delete</button>');
    $('#detail-actions').innerHTML = actions.join('');

    // Reset slots
    $('#detail-claim-slot').innerHTML = '';
    $('#detail-thread-slot').innerHTML = '<p class="thread-empty" style="margin-top:14px">Loading updates…</p>';

    // Show popup
    detailBackdrop.hidden = false;
    detailModal.scrollTop = 0;

    // Load thread
    await loadThread($('#detail-thread-slot'), id, task.status, focusThread);
  }

  function closeDetailPopup() {
    detailBackdrop.hidden = true;
    $('#detail-thread-slot').innerHTML = '';
    $('#detail-claim-slot').innerHTML = '';
  }

  detailBackdrop.addEventListener('click', async (e) => {
    if (e.target === detailBackdrop) { closeDetailPopup(); return; }

    const id = Number(detailModal.dataset.id);

    if (e.target.id === 'detail-close') {
      closeDetailPopup();
      return;
    }
    if (e.target.classList.contains('det-claim')) {
      showClaimPromptInDetail(id);
      return;
    }
    if (e.target.classList.contains('det-done')) {
      await patchTask(id, { status: 'done' });
      closeDetailPopup();
      return;
    }
    if (e.target.classList.contains('det-accept')) {
      await patchTask(id, { status: 'unassigned' });
      closeDetailPopup();
      return;
    }
    if (e.target.classList.contains('det-add-update')) {
      const nameInput = $('#detail-thread-slot').querySelector('.thread-name');
      if (nameInput) {
        nameInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        nameInput.focus();
      }
      return;
    }
    if (e.target.classList.contains('det-delete')) {
      const taskName = $('#detail-modal-title').textContent;
      if (!confirm(`Delete "${taskName}"? This cannot be undone.`)) return;
      try {
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
        closeDetailPopup();
        refresh();
      } catch (err) {
        alert(err.message);
      }
      return;
    }
  });

  // --- claim prompt inside detail popup

  function showClaimPromptInDetail(id) {
    const slot = $('#detail-claim-slot');
    if (slot.childElementCount) { slot.querySelector('input').focus(); return; }

    slot.innerHTML = `
      <div class="claim-row">
        <input type="text" placeholder="Your name" maxlength="100" aria-label="Your name">
        <button class="btn btn-primary claim-confirm">Claim</button>
        <button class="btn btn-ghost claim-cancel">Cancel</button>
      </div>`;

    const input = slot.querySelector('input');
    input.focus();

    const doConfirm = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      await patchTask(id, { status: 'ongoing', assigned_to: name });
      closeDetailPopup();
    };

    slot.querySelector('.claim-confirm').addEventListener('click', doConfirm);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doConfirm(); });
    slot.querySelector('.claim-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
  }

  // --- updates thread (used by the detail popup)

  async function loadThread(slot, id, status, focusInput) {
    let updates = [];
    try {
      updates = await api(`/api/tasks/${id}/updates`);
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        slot.innerHTML = '<p class="thread-empty" style="margin-top:14px">Could not load updates.</p>';
      }
      return;
    }

    const items = updates.length
      ? `<div class="thread-list">${updates.map((u) => `
          <div class="thread-item">
            <div class="thread-item-head">
              <span class="thread-author">${esc(u.author)}</span> · ${fmtDateTime(u.created_at)}
            </div>
            <div>${esc(u.content)}</div>
          </div>`).join('')}</div>`
      : '<p class="thread-empty">No updates yet.</p>';

    const canAdd = status === 'ongoing' || status === 'done';

    slot.innerHTML = `
      <div class="thread">
        ${items}
        ${canAdd ? `
        <div class="thread-form">
          <input type="text" class="thread-name" placeholder="Your name" maxlength="100" aria-label="Your name">
          <textarea class="thread-content" placeholder="What happened?" aria-label="Update"></textarea>
          <button class="btn btn-primary thread-submit">Add update</button>
        </div>` : ''}
      </div>`;

    if (canAdd) {
      const nameInput = slot.querySelector('.thread-name');
      const contentInput = slot.querySelector('.thread-content');
      slot.querySelector('.thread-submit').addEventListener('click', async () => {
        const author = nameInput.value.trim();
        const content = contentInput.value.trim();
        if (!author) { nameInput.focus(); return; }
        if (!content) { contentInput.focus(); return; }
        try {
          await api(`/api/tasks/${id}/updates`, {
            method: 'POST',
            body: JSON.stringify({ author, content }),
          });
          // Reload thread in-place and refresh the card list
          await loadThread(slot, id, status, false);
          refresh();
        } catch (err) {
          alert(err.message);
        }
      });
      if (focusInput) {
        nameInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        nameInput.focus();
      }
    }
  }

  // ------------------------------------------------ 7. Add Task modal

  const backdrop = $('#modal-backdrop');
  const fName = $('#f-name');
  const fDesc = $('#f-description');
  const fColor = $('#f-color');
  const fSwatch = $('#f-swatch');
  const fSubmittedBy = $('#f-submitted-by');
  const modalError = $('#modal-error');

  function openModal() {
    modalError.hidden = true;
    backdrop.hidden = false;
    fName.focus();
  }

  function closeModal() {
    backdrop.hidden = true;
    fName.value = '';
    fDesc.value = '';
    fColor.value = '#9E2A2B';
    fSwatch.style.background = '#9E2A2B';
    fSubmittedBy.value = '';
  }

  $('#add-task-btn').addEventListener('click', openModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!backdrop.hidden) closeModal();
      if (!detailBackdrop.hidden) closeDetailPopup();
    }
  });

  // Live swatch preview
  fColor.addEventListener('input', () => {
    fSwatch.style.background = fColor.value.trim();
  });

  $('#modal-submit').addEventListener('click', async () => {
    const name = fName.value.trim();
    const color = fColor.value.trim();
    const submittedBy = fSubmittedBy.value.trim();

    if (!name)        { showModalError('Task name is required'); fName.focus(); return; }
    if (!color)       { showModalError('Category color is required'); fColor.focus(); return; }
    if (!submittedBy) { showModalError('Your name is required'); fSubmittedBy.focus(); return; }

    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: fDesc.value.trim(),
          category_color: color,
          submitted_by: submittedBy,
        }),
      });
      closeModal();
      // Jump to Under Review so the submitter sees their task land.
      document.querySelector('.tab[data-view="under_review"]').click();
    } catch (err) {
      showModalError(err.message);
    }
  });

  function showModalError(msg) {
    modalError.textContent = msg;
    modalError.hidden = false;
  }

  // ------------------------------------------------ 8. polling on focus

  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

})();
