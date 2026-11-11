# ReForge AI — Final Optimized Reconstruction Engine

## Overview

The Reconstruction Engine is a locally executable geometric estimation and multi-view evidence subsystem for ReForge AI. It combines:
1. **Optional COLMAP Multi-View Reconstruction (`python-engine/reconstruction/multiview.py`)**:
   - Safely executes sparse Structure-from-Motion (SfM) via process-isolated subprocess argument arrays (never `shell=True`).
   - Validates input images (resolution, aspect ratio, blur, duplicates via SHA-256).
   - Manages per-job isolated workspaces, preserving user original photographs.
   - Extracts camera intrinsics, camera poses, 3D point cloud, and reprojection error statistics.
   - Handles missing COLMAP installations gracefully by reporting structured `unavailable` status without crashing the service or blocking single-image workflows.
   - Rigorously enforces scale semantics: applies metric scale when ground-truth physical references are provided; preserves relative coordinates and units otherwise.
2. **SciPy Geometric Parameter Solver (`python-engine/reconstruction/geometry_solver.py`)**:
   - Optimises geometric parameters using `scipy.optimize.least_squares` with robust loss functions (`soft_l1`, `huber`).
   - Enforces physical parameter bounds and handles diverse scales (e.g., millimeters vs. radians).
   - Preserves user-provided ground truth as fixed constraints (`MEASURED`).
   - Employs Singular Value Decomposition (SVD) on the Jacobian matrix to identify rank deficiency, condition numbers, and unobservable degrees of freedom.
   - Classifies every parameter canonically (`MEASURED`, `ESTIMATED`, `UNKNOWN`) with complete provenance tracking.
3. **Reconstruction Service API (`python-engine/app.py`)**:
   - Exposes REST endpoints (`/health`, `/reconstruct/multiview`, `/reconstruct/solve`, `/reconstruct`).
4. **Backend Client Adapter (`backend/reconstruction-adapter.js`)**:
   - Express integration with fail-open semantics, identical to the vision preprocessing adapter.

---

## Architecture & Data Flow

```
User Upload (1-8 Images & Optional Dimensions)
                     │
                     ▼
             Express Backend API
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  Vision Preprocessing     Reconstruction Engine
  (SAM2 / OpenCV / Depth)  (Optional COLMAP + SciPy)
         │                       │
         └───────────┬───────────┘
                     ▼
             Gemini AI Engine
         (Structured Geometry Recipe)
                     │
                     ▼
            Three.js Workbench &
        Downstream CAD / Manufacturing
```

---

## Canonical Classifications & Provenance

### Classifications
- **`MEASURED`**: Directly grounded in user-provided measurements or calibrated observations.
- **`ESTIMATED`**: Inferred through geometric solver optimization, OpenCV observations, or multi-view evidence.
- **`UNKNOWN`**: Insufficient evidence to observe or identify (value is `null`, never `0`).

### Provenance Tracking
- `USER_PROVIDED`
- `CALIBRATED_IMAGE`
- `OPENCV_OBSERVATION`
- `COLMAP_RECONSTRUCTION`
- `DEPTH_PRIOR`
- `GEMINI_PROPOSAL`
- `GEOMETRIC_CONSTRAINT`

### Scale Semantics
- **`metric`**: Grounded by an authenticated physical reference dimension (units: `mm` or `inch`).
- **`relative`**: Reconstructed from uncalibrated multi-view cameras; no mm/inch claim is permitted.
- **`unknown`**: Contradictory scale references detected.

---

## Testing & Acceptance

Run the test suite:
```powershell
$env:PYTHONPATH="python-engine"; python -m pytest python-engine/tests
```
Results: **53 passed** (22 geometry solver tests GS-01..GS-22, 25 multiview tests MV-01..MV-25, 6 integration tests).

