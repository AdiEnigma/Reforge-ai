**REFORGE AI**

**ADVANCED CAD
TECHNICAL HANDOFF**

Architecture â€¢ Four implementation stages â€¢ Two delivery phases â€¢ Three-subsystem integration

![Isometric preview of the advanced mechanical housing specimen](ReForge_AI_Advanced_CAD_Technical_Handoff_assets/image1.png)

*Reference acceptance specimen: advanced_mechanical_housing*

> **PURPOSE** A complete teammate and AI-coding-assistant context document describing what was built, what was verified, what remains unproven, and how Vision, Reconstruction and Advanced CAD should be integrated.

| **Document control**   | **Value**                                                          |
|------------------------|--------------------------------------------------------------------|
| Prepared for           | ReForge AI project teammates and their coding assistants           |
| Prepared on            | 13 November 2026                                                   |
| Repository             | github.com/AdiEnigma/Reforge-ai                                    |
| Current feature branch | feature/advanced-cad-upgrade                                       |
| Published commit       | c3e6787 - Add advanced feature-based CAD generation and exports    |
| Status                 | Committed and pushed; pull request/merge status not confirmed here |

# 1. Executive briefing

ReForge AI now has an upgraded Python CAD subsystem that goes beyond the original primitive/revolved/extruded/gear recipe generator. The upgrade introduces a feature-history-based mechanical modelling layer, ordered additive/subtractive/finishing operations, geometry-aware validation, drawing generation, STEP/STL re-import checks, portable manifests, and a versioned Reconstruction-to-CAD contract.

> **THE KEY CHANGE** CAD no longer needs to receive only a small primitive recipe. It can consume an ordered, typed feature recipe or a validated reforge-cad-interface v1.0 document carrying named dimensions, semantic units, provenance, uncertainty where known, and explicit missing-dimension information.

## What has been delivered

- Two release phases containing four stages: Phase 1 implements feature-based 3D modelling and internal mechanical geometry; Phase 2 adds engineering drawings and export/package validation.

- Three Python API paths coexist: legacy POST /cad/generate, advanced POST /cad/generate-advanced, and reconstruction handoff POST /cad/from-reconstruction.

- A deterministic 22-feature mechanical housing specimen exercises flange/body, holes, ribs, bosses, radial ports, cavities, bores, crossing passages, fillet and chamfers.

- A3 first-angle engineering drawing with six views and 27 dimensions, plus STEP/STL exports and re-import validation.

- A contract adapter from Reconstruction SolverResult to CAD, with metric-scale and dimension-trust checks.

- Final verification reported 283 passing Python Engine tests and 5 known Starlette HTTP 422 deprecation warnings.

## What is not yet proven

- The reference housing is a predefined recipe-based specimen, not inferred from a photograph.

- The Reconstruction-to-CAD round-trip used a deterministic synthetic cylinder point cloud; COLMAP was explicitly not run.

- A real multi-view photo -> Vision -> COLMAP/Reconstruction -> CAD end-to-end run remains an integration milestone.

- The 1.0 bbox fit score for the reference specimen is a bounding-box acceptance measure, not image similarity or reconstruction accuracy.

# 2. Three-subsystem architecture and boundaries

The target system is a pipeline of independently testable engines. Vision extracts bounded evidence from images; Reconstruction estimates 3D geometry and scale; CAD converts a reliable, structured feature description into editable parametric solids and deliverables. The integration layer orchestrates jobs and passes versioned data contracts.

![ReForge AI three-subsystem architecture and CAD interface flow](ReForge_AI_Advanced_CAD_Technical_Handoff_assets/image2.png)

## Subsystem responsibilities

| **Subsystem**          | **Owns**                                                                                                                                                              | **Must not claim**                                                                                          |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Vision Engine          | Image decoding/quality, SAM masks, OpenCV contours/circle/ellipse/line candidates, pixel coordinates, optional relative depth, calibration evidence.                  | Pixel radii are not millimetres. SAM mask is a segmentation hypothesis. Relative depth is not metric depth. |
| Reconstruction Engine  | Multi-view geometry, point clouds, coordinate frames, scale classification, solved parameters, measured/estimated status, provenance and missing critical dimensions. | A visually plausible point cloud is not automatically metric. Unknown scale must remain unknown.            |
| CAD Engine             | Feature recipe validation, CadQuery/OCCT modelling, boolean operations, feature history, solid checks, drawings, STEP/STL export and re-import validation.            | CAD should not invent missing geometry or import Vision/Recon internals directly.                           |
| Orchestrator / backend | Job IDs, timeouts, persistence, retries/fallbacks, API routing, explicit user-review states and artifact pointers.                                                    | Do not silently turn partial evidence into a production CAD model.                                          |

> **BOUNDARY RULE** CAD is intentionally decoupled from Vision and Reconstruction code. It consumes a self-describing, versioned JSON document and either validates it or rejects it with actionable diagnostics.

# 3. CAD subsystem: original baseline versus upgraded engine

## Original CAD foundation (retained)

- python-engine/cad/cad_generator.py dispatches existing styles such as revolved, extruded, combination and gear.

- Primitive support includes box, cylinder, sphere, cone and torus; combination behaviour is primarily additive/union oriented.

- Gear generation uses cq_gears.SpurGear (and has helical-gear test coverage).

- Existing recipe and geometry validation are implemented in recipe_validator.py and cad_validator.py.

- STEP and STL exporters remain in python-engine/exports/step_export.py and mesh_export.py.

- POST /cad/generate remains available with its existing contract.

## What the upgrade adds

| **Capability**        | **Before**                                          | **After upgrade**                                                                                         |
|-----------------------|-----------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Modelling abstraction | Style/primitive recipes                             | Ordered feature recipe with explicit feature IDs, dependencies and operation classes                      |
| Operations            | Mostly whole-body styles and primitive combinations | Additive, subtractive and finishing feature execution                                                     |
| Mechanical details    | Simple holes/primitive assemblies                   | Bores, stepped bores, pockets, radial/axial ports, bolt circles, ribs, bosses, passages, fillets/chamfers |
| Diagnostics           | Basic recipe/geometry validation                    | Per-feature history, failures/skips, expected geometry checks, explicit contract diagnostics              |
| Presentation          | Basic exports                                       | SVG/PNG previews, section views, A3 engineering drawing, detail callout                                   |
| Export trust          | Export files emitted                                | STEP/STL re-import, mesh quality, volume/bbox checks, drawing layout checks, SHA-256 manifests            |
| Subsystem handoff     | Ad hoc recipe input                                 | Versioned Reconstruction-to-CAD contract with provenance, semantic dimensions and missing-input policy    |

Portability note: the branch inherits master commit 1c89efe, which fixes Windows path handling in cad_validator.py by passing the estimator path as a subprocess argument and reading it through Node process.argv\[1\], rather than interpolating a Windows path into JavaScript source. The focused regression tests passed (2 tests), and the original six-file CAD suite reported 78 passing tests on the Windows CAD environment.

> **COMPATIBILITY** This is an additive upgrade. Existing /cad/generate and legacy recipe paths are retained. The advanced adapter can convert a supported subset of legacy revolved, extruded and combination recipes; unsupported legacy styles should continue through the original generator.

# 4. Delivery model: two phases, four stages

The work was delivered in two phases. Each phase covers two of the four implementation stages. Phase 2 uses the same validated Phase 1 reference model and recipe; it does not redefine the housing geometry.

| Phase | Stage | What the stage does | Primary outputs |
| --- | --- | --- | --- |
| Phase 1 / Advanced feature modelling | Stage 1 / Feature recipe + external/primary solids | Defines a versioned feature schema and deterministic feature registry; creates the base body and additive mechanical structure; orders features and captures dependencies. | Feature recipe; CadQuery solid; feature history; primary 3D preview; STEP/STL baseline. |
| Phase 1 / Advanced feature modelling | Stage 2 / Internal geometry + validation | Applies subtractive machining and finishing features; validates the resulting B-Rep/solid and intended geometry; produces diagnostics and section previews. | Bores/cavities/ports/passages/holes; fillets/chamfers; validation report; section/cutaway previews. |
| Phase 2 / Engineering + production export | Stage 3 / Engineering drawing generation | Projects the validated solid into drawing views; lays out dimensions, section and detail views, labels, title block and projection convention. | SVG/PDF/PNG engineering drawing; drawing manifest; layout validation. |
| Phase 2 / Engineering + production export | Stage 4 / Export validation + integration package | Re-imports STEP and STL; checks mesh and geometric equivalence; verifies drawing; writes SHA-256 manifests and reproducible ZIP; demonstrates Reconstruction contract path. | STEP/STL; validation report; export/package manifests; interface schema/example; ZIP package; reconstruction test artifacts. |

## How to interpret the phases

Phase 1 answers: can a structured mechanical feature recipe build a complex, internally machined model with explainable feature history and validated geometry? Phase 2 answers: can that same validated model be communicated as an engineering drawing and exported in neutral formats with independent round-trip checks and portable evidence?

> **STAGE MAPPING** Stage 1 + Stage 2 = Phase 1. Stage 3 + Stage 4 = Phase 2. The two phase names are delivery groupings; the four stages are the functional breakdown teammates should use in planning and issue tracking.

# 5. Phase 1 / Stage 1 - Feature-based modelling foundation

## Feature recipe schema

The feature recipe is identified by format reforge-feature-recipe, version 1.0. A recipe declares units, an ordered feature array, expected acceptance conditions and optional metadata. Each feature carries a stable ID, type, parameters, optional dependencies and metadata. The feature registry maps every supported type to one operation class: additive, subtractive or finish.

## Stage 1 additive / primary-body types

| **Feature type**                    | **Purpose**                                              |
|-------------------------------------|----------------------------------------------------------|
| base_cylinder / base_box            | Create primary cylindrical or prismatic bodies.          |
| revolve_profile / extrude_profile   | Build a body from a section/profile or planar outline.   |
| flange                              | Create circular or rectangular mounting flange geometry. |
| boss_cylindrical / boss_rectangular | Add local external mounting or port bosses.              |
| rib                                 | Add structural ribs/gussets between body regions.        |
| connector                           | Add a connector-style additive feature.                  |

## Execution principles

- Feature IDs are stable identifiers for history, diagnostics and downstream references.

- Features are applied in array order, with dependency information available for validation and topological ordering.

- Each feature has a registered operation class. The interface contract requires the operation to be explicit and consistent with the registry.

- The modeller uses CadQuery workplanes/shapes backed by OpenCASCADE and performs additive/subtractive boolean operations against the current solid.

- Strict mode can fail on the first invalid feature; non-strict execution can record feature failure/skip diagnostics and continue only where dependencies permit.

## Feature history status vocabulary

The tracked lifecycle states are pending, valid, invalid, applied, failed and skipped. This makes the recipe executable and diagnosable rather than an opaque shape-generation request.

# 6. Phase 1 / Stage 2 - Internal geometry, finishing and validation

## Stage 2 subtractive feature types

| **Feature type**                         | **Purpose**                                                                        |
|------------------------------------------|------------------------------------------------------------------------------------|
| through_bore / blind_bore / stepped_bore | Axial holes and stepped internal bores with explicit start/end extents.            |
| counterbore / countersink                | Machined hole-mouth features.                                                      |
| pocket_circular / pocket_rectangular     | Local material removal from faces or defined regions.                              |
| radial_port / axial_port                 | Ports entering from radial or axial directions.                                    |
| internal_passage                         | Drilled or modelled passages between explicit start/end coordinates.               |
| cavity                                   | Larger internal recess or chamber.                                                 |
| bolt_circle / hole_pattern               | Repeated hole cuts controlled by count, pitch radius/position and angle semantics. |

## Finishing feature types

fillet and chamfer are separate finishing operations. They act on selected existing edges, and their history records whether the intended edge(s) could be selected and modified.

## Recipe validation and geometry validation

- Recipe validation checks format/version, supported feature types, required parameters, finite numeric values, units, dependencies/cycles, parameter semantics and geometry-specific parameter constraints.

- Length parameters are normalised to millimetres by the feature-recipe validator; the feature-recipe schema accepts mm/cm/m/in variants, while the Reconstruction-to-CAD interface is intentionally metric-only.

- Geometry validation checks the resulting solid, solid count, bounding box against expected values/tolerance, volume limits, feature counts and required mechanical geometry signals where available.

- Feature history captures applied/failed/skipped features and messages such as cut intersection volumes or finish operation results.

- Preview generation creates orthographic/isometric SVG views, section SVG/cutaway and PNG previews at higher resolution when rendering support is present.

> **IMPORTANT** A successful boolean operation alone is not sufficient acceptance. The final solid is checked against declared expectations and its feature history; an invalid or unexpectedly incomplete model must be surfaced, not silently exported.

# 7. Phase 1 acceptance specimen - advanced_mechanical_housing

This is a deterministic, fully dimensioned reference specimen used to exercise the Stage 1 and Stage 2 feature engine. Coordinate convention: global Z is the housing axis; origin is the centre of the flange base plane at z = 0.

![Isometric preview of the advanced mechanical housing specimen](ReForge_AI_Advanced_CAD_Technical_Handoff_assets/image1.png)

Isometric preview of the acceptance housing (recipe-driven specimen, not photo reconstruction).

| **Feature group**      | **Key values**                                                                                      |
|------------------------|-----------------------------------------------------------------------------------------------------|
| Mounting flange        | Outer radius 80 mm; thickness 12 mm.                                                                |
| Main body              | Cylinder radius 45 mm; nominal height 90 mm.                                                        |
| Mounting pattern       | 6 holes, diameter 8 mm, bolt-circle radius 62 mm.                                                   |
| External ports/bosses  | 3 radial ports at 0Â°, 120Â°, 240Â°; port diameter 14 mm; boss radius 18 mm; boss height 16 mm.        |
| Internal voids         | Upper cavity diameter 50 mm; intermediate stepped bore diameter 28 mm; through-bore diameter 14 mm. |
| Structural ribs        | 4 ribs at 45Â°, 135Â°, 225Â°, 315Â°; length 32 mm, thickness 8 mm, height 38 mm.                        |
| Cross-drilled passages | 2 intersecting internal passages, diameter 8 mm, offset 20 mm, Z=25 mm.                             |
| Machined edges         | Junction fillet R3 mm; chamfers 1.5 mm.                                                             |

## Acceptance result

| **Metric**              | **Reported result**                                                                           |
|-------------------------|-----------------------------------------------------------------------------------------------|
| Features                | 22 / 22 applied; 0 failed; 0 skipped.                                                         |
| Geometry                | Valid; 1 solid; intersecting passages verified.                                               |
| Volume                  | 701,034.334 mmÂ³ (approximately 701,034.3 mmÂ³).                                                |
| Bounding box            | 160 Ã— 160 Ã— 90 mm.                                                                            |
| Fit score               | 1.0 on the declared bounding-box acceptance basis only; not a visual or photo accuracy score. |
| Expected feature checks | 3 bore/cavity elements, 6 mounting holes, 3 radial ports, 2 crossing passages.                |

# 8. Phase 2 / Stage 3 - Engineering drawing generation

The drawing engine projects the same validated Phase 1 workplane into a multi-view technical sheet. It produces geometric polylines/projections, section-cut geometry, placements, dimension callouts, a title block and detail-view crop. The final drawing is not a screenshot of the 3D model.

## Reference drawing configuration

| **Item**          | **Configuration / result**                                                                                                 |
|-------------------|----------------------------------------------------------------------------------------------------------------------------|
| Sheet             | A3 landscape, 420 Ã— 297 mm.                                                                                                |
| Scale / units     | 1:2 scale; millimetres.                                                                                                    |
| Projection        | FIRST ANGLE. RIGHT view is placed left of FRONT; TOP is below FRONT.                                                       |
| Views             | FRONT, RIGHT, TOP, ISO, SECTION A-A and DETAIL B.                                                                          |
| Dimensions        | 27 dimensions in the final regenerated Phase 2 evidence.                                                                   |
| Drawing identity  | ADVANCED MECHANICAL HOUSING; RF-ADV-HOUSING-001; revision A.                                                               |
| Section/detail    | Section A-A exposes internal cavities/passages; Detail B is an actual magnified clip at the flange/body junction.          |
| Layout validation | Zero text collisions, zero view overlaps, no page overflow and no title-block intersections in the reported layout checks. |

## Drawing corrections completed during review

- Corrected first-angle view placement.

- Added actual clipped geometry to Detail B rather than a blank placeholder; the detail is magnified.

- Clipped centre lines to the relevant view regions and placed section cutting-plane markers on the plan/top view.

- Routed front-view leaders as a non-crossing fan and moved dimensions to reduce interference.

- Corrected semantic callouts so rib length is linear and chamfer is not represented as a diameter.

> **ENGINEERING RELEASE LIMIT** Material, finish, general tolerances and GD&T are explicitly NOT SPECIFIED in the specimen source. A human engineering review and completion of manufacturing specifications are required before treating this sheet as a production drawing.

# 9. Phase 2 / Stage 4 - Export validation and reproducible packaging

## STEP validation

- The exported STEP is re-imported through the CAD kernel rather than assumed valid because a file was written.

- Checks include re-import validity, solid count, volume agreement and bounding-box agreement.

- Reference housing result: one solid before and after; relative volume delta approximately 8.58 Ã— 10^-11 percent (effectively zero at reported precision); bounding-box relative errors below 0.061%.

## STL validation

- Binary/ASCII mesh parsing, finite vertices, degenerate triangle checks, normals/winding consistency and watertightness checks are performed.

- Reference housing mesh: 25,722 triangles; 12,837 welded vertices; 38,583 unique edges; zero boundary edges; zero non-manifold edges; zero degenerate triangles; normals consistently oriented.

- STL volume relative error was approximately 0.0297% against the source solid; bounding-box difference was within the configured tolerance.

- A separate section STL was also generated and reported watertight.

## Drawing and package validation

- Drawing checks cover required views/text, units, dimensions, drawing file presence, view placement, overlap/collision and page bounds.

- Export manifest: 21 files, each with relative path, size and SHA-256; 21/21 verified.

- Package manifest: 23 packaged files; 23/23 verified. ZIP CRC and per-entry hashes were checked; ZIP contents match the manifest and contain the current Reconstruction-to-CAD STEP/STL pair only.

- Manifests use portable relative POSIX paths and avoid absolute Windows paths. The ZIP is the compact shareable Phase 2 package.

> **REPRODUCIBILITY NOTE** The live artifact folder may accumulate uniquely named reconstruction_to_cad export pairs on repeated test runs. The package manifest/ZIP intentionally includes only the current run pair; stale local pairs are not part of the canonical package.

# 10. Reconstruction â†’ CAD integration contract v1.0

The contract is the central handoff boundary. It is implemented in python-engine/cad/integration_contract.py and documented in docs/CAD_INTEGRATION_CONTRACT.md. It lets Reconstruction describe geometry without importing CadQuery or calling CAD internals.

## Top-level document

```json
{
  "format": "reforge-cad-interface",
  "version": "1.0",
  "component": { "id": "part_001", "type": "shaft", "geometry_style": "revolved" },
  "units": { "length": "mm", "scale_status": "absolute" },
  "dimensions": { "outer_diameter": { "value": 50, "unit": "mm", "provenance": "measured" } },
  "features": [ { "id": "base_body", "type": "base_cylinder", "operation": "additive", "parameters": {} } ],
  "missing_dimensions": [],
  "assumptions": [],
  "expected": { "solid_count": 1 },
  "provenance": { "source": "reconstruction-engine", "method": "solver-result-adapter" }
}
```

## Required fields and rules

| **Area**        | **Contract rule**                                                                                                                                                            |
|-----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Envelope        | format/version/component/units/dimensions/features are required.                                                                                                             |
| Component       | Stable non-empty ID; type such as housing, bracket, flange, plate, shaft, gear, enclosure, cover, bushing, manifold or custom; geometry_style describes primary formation.   |
| Scale           | Metric length units only: mm/cm/m and spelled variants. scale_status absolute, scaled or unknown. Unknown scale is rejected; scaled requires a positive finite factor to mm. |
| Dimension entry | Each named dimension is an object with value, semantic unit and provenance. Bare numbers are not accepted in contract v1.0.                                                  |
| Provenance      | measured, derived, user_specified, assumed or unknown. No fabricated confidence or uncertainty. Pass uncertainty/confidence only when source actually supplies it.           |
| Feature         | Each feature has ID, type, explicit operation (additive/subtractive/finish), parameters, optional position/orientation/dependencies/metadata. Operation must match registry. |
| References      | Parameters can reference named dimensions via {"\$dim":"name"} or {"dimension":"name"}; unresolved references are explicit errors.                                           |
| Missing inputs  | missing_dimensions and missing_critical_dimensions are preserved. No silent defaults or inferred geometry for absent dimensions.                                             |

# 11. Contract validation: trust, units and rejection policy

## Semantic units

| **Semantic class** | **Canonical token / accepted aliases**  | **Constraint**                                                            |
|--------------------|-----------------------------------------|---------------------------------------------------------------------------|
| Length             | mm; mm/cm/m and spelled metric variants | Metric only; normalised to mm. Must be positive where required.           |
| Angle              | deg; degree; degrees                    | Degrees; finite numeric value. Never length-scaled.                       |
| Count              | count; counts; integer; pcs; pieces     | Integer >= 1. Fractional counts are rejected by runtime and JSON Schema. |
| Dimensionless      | dimensionless; none; ratio; 1           | Finite numeric value.                                                     |

Final semantic-unit remediation removed empty-string unit aliases and added a schema-level integer constraint for count dimensions. The published schema and runtime validator were checked together: integer count values are accepted; fractional counts and empty unit strings are rejected.

## Reliability thresholds

| **Condition for a referenced dimension**                     | **Default treatment**                                                                       |
|--------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Missing/non-finite value, missing/unknown unit or provenance | Hard error.                                                                                 |
| provenance = unknown                                         | Hard error.                                                                                 |
| provenance = assumed                                         | Rejected unless allow_assumed=true is explicitly requested.                                 |
| confidence below 0.5                                         | Error by default.                                                                           |
| relative uncertainty > 0.2                                  | Error by default.                                                                           |
| Semantic mismatch between declared unit and parameter use    | Error.                                                                                      |
| Count not integer                                            | Error; schema also enforces integer type.                                                   |
| Missing reference or missing critical dimension              | Explicit rejection / needs_input diagnostics; never substitute zero or a plausible default. |

## Why this matters to the AI agent

The contract deliberately prevents a model from laundering guesses into engineering dimensions. A user-specified dimension stays user-specified; a calibrated image observation can be measured; geometry inferred by a solver can be derived/estimated; a Gemini or language-model suggestion may be assumed and is refused by default. The receiving CAD engine must preserve this distinction.

# 12. API surface and code map

| **Endpoint**                  | **Purpose**                 | **Behavior**                                                                                                                                 |
|-------------------------------|-----------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| POST /cad/generate            | Legacy CAD route.           | Preserved; accepts the original CAD recipe request and continues to use the legacy generator/validator/export path.                          |
| POST /cad/generate-advanced   | Advanced feature modelling. | Accepts a feature recipe or supported legacy recipe conversion; models, validates, exports STEP/STL and optionally renders previews.         |
| POST /cad/from-reconstruction | Reconstruction handoff.     | Accepts interface v1.0; validates it; optionally returns contract-only recipe or models, validates and exports the resulting feature recipe. |
| GET /health                   | Python engine health.       | Existing app-level health endpoint remains part of the service.                                                                              |

## Key implementation files (final intended layout)

| **Path**                                        | **Responsibility**                                                                |
|-------------------------------------------------|-----------------------------------------------------------------------------------|
| python-engine/app.py                            | FastAPI entry point and three CAD endpoints; orchestration at API boundary.       |
| python-engine/cad/feature_schema.py             | Feature recipe v1.0 types, additive/subtractive/finish registry and data models.  |
| python-engine/cad/feature_recipe_validator.py   | Parameter schema/semantics, unit normalisation, dependencies, recipe validation.  |
| python-engine/cad/feature_modeller.py           | CadQuery/OCCT feature builders, boolean execution, ordered modelling and history. |
| python-engine/cad/advanced_cad_validator.py     | Resulting solid/expected geometry validation.                                     |
| python-engine/cad/advanced_recipe_adapter.py    | Legacy recipe conversion and route-to-modeler helper.                             |
| python-engine/cad/advanced_preview.py           | SVG/PNG, orthographic/isometric and section/cutaway preview bundles.              |
| python-engine/cad/engineering_drawing.py        | Projected views, section geometry, dimensions, detail callout and drawing sheet.  |
| python-engine/cad/export_validation.py          | STEP/STL re-import, mesh QA, drawing layout QA and SHA-256 manifests.             |
| python-engine/cad/integration_contract.py       | Contract validation, solver-result adapter, recipe conversion and JSON Schema.    |
| python-engine/cad/specimens/advanced_housing.py | Deterministic 22-feature reference specimen and documented dimensions.            |
| python-engine/cad/scripts/                      | Phase 1 and Phase 2 demonstration-generation scripts.                             |
| python-engine/cad/artifacts/advanced-cad/       | Generated Phase 1 and Phase 2 artifacts.                                          |
| python-engine/tests/                            | Central test directory; all CAD tests remain here.                                |
| docs/CAD_INTEGRATION_CONTRACT.md                | Human-readable Reconstruction-to-CAD contract reference.                          |
| python-engine/exports/                          | Existing STEP/STL exporters retained.                                             |

# 13. Reconstruction-to-CAD proof: what was actually exercised

The Phase 2 demonstration drove a real Reconstruction solver result through the adapter, the contract validator, the FastAPI endpoint and the CAD feature modeller. The input was a deterministic synthetic cylinder point-cloud fixture created in-process. The evidence explicitly marks fixture_source=synthetic-cylinder-fixture and colmap_executed=false.

| **Item**               | **Demonstration value**                                                                                                                               |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| Input geometry         | Synthetic cylinder point cloud; not a photographed component.                                                                                         |
| Solver                 | solve_geometry reported success; scale classification metric; units mm.                                                                               |
| Parameters             | Outer diameter 50 mm and height 100 mm estimated/derived; inner diameter 20 mm supplied by user in the fixture.                                       |
| Adapted feature recipe | One cylindrical base body plus a through-bore feature; two features total.                                                                            |
| Contract               | reforge-cad-interface v1.0 adapted document validated; no missing critical dimensions.                                                                |
| Endpoint               | POST /cad/from-reconstruction returned success.                                                                                                       |
| Exports                | STEP and STL re-import validated; STEP volume delta approximately 0%; STL volume delta approximately 0.1657% in the reconstruction-specific evidence. |

## Critical scope limit

> **DO NOT CLAIM PHOTO-TO-CAD** COLMAP was not run in this proof. No real Vision output was fed into the solver. The test proves the Reconstruction SolverResult â†’ adapter â†’ contract â†’ CAD endpoint path for a simple cylinder fixture, not the full three-engine image reconstruction workflow.

## Current adapter coverage

The solver adapter deliberately synthesises only a small set of primitive/revolved feature patterns at present: a cylindrical body from outer diameter + height, and a flange-like body for selected component types with thickness, plus a through-bore only when the solver reports an inner-diameter parameter (even if missing, so the contract can request it). General arbitrary housing, ribbed manifold, gear or multi-axis passage synthesis from a point cloud is not yet implemented by this adapter. The versioned contract can carry richer feature lists when Reconstruction can reliably provide them, but that upstream feature inference needs implementation and tests.

# 14. Upstream subsystem context for the integration team

## Vision Engine - verified work and guardrails

| **Component**                    | **Known result / state**                                                                                                                  | **Integration interpretation**                                                                               |
|----------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| SAM 2.1 Small prompted inference | Spur-gear prompted test: IoU 0.969, precision 1.0, recall 0.969, score 0.980.                                                             | Prompted segmentation is promising. Provide prompt/selection UX or API support.                              |
| SAM 2 automatic mask generation  | CPU automatic mode was slow (~547 seconds for default 32Ã—32 grid) and selected a poor/background candidate in the tested image.           | Do not make automatic largest-mask selection a production assumption. Return ambiguity/needs_user_selection. |
| OpenCV                           | 6/6 feature tests passed for flange holes/circles/ellipses, shaft lines, truncation and pixel-space outputs.                              | Treat detections as pixel-space candidates with confidence/provenance; perspective circles may be ellipses.  |
| Depth Anything V2 Small          | Real model inference passed after aspect-ratio preprocessing correction; output is relative depth, metric=false.                          | Depth is an optional shape cue only. Never emit depth_mm or use it to establish scale.                       |
| Browser/backend integration      | A prior Express/browser flow was tested with SAM2 disabled and Depth + OpenCV evidence; full enabled end-to-end flow was not established. | Keep vision feature-flagged/fail-open and validate each integration hop.                                     |

## Reconstruction Engine

- Reconstruction includes multi-view processing (COLMAP) and a SciPy geometry solver; solver parameters carry scale classification, units, classification/provenance and missing-critical-dimension data.

- The CAD adapter requires trustworthy metric scale. Metric scale can map to an absolute CAD unit envelope; relative/unknown scale is converted to scale_status=unknown and rejected by CAD rather than guessed.

- Missing critical dimensions must survive the handoff and become explicit needs-input diagnostics.

- Tithiâ€™s Reconstruction PR \#7 was merged into master on 11 Nov 2026 (per the project update); the CAD integration work consumes SolverResult rather than importing Reconstruction internals into CAD.

> **VISION PROMPT DESIGN** The earlier Vision integration brief explicitly treats SAM2 masks as hypotheses, OpenCV as pixel-space feature candidates, and Depth Anything V2 as non-metric. It also specifies a loopback Python service, feature flags, backward-compatible Node/Gemini integration and fail-open behavior. Preserve those constraints.

# 15. Recommended end-to-end workflow: image to validated CAD

This is the proposed integration path for the teammates who now connect the three subsystems. It is an implementation plan, not a claim that this entire path has already run successfully.

| **Step**                      | **Data movement**                                                                                                                                                             | **Gate / decision**                                                                                             |
|-------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| 1\. Upload + image intake     | User provides one or more views and optional known reference dimensions. Preserve image index, view identity and original dimensions.                                         | Validate format, size, orientation, blur/contrast and boundary truncation.                                      |
| 2\. Vision evidence           | SAM2 selected mask + confidence/ambiguity; OpenCV contours/circle/ellipse/line candidates in pixels; optional relative-depth preview.                                         | If mask ambiguous/low confidence, ask for selection or better image. Do not invent scale.                       |
| 3\. Scale/calibration         | Match a user-known dimension to a visible feature only when geometrically defensible; store method, mm-per-pixel, confidence and image/view context.                          | If calibration is not trustworthy, mark image evidence uncalibrated; do not claim metric dimensions.            |
| 4\. Multi-view reconstruction | Use COLMAP/multi-view geometry where real multi-view photos are available; create point cloud/reconstruction result and coordinate frame.                                     | Record whether COLMAP actually executed; estimate scale from reference/calibration/known constraints.           |
| 5\. Geometry solver           | solve_geometry returns named parameters, units, scale classification, measured/estimated classification, provenance, uncertainty where known and missing_critical_dimensions. | Do not pass relative/unknown scale to metric CAD. Missing critical parameters block modelling or request input. |
| 6\. Contract adapter          | Call interface_from_solver_result or build a contract document from solved features. Use format reforge-cad-interface v1.0.                                                   | Run both runtime contract validation and JSON Schema checks; preserve provenance and explicit operations.       |
| 7\. CAD API                   | POST /cad/from-reconstruction with interface, model=true, job_id, optional previews/output_dir; CAD validates and converts to feature recipe.                                 | On 422, return issues/missing dimensions to user; do not silently fill or retry with defaults.                  |
| 8\. Feature modelling + QA    | Execute ordered additive/subtractive/finish features, feature history, advanced geometry validation, STEP/STL and optional preview.                                           | Require valid solid, expected extents, required features and export round-trip acceptance.                      |
| 9\. Drawing + delivery        | Generate engineering drawings from validated geometry; export package/manifests and retain job provenance.                                                                    | Mark unspecified material/tolerance/GD&T; require engineering review before manufacturing release.              |

# 16. Suggested implementation roadmap for the integration team

## Workstream A - lock the contracts first

- Freeze and version the Vision evidence schema separately from the CAD contract. Keep pixel coordinates, source image index, mask confidence, feature confidence and calibration as explicit values.

- Freeze \`reforge-cad-interface\` v1.0 as the Reconstruction â†’ CAD boundary. Do not casually rename keys or weaken strict checks; use a version bump for breaking changes.

- Define a shared job envelope: job_id, component_id, source image IDs, model/version IDs, coordinate frame, units/scale state, artifact references and trace/correlation IDs.

## Workstream B - Vision to Reconstruction

- Expose Vision through an internal loopback service with VISION_PIPELINE_ENABLED=false by default, explicit timeout/concurrency limits, lazy model loading and fail-open fallback.

- Pass only compact validated visual evidence summaries to Reconstruction/Gemini; store large masks/depth arrays as bounded artifacts, not huge JSON/base64 payloads.

- Preserve each photo/view separately. Do not combine contours from different perspectives without recording the view transform and calibration.

## Workstream C - Reconstruction to CAD

- Extend the Reconstruction solver/feature inference to emit CAD-meaningful feature candidates only when supported by the point cloud and constraints; keep estimates distinct from user-measured values.

- Extend \`interface_from_solver_result()\` gradually beyond its current simple cylinder/flange patterns. First add tested families such as stepped shaft, drilled plate/flange, then multi-feature housings and manifolds.

- Emit all operation classes explicitly and use named dimensions/semantic units. Preserve missing critical dimensions rather than inventing plausible values.

- Run \`/cad/from-reconstruction\` as a separate service boundary; consume its validation and feature history to create a reviewable result.

## Workstream D - orchestration and UX

- Implement a state machine such as received â†’ vision_partial/ok â†’ reconstruction_partial/ok â†’ needs_input â†’ cad_validating â†’ cad_ready / failed.

- Show evidence warnings and provenance to the user: uncalibrated, relative scale, ambiguous mask, partial view, missing dimension, low solver confidence.

- Provide user correction points for target mask selection, reference measurement, view assignment and missing dimensions. Save each stage request/response for reproducibility.

- Add a review/approval step before PDF/STEP/STL are called engineering outputs; expose a â€œnot for manufacture until reviewedâ€ status where specifications are incomplete.

# 17. End-to-end acceptance plan and stop conditions

| **Test family**           | **Minimum acceptance evidence**                                                                                                                                            | **Stop condition**                                                                             |
|---------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Vision quality            | Prompted segmentation on representative parts; explicit ambiguity/low-confidence behavior; OpenCV pixel features with calibrated transforms; depth labelled relative-only. | Bad mask silently selected; pixels treated as mm; relative depth assigned physical units.      |
| Multi-view reconstruction | At least two or more real views with known view ordering/transforms; COLMAP run recorded; scale classification metric only when supported.                                 | COLMAP status misreported; scale unknown but CAD invoked; coordinate frame absent.             |
| Solver provenance         | Named dimensions with classification, provenance, uncertainty only where available, and missing-critical list.                                                             | Assumptions silently relabelled as measured or missing dimensions defaulted.                   |
| Contract v1.0             | JSON Schema and runtime validator agree; semantic units and count integer rule hold; missing refs/unknown scale are rejected.                                              | Schema/runtime disagreement, empty semantic unit, fractional count, unit-semantic mismatch.    |
| CAD modelling             | Feature history includes all applied/failed/skipped items; single valid solid or explicitly supported multi-solid expectation; bbox and feature expectations pass.         | Invalid solid, untracked feature failure, unexpected solid count or fabricated feature.        |
| Exports                   | STEP re-import valid; one expected solid; volume/bbox tolerances pass. STL watertight with no degenerate/nonmanifold/boundary errors as required.                          | Export exists but cannot round-trip, mesh non-watertight, severe volume drift.                 |
| Drawing                   | Correct projection convention; six views where relevant; dimensions trace to model data; no collisions/overflow; unspecified specs clearly labelled.                       | Wrong projection layout, invented tolerance/material or production-ready claim without review. |
| System resilience         | Timeouts, feature flags, fail-open/needs-input states, persisted provenance and no blocking existing app behavior.                                                         | Vision service failure breaks legacy route or leads to silent low-quality CAD.                 |

## Real photo acceptance corpus

Use known-measurement mechanical parts across at least cylinder/shaft, flange/plate, gear and complex housing families. Capture controlled multi-view photographs plus a ruler/caliper reference. Include dark, reflective, corroded, cluttered, occluded, cropped, low-resolution and multiple-object scenes. Use synthetic fixtures for exact pixel/geometry ground truth and curated licensed photos for robustness. Do not commit model weights or private user photos.

# 18. Current limitations, engineering cautions and unresolved work

- No demonstrated real photograph â†’ COLMAP â†’ SolverResult â†’ CAD run is recorded in the current proof. The cylinder test is synthetic and explicitly labelled as such.

- The current SolverResult adapter generates only simple cylinder/flange-like features. It is not yet a universal point-cloud-to-complex-feature-recipe compiler.

- SAM2 prompted mode passed a strong targeted test; automatic CPU mask generation was not reliable or fast enough for unattended default selection in the tested configuration.

- Depth Anything V2 Small outputs relative depth and cannot establish metric size or physical thickness by itself.

- Vision image evidence should enrich inference but must not replace original images or authoritative user-provided dimensions.

- The CAD drawing has geometry/dimensions and a title block but material, surface finish, tolerances and GD&T are not specified in the demonstrated housing data.

- The reference specimen fit score is based on bounding-box agreement; it is not a photo-to-CAD similarity metric.

- Reconstruction-to-CAD output previews were not required/returned in the test pair. Open STEP/STL in a CAD viewer for independent visual inspection when needed.

- The app-level APIs are Python FastAPI endpoints; Visionâ€™s earlier target design is a separate loopback FastAPI service called by the existing Node backend. The orchestration interface between them remains to be built and tested.

> **SAFE DEFAULT** When evidence is uncertain, stop at a reviewable partial result. A trustworthy needs_input response is better than a complete-looking but dimensionally fabricated CAD model.

# 19. Repository state, reproducibility and ownership

## Published Git state

| **Field**       | **Current reported value**                                                                                                                                |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Repository      | https://github.com/AdiEnigma/Reforge-ai                                                                                                                   |
| Branch          | feature/advanced-cad-upgrade                                                                                                                              |
| Commit          | c3e6787                                                                                                                                                   |
| Commit summary  | 22 files changed, 10,167 insertions.                                                                                                                      |
| Remote          | origin/feature/advanced-cad-upgrade; upstream tracking configured.                                                                                        |
| Pull request    | GitHub suggested https://github.com/AdiEnigma/Reforge-ai/pull/new/feature/advanced-cad-upgrade; PR creation/merge was not confirmed in the status shared. |
| Tests           | 283 passed, 5 warnings in the last full run (148.92 seconds).                                                                                             |
| Base commit     | The feature branch was created from master at 1c89efe (Windows path handling fix in CAD validator).                                                       |
| Warnings        | Five known Starlette deprecation warnings for HTTP_422_UNPROCESSABLE_ENTITY; use HTTP_422_UNPROCESSABLE_CONTENT in future cleanup when compatible.        |
| CAD environment | Windows dedicated CAD venv: Python 3.10.11 and CadQuery 2.7.0; do not substitute the Vision Engine venv for CAD testing.                                  |

## Final intended structure

```text
python-engine/
  app.py                         # FastAPI routes; preserved
  cad/
    cad_generator.py             # original CAD generator
    cad_validator.py             # original geometry validator
    gear_generator.py            # original gear path
    recipe_validator.py          # original recipe validation
    feature_schema.py            # advanced feature recipe v1.0
    feature_recipe_validator.py
    feature_modeller.py
    advanced_recipe_adapter.py
    advanced_cad_validator.py
    advanced_preview.py
    engineering_drawing.py
    export_validation.py
    integration_contract.py
    specimens/                   # deterministic advanced housing recipe
    scripts/                     # Phase 1 / Phase 2 generators
    artifacts/advanced-cad/      # Phase 1 and Phase 2 generated outputs
  exports/                       # shared STEP/STL exporters
  tests/                         # central Python Engine test suite
docs/CAD_INTEGRATION_CONTRACT.md
```

## Reproduction commands

```powershell
# Windows PowerShell: use the dedicated CAD virtual environment
$py = Join-Path $env:LOCALAPPDATA "ReForge-CAD-venv\Scripts\python.exe"

# From repository root
& $py .\python-engine\cad\scripts\generate_advanced_cad_demo.py
& $py .\python-engine\cad\scripts\generate_advanced_cad_demo_phase2.py

# Full test suite
Push-Location .\python-engine
& $py -m pytest -q
```

# 20. Ready-to-paste context for the teammateâ€™s AI coding assistant

Paste this block into the AI toolâ€™s project instructions or initial task context. It is intentionally strict and reflects the current implementation status.

```text
PROJECT: ReForge AI (https://github.com/AdiEnigma/Reforge-ai)
CURRENT CAD FEATURE BRANCH: feature/advanced-cad-upgrade
CURRENT CAD COMMIT: c3e6787 (pushed to origin)

SYSTEM ARCHITECTURE
ReForge has three distinct engines: Vision (SAM2/SAM2.1, OpenCV, Depth Anything V2 Small), Reconstruction (COLMAP multi-view + SciPy geometry solver), and Advanced CAD (CadQuery/OpenCASCADE). Treat them as decoupled services/modules connected by versioned JSON contracts. CAD must not directly import Vision or Reconstruction internals.

CAD STATE
The original Python CAD system is retained: python-engine/cad/cad_generator.py, cad_validator.py, gear_generator.py, recipe_validator.py, plus python-engine/exports STEP/STL exporters and POST /cad/generate. The advanced pipeline is additive. Keep all Advanced CAD implementation in python-engine/cad/. Demo scripts live in python-engine/cad/scripts/; generated demos live in python-engine/cad/artifacts/advanced-cad/{phase1,phase2}/; tests remain in python-engine/tests/; app.py remains at python-engine/app.py; human contract docs remain in docs/.

FOUR STAGES / TWO PHASES
Phase 1: Stage 1 feature-based recipe/schema and primary/additive modelling; Stage 2 subtractive internal geometry, finishing, feature history, geometry validation and previews. Phase 2: Stage 3 engineering drawings; Stage 4 STEP/STL re-import validation, mesh/drawing QA, manifests, hashes and package. Do not conflate phase and stage.

FEATURE RECIPE
Format reforge-feature-recipe v1.0. Feature types are registered into additive, subtractive and finish operation classes. Additive includes base_cylinder, base_box, revolve_profile, extrude_profile, flange, cylindrical/rectangular bosses, rib and connector. Subtractive includes through/blind/stepped bores, counterbore, countersink, circular/rectangular pockets, radial/axial ports, internal_passage, cavity, bolt_circle and hole_pattern. Finish includes fillet and chamfer. Feature order, IDs and depends_on are meaningful. Preserve history states and per-feature diagnostics.

RECONSTRUCTION -> CAD CONTRACT
The boundary is reforge-cad-interface v1.0, implemented in python-engine/cad/integration_contract.py and documented in docs/CAD_INTEGRATION_CONTRACT.md. Required envelope fields: format, version, component, units, dimensions, features. Dimensions are objects with value, semantic unit and provenance. Units/scale: metric only; scale_status must be absolute or scaled with a valid factor. unknown scale is rejected. Semantic units are length (mm/cm/m), angle (deg), count (integer >=1; accepted count aliases include count/counts/integer/pcs/pieces), and dimensionless. Empty unit strings are invalid. Each feature must carry an explicit operation consistent with the feature registry. Preserve measured/derived/user_specified/assumed/unknown provenance. Never invent confidence or uncertainty. Missing critical dimensions and unresolved references must produce explicit needs-input/rejection diagnostics. assumed dimensions are rejected by default unless allow_assumed is explicitly enabled.

APIs
POST /cad/generate remains the legacy route. POST /cad/generate-advanced accepts advanced feature recipes or supported legacy conversion. POST /cad/from-reconstruction accepts {interface: <reforge-cad-interface v1.0>, model: true, ...}, validates the contract, builds/validates/exports STEP and STL, and can optionally generate previews. Do not break existing endpoints or request schemas.

IMPORTANT VALIDATION STATUS
The last full Python Engine run passed 283 tests with 5 known Starlette deprecation warnings. The housing demo has 22/22 features applied, one valid solid, volume about 701034.334 mm^3, bbox 160x160x90 mm. Phase 2 drawing: A3, scale 1:2, first-angle, six views, 27 dimensions; material/finish/tolerances/GD&T are NOT SPECIFIED. STEP round-trip volume delta is effectively zero; STL is watertight with zero boundary/non-manifold/degenerate triangles and volume delta about 0.0297%. Export manifest 21/21 and package manifest 23/23 verified.

DO NOT OVERCLAIM
The housing is a deterministic predefined specimen, not a photo-derived model. Reconstruction-to-CAD proof used a synthetic cylinder point cloud fixture; COLMAP was NOT run; fixture metadata states colmap_executed=false. It validates the solver-result adapter + contract + endpoint + CAD path for a simple cylinder, not a true image-to-CAD production workflow. Current solver adapter only synthesizes a limited cylinder/flange-like feature set; do not assume arbitrary complex part feature reconstruction exists.

VISION GUARDRAILS
SAM2 prompted gear inference tested strongly (IoU 0.969, precision 1.0, recall 0.969); automatic CPU segmentation was slow and unreliable in the tested setup. OpenCV tests passed for pixel-space candidates. Depth Anything V2 Small is relative depth only (metric=false), never millimetres. Prompted segmentation, calibration and user-provided reference dimensions take precedence over blind automation. Keep VISION_PIPELINE_ENABLED off until end-to-end regression gates pass; preserve fail-open fallback to existing behavior.

INTEGRATION TARGET
Image intake -> Vision evidence per view -> scale/calibration evidence -> COLMAP/multi-view Reconstruction -> solve_geometry SolverResult -> interface_from_solver_result (or a feature-aware adapter) -> validate reforge-cad-interface -> POST /cad/from-reconstruction -> feature modelling -> geometry validation -> STEP/STL/drawing/export validation. Unknown scale, ambiguous segmentation or missing critical dimensions must stop automatic CAD and return needs_input. Keep provenance, job IDs, coordinate frames and artifact references through every hop.

WORK RULES FOR THIS REPOSITORY
Inspect git status and read relevant code before editing. Preserve uncommitted/user files. Do not reset/clean/delete broad paths. Keep Advanced CAD under python-engine/cad/. Do not relocate app.py, tests/, exports/ or docs/. Preserve the legacy /cad/generate route. Add tests for every contract/feature change. Use the dedicated CAD venv on Windows. Run the full Python Engine suite before claiming success. Do not stage, commit, push or merge unless explicitly asked.
```

# 21. Source materials and terminology

## Project materials reviewed

- Uploaded final review package: ReForge_Final_All_Phases_20261113_174123.zip (Phase 1/Phase 2 evidence, source_review snapshot, integration documentation and repository state).

- Phase 1 EVIDENCE.md and Phase 2 EVIDENCE.md, housing_recipe.json, housing_feature_history.json, housing_validation_report.json, housing_export_validation.json, housing_export_manifest.json, drawing/preview and integration example/schema artifacts.

- CAD integration contract source and documentation: python-engine/cad/integration_contract.py and docs/CAD_INTEGRATION_CONTRACT.md.

- ReForge_Vision_Integration_Implementation_Prompt.md describing the intended isolated Vision service, output evidence schema, fail-open integration, and acceptance tests.

- ReForge_CAD_Additional_Evidence package, including the supplemental kernel round-trip report and its explicit scope limitation.

- Latest OpenCode refactor report and terminal outputs shared in the conversation: final path layout, regenerated artifacts, schema check, 283 tests, commit c3e6787 and successful push.

## Supplemental CAD-kernel evidence - separate from ReForge app tests

An additional evidence note reports four direct CadQuery/OpenCASCADE round-trip cases (cylinder, stepped shaft, drilled plate, fused boss) passing one-solid, bounding-box, STEP round-trip and STL watertightness/volume checks. It used CadQuery 2.8.0 / Python 3.13.5 and explicitly did NOT execute ReForge cad_generator.py, cad_validator.py or the FastAPI /cad/generate route. Treat it as kernel-level supplementary evidence, not part of the 283-test suite or proof of the local app patch.

## Short glossary

| **Term**              | **Meaning in this project**                                                                                       |
|-----------------------|-------------------------------------------------------------------------------------------------------------------|
| B-Rep / solid         | Boundary-representation CAD geometry managed by CadQuery/OpenCASCADE.                                             |
| Feature recipe        | Ordered, typed sequence of modelling operations that creates or modifies the solid.                               |
| SolverResult          | Reconstruction output containing named parameters, scale, classifications, provenance and missing-dimension data. |
| Provenance            | The origin/authority of a dimension: measured, derived, user_specified, assumed or unknown.                       |
| Semantic unit         | The meaning of a numeric value: length, angle, count or dimensionless.                                            |
| Round-trip validation | Export a file, re-import it and compare geometry/mesh properties rather than trusting file creation alone.        |
| needs_input           | A deliberate state indicating the system needs a user measurement, selection or clarification before proceeding.  |

> **HANDOFF SUMMARY** The CAD upgrade is implemented, tested, committed and pushed on its feature branch. The next major engineering milestone is not another CAD rewrite: it is the disciplined, provenance-preserving orchestration of real Vision evidence and real multi-view Reconstruction output into the already-defined CAD contract.
