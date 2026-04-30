---

## name: ollama-docker-guidelines

description: Guardrails for using Ollama from Dockerized backends (base URL normalization, preflight checks, common traps)
version: 1.0
applies_to: ["ollama", "docker", "fastapi", "langchain"]
rules:

- Never assume localhost inside containers reaches the host
- Normalize Ollama base URL in one place and reuse everywhere
- Fail fast with a short preflight check before starting jobs
- Avoid module name collisions (do not name helpers ollama.py)
usage:
- When wiring an Ollama provider, apply these rules to all call paths (model listing + evaluation + health)
- Prefer active fallback (try host.docker.internal) over brittle Docker detection

# SKILL: Ollama guidelines

Reusable notes for this repo and similar projects.

## Ollama + Docker: the “localhost” trap

- **Problem**: When your backend runs in a Docker container, `http://localhost:11434` points to the **container**, not the host.
- **Symptom**: “Hanging” evaluations / long waits / `ConnectError(All connection attempts failed)` from Ragas/LangChain/Ollama calls.
- **Fix**: From containers, reach host Ollama via `**http://host.docker.internal:11434`** (macOS/Windows Docker Desktop; on Linux you may need a different host-gateway setup).

## Normalize the base URL in one place

- **Why**: Multiple call paths (model listing, evaluation, health checks) tend to drift and regress.
- **Pattern**: Create a single helper (e.g. `normalize_ollama_base_url()`) and reuse it everywhere:
  - trim whitespace
  - ensure scheme exists (`http://`)
  - strip trailing `/`
  - if `localhost`/`127.0.0.1` is provided and backend is containerized, rewrite to `host.docker.internal`

## Add a preflight connectivity check (fail fast)

- **Why**: Without a preflight, users experience a long “hang” while the evaluator repeatedly fails in the background.
- **Where**: On the API boundary where jobs start (e.g. `POST /api/evaluate/start`).
- **What**: Do a quick request like `GET {base_url}/api/tags` with a short timeout (1–2s).
- **UX**: If unreachable, return a clear error like:
  - “Ollama unreachable at … If the backend runs in Docker, use `http://host.docker.internal:11434` (not localhost).”

## Don’t rely solely on “am I in Docker?” detection

- **Reason**: `/.dockerenv` checks can be unreliable depending on the runtime/build.
- **More robust**:
  - Keep a best-effort detection (`/.dockerenv`, `/proc/1/cgroup`), **but**
  - Prefer an **active** approach: if the user supplies `localhost`, try `host.docker.internal` too and keep whichever responds.

## Python module naming collision: `ollama.py`

- **Problem**: Naming your helper module `ollama.py` can conflict with the installed **PyPI package** `ollama`.
- **Symptom**: `from ollama import ...` silently imports the external package instead of your file (or raises confusing import errors).
- **Fix**: Use a non-conflicting name like `ollama_utils.py` (or a `utils/` package).

## Containers don’t always include curl

- **Problem**: Minimal images often lack `curl`, making in-container debugging harder.
- **Tip**: For quick checks, use Python inside the container:

```python
import urllib.request
urllib.request.urlopen("http://host.docker.internal:11434/api/tags", timeout=2).read()
```

## “Rebuilt code not taking effect” in Docker

- **Problem**: Editing files on the host doesn’t always update the running container if the service uses a built image without bind mounts.
- **Symptom**: You “fixed” code but container behavior/logs don’t change.
- **Fix**: Rebuild and recreate the service:
  - `docker compose build api`
  - `docker compose up -d --no-deps api`

