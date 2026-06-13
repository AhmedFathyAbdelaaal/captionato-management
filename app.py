"""
app.py — Captionato Internal Task Manager v2.0 (Flask backend).

Auth: individual username + password accounts with roles (user, admin).
New routes vs v1.0 are marked with [NEW]. Modified routes with [MOD].

Routes:
    GET  /                                  -> SPA (static/index.html)
    GET  /admin                             -> Admin panel (static/admin.html)
    POST /auth/register            [NEW]    -> Register with username/password/invite_code
    POST /auth/login               [MOD]    -> Login with username + password
    POST /auth/logout                       -> Clear session
    GET  /api/me                   [NEW]    -> Current user info
    GET  /api/users                [NEW]    -> All users (for dropdowns)
    GET  /api/tasks                [MOD]    -> List tasks (now includes assignments)
    GET  /api/tasks/mine           [NEW]    -> Tasks assigned to current user
    POST /api/tasks                [MOD]    -> Create task (submitted_by from session)
    PATCH /api/tasks/<id>          [MOD]    -> Partial update (claim uses session user)
    GET  /api/tasks/<id>/updates            -> Updates thread
    POST /api/tasks/<id>/updates   [MOD]    -> Add update (author from session)
    POST /api/tasks/<id>/assign    [NEW]    -> Admin: set primary + co assignees
    POST /api/tasks/<id>/unassign  [NEW]    -> Admin: remove all assignees
    POST /api/tasks/<id>/cooperators [NEW]  -> Primary/admin: add co-assignee
    GET  /admin/audit              [NEW]    -> Paginated audit log
    GET  /admin/export             [NEW]    -> Download filtered task export as .md
    POST /admin/users/<id>/promote [NEW]    -> Set user role to admin
    POST /admin/users/<id>/demote  [NEW]    -> Set user role to user
    POST /admin/invite-codes       [NEW]    -> Generate a new invite code
    POST /admin/invite-codes/<id>/deactivate [NEW] -> Deactivate an invite code
    DELETE /admin/tasks/<id>       [NEW]    -> Permanently delete a task

CLI:
    flask make-admin <username>             -> Promote a user to admin
"""

import os
import secrets
import sys
from datetime import timedelta
from functools import wraps

import click
from dotenv import load_dotenv
from flask import (Flask, Response, jsonify, request, session,
                   send_from_directory)
from werkzeug.security import check_password_hash, generate_password_hash

import db

load_dotenv()

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-not-for-production")

app.permanent_session_lifetime = timedelta(hours=8)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

db.init_db()


# ----------------------------------------------------------------- auth decorators

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "Unauthorized"}), 401
        # Always verify role from DB so promotions/demotions take effect
        # immediately without requiring the user to re-login.
        user = db.get_user_by_id(session["user_id"])
        if not user or user["role"] != "admin":
            return jsonify({"error": "Forbidden"}), 403
        session["role"] = user["role"]  # keep session in sync
        return f(*args, **kwargs)
    return decorated


# ----------------------------------------------------------------- auth routes

@app.post("/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    invite_code = (data.get("invite_code") or "").strip()

    if not username:
        return jsonify({"error": "Username is required"}), 400
    if len(username) < 2:
        return jsonify({"error": "Username must be at least 2 characters"}), 400
    if not password:
        return jsonify({"error": "Password is required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    # Invite code is required unless this is the very first user (bootstrap).
    is_first_user = db.get_user_count() == 0
    if not is_first_user:
        if not invite_code:
            return jsonify({"error": "Invite code is required"}), 400
        code_row = db.get_invite_code_by_code(invite_code)
        if not code_row or not code_row["active"]:
            return jsonify({"error": "Invalid or inactive invite code"}), 400

    if db.get_user_by_username(username):
        return jsonify({"error": "Username is already taken"}), 400

    hashed = generate_password_hash(password)
    user = db.create_user(username, hashed)

    session.permanent = True
    session["user_id"] = user["id"]
    session["role"] = user["role"]

    db.log_action(user["id"], "registered_user", "user", user["id"], username)
    return jsonify({"ok": True, "user": user}), 201


@app.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    user_row = db.get_user_by_username(username)
    if not user_row or not check_password_hash(user_row["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    session.permanent = True
    session["user_id"] = user_row["id"]
    session["role"] = user_row["role"]

    db.log_action(user_row["id"], "logged_in", "user", user_row["id"])
    user_public = {"id": user_row["id"], "username": user_row["username"], "role": user_row["role"]}
    return jsonify({"ok": True, "user": user_public})


@app.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


# ----------------------------------------------------------------- SPA routes

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/admin")
def admin_panel():
    return send_from_directory(app.static_folder, "admin.html")


# ----------------------------------------------------------------- user API

@app.get("/api/me")
@login_required
def me():
    user = db.get_user_by_id(session["user_id"])
    if not user:
        session.clear()
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify(user)


@app.get("/api/users")
@login_required
def list_users():
    return jsonify(db.get_all_users())


# ----------------------------------------------------------------- task API

ALLOWED_TRANSITIONS = {
    ("unassigned", "ongoing"),
    ("under_review", "unassigned"),
}


def _transition_allowed(current: str, new: str) -> bool:
    if new == current:
        return True
    if new == "done":
        return True
    return (current, new) in ALLOWED_TRANSITIONS


@app.get("/api/tasks")
@login_required
def list_tasks():
    status = request.args.get("status")
    if status and status not in db.VALID_STATUSES:
        return jsonify({"error": f"Unknown status '{status}'"}), 400
    return jsonify(db.get_all_tasks(status))


@app.get("/api/tasks/mine")
@login_required
def my_tasks():
    return jsonify(db.get_my_tasks(session["user_id"]))


@app.post("/api/tasks")
@login_required
def create_task():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    category_color = (data.get("category_color") or "").strip()
    description = (data.get("description") or "").strip() or None

    if not name:
        return jsonify({"error": "Task name is required"}), 400
    if not category_color:
        return jsonify({"error": "Category color is required"}), 400

    user = db.get_user_by_id(session["user_id"])
    task = db.create_task(
        name, description, category_color,
        submitted_by=user["username"] if user else None,
        created_by_user_id=session["user_id"],
    )
    db.log_action(session["user_id"], "submitted_task", "task", task["id"], name)
    return jsonify(task), 201


@app.patch("/api/tasks/<int:task_id>")
@login_required
def patch_task(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    data = request.get_json(silent=True) or {}
    new_status = data.get("status")

    if new_status is not None:
        if new_status not in db.VALID_STATUSES:
            return jsonify({"error": f"Unknown status '{new_status}'"}), 400
        if not _transition_allowed(task["status"], new_status):
            return jsonify({
                "error": f"Transition {task['status']} → {new_status} is not allowed"
            }), 400

        # Claiming (unassigned → ongoing): auto-assign current user as primary.
        if new_status == "ongoing" and task["status"] == "unassigned":
            db.claim_task(task_id, session["user_id"])
            db.log_action(session["user_id"], "claimed_task", "task", task_id)

        # Marking done: must be an assignee or admin.
        elif new_status == "done":
            if session["role"] != "admin":
                assignments = db.get_task_assignments(task_id)
                if not any(a["user_id"] == session["user_id"] for a in assignments):
                    return jsonify({"error": "You are not assigned to this task"}), 403
            db.log_action(session["user_id"], "completed_task", "task", task_id)

        # Accepting under_review → unassigned: any authenticated user.
        elif new_status == "unassigned" and task["status"] == "under_review":
            db.log_action(session["user_id"], "accepted_task", "task", task_id)

    updated = db.update_task(task_id, data)
    return jsonify(updated)


@app.post("/api/tasks/<int:task_id>/assign")
@admin_required
def assign_task(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    data = request.get_json(silent=True) or {}
    primary_user_id = data.get("primary_user_id")
    co_user_ids = data.get("co_user_ids") or []

    if not primary_user_id:
        return jsonify({"error": "primary_user_id is required"}), 400
    if not db.get_user_by_id(primary_user_id):
        return jsonify({"error": "Primary user not found"}), 404

    db.assign_task(task_id, primary_user_id, co_user_ids)
    db.update_task(task_id, {"status": "ongoing"})

    users = {u["id"]: u["username"] for u in db.get_all_users()}
    names = [users.get(primary_user_id, str(primary_user_id))]
    names += [users.get(uid, str(uid)) for uid in co_user_ids]
    db.log_action(session["user_id"], "assigned_task", "task", task_id,
                  f"assigned to {', '.join(names)}")
    return jsonify(db.get_task(task_id))


@app.post("/api/tasks/<int:task_id>/unassign")
@admin_required
def unassign_task(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    db.unassign_task(task_id)
    db.update_task(task_id, {"status": "unassigned"})
    db.log_action(session["user_id"], "unassigned_task", "task", task_id)
    return jsonify(db.get_task(task_id))


@app.post("/api/tasks/<int:task_id>/cooperators")
@login_required
def add_cooperator(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    # Only primary assignee or admin can add cooperators.
    if session["role"] != "admin":
        assignments = db.get_task_assignments(task_id)
        primary = next((a for a in assignments if a["role"] == "primary"), None)
        if not primary or primary["user_id"] != session["user_id"]:
            return jsonify({"error": "Only the primary assignee or an admin can add cooperators"}), 403

    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    if not db.get_user_by_id(user_id):
        return jsonify({"error": "User not found"}), 404

    added = db.add_cooperator(task_id, user_id)
    if not added:
        return jsonify({"error": "User is already assigned to this task"}), 400

    coop = db.get_user_by_id(user_id)
    db.log_action(session["user_id"], "added_cooperator", "task", task_id,
                  f"added {coop['username']} as co-assignee")
    return jsonify(db.get_task(task_id))


# --------------------------------------------------------------- updates API

@app.get("/api/tasks/<int:task_id>/updates")
@login_required
def list_updates(task_id):
    if db.get_task(task_id) is None:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(db.get_updates(task_id))


@app.post("/api/tasks/<int:task_id>/updates")
@login_required
def create_update(task_id):
    if db.get_task(task_id) is None:
        return jsonify({"error": "Task not found"}), 404

    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "Update content is required"}), 400

    user = db.get_user_by_id(session["user_id"])
    author = user["username"] if user else "Unknown"
    update = db.add_update(task_id, author, content)
    db.log_action(session["user_id"], "added_update", "task", task_id)
    return jsonify(update), 201


# --------------------------------------------------------------- admin API

@app.get("/admin/audit")
@admin_required
def audit_log():
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1
    return jsonify(db.get_audit_log(page=page))


@app.get("/admin/export")
@admin_required
def export_tasks():
    status = request.args.get("status") or None
    if status and status not in db.VALID_STATUSES:
        return jsonify({"error": f"Unknown status '{status}'"}), 400

    tasks = db.get_tasks_with_updates(status)
    from datetime import datetime, timezone
    now_str = datetime.now(timezone.utc).isoformat(timespec="seconds")

    lines = [
        "# Captionato Task Export",
        f"**Status filter:** {status or 'all'}",
        f"**Exported at:** {now_str}",
        "",
        "---",
        "",
    ]
    for t in tasks:
        assignees = ", ".join(
            f"{a['username']} ({a['role']})" for a in t.get("assignments", [])
        ) or "Unassigned"
        lines += [
            f"## Task: {t['name']}",
            f"**Status:** {t['status']}",
            f"**Assigned to:** {assignees}",
            f"**Category color:** {t.get('category_color') or 'N/A'}",
            f"**Created:** {(t.get('created_at') or '')[:10]}",
        ]
        if t.get("description"):
            lines += ["**Description:**", t["description"]]
        updates = t.get("updates", [])
        if updates:
            lines.append("**Updates:**")
            for u in updates:
                date = (u.get("created_at") or "")[:10]
                lines.append(f"- [{date}] {u['author']}: {u['content']}")
        lines += ["", "---", ""]

    md = "\n".join(lines)
    filename = f"tasks-{(status or 'all')}-{now_str[:10]}.md"
    return Response(
        md,
        mimetype="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/admin/users/<int:user_id>/promote")
@admin_required
def promote_user(user_id):
    if not db.get_user_by_id(user_id):
        return jsonify({"error": "User not found"}), 404
    db.set_user_role(user_id, "admin")
    db.log_action(session["user_id"], "promoted_user", "user", user_id)
    return jsonify({"ok": True})


@app.post("/admin/users/<int:user_id>/demote")
@admin_required
def demote_user(user_id):
    if user_id == session["user_id"]:
        return jsonify({"error": "You cannot demote yourself"}), 400
    if not db.get_user_by_id(user_id):
        return jsonify({"error": "User not found"}), 404
    db.set_user_role(user_id, "user")
    db.log_action(session["user_id"], "demoted_user", "user", user_id)
    return jsonify({"ok": True})


@app.get("/admin/invite-codes")
@admin_required
def list_invite_codes():
    return jsonify(db.get_all_invite_codes())


@app.post("/admin/invite-codes")
@admin_required
def create_invite_code():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()
    if not code:
        code = secrets.token_urlsafe(12)

    if db.get_invite_code_by_code(code):
        return jsonify({"error": "That code already exists"}), 400

    result = db.create_invite_code(code, session["user_id"])
    db.log_action(session["user_id"], "generated_invite_code", "invite_code", result["id"], code)
    return jsonify(result), 201


@app.post("/admin/invite-codes/<int:code_id>/deactivate")
@admin_required
def deactivate_invite_code(code_id):
    if not db.deactivate_invite_code(code_id):
        return jsonify({"error": "Invite code not found"}), 404
    db.log_action(session["user_id"], "deactivated_invite_code", "invite_code", code_id)
    return jsonify({"ok": True})


@app.delete("/admin/tasks/<int:task_id>")
@admin_required
def admin_delete_task(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404
    db.log_action(session["user_id"], "deleted_task", "task", task_id, task["name"])
    db.delete_task(task_id)
    return jsonify({"ok": True})


# --------------------------------------------------------------- CLI

@app.cli.command("make-admin")
@click.argument("username")
def make_admin(username):
    """Promote USERNAME to admin role."""
    user = db.get_user_by_username(username)
    if not user:
        click.echo(f"Error: user '{username}' not found.", err=True)
        sys.exit(1)
    db.set_user_role(user["id"], "admin")
    click.echo(f"User '{username}' is now an admin.")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
