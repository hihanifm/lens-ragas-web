import os
import uuid
import json
import pandas as pd
from fastapi import FastAPI, UploadFile, File, HTTPException, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from models import EvalRequest, ParsedFile
from evaluator import detect_format, load_rows, run_evaluation
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
