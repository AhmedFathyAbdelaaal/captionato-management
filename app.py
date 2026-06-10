"""
app.py — Captionato Internal Task Manager (Flask backend).

Routes:
    GET  /                          -> serves the SPA (static/index.html)
    POST /auth/login                -> passphrase check, sets session
    POST /auth/logout               -> clears session ("Lock" button)
    GET  /api/tasks[?status=]       -> list tasks
    POST /api/tasks                 -> create task (forced to under_review)
    PATCH /api/tasks/<id>           -> partial update (status transitions enforced)
    GET  /api/tasks/<id>/updates    -> updates thread, oldest first
    POST /api/tasks/<id>/updates    -> append an update (append-only)

Auth is a single shared passphrase (TEAM_PASSPHRASE env var) + Flask's
built-in signed-cookie session. No accounts, no roles.
"""

import hmac
import os
from datetime import timedelta
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, jsonify, request, session, send_from_directory

import db

load_dotenv()  # local dev only; in Coolify the env vars are injected

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-not-for-production")

# Hard 8h expiry (PRD §3). Sessions are marked permanent on login so
# this lifetime applies.
app.permanent_session_lifetime = timedelta(hours=8)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

TEAM_PASSPHRASE = os.environ.get("TEAM_PASSPHRASE", "")

# Self-bootstrap the schema on every startup (idempotent).
db.init_db()


# ----------------------------------------------------------------- auth

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("authenticated"):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


@app.post("/auth/login")
def login():
    if not TEAM_PASSPHRASE:
        # Misconfiguration guard — fail closed, never open.
        return jsonify({"error": "Server is not configured"}), 500

    data = request.get_json(silent=True) or {}
    attempt = str(data.get("passphrase", ""))

    # Constant-time comparison; generic error on failure (PRD §16).
    if hmac.compare_digest(attempt, TEAM_PASSPHRASE):
        session.permanent = True
        session["authenticated"] = True
        return jsonify({"ok": True})
    return jsonify({"error": "Incorrect passphrase"}), 401


@app.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ SPA

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ------------------------------------------------------------- task API

# PRD §5 — allowed status transitions. "Any status -> done" is handled
# separately below.
ALLOWED_TRANSITIONS = {
    ("unassigned", "ongoing"),      # someone claims it
    ("under_review", "unassigned"), # accepted, becomes a live task
}


def _transition_allowed(current: str, new: str) -> bool:
    if new == current:
        return True            # no status change, just other fields
    if new == "done":
        return True            # any status -> done
    return (current, new) in ALLOWED_TRANSITIONS


@app.get("/api/tasks")
@login_required
def list_tasks():
    status = request.args.get("status")
    if status and status not in db.VALID_STATUSES:
        return jsonify({"error": f"Unknown status '{status}'"}), 400
    return jsonify(db.get_all_tasks(status))


@app.post("/api/tasks")
@login_required
def create_task():
    data = request.get_json(silent=True) or {}

    name = (data.get("name") or "").strip()
    category_color = (data.get("category_color") or "").strip()
    description = (data.get("description") or "").strip() or None
    submitted_by = (data.get("submitted_by") or "").strip() or None

    if not name:
        return jsonify({"error": "Task name is required"}), 400
    if not category_color:
        return jsonify({"error": "Category color is required"}), 400
    if not submitted_by:
        return jsonify({"error": "Submitted by is required"}), 400

    task = db.create_task(name, description, category_color, submitted_by)
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
                "error": f"Transition {task['status']} -> {new_status} is not allowed"
            }), 400
        # Claiming a task requires a name (PRD §9).
        if new_status == "ongoing":
            assignee = (data.get("assigned_to") or task["assigned_to"] or "").strip()
            if not assignee:
                return jsonify({"error": "assigned_to is required to claim a task"}), 400
            data["assigned_to"] = assignee

    updated = db.update_task(task_id, data)
    return jsonify(updated)


@app.delete("/api/tasks/<int:task_id>")
@login_required
def delete_task(task_id):
    if db.get_task(task_id) is None:
        return jsonify({"error": "Task not found"}), 404
    db.delete_task(task_id)
    return jsonify({"ok": True})


# --------------------------------------------------------- updates API

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
    author = (data.get("author") or "").strip()
    content = (data.get("content") or "").strip()

    if not author:
        return jsonify({"error": "Author name is required"}), 400
    if not content:
        return jsonify({"error": "Update content is required"}), 400

    update = db.add_update(task_id, author, content)
    return jsonify(update), 201


if __name__ == "__main__":
    # Local dev only. In production gunicorn runs `app:app` (see Dockerfile).
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
