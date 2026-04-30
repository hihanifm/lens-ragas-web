import os
import uuid
import json
import pandas as pd
import urllib.parse
import urllib.request
from fastapi import FastAPI, UploadFile, File, HTTPException, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from models import EvalRequest, ParsedFile
from evaluator import detect_format, load_rows, run_evaluation
from jobs import start_job, get_job, cancel_job, stream_job_sse
import config

app = FastAPI(title="lens-ragas-web")

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
    url = (base_url or config.OLLAMA_BASE_URL or "").strip()
    if not url:
        raise HTTPException(400, "Missing base_url.")

    url = url.rstrip("/")
    # In Docker, localhost/127.0.0.1 points to the container, not the host.
    if os.path.exists("/.dockerenv"):
        if url.startswith("http://localhost:") or url.startswith("http://127.0.0.1:"):
            url = url.replace("http://localhost:", "http://host.docker.internal:")
            url = url.replace("http://127.0.0.1:", "http://host.docker.internal:")
        if url == "http://localhost" or url == "http://127.0.0.1":
            url = "http://host.docker.internal:11434"

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
    if ext not in (".json", ".csv"):
        raise HTTPException(400, "Only .json and .csv files are supported.")

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

    try:
        rows = load_rows(dest)
    except Exception as e:
        os.remove(dest)
        raise HTTPException(400, str(e))

    if not rows:
        os.remove(dest)
        raise HTTPException(400, "File is empty.")

    cols = list(rows[0].keys())
    try:
        fmt, available = detect_format(cols)
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
    job = start_job(filepath=filepath, req=req)
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
    if not job:
        raise HTTPException(404, "Job not found.")
    return job.snapshot()


@api.post("/evaluate/cancel/{job_id}")
async def evaluate_cancel(job_id: str):
    ok = cancel_job(job_id)
    if not ok:
        raise HTTPException(404, "Job not found.")
    return {"ok": True}


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
