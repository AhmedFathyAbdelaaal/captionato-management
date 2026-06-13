/* ============================================================
   Captionato Admin Panel — admin.js
   Vanilla JS, no frameworks, no build step.
   ============================================================ */

(function () {
  'use strict';

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
    if (res.status === 401) { window.location.href = '/'; throw new Error('Unauthorized'); }
    if (res.status === 403) { alert('Admin access required.'); window.location.href = '/'; throw new Error('Forbidden'); }
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
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------------------------------ dark mode

  const themeBtn = $('#theme-btn');

  (function initTheme() {
    if (localStorage.getItem('captionato-theme') === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }
    syncIcon();
  })();

  function syncIcon() {
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
    syncIcon();
  });

  // ------------------------------------------------ auth check + boot

  let currentUser = null;

  (async function boot() {
    try {
      currentUser = await api('/api/me');
      if (currentUser.role !== 'admin') {
        alert('Admin access required.');
        window.location.href = '/';
        return;
      }
      $('#username-display').textContent = currentUser.username;
      loadSection('users');
    } catch {
      // api() already redirected to /
    }
  })();

  $('#lock-btn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/';
  });

  // ------------------------------------------------ section tabs

  document.querySelectorAll('.tab[data-section]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.section;
      document.querySelectorAll('.tab[data-section]').forEach((t) =>
        t.classList.toggle('is-active', t === tab)
      );
      document.querySelectorAll('.admin-content-panel').forEach((p) =>
        p.classList.toggle('is-active', p.id === `panel-${section}`)
      );
      loadSection(section);
    });
  });

  function loadSection(section) {
    switch (section) {
      case 'users':        loadUsers();  break;
      case 'invite-codes': loadCodes();  break;
      case 'tasks':        loadTasks();  break;
      case 'audit':        loadAudit(1); break;
      case 'export':       /* static */  break;
    }
  }

  // ------------------------------------------------ Users

  async function loadUsers() {
    const tbody = $('#users-tbody');
    try {
      const users = await api('/api/users');
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="dim" style="text-align:center;padding:24px">No users yet.</td></tr>';
        return;
      }
      tbody.innerHTML = users.map((u) => {
        const isSelf = currentUser && u.id === currentUser.id;
        const roleAction = u.role === 'admin'
          ? `<button class="btn btn-ghost" data-action="demote" data-id="${u.id}" ${isSelf ? 'disabled title="Cannot demote yourself"' : ''}>Demote</button>`
          : `<button class="btn btn-primary" data-action="promote" data-id="${u.id}">Promote to Admin</button>`;
        return `<tr>
          <td>${esc(u.username)} ${isSelf ? '<span class="dim">(you)</span>' : ''}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-ongoing' : 'badge-unassigned'}">${esc(u.role)}</span></td>
          <td class="dim">${fmtDate(u.created_at)}</td>
          <td>${roleAction}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="dim" style="text-align:center;padding:24px">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  $('#users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id;
    const label  = action === 'promote' ? 'promote this user to admin' : 'demote this user to regular user';
    if (!confirm(`Are you sure you want to ${label}?`)) return;
    try {
      await api(`/admin/users/${id}/${action}`, { method: 'POST' });
      loadUsers();
    } catch (err) {
      alert(err.message);
    }
  });

  // ------------------------------------------------ Invite Codes

  async function loadCodes() {
    const tbody = $('#codes-tbody');
    try {
      const codes = await api('/admin/invite-codes');
      if (!codes.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">No invite codes yet.</td></tr>';
        return;
      }
      tbody.innerHTML = codes.map((c) => `
        <tr>
          <td class="mono">${esc(c.code)}</td>
          <td>${esc(c.created_by_username || '—')}</td>
          <td class="dim">${fmtDate(c.created_at)}</td>
          <td>
            <span class="badge ${c.active ? 'badge-ongoing' : 'badge-unassigned'}">
              ${c.active ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>
            ${c.active
              ? `<button class="btn btn-ghost" data-deactivate="${c.id}">Deactivate</button>`
              : '<span class="dim">—</span>'}
          </td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  $('#codes-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-deactivate]');
    if (!btn) return;
    if (!confirm('Deactivate this invite code? It can no longer be used to register.')) return;
    try {
      await api(`/admin/invite-codes/${btn.dataset.deactivate}/deactivate`, { method: 'POST' });
      loadCodes();
    } catch (err) {
      alert(err.message);
    }
  });

  $('#gen-code-btn').addEventListener('click', async () => {
    const code = $('#new-code-input').value.trim();
    try {
      await api('/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify(code ? { code } : {}),
      });
      $('#new-code-input').value = '';
      loadCodes();
    } catch (err) {
      alert(err.message);
    }
  });

  // ------------------------------------------------ Tasks

  async function loadTasks() {
    const tbody = $('#tasks-tbody');
    try {
      const tasks = await api('/api/tasks');
      if (!tasks.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">No tasks yet.</td></tr>';
        return;
      }
      const STATUS_CLASS = {
        unassigned: 'badge-unassigned', ongoing: 'badge-ongoing',
        done: 'badge-done', under_review: 'badge-under_review',
      };
      tbody.innerHTML = tasks.map((t) => {
        const assignees = (t.assignments || []).map((a) =>
          `${esc(a.username)} <span class="dim">(${a.role})</span>`
        ).join(', ') || '<span class="dim">Unassigned</span>';
        const safeNameAttr = esc(t.name).replace(/"/g, '&quot;');
        return `<tr>
          <td>${esc(t.name)}</td>
          <td><span class="badge ${STATUS_CLASS[t.status] || 'badge-unassigned'}">${esc(t.status.replace('_', ' '))}</span></td>
          <td>${assignees}</td>
          <td class="dim">${fmtDate(t.created_at)}</td>
          <td><button class="btn btn-danger" data-delete="${t.id}" data-name="${safeNameAttr}">Delete</button></td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  $('#tasks-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete]');
    if (!btn) return;
    const name = btn.dataset.name;
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/admin/tasks/${btn.dataset.delete}`, { method: 'DELETE' });
      loadTasks();
    } catch (err) {
      alert(err.message);
    }
  });

  // ------------------------------------------------ Audit Log

  async function loadAudit(page) {
    const tbody = $('#audit-tbody');
    const pag   = $('#audit-pagination');
    try {
      const result = await api(`/admin/audit?page=${page}`);
      const entries = result.entries || [];

      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">No audit log entries yet.</td></tr>';
        pag.innerHTML = '';
        return;
      }

      tbody.innerHTML = entries.map((e) => `
        <tr>
          <td class="mono dim">${fmtDateTime(e.created_at)}</td>
          <td>${esc(e.username || '—')}</td>
          <td class="mono">${esc(e.action)}</td>
          <td class="dim">${esc(e.target_type || '')} ${e.target_id ? `#${e.target_id}` : ''}</td>
          <td class="dim">${esc(e.detail || '')}</td>
        </tr>`).join('');

      const { total, pages } = result;
      pag.innerHTML = `
        <button class="btn btn-ghost" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span>Page ${page} of ${pages} &nbsp;·&nbsp; ${total} entries</span>
        <button class="btn btn-ghost" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next →</button>`;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="dim" style="text-align:center;padding:24px">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  $('#audit-pagination').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    loadAudit(parseInt(btn.dataset.page));
  });

  // ------------------------------------------------ Export

  const exportStatus = $('#export-status');
  const exportBtn    = $('#export-btn');

  exportStatus.addEventListener('change', () => {
    const status = exportStatus.value;
    exportBtn.href = status ? `/admin/export?status=${status}` : '/admin/export';
  });

})();
