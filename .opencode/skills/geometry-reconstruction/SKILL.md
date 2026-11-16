---
name: geometry-reconstruction
description: Convert image evidence into geometrically consistent CAD parameters. Covers multi-view image processing, optional COLMAP integration, point-cloud processing, SciPy optimisation, geometric constraint solving, analysis-by-synthesis, reconstruction error metrics, parameter refinement, and handling insufficient visual evidence.
---

# Geometry Reconstruction

## Purpose

Convert visual evidence from component photographs into geometrically consistent CAD parameters. This skill covers the full reconstruction pipeline from multi-view processing through parameter estimation to final CAD-ready parameters.

## When to use

- When building or modifying the reconstruction pipeline.
- When implementing geometric parameter estimation from image evidence.
- When adding multi-view processing or COLMAP integration.
- When implementing SciPy-based geometric optimisation.
- When handling insufficient visual evidence or requesting user measurements.

## Project context

The reconstruction engine runs as a separate FastAPI microservice on `127.0.0.1:8766`. It provides endpoints for multi-view reconstruction, geometric parameter solving, and end-to-end reconstruction. The service is optional and fail-open — when disabled or unavailable, the core workflow continues unchanged.

### Reconstruction pipeline

```
POST /reconstruct
    │
    ├── Multi-view SfM (COLMAP) — optional, requires ≥2 images
    │   └── run_multiview_reconstruction()
    │
    └── SciPy geometric parameter solver
        └── solve_geometry()
```

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check with capability status |
| `/reconstruct/multiview` | POST | COLMAP SfM multi-view reconstruction |
| `/reconstruct/solve` | POST | SciPy geometric parameter solver |
| `/reconstruct` | POST | End-to-end reconstruction |
| `/cad/generate` | POST | Legacy CAD generation |
| `/cad/generate-advanced` | POST | Advanced feature-based CAD generation |

### Multi-view processing

**COLMAP integration:**
- Optional COLMAP SfM pipeline via `reconstruction.multiview`
- Requires ≥2 images for multi-view reconstruction
- Returns camera poses, point clouds, sparse reconstructions
- `find_colmap_executable()` checks if COLMAP is available
- `run_multiview_reconstruction()` executes the pipeline

**Point-cloud processing interfaces:**
- Point cloud data from COLMAP SfM
- Feature point correspondence across views
- Camera intrinsic/extrinsic parameters
- Sparse 3D point cloud for geometric fitting

### Geometric parameter estimation

**Solver input:**
```python
class SolveRequest(BaseModel):
    job_id: str
    component_type: str
    user_dimensions: Optional[Dict[str, Any]]
    gemini_proposal: Optional[Dict[str, Any]]
    multiview_evidence: Optional[Dict[str, Any]]
    opencv_observations: Optional[Dict[str, Any]]
    constraints: Optional[List[Dict[str, Any]]]
    options: Optional[Dict[str, Any]]
```

**Solver output:**
```python
class SolverResult(BaseModel):
    job_id: str
    component_type: str
    parameters: Dict[str, Any]
    residuals: ResidualStatistics
    identifiability: IdentifiabilityReport
    status: str
    warnings: List[str]
```

### SciPy optimisation

**Geometric fitting functions:**
- `fit_cylinder_scipy()` — Fit cylinder parameters from point cloud
- `fit_concentric_circles_scipy()` — Fit concentric circles
- `solve_gear_parameters()` — Solve gear parameters from observations
- `solve_geometry()` — End-to-end geometry solver

**Residual computation:**
- Point-to-surface distance residuals
- Circle fitting residuals
- Parameter identifiability diagnostics

### Geometric constraint solving

**Constraints:**
- Concentricity constraints between features
- Parallelism constraints between planes/axes
- Perpendicularity constraints between features
- Dimension constraints (equal, related)
- Positional constraints (coincident, tangent)

**Identifiability diagnostics:**
- `compute_identifiability_diagnostics()` — Check parameter identifiability
- Reports which parameters are identifiable vs. unidentifiable
- Provides confidence bounds for estimated parameters

### Analysis-by-synthesis

**Process:**
1. Generate candidate CAD model from estimated parameters
2. Project CAD model onto image plane
3. Compare projected CAD with original image
4. Compute reconstruction error
5. Refine parameters based on error
6. Repeat until convergence

**Reconstruction error metrics:**
- Chamfer distance between projected CAD and image edges
- Dimension MAE (Mean Absolute Error)
- Volume error between estimated and actual
- Feature detection metrics

### Parameter refinement

**Iterative refinement:**
1. Start with Gemini proposal as initial estimate
2. Apply OpenCV observations as constraints
3. Run SciPy optimisation to minimize residuals
4. Check identifiability diagnostics
5. Refine parameters based on uncertainty bounds
6. Output final CAD-ready parameters

### Handling insufficient visual evidence

**When evidence is insufficient:**
- Mark parameters as unknown
- Request user measurements for critical dimensions
- Flag low-confidence features for user review
- Provide graceful degradation (Gemini-only path)

**User measurement requests:**
- Reference dimensions (outer diameter, inner diameter, height, etc.)
- Known dimensions for calibration
- Additional views for multi-view reconstruction

## Best practices

1. **Never fabricate dimensions** — Mark unknown parameters explicitly
2. **Distinguish known, estimated, unknown** — All parameters must be classified
3. **Use fail-open pattern** — Reconstruction errors should not break user analysis
4. **Track reconstruction error** — Always compute and report error metrics
5. **Validate identifiability** — Check which parameters are identifiable before proceeding
6. **Request user input when needed** — Don't guess critical dimensions
7. **Preserve coordinate systems** — All parameters in consistent coordinate system

## Common mistakes to avoid

- **Fabricating dimensions** — Never invent dimensions not supported by evidence
- **Ignoring identifiability** — Don't proceed with unidentifiable parameters
- **Skipping error computation** — Always compute reconstruction error
- **Breaking fail-open** — Reconstruction errors should not break user analysis
- **Mixing coordinate systems** — All parameters must use consistent units and coordinate system
- **Assuming COLMAP is available** — Always check `find_colmap_executable()` first

## Validation checklist

- [ ] Multi-view processing works with ≥2 images
- [ ] COLMAP availability checked before use
- [ ] SciPy optimisation converges correctly
- [ ] Parameter identifiability checked
- [ ] Reconstruction error computed and reported
- [ ] Unknown parameters explicitly marked
- [ ] User measurement requests generated when needed
- [ ] Fail-open behavior tested
- [ ] Coordinate systems consistent across pipeline
- [ ] Error metrics include dimension MAE, volume error, chamfer distance