---
name: reforge-architecture
description: Complete understanding of the ReForge AI project architecture, repository structure, API contracts, data flow, and architectural boundaries. Activate when working on any part of the ReForge AI codebase, making architectural decisions, or understanding how components interact.
---

# ReForge AI Architecture

## Purpose

Provide a complete, accurate mental model of the ReForge AI codebase so that any AI coding agent can make correct, non-breaking changes that respect the existing architecture.

## When to use

- Before modifying any file in `backend/`, `frontend/`, `python-engine/`, or `vision-engine/`.
- When adding new API endpoints or changing existing ones.
- When deciding where new code should live.
- When debugging cross-service communication issues.
- When reviewing whether a proposed change fits the existing architecture.

## Project context

ReForge AI is an AI-assisted mechanical reverse-engineering application. Users upload photos of mechanical components and receive a parametric 3D CAD model plus engineering analysis (dimensions, material, manufacturing process, cost estimate).

### Repository structure

```
reforge_ai_2/
├── backend/                    # Node.js + Express + Gemini API server
│   ├── index.js                # Express app, all API routes
│   ├── gemini.js               # Gemini API integration, prompt engineering, schema
│   ├── vision-adapter.js       # HTTP client for vision-engine (fail-open)
│   ├── reconstruction-adapter.js # HTTP client for python-engine (fail-open)
│   ├── manufacturing.js        # Cost/process/lead-time calculation engine
│   ├── manufacturing-data.js   # Material and process rate knowledge base
│   ├── geometry-volume.js      # Volume/mass estimation from geometry
│   ├── material-comparison.js  # Material alternative comparison
│   ├── engineering-analysis.js # What-if simulation and sensitivity analysis
│   └── package.json            # Dependencies: express, @google/generative-ai
│
├── frontend/                   # React + Vite + Three.js SPA
│   ├── src/
│   │   ├── main.jsx            # Single-file React app (all components)
│   │   ├── styles.css          # Global styles
│   │   ├── components/         # Workbench sub-components
│   │   │   ├── ExportWorkWindow.jsx
│   │   │   ├── ManageComponentsTab.jsx
│   │   │   ├── MultiViewportGrid.jsx
│   │   │   └── PipWorkbench.jsx
│   │   └── lib/                # Frontend utility modules
│   │       ├── api.js          # Backend API client
│   │       ├── geo.js          # Three.js geometry helpers (materials, shapes)
│   │       ├── recipe.js       # Recipe sanitization + Three.js recipe execution
│   │       ├── reconstruct.js  # Component-specific 3D model builders
│   │       ├── features.js     # Feature extraction and normalization
│   │       ├── exporters.js    # Multi-format export (STEP, STL, DXF, etc.)
│   │       ├── manufacturing.js # Manufacturing data client
│   │       ├── material-comparison.js # Material comparison client
│   │       ├── engineering-context.js # Engineering context builder
│   │       └── machinery-context.js # Multi-component machinery context
│   ├── index.html
│   ├── vite.config.js
│   └── package.json            # Dependencies: react, three, vite, jspdf
│
├── python-engine/              # Python FastAPI reconstruction + CAD engine
│   ├── app.py                  # FastAPI app: /reconstruct, /cad/generate, /cad/generate-advanced
│   ├── recipe_validator.py     # Legacy recipe validation (CadSpec dataclass)
│   ├── reconstruction/
│   │   ├── multiview.py        # Optional COLMAP SfM pipeline
│   │   └── geometry_solver.py  # SciPy-based geometric parameter solver
│   ├── cad/
│   │   ├── cad_generator.py    # Legacy CAD generator (revolved, extruded, combination, gear)
│   │   ├── cad_validator.py    # Geometry validation (volume, bbox, holes)
│   │   ├── feature_schema.py   # Advanced feature-based recipe schema (dataclasses)
│   │   ├── feature_recipe_validator.py # Feature recipe validation
│   │   ├── feature_modeller.py # Feature-based CAD modeller (additive/subtractive/finish)
│   │   ├── advanced_recipe_adapter.py # Bridge between legacy and feature recipes
│   │   ├── advanced_cad_validator.py # Advanced geometry validation
│   │   ├── advanced_preview.py # SVG/PNG preview rendering
│   │   ├── gear_generator.py   # Gear geometry generation (delegation boundary)
│   │   ├── recipe_validator.py # Legacy recipe validation
│   │   ├── integration_contract.py # Integration contract definitions
│   │   └── export_validation.py # STEP/STL export validation
│   ├── exports/
│   │   ├── step_export.py      # STEP file export via CadQuery
│   │   └── mesh_export.py      # STL file export via CadQuery
│   ├── vision/
│   │   ├── segment.py          # SAM2 segmentation wrapper
│   │   ├── image_features.py   # OpenCV feature extraction
│   │   └── depth.py            # Depth Anything V2 wrapper
│   ├── tests/                  # Python tests
│   ├── requirements-cad.txt    # cadquery, cq_gears
│   └── pytest.ini
│
├── vision-engine/              # Python FastAPI vision preprocessing service
│   ├── app.py                  # FastAPI app: /process, /health
│   ├── config.py               # Environment variable configuration
│   ├── schemas.py              # Pydantic v2 request/response models
│   ├── vision/
│   │   ├── pipeline.py         # Orchestrates image processing pipeline
│   │   ├── model_registry.py   # Singleton model cache (SAM2, Depth Anything V2)
│   │   ├── segmentation.py     # SAM2 segmentor wrapper
│   │   ├── depth_estimator.py  # Depth Anything V2 estimator
│   │   ├── opencv_features.py  # OpenCV contour/circle/line detection
│   │   ├── image_io.py         # Image decoding and validation
│   │   └── quality.py          # Image quality metrics
│   ├── scripts/
│   │   ├── download_models.py  # Model checkpoint downloader
│   │   └── install_depth_anything_v2.py
│   ├── tests/                  # Vision engine tests
│   ├── requirements.txt        # Pinned Python dependencies
│   └── README.md
│
├── docs/                       # Documentation
├── .opencode/skills/           # OpenCode agent skills (this directory)
├── README.md                   # Project overview and setup instructions
├── MODEL_NOTICES.md            # AI model licenses and provenance
├── tasks.md                    # Implementation task tracking
└── VISION_ENGINE_COMPLETION_REPORT.md
```

### Layer responsibilities

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| Frontend | React + Vite + Three.js | UI, 3D visualization, user interaction, API calls |
| Backend | Node.js + Express + Gemini | API orchestration, Gemini analysis, manufacturing intelligence, fail-open adapters |
| Vision Engine | Python + FastAPI + SAM2 + OpenCV + Depth Anything V2 | Image preprocessing, segmentation, feature extraction, depth estimation |
| Reconstruction Engine | Python + FastAPI + SciPy + COLMAP + CadQuery | Geometric parameter solving, CAD generation, STEP/STL export |

### API contracts

**Backend (Node.js) — port 8787:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/analyze-component` | POST | Analyze component images via Gemini, optionally with vision evidence |
| `/api/chat` | POST | AI Engineer chat with engineering context |
| `/api/engineering-simulate` | POST | What-if engineering change simulation |
| `/api/engineering-sensitivity` | POST | Dimension sensitivity analysis |
| `/api/manufacturing-intelligence` | POST | Cost, process, lead-time estimation |
| `/api/material-alternatives` | POST | Material comparison |
| `/api/reconstruct` | POST | Proxy to Python reconstruction engine (fail-open) |
| `/api/health` | GET | Health check |

**Vision Engine (Python) — port 8765:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/process` | POST | Process 1-8 images through SAM2, OpenCV, Depth Anything V2 |
| `/health` | GET | Health check with model/device status |

**Reconstruction Engine (Python) — port 8766:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check with capability status |
| `/reconstruct/multiview` | POST | COLMAP SfM multi-view reconstruction |
| `/reconstruct/solve` | POST | SciPy geometric parameter solver |
| `/reconstruct` | POST | End-to-end reconstruction |
| `/cad/generate` | POST | Legacy CAD generation (validate → generate → validate → export) |
| `/cad/generate-advanced` | POST | Advanced feature-based CAD generation |

### Data flow

```
User uploads images
    │
    ▼
Frontend (React) ──POST /api/analyze-component──▶ Backend (Express)
    │                                                    │
    │                                          ┌─────────┴─────────┐
    │                                          │                   │
    │                                    Vision Engine        Gemini API
    │                                    (optional,          (structured
    │                                     fail-open)           analysis)
    │                                          │                   │
    │                                          └────────┬──────────┘
    │                                                   │
    │◀──────────── { analysis, visionDiagnostics } ──────┘
    │
    ▼
Frontend renders 3D model (Three.js)
    │
    ├── Recipe-based geometry (sanitizeRecipe → executeRecipe)
    ├── Component-specific builders (buildSpurGear, buildCylinder, etc.)
    └── Feature highlighting and interaction
```

### Existing functionality that must be preserved

1. **Gemini-only analysis path** — When `VISION_PIPELINE_ENABLED=false` (default), the system works exactly as before with Gemini-only analysis.
2. **Fail-open adapters** — `vision-adapter.js` and `reconstruction-adapter.js` must never throw; they return `null` on any failure.
3. **Recipe sanitization** — `sanitizeRecipe()` in both `backend/gemini.js` and `frontend/src/lib/recipe.js` must remain consistent.
4. **Legacy CAD pipeline** — `/cad/generate` endpoint and `cad_generator.py` must not be broken by advanced feature pipeline changes.
5. **Manufacturing intelligence** — `manufacturing.js` is deterministic (no Gemini calls); preserve this separation.
6. **Three.js recipe execution** — `executeRecipe()` in `frontend/src/lib/recipe.js` handles revolved, extruded, gear, and combination styles.
7. **Component-specific builders** — `reconstruct.js` contains `buildSpurGear`, `buildCylinder`, `buildFlange`, `buildBearing`, `buildBracket`, `buildGeneric`.
8. **Feature normalization** — `features.js` normalizes features from recipe, analysis, and text sources with priority-based merging.

### Dependency and integration rules

- **Backend → Vision Engine**: HTTP via `vision-adapter.js`, fail-open, configurable via `VISION_PIPELINE_ENABLED`, `VISION_SERVICE_URL`, `VISION_FAIL_OPEN`.
- **Backend → Reconstruction Engine**: HTTP via `reconstruction-adapter.js`, fail-open, configurable via `RECONSTRUCTION_ENABLED`, `RECONSTRUCTION_SERVICE_URL`.
- **Backend → Gemini**: `@google/generative-ai` SDK, API key from `GEMINI_API_KEY` env var, model from `GEMINI_MODEL` (default `gemini-2.0-flash`).
- **Frontend → Backend**: `fetch` via `frontend/src/lib/api.js`, base URL is relative (proxied by Vite in dev, served by Express in production).
- **Python services**: Independent FastAPI apps, no shared code, communicate via HTTP JSON only.

### Coding conventions

- **Backend**: ES modules (`"type": "module"` in package.json), `import`/`export` syntax, no CommonJS.
- **Frontend**: ES modules, React function components with hooks, Three.js imported as `import * as THREE from "three"`.
- **Python**: Type hints, dataclasses for structured data, Pydantic v2 for API schemas, `from __future__ import annotations`.
- **Error handling**: Backend uses `error.status` pattern; Python uses custom exception classes with `to_dict()` methods.
- **Configuration**: All configurable values via environment variables with safe defaults.

### Architectural boundaries

- **Gemini interprets evidence, does not invent geometry** — Gemini returns structured feature hypotheses and recipe data; it must not fabricate dimensions.
- **CadQuery generates actual CAD solids** — The Python engine produces real B-rep solids, not meshes.
- **Three.js is for visualization only** — The frontend renders geometry for preview; it does not generate production CAD.
- **Feature-driven, not category-restricted** — The system handles any mechanical component via feature recipes, not just gears/shafts/brackets.
- **Never fabricate dimensions** — Unknown parameters must be marked as unknown; estimated parameters must be distinguished from known ones.

## Implementation guidelines

1. **Always read existing code before modifying** — Use `read_file` to understand the current implementation before making changes.
2. **Preserve existing API contracts** — Do not change request/response shapes without updating all callers.
3. **Maintain fail-open behavior** — Optional services (vision, reconstruction) must never break the core Gemini-only path.
4. **Keep recipe schemas consistent** — The `geometryRecipe` schema in `backend/gemini.js` (ANALYSIS_SCHEMA) and `frontend/src/lib/recipe.js` (sanitizeRecipe) must stay in sync.
5. **Use existing patterns** — Follow the established error handling, logging, and validation patterns.
6. **Do not add unnecessary dependencies** — Prefer existing libraries (express, three, cadquery, fastapi, pydantic).
7. **Do not create duplicate functionality** — Check if a utility already exists in `frontend/src/lib/` or `backend/` before creating new ones.

## Best practices

- **Inspect before acting**: Read the relevant files in `backend/`, `frontend/src/`, `python-engine/`, or `vision-engine/` before making changes.
- **Respect module boundaries**: Frontend code goes in `frontend/src/`, backend in `backend/`, Python in `python-engine/` or `vision-engine/`.
- **Use existing adapters**: New Python services should follow the `vision-adapter.js` / `reconstruction-adapter.js` fail-open pattern.
- **Validate at boundaries**: All API inputs must be validated (see `validateImages`, `sanitizeReference`, `validateAnalysisShape` in `backend/index.js`).
- **Keep secrets server-side**: `GEMINI_API_KEY` must never be exposed to the browser.

## Common mistakes to avoid

- **Modifying the Gemini-only path when adding vision features** — Vision is optional and fail-open; the default path must work without it.
- **Changing the `geometryRecipe` schema without updating both backend and frontend** — The schema is defined in `backend/gemini.js` and consumed in `frontend/src/lib/recipe.js`.
- **Adding microservices unnecessarily** — The current architecture has exactly three services (backend, vision-engine, python-engine); do not add more without justification.
- **Replacing the existing frontend** — The React + Three.js frontend in `frontend/src/main.jsx` is the single source of truth for the UI.
- **Assuming planned features are implemented** — Check the actual code; `tasks.md` describes planned work, not necessarily completed work.
- **Hardcoding API keys or secrets** — All secrets must come from environment variables.
- **Breaking the fail-open contract** — `callVisionService` and `callReconstructionService` must always resolve (never reject).

## Validation checklist

- [ ] Existing API contracts are preserved (request/response shapes unchanged).
- [ ] Fail-open behavior is maintained for optional services.
- [ ] Recipe schema changes are reflected in both backend and frontend.
- [ ] No new dependencies added without justification.
- [ ] No duplicate functionality created.
- [ ] Environment variables used for all configuration.
- [ ] Secrets are not exposed to the client.
- [ ] Existing tests pass (if applicable).