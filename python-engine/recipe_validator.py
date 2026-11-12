"""
recipe_validator.py — Recipe Validation and Normalization Layer for ReForge AI.

Conforms to Step 1 of the CAD Implementation Plan.
Pure-Python validation and normalization layer:
- Validates incoming recipe data against RECIPE_LIMITS.
- Normalizes specification values into millimeters.
- Enforces radius validity (> 0, finite, reject 0/negative/NaN).
- Merges parameters across recipe, solver_result, and user_dims with explicit provenance.
- Applies the verified 1000x dimension-ratio clamp.
- Validates 2D outlines for self-intersection (pure Python).
- Validates hole containment within outline (center and radius boundary inside polygon).
- Produces a structured CadSpec with status in ('ok', 'needs_input', 'rejected').

DO NOT import CadQuery or perform CAD operations in this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

# ---------------------------------------------------------------------------
# Constants matching backend/gemini.js and backend/geometry-volume.js
# ---------------------------------------------------------------------------
COMPONENT_STYLES = ("revolved", "extruded", "gear", "combination")
PRIMITIVE_KINDS = ("box", "cylinder", "sphere", "cone", "torus")

RECIPE_LIMITS = {
    "maxProfilePoints": 200,
    "maxOutlinePoints": 200,
    "maxHoles": 50,
    "maxPrimitives": 30,
    "maxDimensionRatio": 1000,
}

# Unit conversion factors to millimeters (mm)
UNIT_CONVERSION_TO_MM = {
    "mm": 1.0,
    "millimeter": 1.0,
    "millimeters": 1.0,
    "cm": 10.0,
    "centimeter": 10.0,
    "centimeters": 10.0,
    "m": 1000.0,
    "meter": 1000.0,
    "meters": 1000.0,
    "in": 25.4,
    "inch": 25.4,
    "inches": 25.4,
}

# Provenance sources
PROV_USER_DIMS = "user_dims"
PROV_SOLVER_RESULT = "solver_result"
PROV_RECIPE = "recipe"
PROV_DEFAULT = "default"


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------

@dataclass
class CadSpec:
    """Structured result of recipe validation and normalization."""
    spec: Dict[str, Any] = field(default_factory=dict)
    merged_parameters: Dict[str, Any] = field(default_factory=dict)
    provenance: Dict[str, str] = field(default_factory=dict)
    status: str = "rejected"  # 'ok' | 'needs_input' | 'rejected'
    missing: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Numeric & Geometric Helpers
# ---------------------------------------------------------------------------

def _clean_number(val: Any) -> Optional[float]:
    """Return float if finite, None if invalid/nan/inf."""
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _segments_intersect(
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float],
    p4: Tuple[float, float],
) -> bool:
    """
    Check if line segment p1-p2 properly intersects segment p3-p4.
    Excludes shared endpoints (e.g. adjacent edges in polygon).
    """
    def ccw(a: Tuple[float, float], b: Tuple[float, float], c: Tuple[float, float]) -> float:
        return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])

    d1 = ccw(p3, p4, p1)
    d2 = ccw(p3, p4, p2)
    d3 = ccw(p1, p2, p3)
    d4 = ccw(p1, p2, p4)

    # Proper intersection test (signs strictly opposite)
    if ((d1 > 1e-9 and d2 < -1e-9) or (d1 < -1e-9 and d2 > 1e-9)) and \
       ((d3 > 1e-9 and d4 < -1e-9) or (d3 < -1e-9 and d4 > 1e-9)):
        return True

    return False


def check_polygon_self_intersection(points: Sequence[Tuple[float, float]]) -> bool:
    """
    Returns True if the 2D polygon defined by vertices has any self-intersecting edges.
    Points should form a closed loop.
    """
    n = len(points)
    if n < 3:
        return False

    edges = []
    for i in range(n):
        p1 = points[i]
        p2 = points[(i + 1) % n]
        edges.append((p1, p2))

    num_edges = len(edges)
    for i in range(num_edges):
        for j in range(i + 1, num_edges):
            # Ignore adjacent edges (sharing vertex)
            if abs(i - j) <= 1 or abs(i - j) == num_edges - 1:
                continue
            if _segments_intersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1]):
                return True
    return False


def point_in_polygon(pt: Tuple[float, float], polygon: Sequence[Tuple[float, float]]) -> bool:
    """
    Ray-casting algorithm to test if pt is strictly inside the closed polygon.
    Uses the standard Jordan curve theorem (even-odd rule) casting a ray to +x.
    """
    x, y = pt
    inside = False
    n = len(polygon)
    if n < 3:
        return False

    p1x, p1y = polygon[-1]
    for p2x, p2y in polygon:
        # Check if the horizontal ray at y crosses the edge between p1 and p2
        if (p1y > y) != (p2y > y):
            xinters = (p2x - p1x) * (y - p1y) / (p2y - p1y) + p1x
            if x < xinters:
                inside = not inside
        p1x, p1y = p2x, p2y

    return inside


def circle_inside_polygon(
    cx: float, cy: float, radius: float, polygon: Sequence[Tuple[float, float]]
) -> bool:
    """
    Check if a circle (cx, cy, radius) is fully inside polygon.
    Requires center inside, plus cardinal / diagonal perimeter test points inside.
    """
    if not point_in_polygon((cx, cy), polygon):
        return False

    # Check 8 perimeter points on circle boundary
    num_samples = 8
    for i in range(num_samples):
        theta = 2.0 * math.pi * i / num_samples
        px = cx + radius * math.cos(theta)
        py = cy + radius * math.sin(theta)
        if not point_in_polygon((px, py), polygon):
            return False

    return True


# ---------------------------------------------------------------------------
# Primary Validation Function
# ---------------------------------------------------------------------------

def validate_recipe(
    recipe: Any,
    solver_result: Optional[Union[Dict[str, Any], Any]] = None,
    user_dims: Optional[Dict[str, Any]] = None,
) -> CadSpec:
    """
    Validate and normalize recipe data.

    Parameters:
    - recipe: Raw recipe dictionary (or object with recipe structure).
    - solver_result: Solver result dictionary or SolverResult instance.
    - user_dims: Ground-truth user dimensions dictionary.

    Returns:
    - CadSpec object.
    """
    warnings: List[str] = []
    errors: List[str] = []
    missing: List[str] = []
    merged_params: Dict[str, Any] = {}
    provenance: Dict[str, str] = {}
    spec: Dict[str, Any] = {}

    # Basic recipe check
    if not isinstance(recipe, dict):
        errors.append("Recipe must be a valid dictionary/object.")
        return CadSpec(
            spec={},
            merged_parameters={},
            provenance={},
            status="rejected",
            missing=["recipe"],
            warnings=warnings,
            errors=errors,
        )

    # 1. Parameter Merging with Precedence
    # Extract solver parameters dict if solver_result is passed
    solver_params: Dict[str, Any] = {}
    solver_units: str = "mm"
    if solver_result:
        if isinstance(solver_result, dict):
            raw_p = solver_result.get("parameters", {})
            solver_units = solver_result.get("units", "mm")
        elif hasattr(solver_result, "parameters"):
            raw_p = solver_result.parameters
            solver_units = getattr(solver_result, "units", "mm")
        else:
            raw_p = {}

        if isinstance(raw_p, dict):
            for k, v in raw_p.items():
                if isinstance(v, dict) and "value" in v:
                    val = _clean_number(v["value"])
                    if val is not None:
                        solver_params[k] = val
                else:
                    val = _clean_number(v)
                    if val is not None:
                        solver_params[k] = val

    # Merge user_dims (Priority 1)
    if user_dims and isinstance(user_dims, dict):
        for k, v in user_dims.items():
            fn = _clean_number(v)
            if fn is not None:
                merged_params[k] = fn
                provenance[k] = PROV_USER_DIMS

    # Merge solver_params (Priority 2)
    for k, v in solver_params.items():
        if k not in merged_params:
            # Normalize solver units if not mm
            unit_factor = UNIT_CONVERSION_TO_MM.get(str(solver_units).lower(), 1.0)
            merged_params[k] = v * unit_factor
            provenance[k] = PROV_SOLVER_RESULT

    # Extract recipe parameters (Priority 3)
    # Check style
    raw_style = recipe.get("style")
    if raw_style in COMPONENT_STYLES:
        spec["style"] = raw_style
    else:
        spec["style"] = None

    # Check for explicitly unsupported relative units
    raw_units = recipe.get("units")
    if raw_units is not None:
        if str(raw_units).lower() in ("relative", "unknown"):
            errors.append(f"Explicitly unsupported units declaration: '{raw_units}'. Metric units (mm) required for CAD generation.")

    # 2. Revolved Profile Validation
    raw_profile = recipe.get("revolvedProfile")
    if raw_profile is not None:
        if not isinstance(raw_profile, list):
            errors.append("revolvedProfile must be a list.")
        elif len(raw_profile) > RECIPE_LIMITS["maxProfilePoints"]:
            errors.append(
                f"revolvedProfile exceeds limit of {RECIPE_LIMITS['maxProfilePoints']} points (received {len(raw_profile)})."
            )
        else:
            clean_profile = []
            for idx, pt in enumerate(raw_profile):
                if not isinstance(pt, dict):
                    errors.append(f"Profile point at index {idx} must be a dictionary.")
                    continue
                z = _clean_number(pt.get("z"))
                radius = _clean_number(pt.get("radius"))
                if z is None or radius is None:
                    errors.append(f"Profile point at index {idx} contains non-finite z or radius.")
                    continue
                if radius < 0 or math.isnan(radius):
                    errors.append(f"Profile point at index {idx} has invalid negative or NaN radius: {radius}")
                    continue
                clean_profile.append({"z": z, "radius": radius})

            if len(clean_profile) >= 2:
                clean_profile.sort(key=lambda p: p["z"])
                spec["revolvedProfile"] = clean_profile
            elif len(raw_profile) > 0:
                errors.append("revolvedProfile must contain at least 2 valid points.")

    # 3. Outline Validation
    raw_outline = recipe.get("outline")
    outline_points_tuples: List[Tuple[float, float]] = []
    if raw_outline is not None:
        if not isinstance(raw_outline, list):
            errors.append("outline must be a list.")
        elif len(raw_outline) > RECIPE_LIMITS["maxOutlinePoints"]:
            errors.append(
                f"outline exceeds limit of {RECIPE_LIMITS['maxOutlinePoints']} points (received {len(raw_outline)})."
            )
        else:
            clean_outline = []
            for idx, pt in enumerate(raw_outline):
                if not isinstance(pt, dict):
                    errors.append(f"Outline point at index {idx} must be a dictionary.")
                    continue
                x = _clean_number(pt.get("x"))
                y = _clean_number(pt.get("y"))
                if x is None or y is None:
                    errors.append(f"Outline point at index {idx} contains non-finite x or y.")
                    continue
                clean_outline.append({"x": x, "y": y})
                outline_points_tuples.append((x, y))

            if len(clean_outline) >= 3:
                # Remove repeated closing point if present for self-intersection check
                poly = list(outline_points_tuples)
                if len(poly) > 3 and poly[0] == poly[-1]:
                    poly.pop()
                if check_polygon_self_intersection(poly):
                    errors.append("Outline polygon is self-intersecting.")
                else:
                    spec["outline"] = clean_outline
            elif len(raw_outline) > 0:
                errors.append("outline must contain at least 3 points.")

    # 4. Holes Validation & Containment
    raw_holes = recipe.get("holes")
    if raw_holes is not None:
        if not isinstance(raw_holes, list):
            errors.append("holes must be a list.")
        elif len(raw_holes) > RECIPE_LIMITS["maxHoles"]:
            errors.append(
                f"holes exceeds limit of {RECIPE_LIMITS['maxHoles']} (received {len(raw_holes)})."
            )
        else:
            clean_holes = []
            for idx, h in enumerate(raw_holes):
                if not isinstance(h, dict):
                    errors.append(f"Hole at index {idx} must be a dictionary.")
                    continue
                cx = _clean_number(h.get("cx"))
                cy = _clean_number(h.get("cy"))
                radius = _clean_number(h.get("radius"))
                if cx is None or cy is None or radius is None:
                    errors.append(f"Hole at index {idx} contains non-finite values.")
                    continue
                if radius <= 0 or math.isnan(radius):
                    errors.append(f"Hole at index {idx} has invalid non-positive or NaN radius: {radius}")
                    continue

                # Containment check if outline is present
                if "outline" in spec and len(outline_points_tuples) >= 3:
                    poly = list(outline_points_tuples)
                    if len(poly) > 3 and poly[0] == poly[-1]:
                        poly.pop()
                    if not circle_inside_polygon(cx, cy, radius, poly):
                        errors.append(f"Hole at index {idx} ({cx}, {cy}, r={radius}) falls outside outline.")
                        continue

                clean_holes.append({"cx": cx, "cy": cy, "radius": radius})
            if clean_holes:
                spec["holes"] = clean_holes

    # 5. Depth Validation
    raw_depth = recipe.get("depth")
    if raw_depth is not None:
        depth = _clean_number(raw_depth)
        if depth is not None and depth > 0:
            spec["depth"] = depth
            if "depth" not in merged_params:
                merged_params["depth"] = depth
                provenance["depth"] = PROV_RECIPE
        elif depth is not None and depth <= 0:
            errors.append(f"Extrusion depth must be strictly positive: {depth}")

    # Override depth from merged parameters if user_dims or solver provided thickness/depth
    for k in ["thickness", "depth", "height"]:
        if k in merged_params:
            spec["depth"] = merged_params[k]
            break

    # 6. Gear Validation
    raw_gear = recipe.get("gear")
    if raw_gear is not None:
        if not isinstance(raw_gear, dict):
            errors.append("gear specification must be a dictionary.")
        else:
            teeth_val = raw_gear.get("teeth")
            teeth = _clean_number(teeth_val)
            if teeth is not None and teeth >= 3:
                teeth = int(round(teeth))
            else:
                teeth = None

            module_val = _clean_number(raw_gear.get("module"))
            pa_val = _clean_number(raw_gear.get("pressureAngle")) or 20.0
            ha_val = _clean_number(raw_gear.get("helixAngle")) or 0.0
            fw_val = _clean_number(raw_gear.get("faceWidth"))
            bore_val = _clean_number(raw_gear.get("boreRadius"))

            # Check radius conventions
            if bore_val is not None and bore_val < 0:
                errors.append(f"Gear boreRadius cannot be negative: {bore_val}")
                bore_val = None

            # Merge with user_dims / solver_params for gear
            if "teeth" in merged_params:
                teeth = int(round(merged_params["teeth"]))
            elif teeth is not None and "teeth" not in merged_params:
                merged_params["teeth"] = teeth
                provenance["teeth"] = PROV_RECIPE

            if "module" in merged_params:
                module_val = merged_params["module"]
            elif module_val is not None and "module" not in merged_params:
                merged_params["module"] = module_val
                provenance["module"] = PROV_RECIPE

            if "face_width" in merged_params or "faceWidth" in merged_params:
                fw_val = merged_params.get("face_width") or merged_params.get("faceWidth")
            elif fw_val is not None and "faceWidth" not in merged_params:
                merged_params["faceWidth"] = fw_val
                provenance["faceWidth"] = PROV_RECIPE

            gear_spec: Dict[str, Any] = {}
            if teeth is not None:
                gear_spec["teeth"] = teeth
            else:
                missing.append("gear.teeth")

            if module_val is not None and module_val > 0:
                gear_spec["module"] = module_val
            else:
                missing.append("gear.module")

            gear_spec["pressureAngle"] = max(5.0, min(45.0, pa_val))
            gear_spec["helixAngle"] = max(-60.0, min(60.0, ha_val))
            if fw_val is not None and fw_val > 0:
                gear_spec["faceWidth"] = fw_val
            else:
                missing.append("gear.faceWidth")

            gear_spec["boreRadius"] = max(0.0, bore_val if bore_val is not None else 0.0)

            # Preserve measured outer diameter for gear module reconciliation
            measured_od = (
                _clean_number(merged_params.get("outer_diameter"))
                or _clean_number(merged_params.get("outerDiameter"))
                or _clean_number(raw_gear.get("outer_diameter"))
                or _clean_number(raw_gear.get("outerDiameter"))
                or _clean_number(recipe.get("outer_diameter"))
                or _clean_number(recipe.get("outerDiameter"))
            )
            if measured_od is not None and measured_od > 0:
                gear_spec["outer_diameter"] = measured_od
                if "outer_diameter" not in merged_params:
                    merged_params["outer_diameter"] = measured_od
                    provenance["outer_diameter"] = PROV_RECIPE

            spec["gear"] = gear_spec

    # 7. Primitives Validation
    raw_prims = recipe.get("primitives")
    if raw_prims is not None:
        if not isinstance(raw_prims, list):
            errors.append("primitives must be a list.")
        elif len(raw_prims) > RECIPE_LIMITS["maxPrimitives"]:
            errors.append(
                f"primitives exceeds limit of {RECIPE_LIMITS['maxPrimitives']} (received {len(raw_prims)})."
            )
        else:
            clean_prims = []
            for idx, p in enumerate(raw_prims):
                if not isinstance(p, dict) or p.get("kind") not in PRIMITIVE_KINDS:
                    continue
                pos = p.get("position", {}) if isinstance(p.get("position"), dict) else {}
                rot = p.get("rotation", {}) if isinstance(p.get("rotation"), dict) else {}
                x = _clean_number(pos.get("x")) or 0.0
                y = _clean_number(pos.get("y")) or 0.0
                z = _clean_number(pos.get("z")) or 0.0
                rx = _clean_number(rot.get("x")) or 0.0
                ry = _clean_number(rot.get("y")) or 0.0
                rz = _clean_number(rot.get("z")) or 0.0
                clean_prim: Dict[str, Any] = {
                    "kind": p["kind"],
                    "position": {"x": x, "y": y, "z": z},
                    "rotation": {"x": rx, "y": ry, "z": rz},
                }
                for dim_key in ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube", "radialSegments"]:
                    v = _clean_number(p.get(dim_key))
                    if v is not None and v > 0:
                        clean_prim[dim_key] = v
                    elif v is not None and v <= 0 and "radius" in dim_key:
                        errors.append(f"Primitive {p['kind']} has non-positive radius {dim_key}={v}")
                clean_prims.append(clean_prim)
            if clean_prims:
                spec["primitives"] = clean_prims

    # 8. Style Inference if missing
    if not spec.get("style"):
        if "gear" in spec:
            spec["style"] = "gear"
        elif "revolvedProfile" in spec:
            spec["style"] = "revolved"
        elif "outline" in spec:
            spec["style"] = "extruded"
        elif "primitives" in spec:
            spec["style"] = "combination"

    # Style-specific critical missing parameters
    style = spec.get("style")
    if style == "revolved" and "revolvedProfile" not in spec:
        missing.append("revolvedProfile")
    elif style == "extruded":
        if "outline" not in spec:
            missing.append("outline")
        if "depth" not in spec:
            missing.append("depth")
    elif style == "gear" and "gear" not in spec:
        missing.append("gear")

    # 9. 1000x Dimension-Ratio Clamp Algorithm
    # Matches backend/gemini.js:447-482 exactly
    dims: List[float] = []
    for p in spec.get("revolvedProfile", []):
        dims.append(abs(p["z"]))
        dims.append(abs(p["radius"]))
    for pt in spec.get("outline", []):
        dims.append(abs(pt["x"]))
        dims.append(abs(pt["y"]))
    for h in spec.get("holes", []):
        dims.append(abs(h["cx"]))
        dims.append(abs(h["cy"]))
        dims.append(abs(h["radius"]))
    if spec.get("depth") is not None:
        dims.append(abs(spec["depth"]))
    if "gear" in spec:
        for gk in ["module", "faceWidth", "boreRadius"]:
            val = spec["gear"].get(gk)
            if val is not None:
                dims.append(abs(val))
    for p in spec.get("primitives", []):
        for pk in ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]:
            if pk in p:
                dims.append(abs(p[pk]))

    positive = [d for d in dims if isinstance(d, (int, float)) and math.isfinite(d) and d > 0]
    if positive:
        sorted_dims = sorted(positive)
        median = sorted_dims[len(sorted_dims) // 2]
        cap = max(median * RECIPE_LIMITS["maxDimensionRatio"], 1000.0)

        # Check if any dimension exceeds cap
        exceeded = [d for d in positive if d > cap]
        if exceeded:
            warnings.append(
                f"1000x dimension-ratio clamp applied: median={median:.2f}, cap={cap:.2f}, {len(exceeded)} values clamped."
            )
            # Clip dimensions in spec
            def clip(v: Optional[float]) -> Optional[float]:
                if v is not None and isinstance(v, (int, float)) and math.isfinite(v):
                    return max(0.0, min(float(v), cap))
                return v

            for p in spec.get("revolvedProfile", []):
                p["z"] = clip(p["z"])
                p["radius"] = clip(p["radius"])
            for pt in spec.get("outline", []):
                pt["x"] = clip(pt["x"])
                pt["y"] = clip(pt["y"])
            for h in spec.get("holes", []):
                h["radius"] = clip(h["radius"])
            if spec.get("depth") is not None:
                spec["depth"] = clip(spec["depth"])
            if "gear" in spec:
                for gk in ["module", "faceWidth", "boreRadius"]:
                    if gk in spec["gear"]:
                        spec["gear"][gk] = clip(spec["gear"][gk])
            for p in spec.get("primitives", []):
                for pk in ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]:
                    if pk in p:
                        p[pk] = clip(p[pk])

    # 10. Status Determination
    # 'rejected' if any errors or no geometry whatsoever
    # 'needs_input' if no errors, but critical parameters missing
    # 'ok' if valid and complete
    if errors or not spec.get("style"):
        status = "rejected"
    elif missing:
        status = "needs_input"
    else:
        status = "ok"

    return CadSpec(
        spec=spec,
        merged_parameters=merged_params,
        provenance=provenance,
        status=status,
        missing=missing,
        warnings=warnings,
        errors=errors,
    )

