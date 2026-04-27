# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What is this?

A standalone, browser-based wrapper around the `ragas` Python library.
Upload a LENS export or any compatible CSV, pick your metrics and LLM judge, and get scores back without touching the terminal.

Not a RAG system. Not a search tool. Not a benchmark suite. Just evaluation, done simply.

---

## Interaction Protocol (NEVER skip this)

Before writing any code or plan, Claude MUST:
1. Ask clarifying questions to fully understand the requirements
2. Wait for the user to respond
3. Only proceed to coding after the user confirms you have enough context

Do NOT jump straight into code. Always converse first.

---

## Commands

### Dev (two containers — hot-reload for both backend and frontend)
```bash
make up        # start backend (port 37100) + frontend dev server (port 37101)
make down      # stop
make logs      # tail all logs
make restart   # down + up
make build     # rebuild images without starting
```
Frontend: `http://localhost:37101` — Vite dev server with HMR.
Backend API: `http://localhost:37100/api/...`

### Prod (single container — backend serves compiled frontend as static files)
```bash
make prod-up      # build + start; single container on port 37100
make prod-down
make prod-logs
```
Prod uses `docker-compose.prod.yml` + `Dockerfile.prod` (multi-stage: Node build → Python runtime).

### E2E tests (Playwright, runs against the dev stack)
```bash
make e2e           # spins up dev stack, waits for health, runs tests, tears down
```
Or manually:
```bash
make up
cd frontend && npm install && npx playwright install chromium && npm run e2e
```
Single test:
```bash
cd frontend && npx playwright test --grep "upload fixture"
```
Test fixtures live in `frontend/tests/fixtures/`. E2E config: `frontend/playwright.config.js`.

### Local frontend only (no Docker)
```bash
cd frontend && npm install && npm run dev   # http://localhost:37101
```

### Local Python one-offs
```bash
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# run scripts here
```
`.venv/` is gitignored. Never install system-wide.

---

## Design Principles (NEVER violate these)

1. **KISS** — Simpler is always preferred. Complexity only when a simpler solution provably fails.
2. **Wrap, Don't Reimplement** — `ragas` library owns all metric logic. Never rewrite scoring prompts or LLM-judge logic.
3. **On-Prem Default** — Ollama is the default LLM judge. OpenAI is a testing convenience.
4. **All config in `config.py`** — no hardcoded URLs, model names, or API keys in logic files.
5. **Stateless backend** — no database, no session state. Uploaded files are transient.
6. **Defer Complexity** — build the simplest thing first.
7. **One Job, Done Well** — this tool evaluates. It does not search, ingest, or summarize.

---

## Hard Constraints

- **`ragas` library is the authority** — do not reimplement metric scoring or LLM-judge prompts
- **All config in `backend/config.py`** — no hardcoded values in logic files
- **No database** — evaluation is stateless; uploaded files are temporary
- **Ollama runs on HOST** — not inside Docker; container reaches it via `host.docker.internal`
- **Never commit `.env`** — gitignored; copy `.env.example` and fill in locally

---

## Architecture

### Two deployment modes

**Dev** (`docker-compose.yml`): two containers.
- `api` container: FastAPI on port 37100
- `frontend` container: Vite dev server on port 37101, proxies `/api/*` → `http://api:37100`

**Prod** (`docker-compose.prod.yml` + `Dockerfile.prod`): one container.
- Multi-stage build: Node compiles frontend → Python image copies `dist/` into `./static`
- FastAPI serves both API (`/api/*`) and compiled frontend (mounted via `StaticFiles`)
- Single port 37100; `VITE_BASE_PATH` build arg supports sub-path deployments

### Backend (`backend/`)

All API routes are under `/api` prefix (registered via `APIRouter`).

| File | Responsibility |
|---|---|
| `config.py` | All env-var config — LLM provider, model names, upload dir |
| `main.py` | FastAPI app + `/api` router; static file serving for prod |
| `evaluator.py` | Wraps `ragas`: loads rows, wires LLM, runs `evaluate()`, yields SSE events |
| `models.py` | Pydantic: `EvalRequest`, `ParsedFile` |

Key routes: `GET /api/health`, `GET /api/config`, `POST /api/parse`, `POST /api/evaluate` (SSE stream).

`/api/config` returns env defaults (including API key) so the frontend can pre-fill the LLM config form.

**SSE stream events from `/api/evaluate`:**
```
event: start    → {"total": N, "metrics": [...]}
event: row      → {"index": i, "question": "...", "scores": {...}}
event: complete → {"aggregate": {...}, "total": N}
event: error    → {"message": "..."}
```

### Frontend (`frontend/src/`)

Three-step flow: **Upload → Configure → Results** (plus a **History** overlay).
State lives entirely in `App.jsx` — no global store.

| Path | Responsibility |
|---|---|
| `api/client.js` | All HTTP/fetch calls — axios for REST, native fetch for SSE stream |
| `utils/basePath.js` | Derives `API_BASE` from `VITE_BASE_PATH` env var |
| `utils/history.js` | Browser `localStorage` run history (key `lens-ragas-web:history:v1`, max 20 runs) |
| `utils/scoresCsv.js` | Parses previously exported scores CSV back into results shape (no re-run needed) |
| `pages/Upload.jsx` | File drop zone; also has "Load scores CSV" to re-open old results |
| `pages/Configure.jsx` | Loads env defaults from `/api/config` on mount; metric checkboxes + LLM form |
| `pages/Results.jsx` | Per-row scores table + aggregate cards; Export CSV with input-filename prefix |
| `pages/History.jsx` | Lists localStorage runs; click to reopen |
| `components/Footer.jsx` | App version + GitHub link |

**Input format auto-detection** (`evaluator.py: detect_format`):
- Has `answer` column → `faithfulness` + `answer_relevancy` available
- Has `ground_truth` column → `context_precision` + `context_recall` available
- LENS JSON (no `answer`) → only context metrics shown; UI displays an amber warning

---

## Input Formats

### LENS export (`.json`)
```json
[{"question": "...", "contexts": ["ctx1", "ctx2"], "ground_truth": "..."}]
```
No `answer` → only `context_precision` and `context_recall` are computable.

### Generic CSV (`.csv`)
Columns: `question` (required), `contexts` (required, JSON array string), `ground_truth`, `answer`.

---

## System Config

```bash
LLM_PROVIDER=ollama          # ollama | openai
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```
Copy `.env.example` → `.env`. UI values sent in the request body always override env defaults.

---

## What this is NOT

- Not a RAG pipeline (no embedding, retrieval, or ingestion)
- Not connected to LENS's database
- Not a filter/browse tool
- Not a multi-user or auth system
- Not a benchmark registry with persistent history (localStorage only, browser-local)
