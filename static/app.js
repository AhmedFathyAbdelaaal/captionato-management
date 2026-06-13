/* ============================================================
   Captionato Task Manager v2.0 — app.js
   Vanilla JS, no frameworks, no build step.

   Structure:
     1. Helpers (fetch wrapper, escaping, dates)
     2. Dark mode toggle
     3. Auth state + gate (login / register)
     4. View mode toggle (My Tasks / All Tasks)
     5. View switching + rendering
     6. Card HTML builder
     7. Card actions
     8. Detail popup
     9. Add Task modal
    10. Assign modal (admin)
    11. Add Cooperator modal
    12. Polling on tab focus
   ============================================================ */

(function () {
  'use strict';

  // ------------------------------------------------ 1. helpers

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

  // ------------------------------------------------ 2. dark mode

  const themeBtn = $('#theme-btn');

  (function initTheme() {
    if (localStorage.getItem('captionato-theme') === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }
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

  let currentUser = null; // {id, username, role}

  const gate      = $('#gate');
  const appEl     = $('#app');
  const gateLogin = $('#gate-login');
  const gateReg   = $('#gate-register');

  function showGate(showRegister = false) {
    appEl.hidden = true;
    gate.hidden = false;
    if (showRegister) {
      gateLogin.hidden = true;
      gateReg.hidden = false;
      $('#reg-username').value = '';
      $('#reg-password').value = '';
      $('#reg-invite').value = '';
      $('#reg-error').hidden = true;
      $('#reg-username').focus();
    } else {
      gateLogin.hidden = false;
      gateReg.hidden = true;
      $('#gate-username').value = '';
      $('#gate-password').value = '';
      $('#gate-error').hidden = true;
      $('#gate-username').focus();
    }
  }

  function showApp() {
    gate.hidden = true;
    appEl.hidden = false;
    if (currentUser) {
      $('#username-display').textContent = currentUser.username;
      const adminLink = $('#admin-link');
      if (currentUser.role === 'admin') {
        adminLink.hidden = false;
      } else {
        adminLink.hidden = true;
      }
    }
    refresh();
  }

  function setGateError(msg) {
    const el = $('#gate-error');
    el.textContent = msg;
    el.hidden = false;
  }

  function setRegError(msg) {
    const el = $('#reg-error');
    el.textContent = msg;
    el.hidden = false;
  }

  async function attemptLogin() {
    const username = $('#gate-username').value.trim();
    const password = $('#gate-password').value;
    if (!username || !password) return;
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        currentUser = data.user;
        showApp();
      } else {
        setGateError(data.error || 'Login failed');
      }
    } catch {
      setGateError('Could not reach the server');
    }
  }

  async function attemptRegister() {
    const username    = $('#reg-username').value.trim();
    const password    = $('#reg-password').value;
    const invite_code = $('#reg-invite').value.trim();
    if (!username) { setRegError('Username is required'); return; }
    if (!password) { setRegError('Password is required'); return; }
    try {
      const res = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password, invite_code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        currentUser = data.user;
        showApp();
      } else {
        setRegError(data.error || 'Registration failed');
      }
    } catch {
      setRegError('Could not reach the server');
    }
  }

  $('#gate-submit').addEventListener('click', attemptLogin);
  $('#gate-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-password').focus(); });
  $('#gate-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });

  $('#reg-submit').addEventListener('click', attemptRegister);
  $('#reg-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#reg-password').focus(); });
  $('#reg-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#reg-invite').focus(); });
  $('#reg-invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptRegister(); });

  $('#show-register').addEventListener('click', () => showGate(true));
  $('#show-login').addEventListener('click', () => showGate(false));

  $('#lock-btn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* gate shows anyway */ }
    currentUser = null;
    showGate();
  });

  // On load: probe /api/me. 401 → gate, otherwise straight in.
  (async function boot() {
    try {
      currentUser = await api('/api/me');
      showApp();
    } catch {
      showGate();
    }
  })();

  // ------------------------------------------------ 4. view mode toggle

  let myTasksMode = true;
  let currentView = 'dashboard';
  let tasksCache  = [];

  const btnMyTasks  = $('#btn-my-tasks');
  const btnAllTasks = $('#btn-all-tasks');

  btnMyTasks.addEventListener('click', () => {
    if (myTasksMode) return;
    myTasksMode = true;
    btnMyTasks.classList.add('is-active');
    btnAllTasks.classList.remove('is-active');
    updateViewTitle();
    refresh();
  });

  btnAllTasks.addEventListener('click', () => {
    if (!myTasksMode) return;
    myTasksMode = false;
    btnAllTasks.classList.add('is-active');
    btnMyTasks.classList.remove('is-active');
    updateViewTitle();
    refresh();
  });

  function updateViewTitle() {
    const title = (myTasksMode && currentView === 'dashboard')
      ? 'My Tasks'
      : VIEWS[currentView].title;
    $('#view-title').textContent = title;
  }

  // ------------------------------------------------ 5. views + rendering

  const listEl  = $('#task-list');
  const emptyEl = $('#empty-state');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentView = tab.dataset.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      updateViewTitle();
      refresh();
    });
  });

  async function refresh() {
    if (appEl.hidden) return;
    let tasks;
    try {
      if (myTasksMode) {
        const mine = await api('/api/tasks/mine');
        tasksCache = mine;
        if (currentView === 'dashboard') {
          renderMyTasksDashboard(mine);
          return;
        }
        const view = VIEWS[currentView];
        tasks = mine.filter((t) => view.statuses.includes(t.status));
      } else {
        const view = VIEWS[currentView];
        if (view.statuses.length === 1) {
          tasks = await api(`/api/tasks?status=${view.statuses[0]}`);
        } else {
          const all = await api('/api/tasks');
          tasks = all.filter((t) => view.statuses.includes(t.status));
          tasks.sort((a, b) => {
            if (a.status !== b.status) return a.status === 'unassigned' ? -1 : 1;
            return (b.created_at || '').localeCompare(a.created_at || '');
          });
        }
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

  const EMPTY_COPY_MINE = {
    dashboard: 'No tasks assigned to you. Switch to All Tasks to find something to claim.',
    unassigned: 'No unassigned tasks assigned to you.',
    ongoing: 'No ongoing tasks assigned to you.',
    done: 'No completed tasks assigned to you.',
    under_review: 'No under-review tasks assigned to you.',
  };

  function renderTasks(tasks) {
    tasksCache = tasks;
    $('#view-count').textContent = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;
    if (!tasks.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = (myTasksMode ? EMPTY_COPY_MINE : EMPTY_COPY)[currentView];
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      listEl.innerHTML = tasks.map(cardHTML).join('');
    }
    pruneDetailPopupIfGone(tasks);
  }

  function renderMyTasksDashboard(tasks) {
    tasksCache = tasks;
    const primary = tasks.filter((t) => t.my_role === 'primary');
    const co      = tasks.filter((t) => t.my_role === 'co');

    $('#view-count').textContent = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;

    if (!tasks.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = EMPTY_COPY_MINE.dashboard;
      emptyEl.hidden = false;
      pruneDetailPopupIfGone(tasks);
      return;
    }

    emptyEl.hidden = true;
    let html = '';
    if (primary.length) {
      html += '<div class="task-section-header">Assigned to me</div>';
      html += primary.map(cardHTML).join('');
    }
    if (co.length) {
      html += '<div class="task-section-header">Shared with me</div>';
      html += co.map(cardHTML).join('');
    }
    listEl.innerHTML = html;
    pruneDetailPopupIfGone(tasks);
  }

  function pruneDetailPopupIfGone(tasks) {
    if (!detailBackdrop.hidden) {
      const openId = Number(detailModal.dataset.id);
      if (!tasks.find((t) => t.id === openId)) closeDetailPopup();
    }
  }

  // ------------------------------------------------ 6. card HTML

  function getMyRole(task) {
    if (!currentUser) return null;
    const a = (task.assignments || []).find((a) => a.user_id === currentUser.id);
    return a ? a.role : null;
  }

  function isAssignedTo(task) {
    return getMyRole(task) !== null;
  }

  function isPrimary(task) {
    return getMyRole(task) === 'primary';
  }

  function assigneeDisplay(task) {
    const a = task.assignments || [];
    if (!a.length) return '<span class="card-assignee is-empty">unclaimed</span>';
    const primary = a.find((x) => x.role === 'primary');
    const cos     = a.filter((x) => x.role === 'co');
    let names = primary ? esc(primary.username) : '';
    if (cos.length) names += ' <span class="co-badge">+' + cos.length + ' co</span>';
    return `<span class="card-assignee">→ ${names}</span>`;
  }

  function cardHTML(t) {
    const color = /^#[0-9a-fA-F]{3,8}$/.test(t.category_color || '')
      ? t.category_color : 'var(--accent-soft)';
    const updatesLabel = t.updates_count === 1 ? '1 update' : `${t.updates_count} updates`;
    const isAdmin  = currentUser && currentUser.role === 'admin';
    const myRole   = getMyRole(t);
    const coIcon   = myRole === 'co' ? '<span class="coop-icon" title="Shared with you">⟨co⟩</span>' : '';

    const submitted = t.status === 'under_review' && t.submitted_by
      ? `<span>by ${esc(t.submitted_by)}</span>` : '';

    const actions = [];
    if (t.status === 'unassigned') {
      actions.push('<button class="btn btn-primary act-claim">Claim</button>');
    }
    if (t.status === 'ongoing' && (isAdmin || isAssignedTo(t))) {
      actions.push('<button class="btn btn-primary act-done">Mark Done</button>');
    }
    if (t.status === 'under_review') {
      actions.push('<button class="btn btn-primary act-accept">Accept</button>');
    }
    if (t.status === 'ongoing' && (isAdmin || isPrimary(t))) {
      actions.push('<button class="btn btn-ghost act-coop">+ Co-assignee</button>');
    }
    if (isAdmin && t.status !== 'done') {
      actions.push('<button class="btn btn-ghost act-assign">Assign</button>');
    }
    if (isAdmin && t.status === 'ongoing') {
      actions.push('<button class="btn btn-ghost act-unassign">Unassign</button>');
    }
    if (t.updates_count > 0) {
      actions.push(`<button class="updates-link act-view-updates">${updatesLabel}</button>`);
    }

    return `
      <article class="task-card" data-id="${t.id}" data-status="${esc(t.status)}" style="border-left-color:${esc(color)}">
        <div class="card-top">
          <div class="card-name">${esc(t.name)} ${coIcon}</div>
          <span class="badge badge-${esc(t.status)}">${STATUS_LABELS[t.status] || esc(t.status)}</span>
        </div>
        <div class="card-meta">
          <span>${fmtDate(t.created_at)}</span>
          ${assigneeDisplay(t)}
          ${submitted}
        </div>
        ${t.description ? `<p class="card-desc">${esc(t.description)}</p>` : ''}
        <div class="card-actions">${actions.join('')}</div>
      </article>`;
  }

  // ------------------------------------------------ 7. card actions

  listEl.addEventListener('click', async (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const id = Number(card.dataset.id);

    if (e.target.classList.contains('act-claim')) {
      await claimTask(id); return;
    }
    if (e.target.classList.contains('act-done')) {
      await patchTask(id, { status: 'done' }); return;
    }
    if (e.target.classList.contains('act-accept')) {
      await patchTask(id, { status: 'unassigned' }); return;
    }
    if (e.target.classList.contains('act-coop')) {
      const task = tasksCache.find((t) => t.id === id);
      openCoopModal(task); return;
    }
    if (e.target.classList.contains('act-assign')) {
      const task = tasksCache.find((t) => t.id === id);
      openAssignModal(task); return;
    }
    if (e.target.classList.contains('act-unassign')) {
      await unassignTask(id); return;
    }
    // Everything else → open detail popup
    const focusThread = e.target.classList.contains('act-view-updates');
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

  async function claimTask(id) {
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ongoing' }) });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  async function unassignTask(id) {
    if (!confirm('Remove all assignees from this task?')) return;
    try {
      await api(`/api/tasks/${id}/unassign`, { method: 'POST' });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  // ------------------------------------------------ 8. detail popup

  const detailBackdrop = $('#detail-backdrop');
  const detailModal    = $('#detail-modal');

  async function openDetailPopup(id, focusThread = false) {
    const task = tasksCache.find((t) => t.id === id);
    if (!task) return;

    const color = /^#[0-9a-fA-F]{3,8}$/.test(task.category_color || '')
      ? task.category_color : 'var(--accent-soft)';
    const isAdmin = currentUser && currentUser.role === 'admin';

    detailModal.dataset.id = id;
    $('#detail-modal-title').textContent = task.name;
    $('#detail-badge').innerHTML =
      `<span class="badge badge-${esc(task.status)}">${STATUS_LABELS[task.status] || esc(task.status)}</span>`;

    // Meta
    const colorMeta = task.category_color
      ? `<span><span class="detail-color-swatch" style="background:${esc(color)}"></span>${esc(task.category_color)}</span>` : '';
    const submitted = task.submitted_by
      ? `<span>Submitted by ${esc(task.submitted_by)}</span>` : '';
    const assignees = (task.assignments || []).length
      ? `<span>${task.assignments.map((a) => `${esc(a.username)} (${a.role})`).join(', ')}</span>` : '';
    $('#detail-meta').innerHTML = `
      <span>${fmtDate(task.created_at)}</span>
      ${assignees}
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

    // Actions
    const actions = [];
    if (task.status === 'unassigned') {
      actions.push('<button class="btn btn-primary det-claim">Claim Task</button>');
    }
    if (task.status === 'ongoing' && (isAdmin || isAssignedTo(task))) {
      actions.push('<button class="btn btn-primary det-done">Mark as Done</button>');
    }
    if (task.status === 'under_review') {
      actions.push('<button class="btn btn-primary det-accept">Accept</button>');
    }
    if (task.status === 'ongoing' || task.status === 'done') {
      actions.push('<button class="btn btn-ghost det-add-update">Add Update</button>');
    }
    if (task.status === 'ongoing' && (isAdmin || isPrimary(task))) {
      actions.push('<button class="btn btn-ghost det-coop">Add Cooperator</button>');
    }
    if (isAdmin && task.status !== 'done') {
      actions.push('<button class="btn btn-ghost det-assign">Assign</button>');
    }
    if (isAdmin && task.status === 'ongoing') {
      actions.push('<button class="btn btn-ghost det-unassign">Unassign</button>');
    }
    $('#detail-actions').innerHTML = actions.join('');

    $('#detail-claim-slot').innerHTML = '';
    $('#detail-thread-slot').innerHTML = '<p class="thread-empty" style="margin-top:14px">Loading updates…</p>';

    detailBackdrop.hidden = false;
    detailModal.scrollTop = 0;

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
    const task = tasksCache.find((t) => t.id === id);

    if (e.target.id === 'detail-close') { closeDetailPopup(); return; }

    if (e.target.classList.contains('det-claim')) {
      await claimTask(id); closeDetailPopup(); return;
    }
    if (e.target.classList.contains('det-done')) {
      await patchTask(id, { status: 'done' }); closeDetailPopup(); return;
    }
    if (e.target.classList.contains('det-accept')) {
      await patchTask(id, { status: 'unassigned' }); closeDetailPopup(); return;
    }
    if (e.target.classList.contains('det-add-update')) {
      const ta = $('#detail-thread-slot').querySelector('.thread-content');
      if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); ta.focus(); }
      return;
    }
    if (e.target.classList.contains('det-coop') && task) {
      openCoopModal(task); return;
    }
    if (e.target.classList.contains('det-assign') && task) {
      openAssignModal(task); return;
    }
    if (e.target.classList.contains('det-unassign')) {
      await unassignTask(id); closeDetailPopup(); return;
    }
  });

  // --- updates thread

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
          <textarea class="thread-content" placeholder="What happened?" aria-label="Update"></textarea>
          <button class="btn btn-primary thread-submit">Add update</button>
        </div>` : ''}
      </div>`;

    if (canAdd) {
      const contentInput = slot.querySelector('.thread-content');
      slot.querySelector('.thread-submit').addEventListener('click', async () => {
        const content = contentInput.value.trim();
        if (!content) { contentInput.focus(); return; }
        try {
          await api(`/api/tasks/${id}/updates`, {
            method: 'POST',
            body: JSON.stringify({ content }),
          });
          await loadThread(slot, id, status, false);
          refresh();
        } catch (err) {
          alert(err.message);
        }
      });
      if (focusInput) {
        contentInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        contentInput.focus();
      }
    }
  }

  // ------------------------------------------------ 9. Add Task modal

  const backdrop   = $('#modal-backdrop');
  const fName      = $('#f-name');
  const fDesc      = $('#f-description');
  const fColor     = $('#f-color');
  const fSwatch    = $('#f-swatch');
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
  }

  $('#add-task-btn').addEventListener('click', openModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  fColor.addEventListener('input', () => { fSwatch.style.background = fColor.value.trim(); });

  $('#modal-submit').addEventListener('click', async () => {
    const name  = fName.value.trim();
    const color = fColor.value.trim();
    if (!name)  { showModalError('Task name is required'); fName.focus(); return; }
    if (!color) { showModalError('Category color is required'); fColor.focus(); return; }
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ name, description: fDesc.value.trim(), category_color: color }),
      });
      closeModal();
      document.querySelector('.tab[data-view="under_review"]').click();
    } catch (err) {
      showModalError(err.message);
    }
  });

  function showModalError(msg) {
    modalError.textContent = msg;
    modalError.hidden = false;
  }

  // ------------------------------------------------ 10. Assign modal (admin)

  const assignBackdrop = $('#assign-backdrop');
  let assignTargetTask = null;
  let allUsersCache    = [];

  async function openAssignModal(task) {
    assignTargetTask = task;
    $('#assign-error').hidden = true;

    try {
      allUsersCache = await api('/api/users');
    } catch (err) {
      alert('Could not load users: ' + err.message); return;
    }

    const primary  = task.assignments.find((a) => a.role === 'primary');
    const coIds    = task.assignments.filter((a) => a.role === 'co').map((a) => a.user_id);

    // Populate primary dropdown
    const sel = $('#assign-primary');
    sel.innerHTML = '<option value="">— Select a user —</option>' +
      allUsersCache.map((u) =>
        `<option value="${u.id}" ${primary && primary.user_id === u.id ? 'selected' : ''}>${esc(u.username)}</option>`
      ).join('');

    // Populate co checkboxes
    const coList = $('#assign-co-list');
    coList.innerHTML = allUsersCache.map((u) => `
      <label class="co-check-row">
        <input type="checkbox" value="${u.id}" ${coIds.includes(u.id) ? 'checked' : ''}>
        <span>${esc(u.username)}</span>
      </label>`).join('');

    assignBackdrop.hidden = false;
  }

  function closeAssignModal() {
    assignBackdrop.hidden = true;
    assignTargetTask = null;
  }

  $('#assign-cancel').addEventListener('click', closeAssignModal);
  assignBackdrop.addEventListener('click', (e) => { if (e.target === assignBackdrop) closeAssignModal(); });

  $('#assign-confirm').addEventListener('click', async () => {
    if (!assignTargetTask) return;
    const primary_user_id = parseInt($('#assign-primary').value);
    if (!primary_user_id) {
      const el = $('#assign-error');
      el.textContent = 'Primary assignee is required';
      el.hidden = false;
      return;
    }
    const co_user_ids = [...$('#assign-co-list').querySelectorAll('input[type=checkbox]:checked')]
      .map((cb) => parseInt(cb.value))
      .filter((id) => id !== primary_user_id);

    try {
      await api(`/api/tasks/${assignTargetTask.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ primary_user_id, co_user_ids }),
      });
      closeAssignModal();
      if (!detailBackdrop.hidden) closeDetailPopup();
      refresh();
    } catch (err) {
      const el = $('#assign-error');
      el.textContent = err.message;
      el.hidden = false;
    }
  });

  // ------------------------------------------------ 11. Add Cooperator modal

  const coopBackdrop  = $('#coop-backdrop');
  let coopTargetTask  = null;

  async function openCoopModal(task) {
    coopTargetTask = task;
    $('#coop-error').hidden = true;

    try {
      const users = await api('/api/users');
      const assignedIds = task.assignments.map((a) => a.user_id);
      const available = users.filter((u) => !assignedIds.includes(u.id));

      const sel = $('#coop-select');
      if (!available.length) {
        alert('All users are already assigned to this task.'); return;
      }
      sel.innerHTML = '<option value="">— Select a user —</option>' +
        available.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('');
    } catch (err) {
      alert('Could not load users: ' + err.message); return;
    }

    coopBackdrop.hidden = false;
  }

  function closeCoopModal() {
    coopBackdrop.hidden = true;
    coopTargetTask = null;
  }

  $('#coop-cancel').addEventListener('click', closeCoopModal);
  coopBackdrop.addEventListener('click', (e) => { if (e.target === coopBackdrop) closeCoopModal(); });

  $('#coop-confirm').addEventListener('click', async () => {
    if (!coopTargetTask) return;
    const user_id = parseInt($('#coop-select').value);
    if (!user_id) {
      const el = $('#coop-error');
      el.textContent = 'Please select a user';
      el.hidden = false;
      return;
    }
    try {
      await api(`/api/tasks/${coopTargetTask.id}/cooperators`, {
        method: 'POST',
        body: JSON.stringify({ user_id }),
      });
      closeCoopModal();
      if (!detailBackdrop.hidden) closeDetailPopup();
      refresh();
    } catch (err) {
      const el = $('#coop-error');
      el.textContent = err.message;
      el.hidden = false;
    }
  });

  // ------------------------------------------------ global keyboard

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!assignBackdrop.hidden) { closeAssignModal(); return; }
      if (!coopBackdrop.hidden)   { closeCoopModal();   return; }
      if (!backdrop.hidden)       { closeModal();        return; }
      if (!detailBackdrop.hidden) { closeDetailPopup();  return; }
    }
  });

  // ------------------------------------------------ 12. polling on focus

  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

})();
