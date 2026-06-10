# Captionato Internal Task Manager

Lightweight team task board. Vanilla HTML/CSS/JS frontend, Python/Flask
backend, SQLite database. One Docker container, deployed via Coolify at
`management.captionato.tech`.

No accounts — access is gated by a single shared team passphrase.

## Stack

- **Frontend:** vanilla HTML/CSS/JS in `static/` — no frameworks, no build step
- **Backend:** Flask (`app.py`), raw SQL helpers (`db.py`)
- **Database:** SQLite via Python's stdlib `sqlite3` — self-bootstraps on startup
- **Auth:** shared passphrase → Flask signed-cookie session (8h expiry)

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env        # then edit TEAM_PASSPHRASE and SECRET_KEY
python app.py               # dev server on http://localhost:5000
```

The SQLite file is auto-created at `data/tasks.db` on first run.

## Deploy (Coolify)

1. Point a Coolify service at this repo — it builds from the `Dockerfile`.
2. Set environment variables in the service:
   - `TEAM_PASSPHRASE` — the shared team password
   - `SECRET_KEY` — long random string (`python -c "import secrets; print(secrets.token_hex(32))"`)
   - `PORT` — optional, defaults to `5000`
3. Add a **persistent volume** mounted at `/app/data` — this is where
   `tasks.db` lives. Without it, the database is wiped on every redeploy.
4. Attach the domain `management.captionato.tech`. Coolify handles SSL.

The container runs Gunicorn (2 workers); SQLite is in WAL mode so
concurrent workers are fine at team scale.

## API

All `/api/*` routes require an authenticated session and return JSON.

| Method | Route | Description |
|---|---|---|
| `POST` | `/auth/login` | `{passphrase}` → sets session |
| `POST` | `/auth/logout` | Clears session (the "Lock" button) |
| `GET` | `/api/tasks?status=` | List tasks (+ `updates_count` per task) |
| `POST` | `/api/tasks` | Create task — always lands as `under_review` |
| `PATCH` | `/api/tasks/<id>` | Partial update; status transitions enforced |
| `GET` | `/api/tasks/<id>/updates` | Updates thread, oldest first |
| `POST` | `/api/tasks/<id>/updates` | Append an update (append-only) |

**Allowed status transitions:** `unassigned → ongoing` (claim, requires
`assigned_to`), `under_review → unassigned` (accept), and any status `→ done`.
Anything else returns `400`.

## Notes

- `submitted_by` is stored as a column on `tasks` (the PRD's Add Task form
  requires it but the data model didn't list it — added so the name isn't
  lost; shown on Under Review cards as "by &lt;name&gt;").
- Updates are append-only by design — no edit/delete endpoints exist.
- `category_color` is free-form; the live swatch in the Add Task form is
  the only validation affordance (per PRD v1 scope).
