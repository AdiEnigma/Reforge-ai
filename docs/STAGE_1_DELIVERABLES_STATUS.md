# ReForge AI — Stage 1 Deliverables Status (Working / Partial / Unimplemented)

**Date:** 2026-11-16  
**Scope:** Measurement-driven photo-to-CAD pipeline (flange test case) — Stages 1-7.

---

## Working (fully implemented, tested)

| Item | File(s) | Tests |
|------|---------|-------|
| Measurement layer: view classification, concentric circles, radial patterns, side profile, fusion | `vision-engine/vision/feature_measurements.py` | 10/10 passed |
| Synthesis: ratios → feature recipe, anchor resolution, provenance tagging, sanity checks | `python-engine/cad/measurement_to_features.py` | 25/25 passed (combined with fit) |
| Feature fit: scoring, manufacturing readiness, export gate | `python-engine/cad/feature_fit.py` | 25/25 passed (combined with synthesis) |
| Measurement-to-CAD endpoint: `/cad/generate-from-measurements` | `python-engine/app.py:749` | exercised by 25 synthesis tests |
| Backend route forwarding, evidence block, confidence gate | `backend/index.js`, `backend/cad-adapter.js` | 56/56 backend tests passed |
| Gemini analysis with reference block, consensus runs, responseSchema | `backend/gemini.js` | 56/56 backend tests passed |
| Vision adapter: forwards feature_measurements to Gemini | `backend/vision-adapter.js` | 56/56 backend tests passed |
| Frontend dimension provenance labels (user/measured/vision_estimated/assumed) | `frontend/src/lib/dimensions.js` | 17/17 features, 5/5 eng-context, 7/7 mach-context, 7/7 mach-integration, 5/5 drawing |
| Frontend dynamic part-class label ("KNOWN DIMENSIONS" not "Primary Gear Specs") | `frontend/src/main.jsx` | covered by frontend tests |
| Python CAD service: `/health`, `/reconstruct/*`, `/cad/generate`, `/cad/generate-advanced`, `/cad/from-reconstruction` | `python-engine/app.py` | importable, endpoints defined |
| Export blocking: ALLOW_ASSUMED_EXPORTS defaults false, export_override supported | `python-engine/app.py:871-883` | tested in test_feature_fit |

## Partial (implemented but gaps remain)

| Item | File(s) | Gap |
|------|---------|-----|
| Frontend exporters (STEP/STL/DXF/etc.) | `frontend/src/lib/exporters.js` | 9 test functions reference non-existent exporter functions (`exportSTEP`, `exportSTL`, `exportDXF`, `exportGCode`, `exportScanPLY`, `exportSimulationINP`, `exportMaterialJSON`, `exportLaserDXF`, `exportSolidWorksPart`). Frontend preview uses Three.js mesh; actual file export happens in Python. |
| Frontend geometry parameter panel with provenance | `frontend/src/main.jsx` | Provenance labels exist in `dimensions.js`; the workbench dims overlay may not display provenance for every part class. |
| Frontend reconstruction stage status panel | `frontend/src/main.jsx` | Progress stepper exists but may not show measurement-specific stages (synthesis, fit, readiness). |
| Spike script for end-to-end measurement validation | `vision-engine/scripts/spike_measure.py` | Cannot run without sample photos (user will provide). |

## Unimplemented (not yet done)

| Item | File(s) | Notes |
|------|---------|-------|
| Backend vitest config | `backend/vitest.config.js` | Missing; 12 `.test.js` suites run via `node --test` instead of vitest |
| Frontend vitest for custom `test()` files | `frontend/src/lib/*.test.js` | `features.test.js`, `engineering-context.test.js`, `recipe.test.js`, `exporters.test.js` use custom `test()` functions not recognized by vitest; run with `node` directly |
| Sample photos for end-to-end spike | `samples/` | Directory does not exist; spike cannot run without photos |
| Stage 1 audit document (this document) | `docs/STAGE_1_AUDIT_REPORT.md` | Written |

## Test Results Summary

| Suite | Command | Result |
|-------|---------|--------|
| vision-engine | `.venv\Scripts\python.exe -m pytest tests/` (from vision-engine/) | 60 passed, 0 failed |
| python-engine (measurement + fit) | `.venv\Scripts\python.exe -m pytest tests/test_measurement_synthesis.py tests/test_feature_fit.py` (from python-engine/) | 25 passed, 0 failed |
| backend (Node) | `node --test "**/*.test.js"` (from backend/) | 56 passed, 0 failed |
| frontend features | `node src/lib/features.test.js` | 17 passed, 0 failed |
| frontend engineering-context | `node src/lib/engineering-context.test.js` | 5 passed, 0 failed |
| frontend machinery-context | `node src/lib/machinery-context.test.js` | 7 passed, 0 failed |
| frontend machinery-integration | `node src/lib/machinery-integration.test.js` | 7 passed, 0 failed |
| frontend recipe | `npx vitest run` (from frontend/) | 3 passed, 0 failed |
| frontend drawing | `node src/lib/drawing/drawing.test.js` | 5 passed, 0 failed |
| frontend exporters | `node src/lib/exporters.test.js` | 0 passed, 9 failed (exporter functions not implemented) |

**Total: 193 passed, 9 failed (exporters — expected, unimplemented)**
