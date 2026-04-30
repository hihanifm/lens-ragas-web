# Third-Party Notices

This project uses third-party open source software. This file is meant to satisfy common attribution expectations and make future distribution easier, even though this deployment is currently **in-house only**.

## Summary (what we checked)

- **Dependency graphs reviewed**: Python (`backend/requirements.txt`, including transitive installs) and npm (`frontend/package-lock.json`, including transitive installs).
- **Copyleft scan**: No **GPL / LGPL / AGPL / SSPL** licenses were detected in the dependency graphs.
- **Notable non-permissive licenses present**:
  - **MPL-2.0** (file-level copyleft) appears in Python deps (e.g. `certifi` is MPL-2.0).
  - **CC-BY-4.0** (attribution required) appears in npm deps (via `caniuse-lite`).

## Frontend (npm)

Direct dependencies from `frontend/package.json` (license info derived from the resolved install graph):

- **MIT**
  - `axios` — [GitHub](https://github.com/axios/axios)
  - `react` — [GitHub](https://github.com/facebook/react)
  - `react-dom` — [GitHub](https://github.com/facebook/react)
  - `react-router-dom` — [GitHub](https://github.com/remix-run/react-router)
  - `@tanstack/react-query` — [GitHub](https://github.com/TanStack/query)
- **Apache-2.0**
  - `@playwright/test` — [GitHub](https://github.com/microsoft/playwright)
- **MIT (devDependencies)**
  - `vite` — [GitHub](https://github.com/vitejs/vite)
  - `tailwindcss` — [GitHub](https://github.com/tailwindlabs/tailwindcss)
  - `postcss` — [GitHub](https://github.com/postcss/postcss)
  - `autoprefixer` — [GitHub](https://github.com/postcss/autoprefixer)
  - `@vitejs/plugin-react` — [GitHub](https://github.com/vitejs/vite-plugin-react)

**Transitive note**: The resolved npm tree also includes **CC-BY-4.0** content via `caniuse-lite` (Browserslist). Repository: [caniuse-lite](https://github.com/browserslist/caniuse-lite).

## Backend (Python / pip)

Direct dependencies from `backend/requirements.txt` (license info derived from the resolved install graph):

- **MIT**
  - `fastapi` — [GitHub](https://github.com/fastapi/fastapi)
  - `openpyxl` — [Docs](https://openpyxl.readthedocs.io)
  - `langchain-community` — [GitHub](https://github.com/langchain-ai/langchain)
  - `langchain-ollama` — [GitHub](https://github.com/langchain-ai/langchain)
  - `langchain-openai` — [GitHub](https://github.com/langchain-ai/langchain)
- **BSD (various permissive BSD forms in metadata)**
  - `uvicorn` — [Site](https://www.uvicorn.org/)
  - `numpy` — [Site](https://numpy.org)
  - `pandas` — [Site](https://pandas.pydata.org)
  - `python-dotenv` — [GitHub](https://github.com/theskumar/python-dotenv)
- **Apache-2.0**
  - `python-multipart` — [GitHub](https://github.com/Kludex/python-multipart)
  - `ragas` — [GitHub](https://github.com/explodinggradients/Ragas) (Apache-2.0)

## Container base images

This repo builds on:

- `python:3.11-slim` (Debian-based)
- `node:20-alpine` (Alpine-based)

Those images include OS-level packages with their own licenses. If you ever redistribute built images outside your org, you should also capture SBOMs for the built images and include any required notices for base OS packages.

## How to regenerate the full inventory (recommended for release checklists)

- **Python**: create a venv, install `backend/requirements.txt`, then run `pip-licenses --with-license-file`.
- **npm**: in `frontend/`, run `npx license-checker --json`.

