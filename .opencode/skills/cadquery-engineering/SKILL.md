---
name: cadquery-engineering
description: CadQuery architecture, APIs, workplanes, sketches, extrude/revolve/sweep/loft, boolean operations, holes/patterns/fillets/chamfers, gear generation (with optional cq_gears), OpenCASCADE validation, STEP/STL/mesh exports, and error handling for failed geometry operations.
---

# CadQuery Engineering

## Purpose

Ensure reliable parametric CAD generation using CadQuery and OpenCASCADE. Provide the AI agent with a complete understanding of CadQuery's data model, API surface, and operation dispatch so it can generate editable, valid CAD solids rather than arbitrary meshes.

## When to use

- Generating CAD from validated recipes (`generate_cad`, `generate_advanced_cad`).
- Validating generated geometry (`validate_cad_geometry`, `_verify_workplane_integrity`).
- Building specific geometric styles (revolved, extruded, combination, gear).
- Exporting to STEP, STL, IGES, Parasolid formats.
- Checking solid validity, volume, bounding box, bores, passages, features.

## Project context

The ReForge AI system relies on **CadQuery** for producing real B-rep solids from feature trees. The legacy `cad_generator.py` dispatches to four styles:

| Style | Dispatch function |
|------|-------------------|
| revolved | `_build_revolved_geometry` → `cq.Workplane("XZ").polyline().close().revolve(...)` |
| extruded | `_build_extruded_geometry` → `cq.Workplane("XY").polyline().close().extrude(depth)` |
| combination | `_build_combination_geometry` → Boolean union of primitives |
| gear | `_build_gear_geometry` → delegates to `gear_generator.generate_gear()` (currently unimplemented) |

Key modules:
- `python-engine/cad/cad_generator.py` — primary entry point (`generate_cad`), supports `style`.
- `python-engine/cad/advanced_recipe_adapter.py` — bridges legacy recipes to advanced feature recipes.
- `python-engine/cad/feature_schema.py` — versioned feature recipe schema (dataclasses).
- `python-engine/cad/feature_modeller.py` — modeller that turns feature lists into workplanes.
- `python-engine/cad/advanced_preview.py` — SVG/PNG preview rendering.
- `python-engine/cad/integration_contract.py` — integration contract definitions.
- `python-engine/cad/export_validation.py` — export manifest / file validation.
- `python-engine/cad/advanced_cad_validator.py` — advanced geometry validation.

### CadQuery API basics

```python
import cadquery as cq

wp = cq.Workplane("XY")   # or "XZ", "YX", etc.
solid = wp.solids()       # list of Solid objects
solids = wp.solids().vals()  # all vals()
```

Operations (from `cad_generator._build_*`):
- **Revolved**: `revolve(angle=360, profile_points=[...], axis=(0,0,1))`
- **Extruded**: `extrude(outline_points, depth)`
- **Combination**: `union([prim_wp])` per primitive
- **Holes**: `faces(">Z").workplane().pushPoints([(cx,cy)]).hole(diameter)`
- **Primitives**: `box(width, height, depth)`, `cylinder(height, radius)`, `sphere(radius)`, `cone(r1, r2, h)`, `torus(outerR, tube)`, etc.

### Workplane integrity checks

`_verify_workplane_integrity(wp, style, expected_solids=None)` raises `CadGenerationError` if:
- `wp is None`
- No solids found (`len(solids) == 0`)
- Expected solid count mismatches (`expected_solids`)

Also verifies bounding box non-degeneracy (`bb.xlen > 0 && bb.ylen > 0 && bb.zlen > 0`).

### Extrusion & hole drilling

- Outline must have ≥3 points; redundant closing point removed.
- Holes drilled through top face along -Z: `wp.faces(">Z").workplane().pushPoints([(cx,cy)]).hole(diameter)`.
- Depth required positive; defaults to 10mm if missing.

### Gear delegation boundary

`python-engine/cad/cad_generator.py` calls `_build_gear_geometry` which tries `from cad import gear_generator` or `import gear_generator`. If neither is available or lacks `generate_gear()`, raises `CadGenerationError`:
> "Gear generation is not yet implemented (gear_generator.py is currently empty)."

This is an intentional gap — implement via `cad_generator._build_gear_geometry` once `gear_generator` exists.

### Exported formats

- **STEP** (.step, AP214/AP203)
- **IGES** (.iges)
- **Parasolid Text** (.x_t)
- **Parasolid Binary** (.x_b)
- **ACIS** (.sat)
- **JT** (.jt)
- **Fusion 360** (.f3d)
- **Inventor Part/Drawing** (.ipt, .iam)
- **SOLIDWORKS** (.sldprt, .sldasm)
- **CATIA** (.CATPart, .CATProduct, .CATAssembly)
- **Rhino** (.3dm)
- **FreeCAD** (.FCStd)
- **STL** (.stl), **OBJ**, **3MF**, **GLB**, **glTF**, **FBX**, **PLY**, **USDZ**
- **DXF**, **DWG**, **SVG**, **PDF**, **AFT**, **EPS**, **NC**, **GCODE**, **APT**, **TAP**

### Error handling

- `CadGenerationError` raised with `message`, optional `style`, optional `details`.
- `to_dict()` returns `{error, style, details}`.
- Validation functions raise structured errors with status codes (400, 422, 500).

## Best practices

1. **Always verify before generating** — Call `_verify_workplane_integrity` after each build step.
2. **Use existing feature types** — Stick to types in `frontend/src/lib/features.js`.
3. **Handle gear separately** — Implement `gear_generator.generate_gear()` first; the rest depends on it.
4. **Check bbox and solid count** — Both are mandatory for production output.
5. **Avoid meshes** — Prefer editable CAD solids produced by CadQuery.
6. **Respect units** — Default `"mm"`; convert only when evidence provides mm.
7. **Validate before export** — Use `export_validation.validate_export_manifest` and `validate_stl_export`.

## Common mistakes to avoid

- Using arbitrary mesh generation instead of CadQuery solids.
- Forgetting to call `_verify_workplane_integrity` before trusting the output.
- Relying on visual plausibility over geometric correctness.
- Ignoring gear generation until `gear_generator` is available.
- Mixing legacy and advanced pipelines without conversion via `legacy_recipe_to_feature_recipe`.

## Validation checklist

- [ ] Styles supported: revolved, extruded, combination, gear.
- [ ] All four builder functions exist and produce exactly one solid.
- [ ] Workplane integrity verified (non-empty, correct solid count, bbox valid).
- [ ] Hole drilling uses correct through-face axis.
- [ ] Gear delegation correctly routes to `gear_generator.generate_gear()`.
- [ ] Exports cover STEP, STL, OBJ, GLB, FBX, etc.
- [ ] Feature tree preserves history and dependencies.
- [ ] `to_dict()` serialization works for both exceptions and success paths.