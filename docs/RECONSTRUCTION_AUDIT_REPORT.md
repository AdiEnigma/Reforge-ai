# ReForge AI — Reconstruction Subsystem Phase 0 Audit Report

**Date:** 2026-11-12  
**Platform:** Windows 11, Node.js v24.19.0, Python 3.12.5  
**Scope:** Phase 0 Repository Audit for COLMAP Multi-View Reconstruction + SciPy Geometric Parameter Solver.

---

## 1. Current Image-to-CAD Data Flow

1. **User Upload:**
   - User uploads 1–8 images of mechanical components via React UI (`frontend/src/main.jsx`).
   - Optionally inputs known reference dimensions (`outerDiameter`, `innerDiameter`, `height`, `thickness`, `width`, `length`, `teeth`, `module`, `helixAngle`).

2. **Backend Processing (`backend/index.js`):**
   - Receives POST `/api/analyze-component`.
   - Checks `isVisionEnabled()`. If true, delegates to Python vision service (`http://127.0.0.1:8765/process`) via `backend/vision-adapter.js`.
   - Prepares prompt with reference constraints and vision evidence summary (`buildVisionEvidenceSummary`).
   - Calls Gemini API (`backend/gemini.js`) to generate component classification and `geometryRecipe`.
   - Returns `{ analysis, visionDiagnostics }`.

3. **Frontend Parametric Generation & Downstream:**
   - Frontend (`frontend/src/lib/recipe.js`, `frontend/src/lib/reconstruct.js`) sanitizes the recipe and constructs Three.js geometry (`LatheGeometry`, `ExtrudeGeometry`, parametric gear meshes).
   - Downstream export modules (`frontend/src/lib/exporters.js`) generate STEP, IGES, STL, OBJ, GLTF CAD formats.
   - Downstream manufacturing intelligence (`backend/manufacturing.js`, `backend/material-comparison.js`, `backend/engineering-analysis.js`) estimates costs, mass, cycle time, and material alternatives.

---

## 2. Existing Functionality Reusable for Reconstruction

- **`vision-engine/vision/opencv_features.py`:** Circle detection (HoughCircles), contour extraction, principal axes, aspect ratios, bounding boxes, and symmetry hints.
- **`vision-engine/vision/image_io.py`:** Base64 image decoding, format validation, and image normalization.
- **`backend/vision-adapter.js`:** Non-blocking, fail-open HTTP adapter pattern with timeout and structured logging.
- **Pre-installed Python libraries in runtime:**
  - `scipy` 1.14.1 (`scipy.optimize.least_squares`, `scipy.spatial.transform.Rotation`)
  - `numpy` 2.2.6
  - `opencv-python` 4.13.0.92
  - `pydantic` 2.10.4
  - `fastapi` 0.115.6
  - `pytest` 8.3.4

---

## 3. Actual Public Interfaces and Data Structures

### Component Dimensions:
`outerDiameter`, `innerDiameter`, `height`, `width`, `length`, `thickness`, `teeth`, `module`, `helixAngle` (all linear units in mm, angles in deg/rad, counts as integers).

### Parameter Classifications:
- `MEASURED`: Directly grounded in user measurements or calibrated observation.
- `ESTIMATED`: Inferred from geometric evidence/optimization.
- `UNKNOWN`: Insufficient evidence to determine (must be `null`, never `0`).

### Parameter Provenance:
`USER_PROVIDED`, `CALIBRATED_IMAGE`, `OPENCV_OBSERVATION`, `COLMAP_RECONSTRUCTION`, `DEPTH_PRIOR`, `GEMINI_PROPOSAL`, `GEOMETRIC_CONSTRAINT`.

### Scale Classifications:
`metric`, `relative`, `unknown`.

### Coordinate Frames:
`component_local`, `camera`, `relative_world`.

### Reconstruction Statuses:
`success`, `partial`, `failed`, `unavailable`.

---

## 4. Exact Files Proposed for Implementation / Modification

### Implementation Files (existing 0-byte placeholders in `python-engine/`):
1. **`python-engine/reconstruction/multiview.py`:**
   - Robust subprocess CLI wrapper for COLMAP.
   - Input validation (hashes, dimensions, blur detection, mask matching).
   - Metric scale alignment using physical references (rejecting uncalibrated mm/inch claims).
   - Structured diagnostic output (reprojection errors, registered cameras, point counts).
   - Graceful fallback when COLMAP is absent (`status: "unavailable"`).
2. **`python-engine/reconstruction/geometry_solver.py`:**
   - SciPy bounded least-squares optimization (`scipy.optimize.least_squares`).
   - Robust loss functions (`soft_l1`, `huber`).
   - Modular residual blocks (circles, cylinders, planes, axes, distance, concentricity, parallelism).
   - SVD Jacobian rank analysis and conditioning diagnostics for identifiability.
   - Provenance and classification assignment.
3. **`python-engine/app.py`:**
   - FastAPI entry point exposing `/reconstruct`, `/reconstruct/multiview`, `/reconstruct/solve`, and `/health`.

### Test Files:
1. **`python-engine/tests/test_multiview.py`:** Test scenarios MV-01 through MV-25.
2. **`python-engine/tests/test_geometry_solver.py`:** Test scenarios GS-01 through GS-22.
3. **`python-engine/tests/test_reconstruction_integration.py`:** Cross-module and application integration tests.

---

## 5. Dependency, Version, and Platform Risks

- **Operating System:** Windows 11.
- **COLMAP Binary:** Not installed by default in standard Windows PATH. Must detect absence cleanly and return `unavailable` without crashing. Mock subprocess calls in unit tests.
- **SciPy & NumPy:** Installed and verified (`scipy` 1.14.1, `numpy` 2.2.6).
- **Subprocess Execution:** Subprocess calls must use array arguments (e.g. `[colmap_path, "feature_extractor", ...]`), never `shell=True`, and support paths with spaces or non-ASCII characters.

---

## 6. API and Backward-Compatibility Risks

- Single-image jobs must continue to work without COLMAP.
- Legacy geometry recipes without reconstruction metadata must continue without modification.
- Existing Express routes and response structures must remain backward-compatible; reconstruction data is additive.
- Non-finite numbers (NaN, Inf) must be validated and rejected before serialization.

---

## 7. How the New Modules Will Be Reached from the Python Service

- `python-engine/app.py` provides REST endpoints for reconstruction jobs.
- Direct Python module imports (`from reconstruction.multiview import ...` and `from reconstruction.geometry_solver import ...`) allow programmatic invocation within test harnesses or standalone scripts without running a daemon.

