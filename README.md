# ReForge AI

ReForge AI turns photos of a mechanical component into an editable, engineering-ready
parametric CAD model. It is aimed at MSMEs and small workshops that need to
reverse-engineer parts, quote jobs, or re-manufacture components without a
full CAD seat.

Upload one or more photos, optionally enter a known reference dimension, and the
app analyses the geometry, estimates dimensions with provenance, builds a
parametric solid, validates it, and exports STEP/STL plus an interactive 3D
preview.

## Features

- Photo analysis with Gemini, with optional local vision preprocessing
  (SAM 2 masks, OpenCV circles/contours/calibration, Depth Anything V2)
- Measurement-driven CAD: fused photo ratios synthesize generic feature
  recipes, are compared against the built solid, and gate manufacturing export
  behind honest geometry/reconstruction/accuracy/readiness statuses
  ([details](docs/MEASUREMENT_PIPELINE.md))
- Editable dimensions with per-dimension provenance (`user`, `measured`,
  `assumed`, `estimated`) and an anchor dimension that gates export
- Parametric CAD generation in Python (CadQuery) with legacy and feature-based
  advanced routes, geometry validation, STEP/STL export and a JSON mesh preview
- Image-fit check: projected CAD silhouette vs segmentation mask (IoU) with a
  capped 3-5 iteration scale refine loop
- Multi-photo reconstruction (COLMAP + SciPy) that degrades gracefully to the
  single-view solve when COLMAP is not installed
- Job orchestration (`POST /api/jobs`, `GET /api/jobs/:id`, resume) with
  `queued | analyzing | generating_cad | needs_input | done | failed | unavailable`
- Interactive Three.js viewport for the generated mesh, plus OBJ/GLTF export
- AI Engineer chat and manufacturing/material/engineering analysis helpers

## Prerequisites

- Node.js 18+
- Python 3.13
- [`uv`](https://github.com/astral-sh/uv) (manages the shared `.venv`)
- A [Gemini API key](https://aistudio.google.com/apikey)
- Optional: COLMAP on `PATH` (or `COLMAP_EXE_PATH`) for multi-photo reconstruction

## Setup

```powershell
# From the repository root: one venv for every Python service
uv venv .venv --python 3.13
uv pip install --python .venv/Scripts/python.exe -r requirements.txt

# Optional: CUDA PyTorch for the vision engine (NVIDIA on Windows)
uv pip install --python .venv/Scripts/python.exe torch torchvision --index-url https://download.pytorch.org/whl/cu128

# Optional: pinned SAM 2 + model checkpoints for the vision engine
$env:SAM2_BUILD_CUDA = "0"
uv pip install --python .venv/Scripts/python.exe -r vision-engine/requirements-vision-ml.txt
Push-Location vision-engine
..\.venv\Scripts\python.exe .\scripts\install_depth_anything_v2.py
..\.venv\Scripts\python.exe .\scripts\download_models.py
Pop-Location

# Node dependencies
Push-Location backend;  npm ci; Pop-Location
Push-Location frontend; npm ci; Pop-Location

# Configuration
Copy-Item backend/.env.example backend/.env.local
# edit backend/.env.local and set GEMINI_API_KEY, then enable the services you need
```

## Run

### One command (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

This starts the vision engine (`8765`), the Python CAD/reconstruction engine
(`8766`), the Node API (`8787`) and the Vite dev server (`5173`), waits for
health checks, and stops everything on Ctrl+C.

### Manual (separate terminals)

```powershell
# Terminal 1 - vision engine (optional)
Push-Location vision-engine
..\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765

# Terminal 2 - CAD + reconstruction engine
Push-Location python-engine
..\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8766

# Terminal 3 - Node API
Push-Location backend
npm run server

# Terminal 4 - frontend dev server
Push-Location frontend
npm run dev
```

Open http://localhost:5173. Service reachability is reported at
http://localhost:8787/api/health.

### Production-style

```powershell
Push-Location frontend; npm run build; Pop-Location
Push-Location backend;  npm run server; Pop-Location
```

The backend serves the built frontend at http://localhost:8787.

## Multi-process layout

```
backend/        Express API: auth-less local API, CORS, rate limiting,
                Gemini calls, vision/reconstruction/CAD adapters, job store,
                CAD artefact staging and download
frontend/       React + Vite + Three.js UI, upload flow, workbench, 3D viewer
vision-engine/  FastAPI vision service: SAM 2, OpenCV, Depth Anything V2
python-engine/  FastAPI engineering service: SciPy solver, COLMAP multiview,
                CadQuery modelling, validation, STEP/STL/mesh export, fit loop
scripts/        dev.ps1 launcher
```

All Python services share the repository-root `.venv` and bind to `127.0.0.1`.
The Node API is the only process intended to be browser-facing in development.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/analyze-component` | Analyse photos, return enriched analysis + optional vision observations |
| `POST` | `/api/jobs` | Create an analysis + CAD job (returns `202` with a job id) |
| `GET` | `/api/jobs/:id` | Poll job state, progress and result |
| `POST` | `/api/jobs/:id/resume` | Supply dimensions for a `needs_input` job |
| `POST` | `/api/cad/build` | Build CAD from measurements, an analysis or a recipe (blocking) |
| `GET` | `/api/cad/files/:filename` | Download staged STEP/STL/mesh output |
| `POST` | `/api/reconstruct` | COLMAP + SciPy reconstruction (accepts inline `photos[]`) |
| `POST` | `/api/chat` | AI Engineer chat |
| `GET` | `/api/health` | Overall + per-service reachability |

### Job flow

1. `POST /api/jobs` with the same `images` / `reference` payload as analysis.
2. Poll `GET /api/jobs/:id`; the job moves through `analyzing` and
   `generating_cad`.
3. Terminal states are `done`, `needs_input`, `failed`, `unavailable`.
   `needs_input` jobs can be resumed with `user_dimensions`.

Jobs are in-memory and expire after `JOB_TTL_SECONDS` (default 30 minutes).

## Environment variables

Set these in `backend/.env.local`.

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | - | Required. Stays server-side. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Gemini model id |
| `PORT` | `8787` | Node API port |
| `VISION_PIPELINE_ENABLED` | `false` | Enable the local vision service |
| `VISION_SERVICE_URL` | `http://127.0.0.1:8765` | Vision service base URL |
| `VISION_FAIL_OPEN` | `true` | Continue with Gemini only if vision fails |
| `VISION_REQUEST_TIMEOUT_SECONDS` | `60` | Vision request timeout |
| `CAD_ENABLED` | `false` | Enable parametric CAD generation |
| `CAD_SERVICE_URL` | `http://127.0.0.1:8766` | Python engineering service URL |
| `CAD_TIMEOUT_SECONDS` | `120` | CAD request timeout |
| `CAD_ADVANCED_ENABLED` | `false` | Route non-gear recipes to the feature pipeline |
| `MEASUREMENT_CONFIDENCE_GATE` | `0.55` | Minimum fused measurement agreement for the measurement CAD route |
| `GEMINI_CONSENSUS_RUNS` | `1` | Gemini analysis passes (clamped 1-5; majority/median merge) |
| `ALLOW_ASSUMED_EXPORTS` | `false` | Allow STEP/STL export when critical dimensions are assumed |
| `CAD_STORE_DIR` | `backend/var/cad` | Staged CAD artefacts |
| `CAD_JOB_TTL_HOURS` | `24` | Staged artefact retention |
| `RECONSTRUCTION_ENABLED` | `false` | Enable COLMAP + SciPy reconstruction |
| `RECONSTRUCTION_SERVICE_URL` | `http://127.0.0.1:8766` | Reconstruction service URL |
| `RECONSTRUCTION_TIMEOUT_SECONDS` | `60` | Reconstruction timeout |
| `RECONSTRUCTION_IMAGE_ROOT` | OS temp `reforge-recon-images` | Where inline photos are staged |
| `JOB_TTL_SECONDS` | `1800` | Job retention |
| `JOB_MAX_ENTRIES` | `50` | Maximum live jobs |
| `ANALYSIS_LOG_ENABLED` | `false` | Opt-in dataset logging (per-request consent required) |
| `ANALYSIS_LOG_DIR` | `backend/var/analysis-log` | Log output directory |
| `ANALYSIS_LOG_RETENTION_DAYS` | `30` | Log retention |
| `ANALYSIS_LOG_INCLUDE_IMAGES` | `false` | Also store raw photos (review consent first) |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Allowed browser origins |

The Gemini key is never exposed to the browser.

## Tests

```powershell
# Node unit tests
node --test backend/*.test.js

# Python tests (run from each service directory)
Push-Location python-engine
..\.venv\Scripts\python.exe -B -m pytest tests -q
Pop-Location

Push-Location vision-engine
..\.venv\Scripts\python.exe -B -m pytest tests -q
Pop-Location

# Frontend production build
Push-Location frontend; npm run build; Pop-Location
```

## Accuracy evaluation

`evaluation/` contains a harness that compares predicted dimensions against
caliper-measured parts and reports per-dimension MAE/MAPE plus tolerance pass
rates. Fill `evaluation/dataset.json` with 50-100 measured parts (see
`evaluation/README.md`) and run:

```powershell
..\.venv\Scripts\python.exe -B evaluation\run_evaluation.py evaluation\dataset.json --md evaluation\report.md
```

## Privacy and dataset logging

Analysis logging is **off by default** and requires explicit per-request consent
(`consent_for_training: true`). When `ANALYSIS_LOG_ENABLED=true`, consented
records store the Gemini output, user corrections, and reference dimensions;
photos are hashed, not stored, unless `ANALYSIS_LOG_INCLUDE_IMAGES=true`. Logs
expire after `ANALYSIS_LOG_RETENTION_DAYS` (default 30). Send corrections to
`POST /api/analysis-feedback`.

## Model and license notices

SAM 2.1 and Depth Anything V2 checkpoints are described in
[MODEL_NOTICES.md](MODEL_NOTICES.md) (both Apache-2.0). The application is a
prototype intended for demonstration and local evaluation.
