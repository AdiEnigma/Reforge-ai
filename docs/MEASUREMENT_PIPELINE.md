# Measurement-Driven Photo-to-CAD Pipeline

This document describes the measurement pipeline that turns photo ratios into a
generic parametric part, scores how well the built solid matches the measured
evidence, and gates manufacturing exports until the result is trustworthy.

The pipeline is part-based but not part-specific: flanges, wheels, pulleys,
discs, washers and gear blanks go through the same feature synthesis. Part names
are labels and provenance only; there is no branching on a component name.

## Stages

```
photos
  -> vision-engine (SAM 2 / OpenCV / Depth Anything V2)
     fusion of per-image ratios + confidence + agreement
  -> Gemini (naming, sanity check, optional recipe fallback)
  -> Node backend (confidence gate, routing, response shaping)
  -> python-engine /cad/generate-from-measurements
     measurement_to_features -> CadQuery solid -> feature_fit -> export gate
```

1. **Measurement extraction** (`vision-engine/vision/feature_measurements.py`)
   - Classifies each view (axial, side, oblique) and extracts:
     - concentric radii and axial/radial ratios
     - radial hole patterns: count, bolt-circle ratio, hole ratio, start angle
     - side-profile `(z, r)` silhouette points
     - optional non-circular polygon outlines
   - Fuses views with confidence weighting and reports `agreement_score`,
     `needs_input`, and qualitative depth only (no invented metric depth).
2. **Gemini analysis** (`backend/gemini.js`)
   - Names the part, names visible features, and reports uncertainties.
   - With no absolute reference it works in **relative proportions only** and is
     told not to invent millimetre sizes.
   - A compact `MEASURED RATIOS` block is supplied to the model; measurements are
     authoritative and disagreements go in `uncertainties`.
   - `GEMINI_CONSENSUS_RUNS` (1-5) optionally runs several passes and merges them
     (majority class, median numeric estimates).
3. **Backend routing** (`backend/index.js`)
   - Validates and compacts `feature_measurements` (512 KB limit).
   - A confidence gate rejects failed/unknown measurements,
     `agreement_score < MEASUREMENT_CONFIDENCE_GATE` (default `0.55`), and very
     low view confidence.
   - When the gate passes, the measurement route is used. If Python fails and a
     Gemini recipe exists, the backend falls back to the legacy/advanced route
     and records both attempts.
4. **Feature synthesis** (`python-engine/cad/measurement_to_features.py`)
   - Produces `base_cylinder`, `revolve_profile` or `extrude_profile`, plus
     `through_bore`, `bolt_circle` holes, bosses, grooves, fillets and chamfers
     only when observed or user-confirmed.
   - Parameter precedence: user-provided > scaled photo measurement > Gemini
     estimate > unknown (`null`). Unknowns are never coerced to zero.
   - Recipes are always `units: "mm"` for CadQuery. Unanchored models are
     reference models: outer diameter is set to 100, metadata records
     `length_unit: "reference_unit"`, and `preview_only` is true.
5. **Feature fit** (`python-engine/cad/feature_fit.py`)
   - Reads the built solid's cylindrical faces and compares outer diameter,
     bore, bolt-circle holes, individual holes and profile steps against the
     measurements.
   - Scores are weighted: outer `0.15`, bore `0.25`, pattern `0.30`, holes
     `0.20`, profile `0.10`, with an unexplained-hole penalty.
   - A missing expected feature forces a `fail`.
6. **Statuses and export gate** (`python-engine/app.py`)
   - `geometry`: `valid | invalid`
   - `reconstruction`: `complete | partial | insufficient`
   - `dimensional_accuracy`: `pass | warn | fail | not_assessed`
   - `manufacturing_readiness`: `ready | ready_with_assumptions | blocked`

   Block reasons: `geometry_invalid`, `scale_not_anchored`,
   `critical_dimensions_unknown`, `critical_dimensions_assumed`,
   `needs_input`, `dimensional_fit_failed`.

   When blocked, `step_path` and `stl_path` are `null`. Preview mesh/STEP/STL
   paths remain available for the viewer. `export_override: true` or
   `ALLOW_ASSUMED_EXPORTS=true` can opt in to exporting an assumed result.

## API contract

### `POST /cad/generate-from-measurements`

Request:

```json
{
  "job_id": "optional-string",
  "measurements": { "schema_version": 1, "...": "fused feature_measurements" },
  "user_dimensions": {
    "outer_diameter": 120,
    "bore_diameter": 40,
    "thickness": 12,
    "hole_count": 6,
    "bolt_circle_diameter": 90,
    "hole_diameter": 8
  },
  "hints": { "part_type": "flange" },
  "generate_previews": false,
  "allow_assumed_exports": false,
  "export_override": false
}
```

Response highlights:

```json
{
  "status": "success",
  "mode": "measurement",
  "measurement_status": "measured | partial | needs_input | ...",
  "preview_only": false,
  "manufacturing_ready": true,
  "export_allowed": true,
  "export_block_reasons": [],
  "validation_statuses": {
    "geometry": { "status": "valid" },
    "reconstruction": { "status": "complete" },
    "dimensional_accuracy": { "status": "pass" },
    "manufacturing_readiness": { "status": "ready" }
  },
  "feature_fit": { "status": "pass", "score": 1.0, "issues": [] },
  "scale": { "mode": "user_anchored", "reference": "outer_diameter" },
  "provenance": { "outer_diameter": { "provenance": "user_provided" } },
  "needs_input": [],
  "step_path": "/abs/path/model.step",
  "stl_path": "/abs/path/model.stl",
  "mesh_path": "/abs/path/model.mesh.json",
  "preview_step_path": "/abs/path/model.step",
  "preview_stl_path": "/abs/path/model.stl",
  "preview_mesh_path": "/abs/path/model.mesh.json"
}
```

The Node API exposes the same evidence through job results as
`result.measurement`, `result.validation.dimensionalScore`,
`result.validation.dimensionalStatus`, `result.stages`, `result.gemini`, and
`result.routeAttempts`.

### `POST /api/cad/build`

Accepts either a geometry recipe, a `feature_measurements` document, or both.
When measurements are present and pass the gate, the measurement route is used
first; otherwise the legacy/advanced recipe route is used. `analysis`
objects returned by analysis/jobs carry `featureMeasurements` and can be sent
back directly.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEASUREMENT_CONFIDENCE_GATE` | `0.55` | Minimum fused measurement agreement |
| `GEMINI_CONSENSUS_RUNS` | `1` | Gemini passes (clamped 1-5) |
| `ALLOW_ASSUMED_EXPORTS` | `false` | Export assumed/unanchored measurements |
| `VISION_PIPELINE_ENABLED` | `false` | Enable measurement extraction |
| `CAD_ENABLED` | `false` | Enable the Python CAD service |

## Honesty rules

- Photos yield ratios; absolute dimensions require an anchor. Unanchored output
  is a preview and reports `reference_unit`, not fabricated millimetres.
- Missing or contradictory evidence yields `needs_input`, not guesses.
- The UI shows the Stage 4 dimensional score/status for measurement builds.
  Gemini classification confidence is labelled separately and is never used as
  a geometry quality score.
- Legacy build `fitScore` is a declared-expectation fit, not a photo-reference
  score; the UI labels it as such.
