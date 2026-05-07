import os
import uuid
import json
import pandas as pd
import logging
import urllib.parse
import urllib.request
from fastapi import FastAPI, UploadFile, File, HTTPException, APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import JSONResponse
from models import EvalRequest, ParsedFile, ParseMapRequest
from evaluator import detect_format, load_rows, run_evaluation, read_tabular_rows
from jobs import start_job, get_job, cancel_job, stream_job_sse
from ollama_utils import normalize_ollama_base_url, preflight_ollama
import db
import config

logging.basicConfig(
    level=getattr(logging, (config.LOG_LEVEL or "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("lens-ragas-web")

app = FastAPI(title="lens-ragas-web")

db.init_db(config.DB_PATH)
try:
    updated = db.reconcile_startup(config.DB_PATH)
    if updated:
        logger.info("db_reconcile_startup interrupted=%s", updated)
except Exception as e:
    logger.warning("db_reconcile_startup_failed err=%s", str(e))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")

def _extract_lens_metadata(raw_json, rows: list[dict] | None = None):
    # LENS exports may include metadata under a top-level "_lens" key or embedded in any row.
    if isinstance(raw_json, dict) and isinstance(raw_json.get("_lens"), dict):
        return raw_json["_lens"]

    if isinstance(raw_json, list):
        for item in raw_json:
            if isinstance(item, dict) and isinstance(item.get("_lens"), dict):
                return item["_lens"]

    if rows:
        for r in rows:
            if isinstance(r, dict) and isinstance(r.get("_lens"), dict):
                return r["_lens"]

    return None


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/config")
def get_config():
    return {
        "llm_provider": config.LLM_PROVIDER,
        "ollama_base_url": config.OLLAMA_BASE_URL,
        "ollama_model": config.OLLAMA_MODEL,
        "openai_api_key": config.OPENAI_API_KEY,
        "openai_model": config.OPENAI_MODEL,
    }

@api.get("/ollama/models")
def list_ollama_models(base_url: str | None = None):
    """
    Returns available Ollama model tags from /api/tags.
    """
    url = normalize_ollama_base_url(base_url or config.OLLAMA_BASE_URL)
    if not url:
        raise HTTPException(400, "Missing base_url.")

    tags_url = urllib.parse.urljoin(url + "/", "api/tags")

    try:
        req = urllib.request.Request(tags_url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch Ollama models: {e}")

    models = payload.get("models", [])
    names: list[str] = []
    if isinstance(models, list):
        for m in models:
            if isinstance(m, dict) and isinstance(m.get("name"), str):
                names.append(m["name"])

    return {"models": sorted(set(names))}

@api.get("/openai/models")
def list_openai_models(request: Request):
    """
    Fetch available OpenAI models from /v1/models.
    API key can be provided via `X-OpenAI-Api-Key` header; falls back to env default.
    """
    api_key = (request.headers.get("x-openai-api-key") or config.OPENAI_API_KEY or "").strip()
    if not api_key:
        raise HTTPException(400, "Missing OpenAI API key.")

    url = "https://api.openai.com/v1/models"
    try:
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch OpenAI models: {e}")

    data = payload.get("data", [])
    ids: list[str] = []
    if isinstance(data, list):
        for m in data:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                ids.append(m["id"])

    # Keep it simple: show common chat/reasoning models first, but still include everything.
    ids = sorted(set(ids))
    preferred_prefixes = ("gpt-", "o1", "o3")
    preferred = [x for x in ids if x.startswith(preferred_prefixes)]
    rest = [x for x in ids if x not in set(preferred)]
    return {"models": preferred + rest}


@api.post("/parse", response_model=ParsedFile)
async def parse_file(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".json", ".csv", ".xlsx"):
        raise HTTPException(400, "Only .json, .csv and .xlsx files are supported.")

    file_id = str(uuid.uuid4())
    dest = os.path.join(config.UPLOAD_DIR, f"{file_id}{ext}")

    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)

    raw_json = None
    if ext == ".json":
        try:
            raw_json = json.loads(content.decode("utf-8"))
        except Exception:
            raw_json = None

    def _auto_column_map(columns: list[str]) -> dict[str, str] | None:
        # Case-insensitive match of canonical keys to source headers.
        want = {"question", "contexts", "ground_truth", "answer"}
        by_lower = {str(c).strip().lower(): c for c in (columns or []) if str(c).strip()}
        if "question" not in by_lower or "contexts" not in by_lower:
            return None
        out = {"question": by_lower["question"], "contexts": by_lower["contexts"]}
        if "ground_truth" in by_lower:
            out["ground_truth"] = by_lower["ground_truth"]
        if "answer" in by_lower:
            out["answer"] = by_lower["answer"]
        return out

    try:
        if ext == ".xlsx":
            rows = read_tabular_rows(dest, column_map=None)
        else:
            rows = load_rows(dest)
    except Exception as e:
        os.remove(dest)
        raise HTTPException(400, str(e))

    if not rows:
        os.remove(dest)
        raise HTTPException(400, "File is empty.")

    cols = list(rows[0].keys())
    auto_map = _auto_column_map(cols) if ext in (".csv", ".xlsx") else None

    if ext in (".csv", ".xlsx") and not auto_map:
        # Keep the uploaded file so the user can map columns next.
        return ParsedFile(
            file_id=file_id + ext,
            row_count=len(rows),
            columns=cols,
            available_metrics=[],
            format="generic",
            needs_column_mapping=True,
            column_map=None,
            lens_metadata=None,
        )

    # If tabular headers align, detect metrics using canonical column names.
    detect_cols = list(auto_map.keys()) if auto_map else cols
    try:
        fmt, available = detect_format(detect_cols)
    except ValueError as e:
        os.remove(dest)
        raise HTTPException(400, str(e))

    return ParsedFile(
        file_id=file_id + ext,
        row_count=len(rows),
        columns=cols,
        available_metrics=available,
        format=fmt,
        lens_metadata=_extract_lens_metadata(raw_json, rows) if ext == ".json" else None,
        needs_column_mapping=False,
        column_map=auto_map,
    )


@api.post("/parse/map", response_model=ParsedFile)
async def parse_apply_map(req: ParseMapRequest):
    filepath = os.path.join(config.UPLOAD_DIR, req.file_id)
    if not os.path.exists(filepath):
        raise HTTPException(404, "File not found. Please re-upload.")

    ext = os.path.splitext(req.file_id)[1].lower()
    if ext not in (".csv", ".xlsx"):
        raise HTTPException(400, "Column mapping is only supported for .csv and .xlsx files.")

    # Basic validation.
    cm = req.column_map or {}
    q = (cm.get("question") or "").strip()
    c = (cm.get("contexts") or "").strip()
    if not q or not c:
        raise HTTPException(400, "Mapping must include 'question' and 'contexts'.")
    if q == c:
        raise HTTPException(400, "'question' and 'contexts' cannot map to the same column.")
    for opt in ("ground_truth", "answer"):
        if cm.get(opt) and cm.get(opt) in (q, c):
            raise HTTPException(400, f"'{opt}' cannot reuse the same column as question/contexts.")

    try:
        # Read with mapping so rows have canonical keys.
        rows = read_tabular_rows(filepath, column_map=cm)
    except Exception as e:
        raise HTTPException(400, str(e))

    if not rows:
        raise HTTPException(400, "File is empty.")

    cols = list(rows[0].keys())
    try:
        fmt, available = detect_format(cols)
    except ValueError as e:
        raise HTTPException(400, str(e))

    return ParsedFile(
        file_id=req.file_id,
        row_count=len(rows),
        columns=list(read_tabular_rows(filepath, column_map=None)[0].keys()) if ext in (".csv", ".xlsx") else cols,
        available_metrics=available,
        format=fmt,
        needs_column_mapping=False,
        column_map=cm,
        lens_metadata=None,
    )


@api.post("/evaluate")
async def evaluate_endpoint(req: EvalRequest, request: Request):
    filepath = os.path.join(config.UPLOAD_DIR, req.file_id)
    if not os.path.exists(filepath):
        raise HTTPException(404, "File not found. Please re-upload.")

    async def stream():
        try:
            async for chunk in run_evaluation(
                filepath,
                req,
                is_disconnected=request.is_disconnected,
            ):
                yield chunk
        except Exception as e:
            import json as _json
            yield f"event: error\ndata: {_json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

@api.post("/evaluate/start")
async def evaluate_start(req: EvalRequest):
    filepath = os.path.join(config.UPLOAD_DIR, req.file_id)
    if not os.path.exists(filepath):
        raise HTTPException(404, "File not found. Please re-upload.")

    # Fast failure: check Ollama connectivity up front to avoid long "hangs".
    if req.llm_provider == "ollama":
        try:
            working = preflight_ollama(req.ollama_base_url or config.OLLAMA_BASE_URL or "", timeout_s=2.0)
            if working:
                req.ollama_base_url = working
        except Exception as e:
            raise HTTPException(
                502,
                f"{e} If the backend runs in Docker, use http://host.docker.internal:11434 (not localhost).",
            )

    msg = (
        f"evaluate_start file_id={req.file_id} provider={req.llm_provider} "
        f"model={(req.ollama_model if req.llm_provider == 'ollama' else req.openai_model)} "
        f"metrics={','.join(req.metrics or [])}"
    )
    print(msg, flush=True)
    logger.info(
        "evaluate_start file_id=%s provider=%s model=%s metrics=%s",
        req.file_id,
        req.llm_provider,
        req.ollama_model if req.llm_provider == "ollama" else req.openai_model,
        ",".join(req.metrics or []),
    )
    job = start_job(filepath=filepath, req=req)
    # Persist a durable run record for audit/debug.
    project = (req.project or "").strip() or "default"
    db.upsert_run(
        config.DB_PATH,
        job_id=job.id,
        created_at=job.created_at,
        status="running",
        project=project,
        provider=req.llm_provider,
        model=(req.ollama_model if req.llm_provider == "ollama" else req.openai_model),
        metrics=req.metrics or [],
        file_id=req.file_id,
        input_filename=(req.input_filename or "").strip() or None,
    )
    print(f"job_started job_id={job.id}", flush=True)
    logger.info("job_started job_id=%s", job.id)
    return {"job_id": job.id}


@api.get("/evaluate/stream/{job_id}")
async def evaluate_stream(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found.")
    return StreamingResponse(stream_job_sse(job), media_type="text/event-stream")


@api.get("/evaluate/result/{job_id}")
async def evaluate_result(job_id: str):
    job = get_job(job_id)
    if job:
        return job.snapshot()
    snap = db.get_run_snapshot(config.DB_PATH, job_id=job_id)
    if not snap:
        raise HTTPException(404, "Job not found.")
    return snap


@api.get("/export/scored-xlsx/{job_id}")
async def export_scored_xlsx(job_id: str):
    snap = db.get_run_snapshot(config.DB_PATH, job_id=job_id)
    if not snap:
        raise HTTPException(404, "Job not found.")

    file_id = snap.get("file_id")
    if not file_id or not str(file_id).endswith(".xlsx"):
        raise HTTPException(404, "This run does not have an .xlsx source file.")

    src_path = os.path.join(config.UPLOAD_DIR, file_id)
    if not os.path.exists(src_path):
        raise HTTPException(404, "Original .xlsx file not found on server.")

    try:
        df = pd.read_excel(src_path, dtype=str)
    except Exception as e:
        raise HTTPException(400, f"Failed to read source workbook: {e}")

    # Fetch all evaluated rows from DB and merge by row index.
    rows: list[dict] = []
    offset = 0
    page = 2000
    while True:
        batch = db.list_run_rows(config.DB_PATH, job_id=job_id, limit=page, offset=offset)
        if not batch:
            break
        rows.extend(batch)
        offset += len(batch)

    if not rows:
        raise HTTPException(400, "No scored rows found for this run.")

    metrics = snap.get("metrics") or []
    if not isinstance(metrics, list):
        metrics = []

    # Prepare score columns aligned to the dataframe row order.
    score_by_idx = {int(r.get("index")): (r.get("scores") or {}) for r in rows if r.get("index") is not None}
    for m in metrics:
        col = f"score_{m}"
        df[col] = [score_by_idx.get(i, {}).get(m) for i in range(len(df))]

    out_id = str(uuid.uuid4())
    out_path = os.path.join(config.UPLOAD_DIR, f"{out_id}-scored.xlsx")
    try:
        df.to_excel(out_path, index=False)
    except Exception as e:
        raise HTTPException(500, f"Failed to write scored workbook: {e}")

    src_name = (snap.get("input_filename") or "input.xlsx").strip() or "input.xlsx"
    base = os.path.splitext(os.path.basename(src_name))[0] or "input"
    download_name = f"{base}-scored.xlsx"
    return FileResponse(
        out_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@api.get("/runs")
async def runs_list(project: str | None = None, limit: int = 50, offset: int = 0):
    project_key = (project or "").strip() or None
    return {"runs": db.list_runs(config.DB_PATH, project=project_key, limit=limit, offset=offset)}


@api.get("/runs/{job_id}")
async def runs_get(job_id: str):
    snap = db.get_run_snapshot(config.DB_PATH, job_id=job_id)
    if not snap:
        raise HTTPException(404, "Run not found.")
    # Return metadata + aggregate (rows are available via /runs/{job_id}/rows).
    return {
        "job_id": snap.get("id"),
        "created_at": snap.get("created_at"),
        "status": snap.get("status"),
        "error": snap.get("error"),
        "progress": snap.get("progress"),
        "metrics": snap.get("metrics"),
        "aggregate": snap.get("aggregate"),
        "total": snap.get("total"),
    }


@api.get("/runs/{job_id}/rows")
async def runs_rows(job_id: str, limit: int = 100, offset: int = 0):
    return {"rows": db.list_run_rows(config.DB_PATH, job_id=job_id, limit=limit, offset=offset)}


@api.delete("/runs/{job_id}")
async def runs_delete(job_id: str):
    ok = db.delete_run(config.DB_PATH, job_id=job_id)
    if not ok:
        raise HTTPException(404, "Run not found.")
    return {"ok": True}


@api.post("/evaluate/cancel/{job_id}")
async def evaluate_cancel(job_id: str):
    ok = cancel_job(job_id)
    if not ok:
        raise HTTPException(404, "Job not found.")
    print(f"job_cancelled job_id={job_id}", flush=True)
    logger.info("job_cancelled job_id=%s", job_id)
    return {"ok": True}


def _summarize_exc_detail(exc: HTTPException) -> str:
    d = exc.detail
    try:
        return json.dumps(jsonable_encoder(d), default=str)[:2000]
    except Exception:
        return repr(d)[:2000]


@app.exception_handler(HTTPException)
async def http_exception_logging_handler(request: Request, exc: HTTPException):
    """
    Log server / gateway errors at ERROR (not INFO). Uvicorn access logs stay INFO for all status codes.
    """
    client = request.client.host if request.client else None
    if exc.status_code >= 500:
        logger.error(
            "HTTP %s %s -> %s client=%s detail=%s",
            request.method,
            request.url.path,
            exc.status_code,
            client,
            _summarize_exc_detail(exc),
        )
    elif exc.status_code in (502, 503, 504):
        logger.warning(
            "HTTP %s %s -> %s client=%s detail=%s",
            request.method,
            request.url.path,
            exc.status_code,
            client,
            _summarize_exc_detail(exc),
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": jsonable_encoder(exc.detail)},
    )


@app.exception_handler(Exception)
async def unhandled_exception_logging_handler(request: Request, exc: Exception):
    client = request.client.host if request.client else None
    logger.exception(
        "Unhandled exception %s %s client=%s",
        request.method,
        request.url.path,
        client,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


app.include_router(api)

STATIC_DIR = os.getenv("STATIC_DIR", os.path.join(os.path.dirname(__file__), "static"))
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index_path):
        return FileResponse(index_path)
    raise HTTPException(404, "Not Found")
