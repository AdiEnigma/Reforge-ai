# ReForge AI: Integration and Accuracy Plan (v3)

**Goal:** photo(s) of a mechanical part -> an accurate, editable parametric CAD solid, shown in the browser as a real CAD model in Three.js, with STEP/STL exports that are safe to manufacture from.

**Scope:** connect `frontend/` -> `backend/` -> `vision-engine/` -> `python-engine/` into one pipeline, remove duplicated and fake code paths, and make the Python CAD engine the source of truth for geometry.

`WORKFLOW.md` stays the target pipeline and source of truth. This plan is the route to it, and the amended copy of `WORKFLOW.md` delivered with this plan records the decisions below.

---

## 0. Changes from v2

| Change | Why |
|---|---|
| Legacy `/cad/generate` first, for every recipe style | The advanced adapter converts only revolved, extruded and combination recipes and raises an error for `gear`. Gears are a core part type. The legacy route also needs no schema translation. |
| Dropped "route everything through advanced" and `cad-recipe-adapter.js` | Gemini's recipe already matches the Python validator (styles, primitive kinds, limits, primitive size keys). |
| CAD build stays blocking for now, but returns a job-shaped object | Keeps the first version simple while letting real polling replace it later without frontend changes. |
| New scale rule: export needs one anchor dimension | Reconciles "photo assumptions are allowed" with WORKFLOW's "no export without a metric reference". |
| Provenance labels use WORKFLOW's `user | measured | estimated` | Mapped from Python's existing four sources. |
| Viewer work moves to the shared `ReconstructedViewport` and includes scale normalization | It also feeds the PiP/multi-viewport components, and existing code normalizes models to a 6-unit box. |
| Vision adapter must forward raw OpenCV observations | Today they are reduced to counts, so the solver can never use them. |

---

## 1. Target workflow

1. **Capture:** 1 to 8 photos plus optional known dimensions and which feature each refers to.
2. **Understand:** vision evidence (OpenCV, depth, optional SAM2) plus Gemini classify the part and propose a recipe.
3. **Assume and label:** gaps are filled with estimates, snapped to standard sizes where possible, and every dimension carries a provenance label.
4. **Build real CAD:** python-engine builds a CadQuery solid, validates it, and produces STEP, STL and mesh/edge data.
5. **Inspect:** the viewport shows the CAD solid with feature edges. Estimated values are flagged.
6. **Anchor and export:** STEP/STL download needs at least one anchor dimension (see 5.4). Without one, the model is a labeled relative preview.
7. **Edit and act:** editing a dimension rebuilds the solid. Manufacturing estimates, drawings, chat and exports all use that solid.

The full stage-by-stage flow (SAM2, OpenCV, COLMAP/depth, solver, refine loop) is in `WORKFLOW.md`.

---

## 2. Decisions

| Decision | Detail |
|---|---|
| The viewport shows the CAD solid | The CadQuery solid, tessellated and rendered in Three.js, is what is displayed and exported. The JS recipe renderer is only an instant "approximate preview" and the fail-open fallback. |
| CAD contract order | 1) legacy `/cad/generate` for all styles. 2) `/cad/generate-advanced` for non-gear solver-derived parts. 3) `/cad/from-reconstruction` once solver output exists. |
| Job model | Interim: `POST /api/cad/build` blocks but returns a job-shaped result. Target (per WORKFLOW): `POST /api/jobs` plus polling with `needs_input`. Decide when to switch after measuring build time. |
| Scale policy | The solid is always shown. STEP/STL export requires an anchor dimension. Other dimensions may be estimated but are always labeled. |
| Assumptions allowed, never hidden | Labels: `user`, `measured`, `estimated`. |
| No custom vision model for now | The bottleneck is scale, not recognition. Revisit after an evaluation set shows a specific failure. |
| Fail-open stays | If vision or python-engine is down, the Gemini-only preview still works. |
| Python is the CAD authority | CAD recipe validation, volume, STEP/STL export and (optionally) drawings live in python-engine. |
| Service split | Today `python-engine/app.py` (port 8766) hosts both reconstruction and CAD endpoints, and `vision-engine` (port 8765) is separate. WORKFLOW wants reconstruction and CAD as separate services. Keep URLs configurable, and split when COLMAP is added. |

---

## 3. Verified current state

| Link | Status |
|---|---|
| Frontend -> Backend | Connected. Vite proxies `/api` to `localhost:8787`. |
| Backend -> vision-engine | Connected via `vision-adapter.js`, off by default. Evidence reaches Gemini only as prompt text. `calibration` is forwarded, but contours and circles are reduced to counts. |
| Backend -> python-engine `/reconstruct` | Adapter and `/api/reconstruct` route exist, off by default. The adapter hardcodes `/reconstruct`. |
| Frontend -> `/api/reconstruct` | Not called anywhere in `frontend/src`. |
| Anything -> `/cad/generate`, `/cad/generate-advanced`, `/cad/from-reconstruction` | Not called by backend or frontend. Only tests, a demo script and docs reference them. |
| Frontend 3D model and exports | Built in JS from Gemini's recipe (`recipe.js` `executeRecipe`, `reconstruct.js` `buildModel`, `exporters.js`). |
| Process orchestration | None. No launcher, and the README does not cover python-engine setup. |

Verified in this review:

- Gemini's recipe and `python-engine/recipe_validator.py` agree on styles, primitive kinds, limits and primitive size keys (the validator header says it mirrors `backend/gemini.js`). `holes` was not individually compared.
- `advanced_recipe_adapter.py` converts revolved, extruded and combination only. `gear` raises "no feature-recipe conversion".
- `CadSpec` already tracks provenance with four sources: user dims, solver result, recipe, default.
- `/cad/generate` takes `user_dimensions` and, by default, returns `step_path`, `stl_path`, `cad_spec`, `feature_tree` and `validation_report`.
- The Python validator accepts negative outline and profile coordinates, so the Node clamp bug destroys valid input before it arrives.

Known defects:

- `backend/gemini.js` `sanitizeRecipe` clamps with `Math.max(0, ...)`. A plate outline `(-50,-30)..(50,30)` becomes `(0,0)..(50,30)`, and a revolved profile `z: -20..20` becomes `0..20` (reproduced by running it).
- `python-engine/cad/recipe_validator.py` is an empty file. The real one is `python-engine/recipe_validator.py`.
- `python-engine/cad/cad_validator.py` shells out to `backend/geometry-volume.js` through `node -e`.
- Both adapters read env flags once at import.
- SAM2 automatic mode is too slow and picks the background on CPU (per `VISION_ENGINE_COMPLETION_REPORT.md`). Depth and OpenCV work.
- Frontend `exporters.js` produces several formats as hand-written templates. For example STEP is a text template from outer diameter, inner diameter and height, `.x_b` is JSON with a fake header, `exportDWG` returns DXF, and `exportGLB` returns GLTF.
- No image-fit check (projected silhouette vs SAM mask) exists yet. The refine loop in WORKFLOW 4.6 needs one.

Note: line numbers cited by other reviewers differ slightly from GitHub master (e.g. `buildModel` is at `reconstruct.js:255` on master), so the local copy has changes that are not pushed. Push or share it so reviews use the same code.

---

## 4. Target architecture

```
Browser (React + Three.js)
  | 1. POST /api/analyze-component   { images, reference }
  v
Node backend :8787
  |- vision-engine :8765  (optional, fail-open)  -> evidence incl. raw OpenCV observations + calibration
  |- Gemini                                      -> analysis + geometryRecipe
  |- assumptions step                            -> fill gaps, snap to standard sizes, label provenance
  '- returns { analysis (with dimension provenance), visionDiagnostics }
  |
  | 2. Frontend renders the approximate JS preview immediately
  | 3. POST /api/cad/build            { recipe, dimensions }
  v
Node cad-adapter -> python-engine :8766
  route: all styles -> /cad/generate (legacy)   [later: non-gear -> /cad/generate-advanced]
  CadQuery solid -> validate -> STEP + STL + mesh/edge data
  |
  v
Node stores files under random IDs (with expiry), checks the anchor rule
  returns a job-shaped result (see 5.2)
  |
  | 4. Frontend loads mesh + edges into ReconstructedViewport, replaces the preview, shows badges
  v
Edit a dimension -> POST /api/cad/build again (that dimension becomes "user")
```

Analysis and CAD build are separate calls on purpose: analysis stays fast, a CAD failure degrades to the preview, and the five existing `analyzeComponent` call sites do not change.

---

## 5. Data contracts

### 5.1 Dimension object (indicative)

```json
{
  "key": "outerDiameter",
  "value": 62.0,
  "unit": "mm",
  "source": "user | measured | estimated",
  "confidence": 0.0,
  "anchor": true,
  "note": "snapped to standard size"
}
```

Mapping from Python provenance: `user_dims` -> `user`, `solver_result` -> `measured`, `recipe` and `default` -> `estimated`. A calibrated pixel-to-mm value (from vision calibration) counts as `measured`. Align final field names with `docs/CAD_INTEGRATION_CONTRACT.md` and `python-engine/cad/integration_contract.py` (value, unit, provenance) rather than creating a parallel format.

### 5.2 `POST /api/cad/build` (job-shaped)

Request: `{ recipe, dimensions[] }`. The client never supplies file paths, `output_dir` or `job_id`.

Response, shaped like WORKFLOW's job object so polling can replace it later:

```json
{
  "jobId": "<server-generated random id>",
  "state": "done | generating_cad | needs_input | failed | unavailable",
  "status": "done",
  "progress": 1.0,
  "warnings": [],
  "needsInput": null,
  "result": {
    "meshUrl": "/api/cad/files/<id>.mesh.json",
    "stepUrl": "/api/cad/files/<id>.step",
    "stlUrl": "/api/cad/files/<id>.stl",
    "exportBlocked": false,
    "exportBlockedReason": null,
    "validationReport": {},
    "featureTree": [],
    "dimensions": [],
    "hasEstimates": true,
    "confidence": 0.0
  },
  "error": null
}
```

When CAD is disabled or unreachable: `state: "unavailable"` with HTTP 200, and the frontend keeps the preview.

### 5.3 `GET /api/cad/files/:id.:ext`

Only server-issued IDs, a strict ID pattern, an extension whitelist, and a path looked up in a server-side map (never built from user input). STEP and STL requests are refused when the job's anchor check failed. The server enforces this, not the client.

### 5.4 Anchor rule

A job may issue STEP/STL downloads only if at least one dimension is an anchor: `user`-typed, or `measured` from a calibrated source (calibration with adequate confidence, or a solver result classified as metric). Gemini estimates never count. The viewer mesh is always produced. Without an anchor the UI shows "Relative preview. Enter one measurement to enable export." If any dimension is `estimated`, exports carry a note saying so (file metadata where the format allows, plus the UI).

---

## 6. Phases

### Phase 0: Correctness and safety fixes (do first)

| Task | File |
|---|---|
| Make the ratio clamp preserve sign, e.g. `Math.sign(v) * Math.min(Math.abs(v), cap)`. Add a regression test with centered outlines and negative `z` | `backend/gemini.js`, new test |
| Run the same recipe through Node sanitize and Python validate in a test | tests |
| Check whether `frontend/src/lib/recipe.js` `sanitizeRecipe` has the same clamp issue | `frontend/src/lib/recipe.js` |
| After parsing Gemini output, overwrite matching values with the user's reference dimensions in code (label `user`) | `backend/index.js` or `backend/assumptions.js` |
| Only retry with the schema on JSON parse errors, not 429 or network errors | `backend/gemini.js` |
| Remove `BLOCK_NONE` safety overrides unless needed | `backend/gemini.js` |
| Use Gemini `systemInstruction` for chat, cap `message` and `history` length | `backend/gemini.js`, `backend/index.js` |
| Restrict CORS origins, add rate limiting, justify or lower the 20 MB body limit | `backend/index.js` |
| Validate and whitelist the `/api/reconstruct` body (currently raw `req.body`), stop returning raw `error.message` | `backend/index.js` |
| Read env flags per call, not at import | both adapters |

### Phase 1: Provenance, assumptions and the anchor

1. Add `backend/assumptions.js`, run after Gemini output is normalized.
2. Per dimension: user value -> `user`; calibrated or solver value -> `measured`; Gemini value -> `estimated`; otherwise a default -> `estimated`; leave null when no reasonable assumption exists.
3. Snap estimates to standard sizes where the part class allows it: ISO module series for gears, standard bearing bores and outer diameters, common bolt hole sizes, standard flange PCDs.
4. Prefer proportions over absolute size: fix scale from one anchor, derive the rest from Gemini's ratios.
5. Compute `hasEstimates`, an overall confidence, and whether an anchor exists.

### Phase 2: Backend CAD build (legacy route)

1. Add `backend/cad-adapter.js` with its own `CAD_ENABLED`, `CAD_SERVICE_URL` (default `http://127.0.0.1:8766`) and `CAD_TIMEOUT_SECONDS`, fail-open like the other adapters. Do not reuse the 60-second reconstruction timeout.
2. Put route choice in one function (`chooseCadRoute(recipe)`) that returns legacy `/cad/generate` for every style at first.
3. Map the user's reference and anchor dimensions into the request's `user_dimensions`. No schema translation is needed.
4. Add `POST /api/cad/build` (5.2): validate input, generate the job ID server-side, call the adapter, record returned files in a server-side map, apply the anchor rule.
5. Add `GET /api/cad/files/:id.:ext` (5.3) and export expiry/cleanup.
6. Python: write only to a fixed export directory and ignore client `output_dir`. Add mesh output for the viewer (triangles plus edge polylines, e.g. JSON) next to STL and STEP. Remove the `node -e` volume cross-check.
7. Measure real build time for a spur gear, a shaft and a bracket. Record it here. This decides when to build the job layer.

### Phase 3: Frontend CAD viewport

1. Keep the JS recipe model as an instant preview labeled "Approximate preview".
2. Add `buildCad()` to `frontend/src/lib/api.js`. Leave `analyzeComponent` and its five call sites (`main.jsx` 1109, 1113, 2839, 2845, 2853) unchanged. Scope the first version to the primary part. Companion and assembly parts come later.
3. Do the loading in `ReconstructedViewport` (`main.jsx:117`), which also feeds the PiP/multi-viewport components, not only `Workbench`. Show building, ready, failed and unavailable states. On failure keep the preview.
4. Add `frontend/src/lib/cad-mesh.js` to turn mesh JSON into a `THREE.Mesh` plus `LineSegments` for feature edges. If STL is used instead, `STLLoader` ships inside `three/examples/jsm/loaders/` (no dependency change). Call `computeVertexNormals()` for smooth shading.
5. Coordinate frame: CadQuery is Z-up in millimeters, Three.js is Y-up. Rotate, center on the bounding box, and normalize to the existing 6-unit scale used by `executeRecipe`, while keeping the millimeter scale factor so dimension overlays and measurements show real mm values.
6. Dimension overlays come from the solid (bounding box, bores, hole positions), not from Gemini's numbers.
7. Provenance badges per dimension, a notice when any dimension is `estimated`, and the anchor prompt when export is blocked. Disable export buttons until the server reports `exportBlocked: false`.
8. Editable dimensions: a change triggers a rebuild and marks the dimension `user`. Use a debounce only if Phase 2 measurements show fast builds, otherwise use a "Rebuild" button.
9. Move new viewer code out of `main.jsx` (about 2,900 lines).

### Phase 4: Remove redundancy

| Remove or consolidate | Action |
|---|---|
| Fake/template exports in `frontend/src/lib/exporters.js` (STEP, Parasolid, ACIS, JT, FBX, USDZ, DWG-as-DXF, GLB-as-GLTF) | Delete. Offer STEP and STL from python-engine. Offer OBJ and GLTF/GLB from Three's own exporters applied to the actual mesh. Offer only formats that can genuinely be produced. |
| Three recipe sanitizers (`backend/gemini.js`, `frontend/src/lib/recipe.js`, `python-engine/recipe_validator.py`) | Python is the CAD authority. Keep a minimal structural check in Node. The frontend trusts the server-cleaned recipe. |
| Empty `python-engine/cad/recipe_validator.py` | Delete. |
| Legacy vs advanced CAD routes | Keep both: legacy for gears and everything at first, advanced for non-gear solver-derived parts later. Do not remove legacy. |
| Volume estimator in both JS and Python | Keep one. |
| Two engineering-drawing implementations (`frontend/src/lib/drawing/`, `python-engine/cad/engineering_drawing.py`) | Pick one after comparing output quality. Not yet compared. |
| Older hardcoded part builders in `reconstruct.js` | Candidates for removal if the recipe engine covers those part types. Verify first. |
| `.claude/`, `.codex/`, `.opencode/` skill folders (about 2.8 MB each), tracked zips, `__pycache__`, stray images in `docs/` | Remove from git and add to `.gitignore`. Consider moving personal application documents out of a public repo. |

### Phase 5: Better evidence, solver and the advanced route

1. Forward raw OpenCV observations (circles, contours) from `vision-adapter.js` instead of only counts, so the solver can receive `opencv_observations`.
2. Improve calibration: `_estimate_calibration` only calibrates with a user outer diameter and exactly one circle above 0.8 confidence, so it rarely fires on parts with bolt holes. Select circles better (e.g. largest concentric circle, or use the SAM2 mask). Optionally support an ArUco marker or coin (check the OpenCV build includes aruco first).
3. SAM2: do not use automatic full-grid mode on CPU. Use a prompted point or skip segmentation when it would exceed the timeout. Keep fail-open.
4. Route non-gear revolved, extruded and combination recipes to `/cad/generate-advanced` once legacy is working. Gears stay on legacy.
5. Multi-photo: call `/reconstruct` (COLMAP + SciPy) for 2+ overlapping photos, feed solved dimensions in as `measured`, and hand the result to `/cad/from-reconstruction`. Handle COLMAP not being installed.
6. Add the image-fit check (projected silhouette vs SAM mask) and the capped refine loop (3 to 5 iterations, then `needs_input` or `failed` with a reason).

### Phase 6: Jobs, orchestration, tests, measurement

1. Real job layer: `POST /api/jobs` and `GET /api/jobs/:id` returning the object in 5.2, with WORKFLOW's states and `needs_input` resume. Switch the frontend from the blocking call to polling.
2. PowerShell dev script (per WORKFLOW) starting all services with health checks, and extend `/api/health` to report which services are reachable. Split the reconstruction service from the CAD service when COLMAP lands; all Python services use the shared root `.venv` unless a concrete dependency conflict requires otherwise.
3. Rewrite the README: features, python-engine setup, the multi-process layout, env vars.
4. Contract tests for recipe -> `/api/cad/build` -> python-engine and the fail-open paths.
5. Evaluation set of 50 to 100 real parts with caliper-measured dimensions and a per-dimension error report.
6. Log analyses (photos, Gemini output, user corrections, accepted dimensions) for a future dataset, only with explicit consent and a retention policy.

### Mapping to WORKFLOW.md build order

| WORKFLOW step | This plan |
|---|---|
| 1. Job layer | Interim blocking job-shaped build in Phase 2, real polling in Phase 6 |
| 2. Vision on a single image | Exists. Phase 5 forwards raw observations and fixes SAM2/calibration |
| 3. Single-view CAD for simple parts, STEP/STL | Phases 2 and 3 (legacy route) |
| 4. Solver and fit loop | Phase 5 |
| 5. COLMAP | Phase 5, service split in Phase 6 |
| 6. Scale enforcement, report, estimates | Anchor rule in Phase 1, 2 and 3 |
| 7. Dev script | Phase 6 |

---

## 7. Security checklist

- File download by server-issued random ID only, extension whitelist, no user-built paths, anchor check enforced server-side.
- No client-controlled `output_dir`, `job_id` or `image_paths` reaching python-engine.
- python-engine bound to `127.0.0.1` and never exposed directly.
- Rate limiting and origin restriction on the Node API, with size caps on chat and image payloads.
- Generic error messages to clients, details in server logs.
- Pass recipe data to subprocesses through stdin or files, not by splicing into code strings.
- Export cleanup so files do not accumulate.

---

## 8. File change summary

| File | Action |
|---|---|
| `backend/gemini.js` | Fix clamp, retry logic, safety settings, chat system instruction |
| `backend/index.js` | Reference enforcement, validate `/api/reconstruct`, add `/api/cad/build` and `/api/cad/files/:id.:ext`, CORS and rate limits |
| `backend/assumptions.js` | New: provenance labels, standard-size snapping, anchor detection |
| `backend/cad-adapter.js` | New: route choice, `CAD_ENABLED`, `CAD_SERVICE_URL`, `CAD_TIMEOUT_SECONDS`, per-call env reads |
| `backend/vision-adapter.js`, `backend/reconstruction-adapter.js` | Per-call env reads, forward raw observations, https support |
| `python-engine/app.py` | Fixed export directory, ignore client `output_dir`, mesh/edge output |
| `python-engine/cad/cad_validator.py` | Remove Node subprocess |
| `python-engine/cad/recipe_validator.py` | Delete (empty) |
| `vision-engine/vision/pipeline.py` | Improve calibration, SAM2 prompting |
| `frontend/src/main.jsx` | `ReconstructedViewport`: build states, provenance UI, anchor prompt, editable dimensions |
| `frontend/src/lib/cad-mesh.js` | New: mesh and edge rendering, normalization |
| `frontend/src/lib/api.js` | Add `buildCad()` |
| `frontend/src/lib/exporters.js` | Remove fake formats, wire real ones |
| `WORKFLOW.md` | Amend decisions (delivered copy) |
| dev script, `README.md` | New / rewrite |

---

## 9. Acceptance criteria

| Criterion | How to verify |
|---|---|
| Upload one photo and see an approximate preview quickly | The preview appears before CAD finishes |
| CAD solid replaces the preview | `/api/cad/build` returns `state: done` and the viewport shows the mesh with feature edges |
| A spur gear builds | Gear recipes go through legacy `/cad/generate` and produce a valid solid |
| Displayed model matches exports | STEP and STL downloaded from the app load in a CAD viewer with the same bounding box as the viewport |
| Mesh scale is correct | The viewport shows real millimeter values on dimension overlays even though the mesh is normalized for display |
| User dimensions are exact | A typed dimension appears in the solid within CAD tolerance, labeled `user` |
| Negative-coordinate recipes survive | Regression test: a centered plate and a `z: -20..20` profile are unchanged by sanitizing |
| Anchor rule is enforced server-side | With no anchor, the viewer works but STEP/STL URLs are withheld and direct download requests fail |
| Estimates are visible | Any `estimated` dimension shows a badge, and exports carry a note |
| Editing rebuilds | Changing a dimension regenerates the solid and flips its label to `user` |
| Fail-open | With python-engine stopped, upload still shows the preview and a clear "CAD unavailable" state. With vision stopped, analysis still works |
| Safe file serving | Requests with `../`, unknown IDs or non-whitelisted extensions return 404 |
| No fake formats | Every offered export opens correctly in a standard tool |
| Measured build time | Recorded for gear, shaft and bracket, and used to decide on the job layer |
| Measured accuracy | Evaluation set report exists with per-dimension error |

---

## 10. Running locally (target)

```bash
# From repository root: shared Python 3.13 environment
uv venv .venv --python 3.13
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
uv pip install --python .venv/Scripts/python.exe torch torchvision --index-url https://download.pytorch.org/whl/cu128
$env:SAM2_BUILD_CUDA = "0"
uv pip install --python .venv/Scripts/python.exe -r vision-engine/requirements-vision-ml.txt

# python-engine (port 8766, loopback only)
Push-Location python-engine
..\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8766

# vision-engine (port 8765, optional)
Push-Location ..\vision-engine
..\.venv\Scripts\python.exe .\scripts\install_depth_anything_v2.py
..\.venv\Scripts\python.exe .\scripts\download_models.py
..\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765

# backend (port 8787)
cd backend
npm install
# .env.local: GEMINI_API_KEY, CAD_ENABLED=true, CAD_SERVICE_URL, VISION_PIPELINE_ENABLED=true (optional)
npm run server

# frontend (port 5173)
cd frontend
npm install
npm run dev
```

Phase 6 replaces this with the PowerShell dev script and health checks.

---

## 11. Non-goals

- Do not replace the React + Three.js frontend.
- Do not replace Gemini, and do not train custom models yet.
- Do not add single-image-to-3D generators (TripoSR, TRELLIS, Hunyuan3D). They produce plausible meshes, not dimensionally accurate parametric CAD.
- Do not call Gemini from the frontend.
- Do not break fail-open behavior or run the refine loop unbounded.
- Do not hide assumptions: estimated values must be labeled.

---

## 12. Risks, open questions and unverified items

**Not yet verified**

- CadQuery and the Python service have not been run in this review, so the CAD output path is unproven end to end. Build time, mesh/edge export and STEP/STL validity all need a local run.
- Whether the validator's `holes` handling matches Gemini's recipe (styles, primitives and limits were confirmed).
- Whether `frontend/src/lib/recipe.js` has the same clamp bug.
- `main.jsx`, `reconstruct.js` and `geometry_solver.py` were not read line by line.
- JS vs Python engineering-drawing quality has not been compared.
- Your local working copy differs from GitHub master and was not reviewed.

**Risks**

- Rebuild latency may be too slow for live editing, which would need a "Rebuild" button.
- CadQuery (OpenCASCADE) installation can be difficult on some Windows and Python versions.
- A single anchor dimension does not make every other dimension accurate. The labels and export note must stay visible so estimates are not mistaken for measurements.
- Storing customer photos for evaluation or training needs consent and a retention policy.

**Open questions**

- How should "image fit acceptable" be measured (silhouette overlap threshold against the SAM mask)?
- Should the reconstruction and CAD services be split now or when COLMAP lands (this plan says when COLMAP lands)?
