# Product Requirements Document
## Captionato Task Manager — User System Update
**Version:** 2.0  
**Author:** CapCap  
**Status:** Ready for Build  
**Target URL:** `management.captionato.tech`  
**Builds on:** Task Manager v1.0 (Flask + SQLite)

---

## 1. Overview

This update replaces the single shared passphrase system with individual user accounts, roles, and a proper authentication flow. It introduces user-specific task views, cooperator mechanics, an admin panel at `/admin`, and an audit log. The core task system (statuses, cards, updates thread) remains unchanged from v1.0. This document covers only what is new or modified.

---

## 2. What Changes vs v1.0

| Area | v1.0 | v2.0 |
|---|---|---|
| Auth | Single shared passphrase | Individual username + password accounts |
| Registration | N/A | Username, password, invite code |
| Roles | None | `user`, `admin` |
| Task claiming | Enter your name manually | Claim auto-attaches your account |
| Assignment | N/A | Admins assign a primary assignee + optional co-assignees |
| Cooperators | N/A | Primary assignee or admin can add registered users as co-assignees |
| Task views | All tasks only | My Tasks view + All Tasks toggle |
| Admin panel | N/A | `/admin` — user management, task deletion, audit log, export |
| Invite codes | Shared passphrase | Admin-generated reusable codes |
| Existing data | `assigned_to` is plain text | Clear all existing `assigned_to` values — reassign manually after launch |

---

## 3. Tech Stack

No changes to the core stack. All additions are within the existing Flask + SQLite setup.

New Python dependency:
```
werkzeug  # for password hashing — likely already installed as a Flask dependency
```

No other new dependencies required.

---

## 4. Data Model Changes

### Modified Table: `tasks`

Add the following columns to the existing `tasks` table:

| Column | Type | Notes |
|---|---|---|
| `assigned_to` | REMOVED | Replaced by the `task_assignments` table |
| `created_by_user_id` | INTEGER | FK → `users.id` — who submitted the task |

> **Migration note:** Drop the `assigned_to` text column. Null out or migrate existing values. All assignment going forward is handled via `task_assignments`.

---

### New Table: `users`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `username` | TEXT NOT NULL UNIQUE | Display name and login identifier |
| `password_hash` | TEXT NOT NULL | Hashed via `werkzeug.security.generate_password_hash` |
| `role` | TEXT NOT NULL DEFAULT 'user' | One of: `user`, `admin` |
| `created_at` | TEXT | ISO 8601 timestamp |

---

### New Table: `invite_codes`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `code` | TEXT NOT NULL UNIQUE | The invite code string |
| `created_by` | INTEGER | FK → `users.id` — admin who generated it |
| `created_at` | TEXT | ISO 8601 timestamp |
| `active` | INTEGER DEFAULT 1 | 1 = active, 0 = deactivated. Reusable while active. |

---

### New Table: `task_assignments`

Replaces the `assigned_to` text field. Supports one primary assignee and multiple co-assignees per task.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `task_id` | INTEGER | FK → `tasks.id` |
| `user_id` | INTEGER | FK → `users.id` |
| `role` | TEXT NOT NULL | One of: `primary`, `co` |
| `assigned_at` | TEXT | ISO 8601 timestamp |

**Rules:**
- A task can have at most one `primary` assignee at a time.
- A task can have any number of `co` assignees.
- When a user self-claims a task, they are inserted as `primary`.
- When an admin assigns a task, they designate one `primary` and optionally one or more `co` assignees.

---

### New Table: `audit_log`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | INTEGER | FK → `users.id` — who performed the action |
| `action` | TEXT NOT NULL | e.g. `claimed_task`, `assigned_task`, `completed_task`, `added_cooperator`, `accepted_review`, `deleted_task`, `registered_user`, `promoted_user`, `generated_invite_code` |
| `target_type` | TEXT | e.g. `task`, `user`, `invite_code` |
| `target_id` | INTEGER | ID of the affected record |
| `detail` | TEXT | Optional freeform detail string (e.g. "assigned to Kasual + Kabir") |
| `created_at` | TEXT | ISO 8601 timestamp |

Every meaningful action in the app writes a row to this table. See Section 10 for the full list of logged actions.

---

## 5. Authentication Flow

### Login
- `GET /` serves `index.html` as before.
- If the user has no active session, the frontend shows the **Login screen** (full-bleed, same design language as the old password gate).
- Login form: `username` + `password`.
- On submit → `POST /auth/login` → Flask verifies credentials via `werkzeug.security.check_password_hash`.
- On success: `session['user_id']` and `session['role']` are set. User is admitted to the app.
- On failure: generic `"Invalid username or password"` message. No lockout for v2.

### Registration
- A **"Register"** link on the login screen opens the registration form.
- Registration form fields: `username`, `password`, `invite_code`.
- On submit → `POST /auth/register`.
- Server checks: username is not taken, invite code exists and is active (`active = 1`).
- On success: user is created with role `user`, session is set, user is admitted immediately. No admin approval step.
- On failure: specific error per field (username taken, invalid code, etc.).

### Logout
- `POST /auth/logout` clears the session. User returns to login screen.
- The **"Lock"** button in the header calls this.

### Session shape
```python
session['user_id']  # integer
session['role']     # 'user' or 'admin'
```

### Auth middleware
Two decorators replace the single `@login_required` from v1.0:

```python
@login_required       # any authenticated user
@admin_required       # admins only — returns 403 if role != 'admin'
```

---

## 6. Roles & Permissions

| Action | User | Admin |
|---|---|---|
| View all tasks | ✅ | ✅ |
| Claim an unassigned task | ✅ | ✅ |
| Add cooperators to their own task | ✅ | ✅ |
| Mark their own task as done | ✅ | ✅ |
| Mark a cooperated task as done | ✅ | ✅ |
| Add task updates | ✅ | ✅ |
| Submit tasks (under review) | ✅ | ✅ |
| Accept under_review tasks | ✅ | ✅ |
| Assign tasks to specific users | ❌ | ✅ |
| Unassign tasks | ❌ | ✅ |
| Complete tasks on behalf of others | ❌ | ✅ |
| Delete tasks | ❌ | ✅ (admin panel only) |
| Access `/admin` | ❌ | ✅ |
| Generate invite codes | ❌ | ✅ |
| Deactivate invite codes | ❌ | ✅ |
| Promote/demote users | ❌ | ✅ |
| View audit log | ❌ | ✅ |
| Export tasks to Markdown | ❌ | ✅ |

---

## 7. Task Claiming & Assignment

### User self-claiming
- Same flow as v1.0 but no name prompt. The user's account is used automatically.
- Clicking **Claim Task** on an unassigned card immediately inserts a `task_assignments` row with `role = 'primary'` for the current user.
- Task status changes to `ongoing`.

### Admin assignment
- Admins see an **Assign** button on any task card (in addition to standard actions).
- Clicking Assign opens a modal with:
  - A **Primary Assignee** dropdown (registered users list, required).
  - A **Co-assignees** multi-select (registered users list, optional).
- On confirm, the existing `task_assignments` rows for that task are replaced with the new selection.
- Task status changes to `ongoing`.
- Audit log entry written.

### Admin unassign
- Admins see an **Unassign** button on any `ongoing` task.
- Clicking it removes all rows from `task_assignments` for that task and resets status to `unassigned`.
- Audit log entry written.

---

## 8. Cooperators

- The primary assignee of a task (or an admin) can add cooperators.
- **Add Cooperator** button appears on task cards where the current user is the primary assignee (or if admin).
- Clicking opens a dropdown of registered users (excluding already-assigned users on that task).
- Selected user is inserted into `task_assignments` with `role = 'co'`.
- Audit log entry written.

---

## 9. Task Views

### My Tasks view (new default for logged-in users)
Shows tasks where the current user is either `primary` or `co` assignee. Split into two sections:

**Assigned to me** — tasks where `role = 'primary'`
**Shared with me** — tasks where `role = 'co'`, visually distinguished with a small cooperator icon on the card (e.g. a people/group icon).

### All Tasks toggle
A toggle switch in the header (or top of the task area) switches between **My Tasks** and **All Tasks**. All Tasks shows the full Dashboard view from v1.0 (unassigned + ongoing, all users).

### Existing views (unchanged from v1.0)
Views 2–5 (Unassigned, Ongoing, Done, Under Review) remain. When in **My Tasks** mode, these views filter to the current user's tasks only. When in **All Tasks** mode, they show all tasks as before.

---

## 10. Audit Log

Every meaningful action writes a row to `audit_log`. Full list of logged actions:

| Action string | Trigger |
|---|---|
| `registered_user` | New user registers |
| `logged_in` | User logs in |
| `claimed_task` | User self-claims a task |
| `assigned_task` | Admin assigns a task |
| `unassigned_task` | Admin unassigns a task |
| `added_cooperator` | Cooperator added to a task |
| `completed_task` | Task marked as done |
| `added_update` | Update added to a task |
| `submitted_task` | Task submitted (under_review) |
| `accepted_task` | Under_review task accepted |
| `deleted_task` | Task deleted (admin only) |
| `promoted_user` | User promoted to admin |
| `demoted_user` | Admin demoted to user |
| `generated_invite_code` | Invite code created |
| `deactivated_invite_code` | Invite code deactivated |

---

## 11. Admin Panel (`/admin`)

Accessible only to users with `role = 'admin'`. A separate page served at `/admin`. Link in the header nav only visible to admins.

### Sections:

**Users**
- Table of all registered users: username, role, registration date.
- Promote to Admin / Demote to User button per row.
- No user deletion in v2 (can be added later).

**Invite Codes**
- Table of all generated codes: code string, created by, created date, active status.
- **Generate New Code** button — admin enters a code string (or it's auto-generated), inserted into `invite_codes`.
- **Deactivate** button per active code — sets `active = 0`. Deactivated codes can no longer be used to register.

**Task Management**
- Full task list with delete controls.
- Admin can delete any task from here. Deletion is permanent. Audit log entry written.
- No bulk delete in v2.

**Audit Log**
- Paginated table of all audit log entries: timestamp, username, action, target, detail.
- Newest first.
- No filters required in v2 — full log only.

**Export Tasks**
- A filter dropdown for status (`all`, `unassigned`, `ongoing`, `done`, `under_review`).
- **Export to Markdown** button — calls `GET /admin/export?status=<value>`.
- Server generates and returns a `.md` file as a download.

**Markdown export format:**
```markdown
# Captionato Task Export
**Status filter:** ongoing
**Exported at:** 2026-06-13T10:00:00

---

## Task: Fix Contact Form Email
**Status:** ongoing
**Assigned to:** Kasual (primary), Kabir (co)
**Category color:** #C94040
**Created:** 2026-05-01
**Description:**
The Contact Us form stores responses but doesn't send confirmation emails...

**Updates:**
- [2026-05-03] Kasual: Investigated the SMTP config, issue is with the mail plugin settings.

---
```

---

## 12. API Endpoints (New & Modified)

All existing `/api/tasks` endpoints remain. New and modified endpoints:

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | Public | Register with username, password, invite code |
| `POST` | `/auth/login` | Public | Login with username + password |
| `POST` | `/auth/logout` | Any | Clear session |
| `GET` | `/api/users` | Any | List all registered users (for dropdowns) |
| `POST` | `/api/tasks/<id>/assign` | Admin | Assign primary + co-assignees |
| `POST` | `/api/tasks/<id>/unassign` | Admin | Remove all assignees |
| `POST` | `/api/tasks/<id>/cooperators` | Primary assignee or Admin | Add a cooperator |
| `GET` | `/api/tasks/mine` | Any | Tasks assigned to current user (primary + co) |
| `GET` | `/admin/export` | Admin | Download filtered task export as `.md` |
| `GET` | `/admin/audit` | Admin | Paginated audit log |
| `POST` | `/admin/users/<id>/promote` | Admin | Set user role to admin |
| `POST` | `/admin/users/<id>/demote` | Admin | Set user role to user |
| `POST` | `/admin/invite-codes` | Admin | Generate a new invite code |
| `POST` | `/admin/invite-codes/<id>/deactivate` | Admin | Deactivate an invite code |
| `DELETE` | `/admin/tasks/<id>` | Admin | Permanently delete a task |

---

## 13. Frontend Changes

- **Login/Register screens** replace the old password gate. Same full-bleed centered design language. Register form has a "Back to Login" link.
- **Header** gains: username display (top right), Lock button (unchanged), Admin link (visible to admins only), My Tasks / All Tasks toggle.
- **Task cards** gain: assignee display now shows user avatars/names from real accounts. Cooperator icon on shared tasks. Assign button (admins only). Add Cooperator button (primary assignee + admins).
- **My Tasks view** is the new default landing view after login.
- **Admin nav link** in header opens `/admin` in the same tab.

---

## 14. Database Migration from v1.0

On app startup, `init_db()` should handle the migration safely:

1. `CREATE TABLE IF NOT EXISTS` for all new tables (`users`, `invite_codes`, `task_assignments`, `audit_log`).
2. For the `tasks` table: add `created_by_user_id` column if it doesn't exist (`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ...`).
3. Set all existing tasks' `assigned_to` to `NULL` (or leave as-is for display in a legacy field — see note below).
4. The old `assigned_to` text column can remain in the schema temporarily for reference but should not be written to going forward.

> **Practical note for CapCap:** After deploying v2.0, go through existing ongoing tasks in the admin panel and reassign them to the correct users manually. The old `assigned_to` text can serve as a reference during this process.

---

## 15. First Admin User

There is no admin user in the database on first run. Bootstrap process:

1. The first registered user (or a specific one) needs to be promoted manually.
2. Provide a one-time bootstrap script or Flask CLI command: `flask make-admin <username>` that sets `role = 'admin'` for that username.
3. After that, all future promotions happen through the admin panel UI.

---

## 16. Out of Scope (v2)

- Password reset / forgot password flow
- User profile pages or avatars
- Per-user notification preferences
- Bulk task operations
- User deletion
- Audit log filtering
- Real-time updates (polling on tab focus remains acceptable)
- Mobile-optimised layout
