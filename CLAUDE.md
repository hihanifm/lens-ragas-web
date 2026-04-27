# lens-ragas-web — RAGAS Evaluation Web UI

## What is this?
A standalone, browser-based wrapper around the `ragas` Python library.
Upload a LENS export (or any compatible CSV), pick your metrics and LLM judge, and get scores back without touching the terminal.

Not a RAG system. Not a search tool. Not a benchmark suite. Just evaluation, done simply.

---

## Interaction Protocol (NEVER skip this)

Before writing any code or plan, Claude MUST:
1. Ask clarifying questions to fully understand the requirements
2. Wait for the user to respond
3. Only proceed to coding after the user confirms you have enough context

Do NOT jump straight into code. Always converse first.

---

## Design Principles (NEVER violate these)

1. **KISS** — If there's a simpler way, take it. Complexity only when simpler solution provably fails.
2. **Wrap, Don't Reimplement** — Use `ragas` library for all metric logic. Never rewrite scoring prompts or LLM-judge logic from scratch.
3. **On-Prem Default** — Ollama is the default LLM judge. OpenAI is a testing convenience. No other external services.
4. **All config in config.py** — never hardcode URLs or model names in logic files.
5. **Stateless** — No database, no persistence. Files are transient. Each evaluation session is independent.
6. **Defer Complexity** — Build the simplest thing first. Add features only when real users hit real limits.
7. **One Job, Done Well** — This tool evaluates. It does not search, ingest, or summarize.

---

## Hard Constraints

- **ragas library is the authority** — do not reimplement metric scoring, LLM-judge prompts, or dataset handling
- **All config in `config.py`** — no hardcoded URLs, model names, or API keys in logic files
- **No database** — evaluation is stateless; uploaded files are temporary, cleared per session
- **Ollama runs on HOST** — not inside Docker (needs direct GPU access); Docker container reaches it via `host.docker.internal`
- **Never commit `.env`** — secrets stay local

---

## Input Formats

### LENS export (`.json`)
Produced by LENS's "Export RAGAS JSON" button. Shape:
```json
[
  {
    "question": "...",
    "contexts": ["ctx1", "ctx2"],
    "ground_truth": "..."
  }
]
```
No `answer` field → only `context_precision` and `context_recall` are computable.

### Generic CSV (`.csv`)
Any CSV with these columns (all optional except the first two):
| Column | Required | Used by |
|---|---|---|
| `question` | yes | all metrics |
| `contexts` | yes | all metrics (JSON array string or single string) |
| `ground_truth` | for context metrics | `context_precision`, `context_recall` |
| `answer` | for answer metrics | `faithfulness`, `answer_relevancy` |

The system auto-detects which metrics are runnable based on what columns are present.

---

## Supported Metrics

| Metric | Needs `answer` | Needs `ground_truth` |
|---|---|---|
| `faithfulness` | yes | no |
| `answer_relevancy` | yes | no |
| `context_precision` | no | yes |
| `context_recall` | no | yes |

All computed by the `ragas` library. Do not reimplement.

---

## Tech Stack

### Backend
- Python + FastAPI
- `ragas>=0.2` — all evaluation logic lives here
- `langchain-community` — Ollama LLM + embeddings wrapper
- `langchain-openai` — OpenAI LLM + embeddings wrapper
- `pandas` + `openpyxl` — CSV/JSON file parsing
- `python-dotenv` — env var loading

### Frontend
- React + Vite
- TanStack Query (data fetching)
- Tailwind CSS (styling)
- Axios (API calls via `src/api/client.js` — all API calls go here, nowhere else)

### Infrastructure
- Docker Compose: `api` service (FastAPI only — no DB needed)
- Ollama: runs on host, outside Docker
- Communication: FastAPI → Ollama via `host.docker.internal:11434`

---

## System Config (env vars → `config.py`)

```bash
# LLM provider for ragas judge: "ollama" | "openai"
LLM_PROVIDER=ollama

# Ollama (default, on-prem)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2

# OpenAI (testing outside network)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

Copy `.env.example` → `.env` and fill in. Never commit `.env`.

Note: LLM provider can also be set per-request from the UI — the UI values take precedence over env defaults.

---

## Project Structure

```
lens-ragas-web/
  backend/
    config.py       ← ALL config here, nowhere else
    main.py         ← FastAPI app: /health, /parse, /evaluate
    evaluator.py    ← ragas evaluation logic + LLM wiring
    models.py       ← Pydantic models (EvalRequest, ParsedFile)
    requirements.txt
    Dockerfile
    uploads/        ← transient upload dir, gitignored
  frontend/
    src/
      pages/
        Upload.jsx      ← file drop + /parse call
        Configure.jsx   ← metric + LLM config + SSE progress
        Results.jsx     ← scores table + CSV export
      api/
        client.js       ← ALL axios/fetch calls here, nowhere else
      App.jsx           ← 3-step flow: upload → configure → results
      main.jsx
      index.css
    index.html
    package.json
    vite.config.js      ← proxy: /api → localhost:37100
    tailwind.config.js
    postcss.config.js
  docker-compose.yml
  Makefile
  .env.example
  .gitignore
  CLAUDE.md            ← this file
```

---

## API Routes

| Route | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check |
| `/parse` | POST (multipart) | Upload `.json` or `.csv` → returns columns + available metrics |
| `/evaluate` | POST (JSON) | SSE stream → `start`, `row`, `complete`, `error` events |

### SSE event shapes
```
event: start
data: {"total": 20, "metrics": ["context_precision", "context_recall"]}

event: row
data: {"index": 0, "question": "...", "scores": {"context_precision": 0.85, ...}}

event: complete
data: {"aggregate": {"context_precision": 0.82, ...}, "total": 20}

event: error
data: {"message": "..."}
```

---

## What this is NOT (never add without explicit instruction)

- Not a RAG pipeline (no embedding, no retrieval, no ingestion)
- Not a search tool
- Not a results browser or filter UI
- Not a benchmark registry or history tracker
- Not connected to LENS's database
- Not a multi-user / auth system

---

## Dev Setup

### Prerequisites
- Docker + Docker Compose
- Node.js 18+
- Ollama running on the host (for on-prem evaluation):
  ```bash
  ollama pull llama3.2
  ```

### Running

```bash
# 1. Copy env
cp .env.example .env

# 2. Start backend
make up        # FastAPI at http://localhost:37100

# 3. Start frontend (separate terminal)
cd frontend
npm install
npm run dev    # http://localhost:37101
```

Vite proxies `/api/*` → `http://localhost:37100/*` so no CORS issues in dev.

### Common Makefile targets
| Command | What it does |
|---|---|
| `make up` | Start backend detached |
| `make down` | Stop backend |
| `make build` | Rebuild Docker image |
| `make logs` | Follow backend logs |
| `make restart` | down + up |
| `make ps` | Show container status |

### Local Python (one-offs / debugging)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# run scripts here
```

`.venv/` is gitignored. Never install packages system-wide.

### Dev vs Prod architecture

**Dev:** Vite dev server (`localhost:37101`) + FastAPI (`localhost:37100`) run separately.
Vite proxy handles `/api` → FastAPI with no CORS issues.

**Prod (planned):** FastAPI serves the compiled frontend as static files — single port, no
separate frontend process. `npm run build` → mount `frontend/dist/` via FastAPI `StaticFiles`.

---

## Design Decisions

- **`ragas` library** over custom implementation — battle-tested prompts, maintained by the ragas team, no wheel reinvention
- **Stateless / no DB** — evaluation sessions are ephemeral; persisting results is the user's job (Export CSV)
- **SSE for streaming** — same pattern as LENS; gives live per-row progress without WebSockets
- **LLM config in UI, not just env** — users switch between Ollama and OpenAI without restarting the backend
- **Auto-detect metrics** — system checks available columns and disables irrelevant metrics; user never sees a confusing error about missing columns
- **LENS JSON format supported natively** — zero friction path from LENS export → evaluation
