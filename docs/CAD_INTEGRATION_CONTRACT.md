# ReForge AI — Reconstruction → CAD Integration Contract

**Format:** `reforge-cad-interface` · **Version:** `1.0`

This document defines the stable JSON interface that the **Reconstruction
Engine** must provide to the **CAD subsystem**. It is implemented and enforced
by `python-engine/cad/integration_contract.py`.

The CAD subsystem is intentionally decoupled: it does **not** call Vision or
Reconstruction code. It consumes (or rejects) a self-describing JSON document.
A worked example that round-trips to the validated reference housing is
generated at
`python-engine/cad/artifacts/advanced-cad/phase2/integration_example_recipe.json`,
with a machine-readable schema at `integration_interface_schema.json`.

---

## 1. Top-level structure

```jsonc
{
  "format": "reforge-cad-interface",
  "version": "1.0",
  "component":  { ... },      // identity, type, geometry style
  "units":      { ... },      // metric unit + scale status
  "dimensions": { ... },      // named dimension table (value + semantic unit + provenance)
  "features":   [ ... ],      // ORDERED additive/subtractive/finish operations
  "missing_dimensions": [ ... ],
  "assumptions": [ ... ],
  "expected":   { ... },      // optional acceptance expectations
  "provenance": { ... }       // where the description came from
}
```

Required keys: `format`, `version`, `component`, `units`, `dimensions`,
`features`.

---

## 2. `component`

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Non-empty stable identifier. |
| `type` | yes | One of `housing, bracket, flange, plate, shaft, gear, enclosure, cover, bushing, manifold, custom`. Unknown values are accepted with a warning. |
| `geometry_style` | yes | One of `revolved, prismatic, revolved_with_features, extruded_profile, sheet_metal, freeform, custom`. |
| `name` | no | Human-readable name. |

---

## 3. `units`

| Field | Required | Notes |
| --- | --- | --- |
| `length` | yes | **Metric only**: `mm, cm, m` (and spelled-out variants). Non-metric is rejected. |
| `scale_status` | yes | `absolute` \| `scaled` \| `unknown`. |
| `scale_factor` | when `scaled` | Positive finite factor converting model units to real mm. |

* `absolute` — values are already true millimetres.
* `scaled` — values are in model units; multiply by `scale_factor` for mm.
* `unknown` — **rejected**: the real-world scale cannot be trusted.

---

## 4. `dimensions` — the measurement table

Every entry is an **object**; bare numbers are not permitted in v1.0:

```jsonc
"body_outer_radius": {
  "value": 45.0,
  "unit": "mm",               // semantic unit, see table below (REQUIRED)
  "provenance": "user_specified", // measured | derived | user_specified | assumed | unknown (REQUIRED)
  "uncertainty": 0.05,        // optional; only if actually known
  "confidence": 0.97,         // optional; only if actually known
  "note": "from front + top view agreement"
}
```

`value`, `unit` and `provenance` are **required** on every entry, and this is
enforced identically by the runtime validator and the published JSON Schema.

### Semantic units

Every dimension carries a **semantic unit**, and the contract validates that the
declared unit matches the way the dimension is *used* by the feature
parameters that reference it. Counts must be integers, angles are in **degrees**,
lengths are **metric**, and everything else is dimensionless.

| Semantic class | Canonical unit token | Accepted spellings | Constraint |
| --- | --- | --- | --- |
| length | `mm` | `mm, cm, m` (+ spelled out) | metric only; scaled to mm on normalise |
| angle | `deg` | `deg, degree, degrees` | finite; outside `0–360` warns |
| count | `count` | `count, counts, integer, pcs, pieces` | must be an **integer ≥ 1** |
| dimensionless | `dimensionless` | `dimensionless, none, ratio, 1` | finite number |

The semantic class of a parameter is fixed by the deterministic registry in
`cad/feature_recipe_validator.py` (`parameter_semantic(type, key)`), derived from
`_PARAM_SPEC`. A dimension referenced by two parameters with **conflicting**
semantic classes is rejected. In particular, angle parameters
(`*AngleDeg`, e.g. `boss_rectangular.angleDeg`, `bolt_circle.startAngleDeg`) are
**never** length-scaled, and count parameters (`bolt_circle.count`) must be
integers.

Reliability rules applied to **referenced** dimensions. Structural problems
(missing / non-finite `value`, missing or unknown `unit`, missing or unknown
`provenance`) are **always** hard errors — even for dimensions no feature
references — so the runtime stays consistent with the published JSON Schema.
Reliability and semantic-mismatch problems are errors for referenced dimensions
and warnings otherwise:

| Condition | Referenced | Unreferenced |
| --- | --- | --- |
| missing / non-finite `value` | error | error |
| missing or unknown `unit` | error | error |
| missing or unknown `provenance` | error | error |
| `provenance == "unknown"` | error | warning |
| `provenance == "assumed"` | error unless `allow_assumed=True` | warning |
| `confidence < min_confidence` (default `0.5`) | error | warning |
| `uncertainty / \|value\| > max_rel_uncertainty` (default `0.2`) | error | warning |
| declared `unit` disagrees with how the dimension is used | error | warning |
| count dimension is not an integer | error | warning |
| value `<= 0` where a length is required | error (recipe validator) | — |

---

## 5. `features` — ordered operations

Each feature:

```jsonc
{
  "id": "f07",
  "type": "radial_port",              // any type from cad/feature_schema.py
  "operation": "subtractive",         // additive | subtractive | finish
  "parameters": {
    "diameter": { "$dim": "f07__diameter" },
    "angleDeg": 0.0,
    "z": 70.0,
    "startRadius": 62.0,
    "depth": 62.0
  },
  "position":    { "x": 0, "y": 0, "z": 0 },
  "orientation": { "axis": [0, 0, 1], "angleDeg": 0 },
  "depends_on": ["f01"],
  "metadata": {}
}
```

* **Ordering** is significant: features are applied in array order (the
  validator additionally re-orders to satisfy `depends_on`).
* **Operation class** (`additive` / `subtractive` / `finish`) is a **required
  field** on every feature (the JSON Schema lists it in `feature.required`). It
  must agree with the deterministic feature-type registry
  (`cad/feature_schema.py::FEATURE_OPERATION`, exposed as
  `operation_for_type(type)`); a missing, blank, invalid or mismatching
  `operation` is an error. The contract derives the *expected* operation from
  `type` only to produce a precise diagnostic — it does not silently fill one in.
* A parameter value may be a **dimension reference** `{"$dim": "<name>"}` (or
  `{"dimension": "<name>"}`). References are resolved from `dimensions`;
  a missing reference is an explicit error, never a silent default.
* Nested structures (e.g. `stepped_bore.segments`, `internal_passage.start`)
  are passed through literally and unit-normalised by the recipe validator.
* Positions/orientations are recorded as metadata; the geometry is driven by
  `parameters`.

---

## 6. Rejection behaviour (never invent)

`validate_interface(doc)` returns:

```jsonc
{
  "valid": false,
  "status": "rejected" | "needs_input" | "ok",
  "issues": [ "...explicit diagnostics..." ],
  "warnings": [ ... ],
  "missing_dimensions": [ ... ],
  "unreliable_dimensions": [ ... ],
  "dimension_semantics": { "body_outer_radius": ["length"] },
  "recipe": null,          // FeatureRecipe on success
  "recipe_dict": null,
  "diagnostics": { "recipe_status": "...", "recipe_errors": [...], ... }
}
```

A document is accepted only when the envelope is complete **and** the built
feature recipe passes `validate_feature_recipe` with status `ok`. No missing
dimension is ever defaulted, and an `assumed` dimension is refused unless the
caller explicitly opts in.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `allow_assumed` | `False` | Accept `provenance == "assumed"` dimensions. |
| `min_confidence` | `0.5` | Minimum accepted per-dimension confidence. |
| `max_rel_uncertainty` | `0.2` | Maximum accepted `uncertainty / value`. |

---

## 7. Usage

```python
from cad.integration_contract import (
    validate_interface, interface_json_schema, example_housing_interface,
)

result = validate_interface(document)          # or feature_recipe_from_interface
if result["valid"]:
    recipe = result["recipe"]                  # FeatureRecipe, ready to model
else:
    print(result["issues"])                    # explicit, actionable diagnostics
```

Reverse direction (CAD → contract shape), used to build the worked example:

```python
from cad.integration_contract import interface_from_recipe
doc = interface_from_recipe(recipe_dict, provenance="user_specified")
```

### Reconstruction `SolverResult` → contract

The Reconstruction Engine's `solve_geometry(...)` returns a `SolverResult`.
`interface_from_solver_result` maps it into a contract document **truthfully**:

```python
from cad.integration_contract import interface_from_solver_result
doc = interface_from_solver_result(solver_result, component_type="shaft")
```

* Solver `units` / `scale_classification` are preserved: metric → `absolute`;
  `relative`/`unknown` → `scale_status = "unknown"` (which the contract then
  **rejects** rather than inventing a real-world size).
* Each parameter's `classification` (`MEASURED`/`ESTIMATED`/`UNKNOWN`) and
  `provenance` list drive the interface `provenance`; no confidence or
  uncertainty is fabricated (uncertainty is copied only when the solver set it).
* `missing_critical_dimensions` are carried into `missing_dimensions` **and**
  referenced by the synthesised feature, so an incomplete result is rejected with
  a clear `needs_input` diagnostic.
* Only cylinder/flange features are synthesised from the dimensions the solver
  actually determined; nothing is invented for values it could not determine.
* **Truthful fixture provenance.** The Reconstruction cylinder branch stamps a
  point-cloud fit `COLMAP_RECONSTRUCTION` even when the points did not come from
  a real COLMAP run (e.g. the deterministic synthetic fixture used by the
  integration tests). A caller that knows the true source calls
  `record_fixture_source(solver_result, source=..., colmap_executed=False)`; the
  adapter then re-labels those parameters `SYNTHETIC_FIXTURE` and records
  `fixture_source` / `colmap_executed` / `solver_input_note` in the interface
  `provenance`. Parameter **classifications** (`ESTIMATED` for the fitted outer
  diameter / height, `MEASURED` for the `USER_PROVIDED` inner diameter) are
  never changed, so the estimated-vs-measured distinction is preserved.

### Worked examples

* `python-engine/cad/artifacts/advanced-cad/phase2/integration_example_recipe.json`
  — the reference housing, generated by `interface_from_recipe` with truthful
  `user_specified` provenance and no fabricated confidence.
* `python-engine/cad/artifacts/advanced-cad/phase2/reconstruction_to_cad_request.json`
  and `..._response.json` — an actual `SolverResult` from a known cylinder,
  adapted via `interface_from_solver_result` and posted through
  `POST /cad/from-reconstruction`.

---

## 8. Scope

This task delivers a **dependable, independently testable CAD subsystem** and a
documented contract. Wiring the live Vision → Reconstruction → CAD path is
deliberately **out of scope** here; the contract above is the integration point.
