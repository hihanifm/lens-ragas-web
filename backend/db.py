import json
import os
import sqlite3
import threading
import time
from typing import Any, Optional


_lock = threading.Lock()


def _connect(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # Best-effort settings for concurrent reads/writes.
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db(db_path: str) -> None:
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                  job_id TEXT PRIMARY KEY,
                  created_at TEXT,
                  status TEXT,
                  project TEXT,
                  provider TEXT,
                  model TEXT,
                  metrics_json TEXT,
                  file_id TEXT,
                  input_filename TEXT,
                  started_ms INTEGER,
                  completed_ms INTEGER,
                  elapsed_ms INTEGER,
                  llm_calls INTEGER,
                  prompt_tokens INTEGER,
                  completion_tokens INTEGER,
                  total_tokens INTEGER,
                  cost_usd REAL,
                  total INTEGER,
                  progress_done INTEGER,
                  progress_total INTEGER,
                  aggregate_json TEXT,
                  lens_metadata_json TEXT,
                  error TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS run_rows (
                  job_id TEXT NOT NULL,
                  row_index INTEGER NOT NULL,
                  question TEXT,
                  scores_json TEXT,
                  contexts_json TEXT,
                  ground_truth TEXT,
                  answer TEXT,
                  PRIMARY KEY (job_id, row_index)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS run_events (
                  job_id TEXT NOT NULL,
                  ts_ms INTEGER NOT NULL,
                  event TEXT NOT NULL,
                  payload_json TEXT
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_run_rows_job ON run_rows(job_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_run_events_job ON run_events(job_id)")

            # Back-compat: add new columns if the DB was created before.
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
            if "project" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN project TEXT")
            if "started_ms" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN started_ms INTEGER")
            if "completed_ms" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN completed_ms INTEGER")
            if "elapsed_ms" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN elapsed_ms INTEGER")
            if "llm_calls" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN llm_calls INTEGER")
            if "prompt_tokens" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN prompt_tokens INTEGER")
            if "completion_tokens" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN completion_tokens INTEGER")
            if "total_tokens" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN total_tokens INTEGER")
            if "cost_usd" not in cols:
                conn.execute("ALTER TABLE runs ADD COLUMN cost_usd REAL")
        finally:
            conn.close()


def reconcile_startup(db_path: str) -> int:
    """
    Mark any runs left in 'running' as 'interrupted'. Returns number updated.
    """
    with _lock:
        conn = _connect(db_path)
        try:
            cur = conn.execute(
                "UPDATE runs SET status='interrupted' WHERE status='running'"
            )
            return int(cur.rowcount or 0)
        finally:
            conn.close()


def upsert_run(
    db_path: str,
    *,
    job_id: str,
    created_at: str,
    status: str,
    project: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    metrics: Optional[list[str]] = None,
    file_id: Optional[str] = None,
    input_filename: Optional[str] = None,
) -> None:
    payload = json.dumps(metrics or [])
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                INSERT INTO runs (
                  job_id, created_at, status, project, provider, model, metrics_json, file_id, input_filename,
                  started_ms, completed_ms, elapsed_ms, llm_calls, prompt_tokens, completion_tokens, total_tokens, cost_usd,
                  total, progress_done, progress_total, aggregate_json, lens_metadata_json, error
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  NULL, NULL, NULL, 0, 0, 0, 0, NULL,
                  NULL, 0, NULL, NULL, NULL, NULL
                )
                ON CONFLICT(job_id) DO UPDATE SET
                  created_at=excluded.created_at,
                  status=excluded.status,
                  project=COALESCE(excluded.project, runs.project),
                  provider=COALESCE(excluded.provider, runs.provider),
                  model=COALESCE(excluded.model, runs.model),
                  metrics_json=COALESCE(excluded.metrics_json, runs.metrics_json),
                  file_id=COALESCE(excluded.file_id, runs.file_id),
                  input_filename=COALESCE(excluded.input_filename, runs.input_filename)
                """,
                (job_id, created_at, status, project, provider, model, payload, file_id, input_filename),
            )
        finally:
            conn.close()


def mark_started(db_path: str, *, job_id: str) -> None:
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                "UPDATE runs SET started_ms=COALESCE(started_ms, ?) WHERE job_id=?",
                (now, job_id),
            )
        finally:
            conn.close()


def mark_finished(db_path: str, *, job_id: str) -> None:
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                UPDATE runs
                SET completed_ms=?,
                    elapsed_ms=CASE
                      WHEN started_ms IS NOT NULL THEN (? - started_ms)
                      ELSE elapsed_ms
                    END
                WHERE job_id=?
                """,
                (now, now, job_id),
            )
        finally:
            conn.close()


def incr_llm_usage(
    db_path: str,
    *,
    job_id: str,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    cost_usd_add: float | None = None,
) -> None:
    pt = int(prompt_tokens or 0)
    ct = int(completion_tokens or 0)
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                UPDATE runs
                SET llm_calls=COALESCE(llm_calls,0)+1,
                    prompt_tokens=COALESCE(prompt_tokens,0)+?,
                    completion_tokens=COALESCE(completion_tokens,0)+?,
                    total_tokens=COALESCE(total_tokens,0)+?,
                    cost_usd=CASE
                      WHEN ? IS NULL THEN cost_usd
                      WHEN cost_usd IS NULL THEN ?
                      ELSE cost_usd + ?
                    END
                WHERE job_id=?
                """,
                (
                    pt,
                    ct,
                    pt + ct,
                    cost_usd_add,
                    cost_usd_add,
                    cost_usd_add,
                    job_id,
                ),
            )
        finally:
            conn.close()


def append_event(db_path: str, *, job_id: str, event: str, payload: dict[str, Any]) -> None:
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                "INSERT INTO run_events(job_id, ts_ms, event, payload_json) VALUES(?,?,?,?)",
                (job_id, int(time.time() * 1000), event, json.dumps(payload)),
            )
        finally:
            conn.close()


def update_from_start(db_path: str, *, job_id: str, total: Optional[int], metrics: list[str]) -> None:
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                UPDATE runs
                SET total=?,
                    progress_done=0,
                    progress_total=?,
                    metrics_json=?
                WHERE job_id=?
                """,
                (total, total, json.dumps(metrics or []), job_id),
            )
        finally:
            conn.close()


def upsert_row(db_path: str, *, job_id: str, row: dict[str, Any]) -> None:
    idx = int(row.get("index") or 0)
    question = row.get("question")
    scores = row.get("scores") or {}
    contexts = row.get("contexts")
    ground_truth = row.get("ground_truth")
    answer = row.get("answer")
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                INSERT INTO run_rows(
                  job_id, row_index, question, scores_json, contexts_json, ground_truth, answer
                ) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(job_id,row_index) DO UPDATE SET
                  question=excluded.question,
                  scores_json=excluded.scores_json,
                  contexts_json=excluded.contexts_json,
                  ground_truth=excluded.ground_truth,
                  answer=excluded.answer
                """,
                (
                    job_id,
                    idx,
                    question,
                    json.dumps(scores),
                    json.dumps(contexts) if contexts is not None else None,
                    ground_truth,
                    answer,
                ),
            )
            # Keep progress in runs in sync.
            conn.execute(
                """
                UPDATE runs
                SET progress_done=(
                  SELECT COUNT(*) FROM run_rows WHERE job_id=?
                )
                WHERE job_id=?
                """,
                (job_id, job_id),
            )
        finally:
            conn.close()


def set_complete(db_path: str, *, job_id: str, aggregate: dict[str, Any], total: Optional[int]) -> None:
    with _lock:
        conn = _connect(db_path)
        try:
            # If total isn't provided, derive from rows.
            if total is None:
                cur = conn.execute("SELECT COUNT(*) AS c FROM run_rows WHERE job_id=?", (job_id,))
                total = int(cur.fetchone()["c"])
            conn.execute(
                """
                UPDATE runs
                SET status='complete',
                    aggregate_json=?,
                    total=?,
                    progress_done=?,
                    progress_total=?,
                    error=NULL
                WHERE job_id=?
                """,
                (json.dumps(aggregate or {}), total, total, total, job_id),
            )
        finally:
            conn.close()
    mark_finished(db_path, job_id=job_id)


def set_error(db_path: str, *, job_id: str, status: str, message: str) -> None:
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                UPDATE runs
                SET status=?,
                    error=?
                WHERE job_id=?
                """,
                (status, message, job_id),
            )
        finally:
            conn.close()
    if status in ("error", "cancelled", "interrupted"):
        mark_finished(db_path, job_id=job_id)


def set_cancelled(db_path: str, *, job_id: str) -> None:
    set_error(db_path, job_id=job_id, status="cancelled", message="cancelled")


def get_run_snapshot(db_path: str, *, job_id: str) -> Optional[dict[str, Any]]:
    conn = _connect(db_path)
    try:
        cur = conn.execute("SELECT * FROM runs WHERE job_id=?", (job_id,))
        r = cur.fetchone()
        if not r:
            return None
        rows_cur = conn.execute(
            "SELECT * FROM run_rows WHERE job_id=? ORDER BY row_index ASC",
            (job_id,),
        )
        out_rows = []
        for rr in rows_cur.fetchall():
            out_rows.append(
                {
                    "index": rr["row_index"],
                    "question": rr["question"] or "",
                    "scores": json.loads(rr["scores_json"] or "{}"),
                    "contexts": json.loads(rr["contexts_json"]) if rr["contexts_json"] else None,
                    "ground_truth": rr["ground_truth"],
                    "answer": rr["answer"],
                }
            )
        metrics = json.loads(r["metrics_json"] or "[]")
        agg = json.loads(r["aggregate_json"] or "{}") if r["aggregate_json"] else {}
        progress = {
            "done": int(r["progress_done"] or 0),
            "total": r["progress_total"] if r["progress_total"] is not None else r["total"],
        }
        return {
            "id": r["job_id"],
            "created_at": r["created_at"],
            "status": r["status"],
            "error": r["error"],
            "progress": progress,
            "metrics": metrics,
            "rows": out_rows,
            "aggregate": agg,
            "total": r["total"],
            "stats": {
                "started_ms": r["started_ms"],
                "completed_ms": r["completed_ms"],
                "elapsed_ms": r["elapsed_ms"],
                "llm_calls": r["llm_calls"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "total_tokens": r["total_tokens"],
                "cost_usd": r["cost_usd"],
            },
        }
    finally:
        conn.close()


def list_runs(
    db_path: str, *, project: Optional[str] = None, limit: int = 50, offset: int = 0
) -> list[dict[str, Any]]:
    conn = _connect(db_path)
    try:
        if project:
            cur = conn.execute(
                """
                SELECT job_id, created_at, status, project, provider, model, metrics_json, file_id, input_filename,
                       total, progress_done, progress_total, error
                FROM runs
                WHERE project=?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (project, int(limit), int(offset)),
            )
        else:
            cur = conn.execute(
            """
            SELECT job_id, created_at, status, project, provider, model, metrics_json, file_id, input_filename,
                   total, progress_done, progress_total, error
            FROM runs
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (int(limit), int(offset)),
        )
        out = []
        for r in cur.fetchall():
            out.append(
                {
                    "job_id": r["job_id"],
                    "created_at": r["created_at"],
                    "status": r["status"],
                    "project": r["project"],
                    "provider": r["provider"],
                    "model": r["model"],
                    "metrics": json.loads(r["metrics_json"] or "[]"),
                    "file_id": r["file_id"],
                    "input_filename": r["input_filename"],
                    "total": r["total"],
                    "progress": {
                        "done": int(r["progress_done"] or 0),
                        "total": r["progress_total"] if r["progress_total"] is not None else r["total"],
                    },
                    "error": r["error"],
                }
            )
        return out
    finally:
        conn.close()


def list_run_rows(db_path: str, *, job_id: str, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    conn = _connect(db_path)
    try:
        cur = conn.execute(
            """
            SELECT * FROM run_rows
            WHERE job_id=?
            ORDER BY row_index ASC
            LIMIT ? OFFSET ?
            """,
            (job_id, int(limit), int(offset)),
        )
        out = []
        for rr in cur.fetchall():
            out.append(
                {
                    "index": rr["row_index"],
                    "question": rr["question"] or "",
                    "scores": json.loads(rr["scores_json"] or "{}"),
                    "contexts": json.loads(rr["contexts_json"]) if rr["contexts_json"] else None,
                    "ground_truth": rr["ground_truth"],
                    "answer": rr["answer"],
                }
            )
        return out
    finally:
        conn.close()


def delete_run(db_path: str, *, job_id: str) -> bool:
    with _lock:
        conn = _connect(db_path)
        try:
            conn.execute("DELETE FROM run_rows WHERE job_id=?", (job_id,))
            conn.execute("DELETE FROM run_events WHERE job_id=?", (job_id,))
            cur = conn.execute("DELETE FROM runs WHERE job_id=?", (job_id,))
            return (cur.rowcount or 0) > 0
        finally:
            conn.close()

