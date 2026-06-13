"""
db.py — SQLite layer for the Captionato Task Manager v2.0.

All raw SQL lives here. No ORM. app.py only ever calls the helper
functions below and receives plain dicts back.

init_db() creates all tables on every startup (idempotent) and runs
an inline migration to add new columns to the existing tasks table.
"""

import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tasks.db"),
)

VALID_STATUSES = ("unassigned", "ongoing", "done", "under_review")


def _now() -> str:
    """ISO 8601 UTC timestamp."""
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
        conn.execute("PRAGMA journal_mode = WAL")
        # executescript commits any pending txn, then runs all statements.
        # tasks table intentionally omits created_by_user_id so the
        # CREATE TABLE IF NOT EXISTS is safe for both fresh and v1.0 databases.
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                created_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS invite_codes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                code       TEXT NOT NULL UNIQUE,
                created_by INTEGER REFERENCES users(id),
                created_at TEXT,
                active     INTEGER DEFAULT 1
            );

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

            CREATE TABLE IF NOT EXISTS task_assignments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id     INTEGER REFERENCES tasks(id),
                user_id     INTEGER REFERENCES users(id),
                role        TEXT NOT NULL,
                assigned_at TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER REFERENCES users(id),
                action      TEXT NOT NULL,
                target_type TEXT,
                target_id   INTEGER,
                detail      TEXT,
                created_at  TEXT
            );
        """)
        # Migration: add created_by_user_id to tasks if this is a v1.0 database.
        existing_cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        if "created_by_user_id" not in existing_cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN created_by_user_id INTEGER")
            conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------- users

def create_user(username: str, password_hash: str, role: str = "user") -> dict:
    now = _now()
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            (username, password_hash, role, now),
        )
        conn.commit()
        new_id = cur.lastrowid
    finally:
        conn.close()
    return get_user_by_id(new_id)


def get_user_by_id(user_id: int) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, username, role, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_user_by_username(username: str) -> dict | None:
    """Returns full row including password_hash (needed for auth)."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_all_users() -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, username, role, created_at FROM users ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_user_count() -> int:
    conn = get_conn()
    try:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    finally:
        conn.close()


def set_user_role(user_id: int, role: str) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ---------------------------------------------------------------- invite codes

def create_invite_code(code: str, created_by: int) -> dict:
    now = _now()
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO invite_codes (code, created_by, created_at, active) VALUES (?, ?, ?, 1)",
            (code, created_by, now),
        )
        conn.commit()
        row = conn.execute(
            """SELECT ic.*, u.username AS created_by_username
               FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
               WHERE ic.id = ?""",
            (cur.lastrowid,),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


def get_invite_code_by_code(code: str) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM invite_codes WHERE code = ?", (code,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_all_invite_codes() -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT ic.*, u.username AS created_by_username
               FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
               ORDER BY ic.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def deactivate_invite_code(code_id: int) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute("UPDATE invite_codes SET active = 0 WHERE id = ?", (code_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ---------------------------------------------------------------- tasks

def _enrich_with_assignments(tasks: list[dict], conn: sqlite3.Connection) -> list[dict]:
    """Attach assignments list to each task dict in-place."""
    if not tasks:
        return tasks
    task_ids = [t["id"] for t in tasks]
    placeholders = ",".join("?" * len(task_ids))
    rows = conn.execute(
        f"""SELECT ta.task_id, ta.user_id, ta.role, u.username
            FROM task_assignments ta
            JOIN users u ON u.id = ta.user_id
            WHERE ta.task_id IN ({placeholders})""",
        task_ids,
    ).fetchall()
    by_task: dict[int, list] = {}
    for r in rows:
        by_task.setdefault(r["task_id"], []).append(
            {"user_id": r["user_id"], "username": r["username"], "role": r["role"]}
        )
    for t in tasks:
        t["assignments"] = by_task.get(t["id"], [])
    return tasks


def get_all_tasks(status: str | None = None) -> list[dict]:
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
        tasks = [dict(r) for r in rows]
        return _enrich_with_assignments(tasks, conn)
    finally:
        conn.close()


def get_task(task_id: int) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        task = dict(row)
        _enrich_with_assignments([task], conn)
        return task
    finally:
        conn.close()


def create_task(name: str, description: str | None, category_color: str,
                submitted_by: str | None, created_by_user_id: int | None = None) -> dict:
    """New tasks always start life as under_review."""
    now = _now()
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO tasks (name, description, status, assigned_to,
                                  category_color, submitted_by, created_by_user_id,
                                  created_at, updated_at)
               VALUES (?, ?, 'under_review', NULL, ?, ?, ?, ?, ?)""",
            (name, description, category_color, submitted_by, created_by_user_id, now, now),
        )
        conn.commit()
        task_id = cur.lastrowid
    finally:
        conn.close()
    task = get_task(task_id)
    task["updates_count"] = 0
    return task


# assigned_to removed from patchable fields — assignment handled via task_assignments
PATCHABLE_FIELDS = ("name", "description", "status", "category_color")


def update_task(task_id: int, fields: dict) -> dict | None:
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


def delete_task(task_id: int) -> bool:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM task_updates WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM task_assignments WHERE task_id = ?", (task_id,))
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --------------------------------------------------------- task assignments

def get_task_assignments(task_id: int) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT ta.user_id, ta.role, u.username
               FROM task_assignments ta JOIN users u ON u.id = ta.user_id
               WHERE ta.task_id = ?""",
            (task_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def claim_task(task_id: int, user_id: int) -> None:
    """Self-claim: insert primary assignment, replacing any existing primary."""
    now = _now()
    conn = get_conn()
    try:
        conn.execute(
            "DELETE FROM task_assignments WHERE task_id = ? AND role = 'primary'", (task_id,)
        )
        conn.execute(
            "INSERT INTO task_assignments (task_id, user_id, role, assigned_at) VALUES (?, ?, 'primary', ?)",
            (task_id, user_id, now),
        )
        conn.commit()
    finally:
        conn.close()


def assign_task(task_id: int, primary_user_id: int, co_user_ids: list[int]) -> None:
    """Replace ALL assignments for a task (admin operation)."""
    now = _now()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM task_assignments WHERE task_id = ?", (task_id,))
        conn.execute(
            "INSERT INTO task_assignments (task_id, user_id, role, assigned_at) VALUES (?, ?, 'primary', ?)",
            (task_id, primary_user_id, now),
        )
        for uid in co_user_ids:
            conn.execute(
                "INSERT INTO task_assignments (task_id, user_id, role, assigned_at) VALUES (?, ?, 'co', ?)",
                (task_id, uid, now),
            )
        conn.commit()
    finally:
        conn.close()


def unassign_task(task_id: int) -> None:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM task_assignments WHERE task_id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


def add_cooperator(task_id: int, user_id: int) -> bool:
    """Add a co-assignee. Returns False if user is already assigned."""
    existing = get_task_assignments(task_id)
    if any(a["user_id"] == user_id for a in existing):
        return False
    now = _now()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO task_assignments (task_id, user_id, role, assigned_at) VALUES (?, ?, 'co', ?)",
            (task_id, user_id, now),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def get_my_tasks(user_id: int) -> list[dict]:
    """Tasks the current user is assigned to (primary or co), tagged with my_role."""
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT t.*, COUNT(DISTINCT upd.id) AS updates_count, ta_me.role AS my_role
               FROM tasks t
               JOIN task_assignments ta_me ON ta_me.task_id = t.id AND ta_me.user_id = ?
               LEFT JOIN task_updates upd ON upd.task_id = t.id
               GROUP BY t.id
               ORDER BY t.created_at DESC""",
            (user_id,),
        ).fetchall()
        tasks = [dict(r) for r in rows]
        return _enrich_with_assignments(tasks, conn)
    finally:
        conn.close()


# --------------------------------------------------------------- updates

def get_updates(task_id: int) -> list[dict]:
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
        row = conn.execute("SELECT * FROM task_updates WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


# -------------------------------------------------------------- audit log

def log_action(user_id: int, action: str, target_type: str | None = None,
               target_id: int | None = None, detail: str | None = None) -> None:
    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO audit_log (user_id, action, target_type, target_id, detail, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, action, target_type, target_id, detail, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def get_audit_log(page: int = 1, per_page: int = 50) -> dict:
    offset = (page - 1) * per_page
    conn = get_conn()
    try:
        total = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        rows = conn.execute(
            """SELECT al.*, u.username
               FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
               ORDER BY al.created_at DESC
               LIMIT ? OFFSET ?""",
            (per_page, offset),
        ).fetchall()
        return {
            "entries": [dict(r) for r in rows],
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total + per_page - 1) // per_page),
        }
    finally:
        conn.close()


# --------------------------------------------------------------- export

def get_tasks_with_updates(status: str | None = None) -> list[dict]:
    """For markdown export: tasks enriched with full assignment info and updates."""
    tasks = get_all_tasks(status)
    if not tasks:
        return tasks
    task_ids = [t["id"] for t in tasks]
    placeholders = ",".join("?" * len(task_ids))
    conn = get_conn()
    try:
        update_rows = conn.execute(
            f"SELECT * FROM task_updates WHERE task_id IN ({placeholders}) ORDER BY created_at ASC",
            task_ids,
        ).fetchall()
    finally:
        conn.close()
    by_task: dict[int, list] = {}
    for r in update_rows:
        by_task.setdefault(r["task_id"], []).append(dict(r))
    for t in tasks:
        t["updates"] = by_task.get(t["id"], [])
    return tasks
