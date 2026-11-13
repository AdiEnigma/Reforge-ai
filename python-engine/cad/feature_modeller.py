"""
feature_modeller.py — Feature-based CadQuery/OpenCASCADE modelling engine.

Executes a validated :class:`~cad.feature_schema.FeatureRecipe` as an ordered
sequence of modelling operations against a single evolving solid:

* **additive** features are Boolean-unioned onto the body (the first additive
  feature seeds the base body),
* **subtractive** features are Boolean-cut from the body,
* **finish** features (fillet / chamfer) are applied to selected edges.

Every operation is checked.  A union that would produce disconnected solids, a
cut that misses the body, a degenerate result or a failed fillet/chamfer is
recorded as a *failed* feature with diagnostics instead of being silently
swapped for a fallback shape.  A complete feature history is returned so the
model can be inspected and reproduced.

Public API
----------
``model_feature_recipe(recipe, strict=False) -> (cq.Workplane, history)``
``model_feature_recipe_from_dict(recipe_dict, strict=False)``
"""

from __future__ import annotations

import logging
import math
from typing import Any, Callable, Dict, List, Optional, Tuple

import cadquery as cq
from cadquery import Vector

try:
    from cad.feature_schema import (
        Feature,
        FeatureRecipe,
        OPERATION_ADDITIVE,
        OPERATION_FINISH,
        OPERATION_SUBTRACTIVE,
    )
    from cad.feature_recipe_validator import validate_feature_recipe
except ImportError:  # pragma: no cover
    try:
        from feature_schema import (  # type: ignore
            Feature,
            FeatureRecipe,
            OPERATION_ADDITIVE,
            OPERATION_FINISH,
            OPERATION_SUBTRACTIVE,
        )
        from feature_recipe_validator import validate_feature_recipe  # type: ignore
    except ImportError:
        from python_engine.cad.feature_schema import (  # type: ignore
            Feature,
            FeatureRecipe,
            OPERATION_ADDITIVE,
            OPERATION_FINISH,
            OPERATION_SUBTRACTIVE,
        )
        from python_engine.cad.feature_recipe_validator import validate_feature_recipe  # type: ignore

logger = logging.getLogger("reforge.cad.feature_modeller")

# Volume below which a Boolean intersection is treated as "no overlap" (mm^3).
INTERSECTION_VOLUME_TOL = 1e-6


class FeatureModellingError(Exception):
    """Raised when a feature recipe cannot be modelled."""

    def __init__(self, message: str, feature_id: Optional[str] = None,
                 details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.feature_id = feature_id
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {"error": self.message, "feature_id": self.feature_id, "details": self.details}


# ---------------------------------------------------------------------------
# Low-level geometry helpers
# ---------------------------------------------------------------------------

def _wp_from_solid(solid: cq.Shape) -> cq.Workplane:
    return cq.Workplane("XY").newObject([solid])


def _fnum(params: Dict[str, Any], key: str, default: float = 0.0) -> float:
    v = params.get(key, default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


def _center_xy(params: Dict[str, Any], position: Optional[Dict[str, float]] = None) -> Tuple[float, float]:
    center = params.get("center")
    if isinstance(center, dict):
        return _fnum(center, "x", 0.0), _fnum(center, "y", 0.0)
    if position:
        return float(position.get("x", 0.0)), float(position.get("y", 0.0))
    return 0.0, 0.0


def _cyl(radius: float, p0: Tuple[float, float, float], p1: Tuple[float, float, float]) -> cq.Workplane:
    """A cylinder from p0 to p1 with the given radius (axis = p1 - p0)."""
    v = Vector(*p1) - Vector(*p0)
    h = v.Length
    if h <= 0:
        raise FeatureModellingError(f"Cylinder has zero length between {p0} and {p1}.")
    if radius <= 0:
        raise FeatureModellingError(f"Cylinder radius must be > 0 (got {radius}).")
    solid = cq.Solid.makeCylinder(radius, h, Vector(*p0), v.normalized())
    return _wp_from_solid(solid)


def _cone(r1: float, r2: float, p0: Tuple[float, float, float],
          p1: Tuple[float, float, float]) -> cq.Workplane:
    v = Vector(*p1) - Vector(*p0)
    h = v.Length
    if h <= 0:
        raise FeatureModellingError("Cone has zero height.")
    solid = cq.Solid.makeCone(r1, r2, h, Vector(*p0), v.normalized())
    return _wp_from_solid(solid)


def _box(length: float, width: float, height: float,
         center: Tuple[float, float, float] = (0.0, 0.0, 0.0),
         rz: float = 0.0) -> cq.Workplane:
    wp = cq.Workplane("XY").box(length, width, height)
    if rz:
        wp = wp.rotate((0, 0, 0), (0, 0, 1), rz)
    if center != (0.0, 0.0, 0.0):
        wp = wp.translate(center)
    return wp


def _radial_dir(angle_deg: float) -> Tuple[float, float]:
    a = math.radians(angle_deg)
    return math.cos(a), math.sin(a)


def _apply_rotation(wp: cq.Workplane, rot: Optional[Dict[str, Any]]) -> cq.Workplane:
    if not isinstance(rot, dict):
        return wp
    rx, ry, rz = _fnum(rot, "x"), _fnum(rot, "y"), _fnum(rot, "z")
    if rx:
        wp = wp.rotate((0, 0, 0), (1, 0, 0), rx)
    if ry:
        wp = wp.rotate((0, 0, 0), (0, 1, 0), ry)
    if rz:
        wp = wp.rotate((0, 0, 0), (0, 0, 1), rz)
    return wp


def _shapes_intersect(a: cq.Shape, b: cq.Shape) -> Tuple[bool, float]:
    """Return (overlaps, common_volume) for two shapes."""
    try:
        common = a.intersect(b)
        vol = common.Volume()
    except Exception:
        return False, 0.0
    if vol is None or math.isnan(vol) or math.isinf(vol):
        return False, 0.0
    return vol > INTERSECTION_VOLUME_TOL, float(vol)


# ---------------------------------------------------------------------------
# Feature tool builders (each returns a positive Workplane)
# ---------------------------------------------------------------------------

def _build_base_cylinder(f: Feature) -> cq.Workplane:
    p = f.parameters
    r = _fnum(p, "radius")
    # Mode B: centred cylinder with optional arbitrary rotation (used by the
    # legacy combination adapter).
    if "height" in p and "zStart" not in p and "zEnd" not in p:
        h = _fnum(p, "height")
        c = p.get("center") or f.position
        wp = _cyl(r, (0.0, 0.0, -h / 2.0), (0.0, 0.0, h / 2.0))
        wp = _apply_rotation(wp, p.get("rotation"))
        cx, cy, cz = float(c.get("x", 0.0)), float(c.get("y", 0.0)), float(c.get("z", 0.0))
        if (cx, cy, cz) != (0.0, 0.0, 0.0):
            wp = wp.translate((cx, cy, cz))
        return wp
    # Mode A: axis-aligned from zStart to zEnd.
    cx, cy = _center_xy(p, f.position)
    z0, z1 = _fnum(p, "zStart"), _fnum(p, "zEnd")
    if z1 <= z0:
        raise FeatureModellingError(f"base_cylinder requires zEnd > zStart ({z0} -> {z1}).")
    return _cyl(r, (cx, cy, z0), (cx, cy, z1))


def _build_base_box(f: Feature) -> cq.Workplane:
    p = f.parameters
    c = p.get("center") or f.position
    center = (float(c.get("x", 0.0)), float(c.get("y", 0.0)), float(c.get("z", 0.0)))
    rot = p.get("rotation")
    if isinstance(rot, dict) and any(_fnum(rot, k) for k in ("x", "y", "z")):
        wp = _box(_fnum(p, "length"), _fnum(p, "width"), _fnum(p, "height"), (0.0, 0.0, 0.0))
        wp = _apply_rotation(wp, rot)
        if center != (0.0, 0.0, 0.0):
            wp = wp.translate(center)
        return wp
    return _box(_fnum(p, "length"), _fnum(p, "width"), _fnum(p, "height"), center)


def _build_revolve_profile(f: Feature) -> cq.Workplane:
    profile = f.parameters.get("profile") or []
    if len(profile) < 2:
        raise FeatureModellingError("revolve_profile requires >= 2 profile points.")
    angle = _fnum(f.parameters, "angleDeg", 360.0)
    pts: List[Tuple[float, float]] = []
    z_min = float(profile[0]["z"])
    z_max = float(profile[-1]["z"])
    pts.append((0.0, z_min))
    for pt in profile:
        r, z = float(pt["radius"]), float(pt["z"])
        if not (abs(r) < 1e-9 and (abs(z - z_min) < 1e-9 or abs(z - z_max) < 1e-9)):
            pts.append((r, z))
    if abs(pts[-1][0]) > 1e-9:
        pts.append((0.0, z_max))
    wp = cq.Workplane("XZ").polyline(pts).close().revolve(angle, (0, 0, 0), (0, 1, 0))
    return wp


def _build_extrude_profile(f: Feature) -> cq.Workplane:
    p = f.parameters
    outline = p.get("outline") or []
    if len(outline) < 3:
        raise FeatureModellingError("extrude_profile requires >= 3 outline points.")
    depth = _fnum(p, "depth")
    z_start = _fnum(p, "zStart", 0.0)
    pts = [(float(pt["x"]), float(pt["y"])) for pt in outline]
    if len(pts) > 3 and pts[0] == pts[-1]:
        pts.pop()
    wp = cq.Workplane("XY").polyline(pts).close().extrude(depth)
    if z_start:
        wp = wp.translate((0, 0, z_start))
    return wp


def _build_flange(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    thickness = _fnum(p, "thickness")
    z0 = _fnum(p, "zStart", 0.0)
    z1 = z0 + thickness
    if p.get("shape") == "circular":
        return _cyl(_fnum(p, "outerRadius"), (cx, cy, z0), (cx, cy, z1))
    return _box(_fnum(p, "length"), _fnum(p, "width"), thickness, (cx, cy, (z0 + z1) / 2.0))


def _build_boss_cylindrical(f: Feature) -> cq.Workplane:
    p = f.parameters
    a = _fnum(p, "angleDeg")
    z = _fnum(p, "z")
    r0 = _fnum(p, "startRadius")
    h = _fnum(p, "height")
    dx, dy = _radial_dir(a)
    p0 = (r0 * dx, r0 * dy, z)
    p1 = ((r0 + h) * dx, (r0 + h) * dy, z)
    return _cyl(_fnum(p, "radius"), p0, p1)


def _build_boss_rectangular(f: Feature) -> cq.Workplane:
    p = f.parameters
    a = _fnum(p, "angleDeg")
    length = _fnum(p, "length")
    width = _fnum(p, "width", _fnum(p, "thickness"))
    height = _fnum(p, "height")
    r0 = _fnum(p, "startRadius")
    z = _fnum(p, "z")
    rmid = r0 + length / 2.0
    dx, dy = _radial_dir(a)
    center = (rmid * dx, rmid * dy, z + height / 2.0)
    return _box(length, width, height, center, rz=a)


def _build_rib(f: Feature) -> cq.Workplane:
    return _build_boss_rectangular(f)


def _build_connector(f: Feature) -> cq.Workplane:
    return _build_boss_cylindrical(f)


def _build_through_bore(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    return _cyl(_fnum(p, "diameter") / 2.0, (cx, cy, _fnum(p, "zStart")), (cx, cy, _fnum(p, "zEnd")))


def _build_blind_bore(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    z0 = _fnum(p, "zStart")
    return _cyl(_fnum(p, "diameter") / 2.0, (cx, cy, z0), (cx, cy, z0 - _fnum(p, "depth")))


def _build_stepped_bore(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    tools: List[cq.Workplane] = []
    for seg in p.get("segments", []):
        tools.append(_cyl(_fnum(seg, "diameter") / 2.0,
                          (cx, cy, _fnum(seg, "zStart")),
                          (cx, cy, _fnum(seg, "zEnd"))))
    if not tools:
        raise FeatureModellingError("stepped_bore has no segments.")
    combined = tools[0]
    for t in tools[1:]:
        combined = combined.union(t)
    return combined


def _build_counterbore(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    z0, z1 = _fnum(p, "zStart"), _fnum(p, "zEnd")
    bore = _cyl(_fnum(p, "diameter") / 2.0, (cx, cy, z0), (cx, cy, z1))
    cb = _cyl(_fnum(p, "counterboreDiameter") / 2.0, (cx, cy, z0), (cx, cy, z0 - _fnum(p, "counterboreDepth")))
    return bore.union(cb)


def _build_countersink(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    z0 = _fnum(p, "zStart")
    d = _fnum(p, "diameter")
    cs_d = _fnum(p, "countersinkDiameter")
    angle = _fnum(p, "angleDeg", 90.0)
    depth = _fnum(p, "depth")
    body = _cyl(d / 2.0, (cx, cy, z0), (cx, cy, z0 - depth))
    half = math.radians(max(1.0, min(89.0, angle / 2.0)))
    h_cs = max(1e-3, ((cs_d - d) / 2.0) / math.tan(half))
    cone = _cone(cs_d / 2.0, d / 2.0, (cx, cy, z0), (cx, cy, z0 - h_cs))
    return body.union(cone)


def _build_pocket_circular(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    z0 = _fnum(p, "zStart")
    return _cyl(_fnum(p, "diameter") / 2.0, (cx, cy, z0), (cx, cy, z0 - _fnum(p, "depth")))


def _build_pocket_rectangular(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    z0 = _fnum(p, "zStart")
    depth = _fnum(p, "depth")
    return _box(_fnum(p, "length"), _fnum(p, "width"), depth, (cx, cy, z0 - depth / 2.0))


def _build_radial_port(f: Feature) -> cq.Workplane:
    p = f.parameters
    a = _fnum(p, "angleDeg")
    z = _fnum(p, "z")
    r0 = _fnum(p, "startRadius")
    depth = _fnum(p, "depth")
    dx, dy = _radial_dir(a)
    p0 = (r0 * dx, r0 * dy, z)
    p1 = ((r0 - depth) * dx, (r0 - depth) * dy, z)
    return _cyl(_fnum(p, "diameter") / 2.0, p0, p1)


def _build_axial_port(f: Feature) -> cq.Workplane:
    return _build_through_bore(f)


def _build_internal_passage(f: Feature) -> cq.Workplane:
    p = f.parameters
    s, e = p.get("start") or {}, p.get("end") or {}
    p0 = (float(s.get("x", 0.0)), float(s.get("y", 0.0)), float(s.get("z", 0.0)))
    p1 = (float(e.get("x", 0.0)), float(e.get("y", 0.0)), float(e.get("z", 0.0)))
    return _cyl(_fnum(p, "diameter") / 2.0, p0, p1)


def _build_cavity(f: Feature) -> cq.Workplane:
    return _build_through_bore(f)


def _build_bolt_circle(f: Feature) -> cq.Workplane:
    p = f.parameters
    cx, cy = _center_xy(p, f.position)
    count = int(round(_fnum(p, "count")))
    bcr = _fnum(p, "boltCircleRadius")
    hr = _fnum(p, "holeDiameter") / 2.0
    z0, z1 = _fnum(p, "zStart"), _fnum(p, "zEnd")
    start = _fnum(p, "startAngleDeg", 0.0)
    tools: List[cq.Workplane] = []
    for i in range(max(1, count)):
        a = math.radians(start + i * 360.0 / max(1, count))
        hx, hy = cx + bcr * math.cos(a), cy + bcr * math.sin(a)
        tools.append(_cyl(hr, (hx, hy, z0), (hx, hy, z1)))
    combined = tools[0]
    for t in tools[1:]:
        combined = combined.union(t)
    return combined


def _build_hole_pattern(f: Feature) -> cq.Workplane:
    p = f.parameters
    pattern = p.get("pattern")
    cx, cy = _center_xy(p, f.position)
    hr = _fnum(p, "holeDiameter") / 2.0
    z0, z1 = _fnum(p, "zStart", -1.0), _fnum(p, "zEnd", 1000.0)
    tools: List[cq.Workplane] = []
    if pattern == "bolt_circle":
        return _build_bolt_circle(f)
    if pattern == "linear":
        n = int(round(_fnum(p, "countX", _fnum(p, "count", 1))))
        sx = _fnum(p, "spacing", _fnum(p, "spacingX", 0.0))
        for i in range(max(1, n)):
            tools.append(_cyl(hr, (cx + i * sx, cy, z0), (cx + i * sx, cy, z1)))
    elif pattern == "grid":
        nx = int(round(_fnum(p, "countX", 1)))
        ny = int(round(_fnum(p, "countY", 1)))
        sx = _fnum(p, "spacingX", _fnum(p, "spacing", 0.0))
        sy = _fnum(p, "spacingY", _fnum(p, "spacing", 0.0))
        for i in range(max(1, nx)):
            for j in range(max(1, ny)):
                tools.append(_cyl(hr, (cx + i * sx, cy + j * sy, z0), (cx + i * sx, cy + j * sy, z1)))
    if not tools:
        raise FeatureModellingError(f"hole_pattern '{pattern}' produced no holes.")
    combined = tools[0]
    for t in tools[1:]:
        combined = combined.union(t)
    return combined


#: Registry mapping additive/subtractive feature types to tool builders.
_TOOL_BUILDERS: Dict[str, Callable[[Feature], cq.Workplane]] = {
    "base_cylinder": _build_base_cylinder,
    "base_box": _build_base_box,
    "revolve_profile": _build_revolve_profile,
    "extrude_profile": _build_extrude_profile,
    "flange": _build_flange,
    "boss_cylindrical": _build_boss_cylindrical,
    "boss_rectangular": _build_boss_rectangular,
    "rib": _build_rib,
    "connector": _build_connector,
    "through_bore": _build_through_bore,
    "blind_bore": _build_blind_bore,
    "stepped_bore": _build_stepped_bore,
    "counterbore": _build_counterbore,
    "countersink": _build_countersink,
    "pocket_circular": _build_pocket_circular,
    "pocket_rectangular": _build_pocket_rectangular,
    "radial_port": _build_radial_port,
    "axial_port": _build_axial_port,
    "internal_passage": _build_internal_passage,
    "cavity": _build_cavity,
    "bolt_circle": _build_bolt_circle,
    "hole_pattern": _build_hole_pattern,
}


# ---------------------------------------------------------------------------
# Edge selection for finishing operations
# ---------------------------------------------------------------------------

def _select_edges(solid: cq.Shape, selectors: List[Dict[str, Any]]) -> List[Any]:
    matched: List[Any] = []
    seen = set()
    for sel in selectors or []:
        kind = sel.get("kind")
        tol = float(sel.get("tolerance", 0.05))
        for e in solid.Edges():
            try:
                key = e.hashCode()
            except Exception:
                key = id(e)
            if key in seen:
                continue
            ok = False
            gtype = e.geomType()
            if kind == "all":
                ok = True
            elif kind == "circle":
                if gtype == "CIRCLE":
                    r = e.radius()
                    c = e.arcCenter()
                    want_r = sel.get("radius")
                    want_z = sel.get("z")
                    if want_r is not None and abs(r - float(want_r)) > tol:
                        ok = False
                    elif want_z is not None and abs(c.z - float(want_z)) > tol:
                        ok = False
                    else:
                        ok = True
            elif kind == "line":
                if gtype == "LINE":
                    ok = True
            if ok:
                seen.add(key)
                matched.append(e)
    return matched


def _apply_finish(current: cq.Workplane, f: Feature) -> Tuple[cq.Workplane, str, List[str]]:
    if current is None:
        return None, "failed", ["Cannot apply a finishing operation to an empty body."]
    solid = current.val()
    edges = _select_edges(solid, f.parameters.get("edges", []))
    if not edges:
        return current, "failed", ["No edges matched the finish selector."]
    try:
        if f.type == "fillet":
            new_solid = solid.fillet(_fnum(f.parameters, "radius"), edges)
        else:
            dist = _fnum(f.parameters, "distance")
            new_solid = solid.chamfer(dist, dist, edges)
    except Exception as e:  # OCC fillet/chamfer failures are common and must be reported
        return current, "failed", [f"{f.type} failed on {len(edges)} edge(s): {e}"]
    try:
        if not new_solid.isValid():
            return current, "failed", [f"{f.type} produced an invalid solid."]
    except Exception:
        pass
    return _wp_from_solid(new_solid), "applied", [f"{f.type} applied to {len(edges)} edge(s)."]


# ---------------------------------------------------------------------------
# Operation execution
# ---------------------------------------------------------------------------

def _snapshot(wp: Optional[cq.Workplane]) -> Dict[str, Any]:
    if wp is None:
        return {"volume": 0.0, "solids": 0, "bbox": None}
    try:
        solids = wp.solids().vals()
    except Exception:
        solids = []
    vol = 0.0
    for s in solids:
        try:
            vol += float(s.Volume())
        except Exception:
            pass
    bbox = None
    try:
        bb = wp.val().BoundingBox()
        bbox = {"xlen": bb.xlen, "ylen": bb.ylen, "zlen": bb.zlen,
                "xmin": bb.xmin, "xmax": bb.xmax,
                "ymin": bb.ymin, "ymax": bb.ymax,
                "zmin": bb.zmin, "zmax": bb.zmax}
    except Exception:
        pass
    return {"volume": round(vol, 6), "solids": len(solids), "bbox": bbox}


def _apply_additive(current: Optional[cq.Workplane], tool: cq.Workplane,
                    f: Feature) -> Tuple[Optional[cq.Workplane], str, List[str]]:
    if current is None:
        return tool, "applied", ["Base body created."]
    overlaps, common_vol = _shapes_intersect(current.val(), tool.val())
    if not overlaps:
        return current, "failed", [
            "Additive feature does not intersect the current body; refusing to create a disconnected solid."
        ]
    new = current.union(tool)
    solids = new.solids().vals()
    if len(solids) != 1:
        return current, "failed", [f"Boolean union produced {len(solids)} solids (expected 1)."]
    return new, "applied", [f"Union overlap volume {common_vol:.3f} mm^3."]


def _apply_subtractive(current: Optional[cq.Workplane], tool: cq.Workplane,
                       f: Feature) -> Tuple[Optional[cq.Workplane], str, List[str]]:
    if current is None:
        return None, "failed", ["Cannot apply a subtractive feature before a base body exists."]
    overlaps, common_vol = _shapes_intersect(current.val(), tool.val())
    if not overlaps:
        return current, "failed", ["Cut misses the target body (zero intersection volume)."]
    new = current.cut(tool)
    solids = new.solids().vals()
    if len(solids) != 1:
        return current, "failed", [
            f"Cut produced {len(solids)} solids (expected 1); the cut likely split the body."
        ]
    try:
        if float(new.val().Volume()) <= 0:
            return current, "failed", ["Cut removed all material (non-positive volume)."]
    except Exception as e:
        return current, "failed", [f"Cut produced invalid geometry: {e}"]
    return new, "applied", [f"Cut intersection volume {common_vol:.3f} mm^3."]


def _execute_feature(current: Optional[cq.Workplane], f: Feature) -> Tuple[Optional[cq.Workplane], str, List[str]]:
    if f.operation == OPERATION_FINISH:
        return _apply_finish(current, f)

    builder = _TOOL_BUILDERS.get(f.type)
    if builder is None:
        return current, "failed", [f"No builder for feature type '{f.type}'."]

    try:
        tool = builder(f)
    except FeatureModellingError as e:
        return current, "failed", [e.message]
    except Exception as e:  # noqa: BLE001
        return current, "failed", [f"Tool construction failed: {e}"]

    if f.operation == OPERATION_ADDITIVE:
        return _apply_additive(current, tool, f)
    if f.operation == OPERATION_SUBTRACTIVE:
        return _apply_subtractive(current, tool, f)
    return current, "failed", [f"Unknown operation '{f.operation}' for feature '{f.id}'."]


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def model_feature_recipe(recipe: Any, strict: bool = False) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """Model a validated feature recipe into a CadQuery workplane.

    Args:
        recipe: A :class:`FeatureRecipe`, or a raw recipe dict.
        strict: If True, raise :class:`FeatureModellingError` on the first
            feature that fails.  If False (default), failed features are
            recorded in the history and modelling continues.

    Returns:
        ``(workplane, history)`` where ``history`` is a serialisable dict with
        the recipe, per-step diagnostics and final metrics.
    """
    validation = validate_feature_recipe(recipe)
    if validation.status == "rejected":
        raise FeatureModellingError(
            "Feature recipe was rejected during validation: " + "; ".join(validation.errors),
            details={"errors": validation.errors},
        )
    if validation.status == "needs_input":
        raise FeatureModellingError(
            "Feature recipe is incomplete: missing " + ", ".join(validation.missing),
            details={"missing": validation.missing},
        )

    fr = validation.recipe
    current: Optional[cq.Workplane] = None
    steps: List[Dict[str, Any]] = []

    for idx, f in enumerate(fr.features):
        before = _snapshot(current)
        status = "failed"
        diagnostics: List[str] = []
        try:
            current, status, diagnostics = _execute_feature(current, f)
        except Exception as e:  # noqa: BLE001
            diagnostics = [f"Unexpected error: {e}"]
            status = "failed"

        f.validation_status = status
        f.diagnostics = list(diagnostics)
        after = _snapshot(current)
        steps.append({
            "index": idx,
            "id": f.id,
            "type": f.type,
            "operation": f.operation,
            "status": status,
            "diagnostics": diagnostics,
            "parameters": dict(f.parameters),
            "position": dict(f.position),
            "orientation": dict(f.orientation),
            "depends_on": list(f.depends_on),
            "before": before,
            "after": after,
        })

        if status != "applied":
            logger.warning("Feature '%s' (%s) failed: %s", f.id, f.type, "; ".join(diagnostics))
            if strict:
                raise FeatureModellingError(
                    f"Feature '{f.id}' ({f.type}) failed: {'; '.join(diagnostics)}",
                    feature_id=f.id,
                    details={"diagnostics": diagnostics},
                )

    if current is None:
        raise FeatureModellingError("Modelling produced no geometry.")

    applied = sum(1 for s in steps if s["status"] == "applied")
    failed = sum(1 for s in steps if s["status"] == "failed")
    skipped = sum(1 for s in steps if s["status"] == "skipped")
    final = _snapshot(current)

    history = {
        "format": fr.format,
        "version": fr.version,
        "name": fr.name,
        "units": fr.units,
        "recipe": fr.to_dict(),
        "validation": validation.to_dict(),
        "steps": steps,
        "summary": {
            "num_features": len(steps),
            "applied": applied,
            "failed": failed,
            "skipped": skipped,
            "all_applied": failed == 0 and skipped == 0,
            "final": final,
        },
    }
    return current, history


def model_feature_recipe_from_dict(recipe: Dict[str, Any], strict: bool = False) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """Convenience wrapper around :func:`model_feature_recipe` for raw dicts."""
    return model_feature_recipe(recipe, strict=strict)


def build_feature_tool(f: Feature) -> Optional[cq.Workplane]:
    """Public helper: build the positive tool solid for an additive/subtractive feature.

    Returns ``None`` for feature types without a tool builder (e.g. finishes).
    Used by the advanced validator to independently re-derive feature geometry.
    """
    builder = _TOOL_BUILDERS.get(f.type)
    if builder is None:
        return None
    return builder(f)


def shapes_intersect(a: cq.Shape, b: cq.Shape) -> Tuple[bool, float]:
    """Public wrapper around the Boolean-overlap test."""
    return _shapes_intersect(a, b)
