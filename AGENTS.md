# AGENTS.md — working on ReForge AI

Guidance for AI agents (and humans) changing this repository. Read this before
editing; it records how the project is wired and the rules that have already
caused regressions here.

**Working agreement: fix one issue per change.** Change only what the reported
issue needs. Do not refactor, restyle, or "improve" adjacent code, and never
trade a working feature for a cleaner abstraction. State what you checked and
what you did not.

## 1. What this project is

ReForge AI turns photos of mechanical components (gears, shafts, flanges,
brackets, bearings) into a parametric 3D reconstruction, a manufacturing
estimate, and downloadable engineering deliverables, for small manufacturing
workshops.

```
frontend/       React + Vite + three.js 0.128 workbench (landing, upload, 3D viewer,
                manufacturing panels, drawings, export center)
backend/        Express API: Gemini analysis/chat, manufacturing + material engines,
                proxies for the optional Python services
python-engine/  Optional CAD + reconstruction engine (CadQuery, OpenCASCADE, SciPy,
                COLMAP). Also the source of real B-Rep CAD exports.
vision-engine/  Optional SAM2/OpenCV/Depth-Anything preprocessing service
docs/           Integration contracts and technical handoffs
.venv/          Repository virtualenv that already contains CadQuery + OCP + cq_gears
```

## 2. Run and verify

```bash
# backend API (http://localhost:8787) — needs backend/.env.local with GEMINI_API_KEY
cd backend && npm install && npm run server

# frontend dev server (http://localhost:5173, proxies /api to 8787)
cd frontend && npm install && npm run dev
```

Checks used in this repo (run the smallest set that covers your change):

```bash
cd frontend && npm test          # node --test on src/lib/*.test.js
cd frontend && npm run build     # must exit 0
cd backend  && npm test          # node --test *.test.js
.venv/Scripts/python.exe -m pytest python-engine/tests          # Windows
.venv/bin/python -m pytest python-engine/tests                 # POSIX
```

Environment variables (`backend/.env.local`, never committed):

| Variable | Meaning |
| --- | --- |
| `GEMINI_API_KEY` | Required for analysis/chat. Server-side only. |
| `GEMINI_MODEL` | Optional model override. |
| `PORT` | Backend port, default 8787. |
| `VISION_PIPELINE_ENABLED`, `VISION_SERVICE_URL` | Optional vision service. |
| `RECONSTRUCTION_ENABLED`, `RECONSTRUCTION_SERVICE_URL` | Optional reconstruction service. |
| `CAD_EXPORT_PYTHON` | Optional Python interpreter for CAD export (defaults to `.venv`, then `python`). |
| `CAD_EXPORT_TIMEOUT_SECONDS` | CAD export timeout, default 180. |

## 3. Hard rules learned from this codebase

1. **Never emit a file that pretends to be a format the project cannot really
   write.** The CAD export used to concatenate STEP/IGES text in the browser;
   OpenCASCADE transferred zero roots and FreeCAD showed nothing. Real geometry
   comes from `python-engine/exports/reconstruction_export.py` (CadQuery) through
   `POST /api/cad/export`. If a format cannot be produced validly, it must not be
   offered in the UI.
2. **`ANALYSIS_SCHEMA` in `backend/gemini.js` must mirror every recipe field**
   that the prompt or `sanitizeRecipe` can return. The retry path uses
   schema-constrained generation and silently drops fields that are missing from
   the schema — a silent data-loss bug, not a validation error.
3. **Recipe limits live in three places**: `backend/gemini.js`
   (`sanitizeRecipe`), `frontend/src/lib/recipe.js` (`RECIPE_LIMITS`), and
   `python-engine/exports/reconstruction_export.py` (`LIMITS`) /
   `python-engine/recipe_validator.py`. Change them together.
4. **Keep the parametric fallbacks and the recipe path in sync.** The workbench
   renders from `geometryRecipe` when it sanitises successfully and otherwise
   falls back to the builders in `frontend/src/lib/reconstruct.js`. CAD export
   mirrors the same order (recipe first, dimension fallback second). A new part
   type means touching both.
5. **No invented numbers.** Dimensions come from Gemini/user references and are
   clamped; sanitize untrusted client input in the backend (`validateAnalysisShape`
   and friends) before it reaches a calculation or the CAD engine.
6. **Optional Python services fail open.** Vision and reconstruction adapters
   return `null` on error so the Gemini-only path keeps working. CAD export is
   different: it must fail loudly (HTTP 503 with a fix hint) rather than download
   a placeholder.
7. **three.js stays at ^0.128.0.** New visuals must work on that version (no
   post-processing APIs from newer releases).
8. **Windows-first.** Shell examples are bash (Git Bash); Python paths usually
   mean `.venv/Scripts/python.exe`.

## 4. Where things live

| Concern | File |
| --- | --- |
| API routes, input validation | `backend/index.js` |
| Gemini prompt, analysis schema, recipe sanitising | `backend/gemini.js` |
| Cost / process / lead-time engine | `backend/manufacturing.js`, `manufacturing-data.js`, `geometry-volume.js` |
| 3D reconstruction + parametrics | `frontend/src/lib/reconstruct.js`, `geo.js`, `recipe.js` |
| Export catalog UI | `frontend/src/components/ExportWorkWindow.jsx` |
| Export implementations | `frontend/src/lib/exporters.js` (client) and `frontend/src/lib/cad-export.js` (server-backed CAD) |
| CAD export bridge | `backend/cad-export-adapter.js` |
| Real CAD geometry | `python-engine/exports/reconstruction_export.py` |
| CAD contract between engines | `docs/CAD_INTEGRATION_CONTRACT.md`, `python-engine/cad/integration_contract.py` |

Generated artifacts (`backend/var/`, `python-engine/exports/cad/`,
`python-engine/cad/artifacts/`, `.cache/`) are build/test output, not source.

## 5. Definition of done

- The reported behaviour works end to end, verified with a command whose output
  you actually read.
- For geometry/CAD changes: the produced STEP/IGES re-imports through
  OpenCASCADE (`BRepCheck_Analyzer.IsValid()`), because that is the kernel
  FreeCAD uses. Say plainly if a check needed a tool you did not have (for
  example FreeCAD itself).
- Existing tests still pass; `frontend` builds.
- Nothing outside the issue's scope was edited, and no secrets were added to
  files, logs, or browser code.
