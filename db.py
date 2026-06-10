"""
db.py — SQLite layer for the Captionato Task Manager.

All raw SQL lives here. No ORM. app.py only ever calls the helper
functions below and receives plain dicts back.

The database self-bootstraps: init_db() runs CREATE TABLE IF NOT EXISTS
on every startup, so there is no migration step.
"""

import os
import sqlite3
from datetime import datetime, timezone

# In the container the volume is mounted at /app/data, so the default
# resolves to /app/data/tasks.db. Locally it resolves to ./data/tasks.db.
# Override with the DB_PATH env var if you ever need to.
DB_PATH = os.environ.get(
    "DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tasks.db"),
)

VALID_STATUSES = ("unassigned", "ongoing", "done", "under_review")


def _now() -> str:
    """ISO 8601 UTC timestamp, e.g. 2026-06-11T07:42:13+00:00"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """Idempotent schema setup — safe to call on every startup."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_conn()
    try:
        # WAL mode plays much nicer with gunicorn running >1 worker.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                description    TEXT,
                status         TEXT NOT NULL,
                assigned_to    TEXT,
                category_color TEXT,
                submitted_by   TEXT,
                created_at     TEXT,
                updated_at     TEXT
            );

            CREATE TABLE IF NOT EXISTS task_updates (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id    INTEGER REFERENCES tasks(id),
                author     TEXT,
                content    TEXT NOT NULL,
                created_at TEXT
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------- tasks

def get_all_tasks(status: str | None = None) -> list[dict]:
    """
    All tasks, newest first, each with an updates_count so the frontend
    can render the "N updates" affordance without extra requests.
    """
    sql = """
        SELECT t.*, COUNT(u.id) AS updates_count
        FROM tasks t
        LEFT JOIN task_updates u ON u.task_id = t.id
    """
    params: tuple = ()
    if status:
        sql += " WHERE t.status = ?"
        params = (status,)
    sql += " GROUP BY t.id ORDER BY t.created_at DESC"

    conn = get_conn()
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_task(task_id: int) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_task(name: str, description: str | None,
                category_color: str, submitted_by: str | None) -> dict:
    """New tasks always start life as under_review (PRD §8)."""
    now = _now()
    conn = get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO tasks (name, description, status, assigned_to,
                               category_color, submitted_by, created_at, updated_at)
            VALUES (?, ?, 'under_review', NULL, ?, ?, ?, ?)
            """,
            (name, description, category_color, submitted_by, now, now),
        )
        conn.commit()
        task_id = cur.lastrowid
    finally:
        conn.close()
    task = get_task(task_id)
    task["updates_count"] = 0
    return task


# Fields a PATCH is allowed to touch. updated_at is managed here, not by callers.
PATCHABLE_FIELDS = ("name", "description", "status", "assigned_to", "category_color")


def update_task(task_id: int, fields: dict) -> dict | None:
    """Partial update. Only whitelisted fields are written."""
    clean = {k: v for k, v in fields.items() if k in PATCHABLE_FIELDS}
    if not clean:
        return get_task(task_id)

    clean["updated_at"] = _now()
    sets = ", ".join(f"{k} = ?" for k in clean)
    params = list(clean.values()) + [task_id]

    conn = get_conn()
    try:
        cur = conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", params)
        conn.commit()
        if cur.rowcount == 0:
            return None
    finally:
        conn.close()
    return get_task(task_id)


# -------------------------------------------------------------- updates

def get_updates(task_id: int) -> list[dict]:
    """Updates for a task, oldest first (chronological — PRD §10)."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM task_updates WHERE task_id = ? ORDER BY created_at ASC, id ASC",
            (task_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_update(task_id: int, author: str, content: str) -> dict:
    now = _now()
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO task_updates (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
            (task_id, author, content, now),
        )
        conn.commit()
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM task_updates WHERE id = ?", (new_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()
