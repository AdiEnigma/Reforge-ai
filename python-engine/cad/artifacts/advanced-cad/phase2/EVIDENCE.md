# ReForge AI — Advanced CAD Phase 2 Evidence (Stages 3 & 4)

Engineering drawings and export validation generated from the **same** validated Phase 1 housing model and feature recipe (`python-engine/cad/scripts/generate_advanced_cad_demo_phase2.py`).

## Source model (unchanged from Phase 1)

- Features: **22** (22 applied, 0 failed, 0 skipped)
- Geometry valid: **True**, fit score **1.0**
- Volume: **701,034.3 mm³**
- Bounding box: **160.00 × 160.00 × 90.00 mm** (expected 160 × 160 × 90 mm)

## Stage 3 — Engineering drawings

- Views: **FRONT, RIGHT, TOP, SECTION A-A, ISO, DETAIL B**
- Dimensions: **27**
- Title block: ADVANCED MECHANICAL HOUSING / RF-ADV-HOUSING-001 / rev A / scale 1:2 / units mm
- Section labels: ['A']
- Projection: FIRST ANGLE (right-side view left of front, top view below front)
- Rendered geometry per view (line counts): {'FRONT': 282, 'RIGHT': 273, 'TOP': 195, 'SECTION A-A': 64, 'ISO': 107, 'DETAIL B': 11}
- Layout checks: text collisions=0, view overlaps=0, page overflow=[], title-block intersections=[]
- Unspecified GD&T / tolerances are explicitly marked as such.
- Dimension kinds are truthful: `RIB L=…` is a **linear** callout and `… CHAMFER` is a **chamfer** callout (neither is mislabelled a diameter).
- Front-view feature leaders are routed as a single non-crossing fan on the right; the overall vertical dimension sits on the left.
- The SECTION A-A cutting-plane line + endpoint arrows/labels are drawn on the plan (top) view where the Y=0 plane is edge-on.
- DETAIL B carries a circled callout with its magnification and a magnified clip centred on the flange/body junction.
- Vector SVG: `housing_drawing.svg` (395 KB)
- PDF: `housing_drawing.pdf` (65 KB)
- Raster preview: `housing_drawing_preview.png`

## Stage 4 — Export validation (re-imported, not assumed)

- STEP re-import: valid=**True**, solid count 1 → 1, volume Δ 0.00000%
- STL mesh: valid=**True**, 12837 verts, 38583 edges, watertight=True, degenerate=0, volume Δ 0.0297%
- Drawing validation: valid=**True** (6 views, 27 dimensions, units mm)
- Export manifest: **21** files with relative paths, sizes and SHA-256; re-verified=**True** (21/21).

## Integration contract

`integration_example_recipe.json` is a complete `reforge-cad-interface` v1.0 document that the Reconstruction Engine could emit. It carries a named dimension table with semantic units and truthful (`user_specified` / demo-fixture) provenance, plus the ordered feature list with an explicit `operation` on every feature. The validator rejects missing / unreliable dimensions with explicit diagnostics (see `tests/test_integration_contract.py`).
- Example validates: **True** (78 dimensions, 22 features)

## Real Reconstruction → CAD round trip

`reconstruction_to_cad_request.json` / `..._response.json` are the **actual** JSON documents produced by driving the real Reconstruction Engine (`solve_geometry` on a known cylinder r=25 / h=100 / bore 20) through `interface_from_solver_result` and `POST /cad/from-reconstruction`.

The cylinder point cloud is a **deterministic synthetic fixture synthesised in-process; COLMAP was NOT run**. The solver's cylinder branch labels a point-cloud fit `COLMAP_RECONSTRUCTION` by default, so `record_fixture_source` re-labels it `SYNTHETIC_FIXTURE` and records `colmap_executed=false` in the solver result, the adapted interface document and the evidence below. The user-supplied bore keeps `USER_PROVIDED` provenance and the ESTIMATED (outer diameter / height) vs MEASURED (inner diameter) classification distinction is preserved.

- Solver status: **success** (scale `metric`, units `mm`)
- Input source: **synthetic fixture** (`colmap_executed=false`)
- Missing critical dimensions: []
- Adapted interface valid: **True**
- Endpoint status: **success**
- Re-imported STEP/STL exports valid: **True** (STEP volume Δ 0.00000%, STL volume Δ 0.1657%)

## Files

| File | Description |
| --- | --- |
| `housing_drawing.svg` / `.pdf` | Engineering drawing (Stage 3). |
| `housing_drawing_preview.png` | Raster preview of the A3 sheet. |
| `housing_isometric_hires.png` | High-resolution isometric preview. |
| `housing_section_hires.png` | High-resolution section/cutaway preview. |
| `housing.step` / `housing.stl` | STEP solid / STL mesh. |
| `housing_recipe.json` | Source feature recipe (Phase 1). |
| `housing_feature_history.json` | Full modelling history. |
| `housing_validation_report.json` | Geometry validation report. |
| `housing_drawing_manifest.json` | Drawing manifest (views/dims/title block). |
| `housing_export_validation.json` | STEP/STL/drawing re-import validation. |
| `housing_export_manifest.json` | Export manifest with relative paths + SHA-256. |
| `housing_package_manifest.json` | Every packaged file (relative path + SHA-256). |
| `integration_example_recipe.json` | Example Reconstruction→CAD interface. |
| `integration_interface_schema.json` | JSON Schema for the contract. |
| `reconstruction_solver_result.json` | Real `SolverResult` from `solve_geometry`. |
| `reconstruction_to_cad_request.json` | Actual endpoint request (contract document). |
| `reconstruction_to_cad_response.json` | Actual endpoint response (model + exports). |
| `reconstruction_to_cad_export_validation.json` | STEP/STL re-import of the recon exports. |
| `advanced-cad-phase2.zip` | ZIP deliverable (current run + current recon pair only). |

All JSON manifests record **relative POSIX paths** (no absolute Windows paths); sizes and SHA-256 are read from the exact files on disk.

## Reproduction

```
cd python-engine
python cad/scripts/generate_advanced_cad_demo_phase2.py
```
