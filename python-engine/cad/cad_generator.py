"""
cad_generator.py — Parametric 3D CAD Geometry Generator for ReForge AI.

Consumes a validated CadSpec from Step 1 (recipe_validator.py).
Dispatches geometry generation based on style:
- Revolved: Revolved solid from (radius, z) profile points around Z axis.
- Extruded: 2D polygon outline extruded to depth, with optional through-holes.
- Combination: 3D CSG primitives combined via Boolean union (verified exactly 1 solid).
- Gear: Clear delegation boundary to gear_generator.py (structured error if unimplemented).

Returns:
    (cq.Workplane, feature_tree)
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple, Union

import cadquery as cq

# Support imports both when run as a package (python-engine.cad) and with pythonpath set
try:
    from recipe_validator import CadSpec, validate_recipe
except ImportError:
    try:
        from ..recipe_validator import CadSpec, validate_recipe
    except ImportError:
        from python_engine.recipe_validator import CadSpec, validate_recipe

logger = logging.getLogger("reforge.cad.cad_generator")


# ---------------------------------------------------------------------------
# Exceptions & Error Handling
# ---------------------------------------------------------------------------

class CadGenerationError(Exception):
    """Structured error raised when CAD geometry generation fails."""

    def __init__(self, message: str, style: Optional[str] = None, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.style = style
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "error": self.message,
            "style": self.style,
            "details": self.details,
        }


# ---------------------------------------------------------------------------
# Integrity Checks
# ---------------------------------------------------------------------------

def _verify_workplane_integrity(wp: cq.Workplane, style: str, expected_solids: Optional[int] = None) -> List[cq.Solid]:
    """
    Verifies that the generated CadQuery Workplane contains valid non-empty geometry.
    """
    if wp is None:
        raise CadGenerationError(f"Generated workplane is None for style '{style}'.", style=style)

    solids = wp.solids().vals()
    if not solids:
        raise CadGenerationError(f"Generated geometry contains 0 solids for style '{style}'.", style=style)

    if expected_solids is not None and len(solids) != expected_solids:
        raise CadGenerationError(
            f"Geometry for style '{style}' expected {expected_solids} solid(s), but found {len(solids)}.",
            style=style,
            details={"solids_found": len(solids), "expected_solids": expected_solids},
        )

    # Check bounding box validity
    try:
        bb = wp.val().BoundingBox()
        if bb.xlen <= 0 and bb.ylen <= 0 and bb.zlen <= 0:
            raise CadGenerationError(f"Generated geometry has degenerate bounding box for style '{style}'.", style=style)
    except Exception as e:
        if isinstance(e, CadGenerationError):
            raise
        raise CadGenerationError(f"Failed to calculate bounding box for style '{style}': {str(e)}", style=style)

    return solids


# ---------------------------------------------------------------------------
# Geometry Builders
# ---------------------------------------------------------------------------

def _build_revolved_geometry(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Revolves a closed profile defined in (radius, z) through 360 degrees around global Z.
    Profile points in spec['revolvedProfile'] are dicts with {'z', 'radius'}.
    """
    raw_profile = spec.get("revolvedProfile")
    if not raw_profile or len(raw_profile) < 2:
        raise CadGenerationError("Revolved geometry requires at least 2 profile points.", style="revolved")

    # In CadQuery XZ workplane, local X is global X (radial distance), local Y is global Z.
    # To form a valid closed 2D polygon for revolving around Z (local Y), the profile is closed:
    # (0, z_min) -> (r_0, z_0) -> ... -> (r_n, z_n) -> (0, z_max) -> (0, z_min)
    z_min = raw_profile[0]["z"]
    z_max = raw_profile[-1]["z"]

    pts: List[Tuple[float, float]] = []
    # Start on rotation axis at bottom
    pts.append((0.0, z_min))
    for pt in raw_profile:
        r = float(pt["radius"])
        z = float(pt["z"])
        # Avoid duplicate point if already at axis
        if not (abs(r) < 1e-9 and (abs(z - z_min) < 1e-9 or abs(z - z_max) < 1e-9)):
            pts.append((r, z))
    # Close on rotation axis at top
    if abs(pts[-1][0]) > 1e-9:
        pts.append((0.0, z_max))

    try:
        # Construct profile on XZ plane and revolve 360 deg around local Y axis (global Z)
        # Revolve axis from (0, 0, 0) to (0, 1, 0) on XZ plane corresponds to global Z axis
        wp = (
            cq.Workplane("XZ")
            .polyline(pts)
            .close()
            .revolve(360, (0.0, 0.0, 0.0), (0.0, 1.0, 0.0))
        )
    except Exception as e:
        raise CadGenerationError(f"Failed to construct revolved solid: {str(e)}", style="revolved")

    _verify_workplane_integrity(wp, style="revolved", expected_solids=1)

    feature_tree = {
        "style": "revolved",
        "parameters": {
            "num_profile_points": len(raw_profile),
            "z_min": z_min,
            "z_max": z_max,
        },
        "operations": [
            {
                "type": "revolve",
                "plane": "XZ",
                "axis": "(0, 0, 0) to (0, 1, 0) [global Z]",
                "angle": 360.0,
                "profile_points": pts,
            }
        ],
    }

    return wp, feature_tree


def _build_extruded_geometry(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Extrudes a 2D closed polygon outline along +Z to specified depth.
    Applies circular through-holes if specified.
    """
    raw_outline = spec.get("outline")
    if not raw_outline or len(raw_outline) < 3:
        raise CadGenerationError("Extruded geometry requires at least 3 outline points.", style="extruded")

    depth = spec.get("depth")
    if depth is None or depth <= 0:
        raise CadGenerationError(f"Extruded geometry requires a positive depth (received: {depth}).", style="extruded")

    outline_pts: List[Tuple[float, float]] = [(float(pt["x"]), float(pt["y"])) for pt in raw_outline]
    # Remove redundant closing point if provided
    if len(outline_pts) > 3 and outline_pts[0] == outline_pts[-1]:
        outline_pts.pop()

    try:
        wp = cq.Workplane("XY").polyline(outline_pts).close().extrude(float(depth))
    except Exception as e:
        raise CadGenerationError(f"Failed to extrude outline: {str(e)}", style="extruded")

    operations = [
        {
            "type": "extrude",
            "plane": "XY",
            "depth": float(depth),
            "outline_points": outline_pts,
        }
    ]

    # Process holes
    raw_holes = spec.get("holes", [])
    if raw_holes:
        for idx, h in enumerate(raw_holes):
            cx = float(h["cx"])
            cy = float(h["cy"])
            radius = float(h["radius"])
            diameter = 2.0 * radius
            try:
                # Drill through-hole on top face along -Z
                wp = wp.faces(">Z").workplane().pushPoints([(cx, cy)]).hole(diameter)
            except Exception as e:
                raise CadGenerationError(
                    f"Failed to cut hole at index {idx} (cx={cx}, cy={cy}, r={radius}): {str(e)}",
                    style="extruded",
                )
            operations.append({
                "type": "hole",
                "position": (cx, cy),
                "radius": radius,
                "diameter": diameter,
                "depth": "through",
            })

    _verify_workplane_integrity(wp, style="extruded", expected_solids=1)

    feature_tree = {
        "style": "extruded",
        "parameters": {
            "depth": float(depth),
            "num_outline_points": len(outline_pts),
            "num_holes": len(raw_holes),
        },
        "operations": operations,
    }

    return wp, feature_tree


def _build_combination_geometry(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Generates supported 3D CSG primitives and combines them via Boolean union.
    Enforces that the final result contains exactly one solid (no disconnected bodies).
    """
    raw_prims = spec.get("primitives")
    if not raw_prims:
        raise CadGenerationError("Combination geometry requires at least one primitive.", style="combination")

    combined_wp: Optional[cq.Workplane] = None
    primitive_ops: List[Dict[str, Any]] = []

    for idx, p in enumerate(raw_prims):
        kind = p.get("kind")
        pos = p.get("position", {})
        rot = p.get("rotation", {})

        x = float(pos.get("x", 0.0))
        y = float(pos.get("y", 0.0))
        z = float(pos.get("z", 0.0))

        rx = float(rot.get("x", 0.0))
        ry = float(rot.get("y", 0.0))
        rz = float(rot.get("z", 0.0))

        prim_wp: Optional[cq.Workplane] = None

        if kind == "box":
            w = float(p.get("width", 10.0))
            h = float(p.get("height", 10.0))
            d = float(p.get("depth", 10.0))
            prim_wp = cq.Workplane("XY").box(w, h, d)
        elif kind == "cylinder":
            # CadQuery cylinder expects (height, radius)
            r = float(p.get("radius", 5.0))
            h = float(p.get("height", 10.0))
            prim_wp = cq.Workplane("XY").cylinder(h, r)
        elif kind == "sphere":
            r = float(p.get("radius", 5.0))
            prim_wp = cq.Workplane("XY").sphere(r)
        elif kind == "cone":
            r1 = float(p.get("radiusBottom", p.get("radius", 10.0)))
            r2 = float(p.get("radiusTop", 0.0))
            h = float(p.get("height", 20.0))
            cone_solid = cq.Solid.makeCone(r1, r2, h)
            prim_wp = cq.Workplane("XY").newObject([cone_solid])
        elif kind == "torus":
            r1 = float(p.get("radius", 20.0))
            r2 = float(p.get("tube", 5.0))
            torus_solid = cq.Solid.makeTorus(r1, r2)
            prim_wp = cq.Workplane("XY").newObject([torus_solid])
        else:
            raise CadGenerationError(
                f"Unsupported primitive kind '{kind}' at index {idx}.",
                style="combination",
                details={"primitive_index": idx, "kind": kind},
            )

        # Apply rotation (in degrees) around X, Y, Z if non-zero
        if rx != 0.0:
            prim_wp = prim_wp.rotate((0, 0, 0), (1, 0, 0), rx)
        if ry != 0.0:
            prim_wp = prim_wp.rotate((0, 0, 0), (0, 1, 0), ry)
        if rz != 0.0:
            prim_wp = prim_wp.rotate((0, 0, 0), (0, 0, 1), rz)

        # Apply translation
        if x != 0.0 or y != 0.0 or z != 0.0:
            prim_wp = prim_wp.translate((x, y, z))

        primitive_ops.append({
            "index": idx,
            "kind": kind,
            "position": (x, y, z),
            "rotation": (rx, ry, rz),
            "parameters": {k: v for k, v in p.items() if k not in ("kind", "position", "rotation")},
        })

        if combined_wp is None:
            combined_wp = prim_wp
        else:
            try:
                combined_wp = combined_wp.union(prim_wp)
            except Exception as e:
                raise CadGenerationError(
                    f"Boolean union failed for primitive at index {idx} ({kind}): {str(e)}",
                    style="combination",
                    details={"primitive_index": idx, "kind": kind},
                )

    if combined_wp is None:
        raise CadGenerationError("No primitives were generated for combination geometry.", style="combination")

    # Verify that the final union contains exactly 1 solid
    _verify_workplane_integrity(combined_wp, style="combination", expected_solids=1)

    feature_tree = {
        "style": "combination",
        "parameters": {
            "num_primitives": len(raw_prims),
        },
        "operations": [
            {
                "type": "boolean_union",
                "primitives": primitive_ops,
            }
        ],
    }

    return combined_wp, feature_tree


def _build_gear_geometry(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Gear delegation boundary. Delegates to gear_generator.py if implemented.
    """
    # Check if gear_generator module is available and implemented
    try:
        from cad import gear_generator  # type: ignore
    except ImportError:
        try:
            import gear_generator  # type: ignore
        except ImportError:
            gear_generator = None

    if gear_generator is None or not hasattr(gear_generator, "generate_gear"):
        raise CadGenerationError(
            "Gear generation is not yet implemented (gear_generator.py is currently empty).",
            style="gear",
            details={"gear_generator_available": False},
        )

    return gear_generator.generate_gear(spec)


# ---------------------------------------------------------------------------
# Public Generator Dispatch
# ---------------------------------------------------------------------------

DISPATCH_TABLE = {
    "revolved": _build_revolved_geometry,
    "extruded": _build_extruded_geometry,
    "combination": _build_combination_geometry,
    "gear": _build_gear_geometry,
}


def generate_cad(cad_spec_or_recipe: Union[CadSpec, Dict[str, Any]]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Primary CAD geometry generation function.

    Accepts either:
    1. A validated CadSpec instance (recommended).
    2. A raw recipe dict (which is first validated using recipe_validator).

    Returns:
        (cq.Workplane, feature_tree)

    Raises:
        CadGenerationError: On invalid specification, unsupported style, or geometry generation failure.
    """
    if isinstance(cad_spec_or_recipe, CadSpec):
        cad_spec = cad_spec_or_recipe
    elif isinstance(cad_spec_or_recipe, dict):
        cad_spec = validate_recipe(cad_spec_or_recipe)
    else:
        raise CadGenerationError(
            f"Expected CadSpec or recipe dict, received: {type(cad_spec_or_recipe).__name__}."
        )

    if cad_spec.status == "rejected":
        error_msg = "; ".join(cad_spec.errors) if cad_spec.errors else "Recipe validation was rejected."
        raise CadGenerationError(f"Cannot generate CAD from rejected CadSpec: {error_msg}")

    if cad_spec.status == "needs_input":
        missing_msg = ", ".join(cad_spec.missing) if cad_spec.missing else "Required parameters missing."
        raise CadGenerationError(f"Cannot generate CAD from incomplete CadSpec: Missing {missing_msg}")

    spec = cad_spec.spec
    style = spec.get("style")

    if not style:
        raise CadGenerationError("CadSpec does not specify a component geometry style.")

    builder = DISPATCH_TABLE.get(style)
    if not builder:
        raise CadGenerationError(
            f"Unsupported component style '{style}'. Supported styles: {list(DISPATCH_TABLE.keys())}.",
            style=style,
        )

    return builder(spec)

