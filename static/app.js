/* ============================================================
   Captionato Task Manager — app.js
   Vanilla JS, no frameworks, no build step.

   Structure:
     1. Tiny helpers (fetch wrapper, escaping, dates)
     2. Auth gate
     3. View switching + rendering
     4. Card actions (claim / done / accept / updates)
     5. Add Task modal
     6. Polling on tab focus
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
  let openThreads = new Set(); // task ids with thread expanded, survives re-render

  // ------------------------------------------------ 2. auth gate

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

  // ------------------------------------------------ 3. views + rendering

  const listEl = $('#task-list');
  const emptyEl = $('#empty-state');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentView = tab.dataset.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $('#view-title').textContent = VIEWS[currentView].title;
      openThreads = new Set();
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
        // Dashboard: fetch all, filter client-side, unassigned first (PRD §6).
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
    $('#view-count').textContent = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;

    if (!tasks.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = EMPTY_COPY[currentView];
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = tasks.map(cardHTML).join('');

    // Re-open any threads that were open before the re-render.
    openThreads.forEach((id) => {
      const card = listEl.querySelector(`.task-card[data-id="${id}"]`);
      if (card) openThread(card, id, false);
    });
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
      actions.push('<button class="btn btn-primary act-claim">Claim Task</button>');
    }
    if (t.status === 'ongoing') {
      actions.push('<button class="btn btn-primary act-done">Mark as Done</button>');
    }
    if (t.status === 'under_review') {
      actions.push('<button class="btn btn-primary act-accept">Accept</button>');
    }
    if (t.status === 'ongoing' || t.status === 'done') {
      actions.push('<button class="btn btn-ghost act-add-update">Add Update</button>');
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
        ${t.description ? `<p class="card-desc" title="Click to expand">${esc(t.description)}</p>` : ''}
        <div class="card-actions">${actions.join('')}</div>
        <div class="claim-slot"></div>
        <div class="thread-slot"></div>
      </article>`;
  }

  // ------------------------------------------------ 4. card actions

  listEl.addEventListener('click', async (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const id = Number(card.dataset.id);

    if (e.target.classList.contains('card-desc')) {
      e.target.classList.toggle('is-expanded');
      return;
    }
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
    if (e.target.classList.contains('act-view-updates') ||
        e.target.classList.contains('act-add-update')) {
      const slot = card.querySelector('.thread-slot');
      if (slot.childElementCount && !e.target.classList.contains('act-add-update')) {
        slot.innerHTML = '';
        openThreads.delete(id);
      } else {
        await openThread(card, id, e.target.classList.contains('act-add-update'));
      }
    }
  });

  async function patchTask(id, body) {
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  // --- claim inline prompt (PRD §9)

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
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
    slot.querySelector('.claim-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
  }

  // --- updates thread (PRD §10)

  async function openThread(card, id, focusInput) {
    const slot = card.querySelector('.thread-slot');
    let updates = [];
    try {
      updates = await api(`/api/tasks/${id}/updates`);
    } catch (err) {
      if (err.message !== 'Unauthorized') alert(err.message);
      return;
    }
    openThreads.add(id);

    const items = updates.length
      ? `<div class="thread-list">${updates.map((u) => `
          <div class="thread-item">
            <div class="thread-item-head">
              <span class="thread-author">${esc(u.author)}</span> · ${fmtDateTime(u.created_at)}
            </div>
            <div>${esc(u.content)}</div>
          </div>`).join('')}</div>`
      : '<p class="thread-empty">No updates yet.</p>';

    const status = card.dataset.status;
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
          refresh();
        } catch (err) {
          alert(err.message);
        }
      });
      if (focusInput) nameInput.focus();
    }
  }

  // ------------------------------------------------ 5. Add Task modal

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
    if (e.key === 'Escape' && !backdrop.hidden) closeModal();
  });

  // Live swatch — the only color validation affordance for v1 (PRD §16).
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
      // Jump to Under Review so the submitter sees their task land (PRD §8).
      document.querySelector('.tab[data-view="under_review"]').click();
    } catch (err) {
      showModalError(err.message);
    }
  });

  function showModalError(msg) {
    modalError.textContent = msg;
    modalError.hidden = false;
  }

  // ------------------------------------------------ 6. polling on focus

  // PRD §15: no real-time push; refetch when the tab regains focus.
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

})();
