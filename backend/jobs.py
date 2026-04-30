import asyncio
import json
import time
import uuid
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Optional

from evaluator import run_evaluation
import config
import db


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_sse_chunk(chunk: str) -> tuple[str, dict[str, Any]] | None:
    # Expected format:
    # event: <name>\n
    # data: <json>\n\n
    if not chunk:
        return None
    event = None
    data = None
    for line in chunk.splitlines():
        if line.startswith("event: "):
            event = line[len("event: ") :].strip()
        elif line.startswith("data: "):
            data = line[len("data: ") :].strip()
    if not event or data is None:
        return None
    try:
        return event, json.loads(data)
    except Exception:
        return None


@dataclass
class EvalJob:
    id: str
    created_at: str
    status: str = "running"  # running | complete | error | cancelled
    error: Optional[str] = None
    progress: dict[str, Any] = field(default_factory=lambda: {"done": 0, "total": None})
    metrics: list[str] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    aggregate: dict[str, Any] = field(default_factory=dict)
    total: Optional[int] = None
    cancelled: bool = False
    # streaming
    sse_chunks: list[str] = field(default_factory=list)
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: Optional[asyncio.Task] = None
    last_update_ms: int = field(default_factory=_now_ms)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "status": self.status,
            "error": self.error,
            "progress": self.progress,
            "metrics": self.metrics,
            "rows": self.rows,
            "aggregate": self.aggregate,
            "total": self.total,
        }


JOBS: dict[str, EvalJob] = {}
logger = logging.getLogger("lens-ragas-web.jobs")


async def _append(job: EvalJob, chunk: str) -> None:
    job.sse_chunks.append(chunk)
    job.last_update_ms = _now_ms()
    async with job.cond:
        job.cond.notify_all()


async def _run_job(job: EvalJob, filepath: str, req) -> None:
    async def is_disconnected():
        return job.cancelled

    msg = (
        f"job_run_begin job_id={job.id} provider={getattr(req, 'llm_provider', None)} "
        f"model={getattr(req, 'ollama_model', None) if getattr(req, 'llm_provider', None) == 'ollama' else getattr(req, 'openai_model', None)} "
        f"metrics={','.join(getattr(req, 'metrics', []) or [])}"
    )
    print(msg, flush=True)
    logger.info(
        "job_run_begin job_id=%s provider=%s model=%s metrics=%s",
        job.id,
        getattr(req, "llm_provider", None),
        (getattr(req, "ollama_model", None) if getattr(req, "llm_provider", None) == "ollama" else getattr(req, "openai_model", None)),
        ",".join(getattr(req, "metrics", []) or []),
    )
    try:
        async for chunk in run_evaluation(filepath, req, is_disconnected=is_disconnected):
            parsed = _parse_sse_chunk(chunk)
            if parsed:
                event, data = parsed
                if event == "start":
                    job.total = data.get("total")
                    job.metrics = data.get("metrics") or []
                    job.progress = {"done": 0, "total": job.total}
                    db.update_from_start(config.DB_PATH, job_id=job.id, total=job.total, metrics=job.metrics)
                    db.append_event(config.DB_PATH, job_id=job.id, event="start", payload=data)
                elif event == "row":
                    job.rows.append(data)
                    job.progress = {"done": len(job.rows), "total": job.total}
                    db.upsert_row(config.DB_PATH, job_id=job.id, row=data)
                    db.append_event(config.DB_PATH, job_id=job.id, event="row", payload={"index": data.get("index")})
                elif event == "complete":
                    job.aggregate = data.get("aggregate") or {}
                    job.total = data.get("total") or job.total
                    job.progress = {"done": job.total or len(job.rows), "total": job.total}
                    job.status = "complete"
                    db.set_complete(config.DB_PATH, job_id=job.id, aggregate=job.aggregate, total=job.total)
                    db.append_event(config.DB_PATH, job_id=job.id, event="complete", payload=data)
                elif event == "error":
                    job.status = "error"
                    job.error = data.get("message") or "Unknown error"
                    db.set_error(config.DB_PATH, job_id=job.id, status="error", message=job.error)
                    db.append_event(config.DB_PATH, job_id=job.id, event="error", payload=data)

            await _append(job, chunk)

            if job.cancelled:
                job.status = "cancelled"
                print(f"job_cancelled job_id={job.id} done={len(job.rows)} total={job.total}", flush=True)
                logger.info("job_cancelled job_id=%s done=%s total=%s", job.id, len(job.rows), job.total)
                db.set_cancelled(config.DB_PATH, job_id=job.id)
                db.append_event(config.DB_PATH, job_id=job.id, event="cancelled", payload={"message": "cancelled"})
                await _append(job, "event: error\ndata: " + json.dumps({"message": "cancelled"}) + "\n\n")
                return

        if job.status == "running":
            # If generator ended early without complete/error, treat as cancelled or error.
            job.status = "cancelled" if job.cancelled else "error"
            job.error = job.error or ("cancelled" if job.cancelled else "Evaluation stopped unexpectedly")
            if job.status == "cancelled":
                db.set_cancelled(config.DB_PATH, job_id=job.id)
            else:
                db.set_error(config.DB_PATH, job_id=job.id, status="error", message=job.error)
    except Exception as e:
        job.status = "error"
        job.error = str(e)
        print(f"job_error job_id={job.id} err={str(e)}", flush=True)
        logger.exception("job_error job_id=%s err=%s", job.id, str(e))
        db.set_error(config.DB_PATH, job_id=job.id, status="error", message=str(e))
        await _append(job, f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n")
    finally:
        job.last_update_ms = _now_ms()
        print(f"job_run_end job_id={job.id} status={job.status} done={len(job.rows)} total={job.total}", flush=True)
        logger.info("job_run_end job_id=%s status=%s done=%s total=%s", job.id, job.status, len(job.rows), job.total)
        async with job.cond:
            job.cond.notify_all()


def start_job(*, filepath: str, req) -> EvalJob:
    job_id = str(uuid.uuid4())
    job = EvalJob(id=job_id, created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    JOBS[job_id] = job
    job.task = asyncio.create_task(_run_job(job, filepath, req))
    return job


def get_job(job_id: str) -> Optional[EvalJob]:
    return JOBS.get(job_id)


def cancel_job(job_id: str) -> bool:
    job = JOBS.get(job_id)
    if not job:
        return False
    job.cancelled = True
    return True


async def stream_job_sse(job: EvalJob) -> AsyncGenerator[str, None]:
    idx = 0
    # replay existing chunks
    while True:
        while idx < len(job.sse_chunks):
            yield job.sse_chunks[idx]
            idx += 1
        if job.status in ("complete", "error", "cancelled"):
            return
        async with job.cond:
            await job.cond.wait()

