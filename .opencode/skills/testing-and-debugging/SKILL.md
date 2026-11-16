---
name: testing-and-debugging
description: Ensure generated geometry and application functionality are correct. Covers unit testing, API testing, integration testing, image-processing tests, CAD geometry validation, STEP export testing, reconstruction accuracy metrics, dimension MAE, volume error, chamfer distance, feature detection metrics, regression testing, and reproducible test datasets.
---

# Testing and Debugging

## Purpose

Ensure that generated geometry and application functionality are correct. Provide a comprehensive testing strategy covering all layers of the ReForge AI system.

## When to use

- When writing tests for new functionality.
- When debugging geometry generation issues.
- When validating CAD output quality.
- When measuring reconstruction accuracy.
- When running regression tests.
- When creating test datasets.

## Project context

ReForge AI has multiple testing layers across its services:

### Frontend tests

**Location:** `frontend/src/lib/*.test.js`

**Test files:**
- `exporters.test.js` — Export functionality tests
- `features.test.js` — Feature extraction and normalization tests
- `machinery-context.test.js` — Machinery context tests
- `machinery-integration.test.js` — Machinery integration tests
- `engineering-context.test.js` — Engineering context tests

**Run:** `cd frontend && npm test` (if configured)

### Backend tests

**Location:** `backend/*.test.js`

**Test files:**
- `engineering-analysis.test.js` — Engineering analysis tests
- `material-comparison.test.js` — Material comparison tests
- `reconstruction-adapter.test.js` — Reconstruction adapter tests
- `vision-adapter.test.js` — Vision adapter tests

**Run:** `cd backend && npm test` (if configured)

### Python tests

**Vision Engine:** `vision-engine/tests/`
- `test_pipeline.py` — Pipeline integration tests
- `test_segmentation.py` — SAM2 segmentation tests
- `test_depth.py` — Depth Anything V2 tests
- `test_opencv_features.py` — OpenCV feature extraction tests
- `test_quality.py` — Image quality tests
- `test_image_io.py` — Image I/O tests

**Reconstruction Engine:** `python-engine/tests/`
- `test_recipe_validator.py` — Recipe validation tests
- `test_cad_generator.py` — CAD generation tests
- `test_feature_schema.py` — Feature schema tests
- `test_feature_recipe_validator.py` — Feature recipe validation tests
- `test_feature_modeller.py` — Feature modeller tests
- `test_geometry_solver.py` — Geometry solver tests
- `test_multiview.py` — Multi-view reconstruction tests
- `test_export_validation.py` — Export validation tests

**Run:** `cd vision-engine && pytest tests/ -v` or `cd python-engine && pytest tests/ -v`

### Test datasets

**Synthetic fixtures:**
- `vision-engine/tests/fixtures/generate_synthetic_fixtures.py` — Generates synthetic mechanical fixtures for testing
- Run: `python tests/fixtures/generate_synthetic_fixtures.py`

## Testing strategies

### Unit testing

**Frontend:**
- Test utility functions in isolation
- Test React components with React Testing Library
- Mock API calls with MSW or similar

**Backend:**
- Test individual functions (sanitizeRecipe, validateImages, etc.)
- Test API endpoints with supertest
- Mock external services (Gemini, vision, reconstruction)

**Python:**
- Test individual functions and classes
- Use pytest fixtures for common test data
- Mock external dependencies (models, file I/O)

### API testing

**Backend API:**
- Test all endpoints with valid and invalid inputs
- Test error responses and status codes
- Test fail-open behavior

**Python services:**
- Test `/process`, `/health` endpoints
- Test `/reconstruct`, `/cad/generate` endpoints
- Test request/response validation

### Integration testing

**Full pipeline:**
- Test image upload → analysis → 3D rendering
- Test vision preprocessing → Gemini analysis → CAD generation
- Test manufacturing intelligence calculation

**Cross-service:**
- Test Node.js → Python service communication
- Test fail-open behavior when Python services are down
- Test timeout handling

### Image-processing tests

**SAM 2 segmentation:**
- Test with synthetic mechanical components
- Test mask quality metrics
- Test ambiguous scene handling
- Test low-confidence detection

**OpenCV features:**
- Test contour extraction accuracy
- Test circle/ellipse/line detection
- Test bounding box calculation
- Test symmetry detection

**Depth Anything V2:**
- Test relative depth output
- Verify `depth_type: "relative"` and `metric: false`
- Test mask-aware depth estimation

### CAD geometry validation

**Solid validity:**
- Test that generated geometry contains exactly 1 solid
- Test bounding box non-degeneracy
- Test volume > 0

**Feature validation:**
- Test hole/bore positions and diameters
- Test gear tooth count and geometry
- Test fillet/chamfer application

**Export validation:**
- Test STEP export produces valid AP214/AP203 files
- Test STL export produces valid mesh
- Test export manifest verification

### Reconstruction accuracy metrics

**Dimension MAE:**
- Compare estimated dimensions with ground truth
- Report Mean Absolute Error per dimension

**Volume error:**
- Compare estimated volume with ground truth
- Report relative volume error

**Chamfer distance:**
- Compare projected CAD edges with image edges
- Report chamfer distance for edge alignment

**Feature detection metrics:**
- Precision/recall for feature detection
- Confidence calibration

### Regression testing

**Automated regression:**
- Run full test suite on every change
- Compare outputs with golden master files
- Alert on significant deviations

**Visual regression:**
- Compare rendered 3D views with reference images
- Test with known component images

## Best practices

1. **Test at all levels** — Unit, API, integration, and end-to-end
2. **Use synthetic fixtures** — Generate reproducible test data
3. **Validate geometry, not just visuals** — A visually attractive model must not be considered geometrically accurate
4. **Measure accuracy quantitatively** — Use MAE, volume error, chamfer distance
5. **Test fail-open behavior** — Ensure optional services degrade gracefully
6. **Test edge cases** — Small components, ambiguous scenes, missing data
7. **Automate regression testing** — Run tests on every change

## Common mistakes to avoid

- **Treating visual plausibility as engineering accuracy** — Always validate geometry quantitatively
- **Not testing fail-open behavior** — Optional services must degrade gracefully
- **Using only real images for testing** — Synthetic fixtures provide reproducible ground truth
- **Skipping export validation** — STEP/STL exports must be validated
- **Not testing with missing/ambiguous data** — Edge cases are where bugs hide
- **Not measuring reconstruction accuracy** — Without metrics, you can't detect regressions

## Validation checklist

- [ ] Unit tests pass for all utility functions
- [ ] API tests pass for all endpoints
- [ ] Integration tests pass for full pipeline
- [ ] Image-processing tests cover SAM2, OpenCV, Depth
- [ ] CAD geometry validation tests pass
- [ ] STEP/STL export validation tests pass
- [ ] Reconstruction accuracy metrics measured
- [ ] Dimension MAE within acceptable bounds
- [ ] Volume error within acceptable bounds
- [ ] Chamfer distance within acceptable bounds
- [ ] Feature detection metrics tracked
- [ ] Regression tests automated
- [ ] Synthetic fixtures generate reproducible data
- [ ] Fail-open behavior tested and working