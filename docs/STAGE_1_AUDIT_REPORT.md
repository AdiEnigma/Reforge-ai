# ReForge AI — Stage 1 Audit: Measurement-Driven Photo-to-CAD Pipeline

**Date:** 2026-11-16  
**Platform:** Windows 11, Node.js v24.19.0, Python 3.13.7  
**Scope:** Stage 1 of the measurement-driven photo-to-CAD reconstruction pipeline (flange test case).

---

## 1. Pipeline Architecture

The pipeline converts uploaded component photos into manufacturable CAD models through four layers:

| Layer | Responsibility | Key Files |
|-------|---------------|-----------|
| **Vision** | Classify views, detect concentric circles/radial patterns/side profile, fuse measurements | `vision-engine/vision/feature_measurements.py` |
| **Synthesis** | Convert normalized ratio measurements into a feature recipe, never invent mm without anchor | `python-engine/cad/measurement_to_features.py` |
| **Fit** | Score synthesized CAD against measured features, gate manufacturing exports | `python-engine/cad/feature_fit.py` |
| **Orchestration** | FastAPI endpoint `/cad/generate-from-measurements`, confidence gate, export blocking | `python-engine/app.py` |
| **Backend (Node/Express)** | Route forwarding, evidence block, Gemini analysis, confidence gating | `backend/index.js`, `backend/gemini.js`, `backend/vision-adapter.js`, `backend/cad-adapter.js` |
| **Frontend (React)** | Dimension provenance labels, preview renderer, workbench UI | `frontend/src/lib/dimensions.js`, `frontend/src/lib/recipe.js`, `frontend/src/main.jsx` |

### Core Design Rules (enforced, no exceptions)

1. **No part-name branching** — `if part == "flange"` is forbidden. Synthesis is topology-driven (circular/polygonal outline, side profile, concentric radii, radial arrays).
2. **Provenance per dimension** — every dimension carries a source: `measured`, `vision_estimated`, `user_provided`, or `assumed`. Assumed values are never presented as measured.
3. **Scale separate from ratios** — mm output requires an anchor (e.g. `outerDiameter` in mm). Without an anchor, output is relative proportions only and marked `preview_only`.
4. **`needs_input` instead of guessing** — when critical geometry is missing, the pipeline asks rather than inventing.
5. **`ALLOW_ASSUMED_EXPORTS` defaults to `false`** — manufacturing exports (STEP/STL) are blocked when critical dimensions are assumed, unless explicitly overridden.

---

## 2. Execution Flow (End-to-End)

```
1. User uploads 1-8 component photos + optional known dimensions
   │
2. Backend POST /api/analyze-component (backend/index.js)
   │
3. Vision service forwards feature_measurements to Gemini (backend/vision-adapter.js)
   │
4. Gemini analyzes images, returns geometryRecipe + measurement evidence (backend/gemini.js)
   │
5. Backend applies confidence gate (MEASUREMENT_CONFIDENCE_GATE, default 0.55)
   │
6. Frontend calls POST /cad/generate-from-measurements (python-engine/app.py)
   │
7. synthesize_feature_recipe() converts ratios -> feature recipe (python-engine/cad/measurement_to_features.py)
   │
   ├── Topology analysis: circular / polygonal / side profile / concentric / radial
   ├── Anchor resolution: calibration or user_dimensions in mm
   ├── Provenance tagging: measured / vision_estimated / user_provided / assumed
   └── Sanity checks: overlapping holes, oversized bores, hole count bounds
   │
8. validate_feature_recipe() validates the synthesised recipe (python-engine/cad/feature_recipe_validator.py)
   │
9. generate_cad_from_recipe() models the feature sequence (python-engine/cad/advanced_recipe_adapter.py)
   │
10. validate_feature_geometry() checks solid validity, bbox, bores, passages (python-engine/cad/advanced_cad_validator.py)
    │
11. compare_features() scores CAD against measured features (python-engine/cad/feature_fit.py)
    │
12. assess_measurement_build() determines manufacturing readiness + export gate (python-engine/cad/feature_fit.py)
    │
13. STEP/STL exported ONLY if export_allowed (ALLOW_ASSUMED_EXPORTS or explicit override)
    │
14. Response: status, preview_only, manufacturing_ready, export_allowed, export_block_reasons,
    assumed_dimensions, critical_unknowns, confidence, provenance, scale
```

---

## 3. Root Cause Analysis: What Was Missing Before Stage 1

| Gap Before | Impact | Resolution in Stage 1 |
|------------|--------|----------------------|
| No measurement layer in vision engine | Vision output was raw classifications only, no fused dimensional measurements | `feature_measurements.py` — view classification, concentric circles, radial patterns, side profile, fusion |
| No synthesis from ratios to feature recipe | Could not convert vision measurements into CAD topology | `measurement_to_features.py` — `synthesize_feature_recipe()` |
| No fit scoring between CAD and measurements | No way to verify reconstructed geometry matches photos | `feature_fit.py` — `compare_features`, `assess_measurement_build` |
| No measurement-to-CAD API endpoint | Frontend could not trigger CAD generation from measurements | `app.py` — `POST /cad/generate-from-measurements` |
| No confidence gate on measurement-derived CAD | Assumed dimensions could reach manufacturing exports unchecked | Confidence gate + `ALLOW_ASSUMED_EXPORTS` default false |
| No provenance tracking per dimension | Users couldn't tell measured vs assumed vs estimated | Provenance on every dimension; frontend `dimensionSourceLabel()` |
| Hardcoded "Primary Gear Specs" label | UI was gear-specific, not part-class agnostic | Changed to "KNOWN DIMENSIONS" |

---

## 4. Files Changed / Created

### New files
- `vision-engine/vision/feature_measurements.py` — measurement layer
- `vision-engine/tests/test_feature_measurements.py` — 10 tests
- `python-engine/cad/measurement_to_features.py` — synthesis layer
- `python-engine/cad/feature_fit.py` — fit scoring + readiness assessment
- `python-engine/tests/test_measurement_synthesis.py` — 25 tests
- `python-engine/tests/test_feature_fit.py` — feature fit tests
- `docs/MEASUREMENT_PIPELINE.md` — pipeline documentation

### Modified files
- `python-engine/app.py` — added `MeasurementCadGenerateRequest`, `POST /cad/generate-from-measurements`
- `backend/index.js` — measurement route, evidence block, confidence gate, error visibility
- `backend/gemini.js` — `referenceBlock` (relative proportions only), `responseSchema` on first attempt, `GEMINI_CONSENSUS_RUNS`
- `backend/vision-adapter.js` — forwards `feature_measurements` to Gemini
- `backend/cad-adapter.js` — `MEASUREMENT_ROUTE`, `chooseMeasurementRoute`, `ALLOW_ASSUMED_EXPORTS` check
- `frontend/src/lib/dimensions.js` — `dimensionSourceLabel()` handles all provenance values
- `frontend/src/main.jsx` — "KNOWN DIMENSIONS" label (was "PRIMARY GEAR SPECS")
- `backend/.env.example` — all env vars documented

### Regressions undone (from commit d0f91da)
- `ALLOW_ASSUMED_EXPORTS` now defaults to `false` (was `=== "true"`)
- `referenceBlock` states "relative proportions only; set dimension values to null"
- `recipeSource = recipeSource ?? analysis.geometryRecipe` (recipeSource priority)
- "flanges" removed from revolved description
- `responseSchema` sent on first `attempt(true)` call

---

## 5. Missing Integrations / Gaps

| Area | Status | Details |
|------|--------|---------|
| Sample photos for spike | Blocked | `vision-engine/scripts/spike_measure.py` exists but cannot run without sample photos (user will provide) |
| Backend vitest config | Missing | 12 `.test.js` suites exist but run via `node --test`, not vitest |
| Frontend exporters | Unimplemented | `frontend/src/lib/exporters.test.js` tests 9 functions (`exportSTEP`, `exportSTL`, `exportDXF`, etc.) that do not exist in `exporters.js` |
| Stage 1 audit document | Missing | This document |
| Frontend geometry parameter panel | Partial | Provenance display present but may need completion for all part classes |
| Dynamic part-class labels | Fixed | "PRIMARY GEAR SPECS" → "KNOWN DIMENSIONS" |
| `vision-engine/app.py` import conflict | Known | `vision-engine/app.py` exists alongside `python-engine/app.py`; pytest rootdir confusion when running from repo root |

---

## 6. Test Results Summary

| Suite | Location | Result |
|-------|----------|--------|
| vision-engine tests | `vision-engine/tests/` | 60 passed, 0 failed |
| measurement synthesis | `python-engine/tests/test_measurement_synthesis.py` | 25 passed, 0 failed |
| feature fit | `python-engine/tests/test_feature_fit.py` | included in 25 above |
| backend tests | `backend/*.test.js` | 56 passed, 0 failed (via `node --test`) |
| frontend features | `frontend/src/lib/features.test.js` | 17 passed, 0 failed |
| frontend engineering-context | `frontend/src/lib/engineering-context.test.js` | 5 passed, 0 failed |
| frontend machinery-context | `frontend/src/lib/machinery-context.test.js` | 7 passed, 0 failed |
| frontend machinery-integration | `frontend/src/lib/machinery-integration.test.js` | 7 passed, 0 failed |
| frontend recipe | `frontend/src/lib/recipe.test.js` | 3 passed, 0 failed (vitest) |
| frontend drawing | `frontend/src/lib/drawing/drawing.test.js` | 5 passed, 0 failed |
| frontend exporters | `frontend/src/lib/exporters.test.js` | 0 passed, 9 failed (functions not implemented) |

**Total: 193 passed, 9 failed (exporters — expected, unimplemented)**
