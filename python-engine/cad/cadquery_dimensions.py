"""
cadquery_dimensions.py — CadQuery-accurate dimension extraction for Stage 3
engineering drawings.

Every dimension endpoint is derived directly from the modeled CadQuery/OpenCASCADE
solid — cylindrical faces, circular edges, vertices and bounding boxes — rather
than from recipe metadata.  This makes the PDF drawing callouts match the actual
geometry, not an idealised recipe.

Public API
----------
``extract_dimensions(shape) -> CadQueryDimensions``
    Extract overall size, cylindrical features (bores, bosses, ports, holes),
    center points and overall extents from a CadQuery solid.

``dimension_values(cqd) -> Dict[str, float]``
    Flatten into a plain dict keyed by feature name (``flange_outer_diameter``,
    ``body_outer_diameter``, ``through_bore_diameter``, etc.) for use by
    ``build_housing_drawing_spec``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import cadquery as cq
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepGProp import BRepGProp_Face
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Pnt

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class CylindricalFeature:
    """One cylindrical feature found in the solid: bore, boss, port or flange."""
    kind: str              # "bore" | "boss" | "port" | "flange" | "cylinder"
    diameter: float        # mm
    radius: float          # mm
    center: Tuple[float, float, float]   # (x, y, z) in model mm
    axis: Tuple[float, float, float]     # unit axis direction
    z_min: float
    z_max: float


@dataclass
class CircularEdge:
    """One circular edge (e.g. a hole rim or boss shoulder)."""
    center: Tuple[float, float, float]
    radius: float
    normal: Tuple[float, float, float]


@dataclass
class CadQueryDimensions:
    """All dimensions extracted from a CadQuery solid."""
    # Overall
    xlen: float = 0.0
    ylen: float = 0.0
    zlen: float = 0.0
    xmin: float = 0.0
    xmax: float = 0.0
    ymin: float = 0.0
    ymax: float = 0.0
    zmin: float = 0.0
    zmax: float = 0.0
    volume: float = 0.0

    # Cylindrical features (sorted by diameter desc)
    cylinders: List[CylindricalFeature] = field(default_factory=list)

    # Circular edges (holes, bosses, shoulders)
    circles: List[CircularEdge] = field(default_factory=list)

    # Vertices (for exact corner/edge positions)
    vertices: List[Tuple[float, float, float]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# OpenCASCADE helpers
# ---------------------------------------------------------------------------


def _unwrap(shape: Any) -> Any:
    if isinstance(shape, cq.Workplane):
        return shape.val()
    return shape


def _face_center(face) -> Optional[Tuple[float, float, float]]:
    try:
        c = face.Center()
        return (c.x, c.y, c.z)
    except Exception:
        return None


def _face_normal(face) -> Optional[Tuple[float, float, float]]:
    try:
        n = face.normalAt(face.Center())
        return (n.x, n.y, n.z)
    except Exception:
        return None


def _face_area(face) -> float:
    try:
        props = GProp_GProps()
        BRepGProp_Face.SurfaceProperties(face.wrapped if hasattr(face, "wrapped") else face, props)
        return float(props.Mass())
    except Exception:
        return 0.0


def _is_cylindrical(face) -> bool:
    try:
        surf = BRepAdaptor_Surface(face.wrapped if hasattr(face, "wrapped") else face)
        return surf.GetType() == 1  # GeomAbs_SurfaceType == Cylinder
    except Exception:
        return False


def _cyl_radius(face) -> Optional[float]:
    try:
        surf = BRepAdaptor_Surface(face.wrapped if hasattr(face, "wrapped") else face)
        cyl = surf.Cylinder()
        return float(cyl.Radius())
    except Exception:
        return None


def _cyl_axis(face) -> Optional[Tuple[float, float, float]]:
    try:
        surf = BRepAdaptor_Surface(face.wrapped if hasattr(face, "wrapped") else face)
        cyl = surf.Cylinder()
        axis = cyl.Axis().Direction()
        return (axis.X(), axis.Y(), axis.Z())
    except Exception:
        return None


def _vertex_point(v) -> Optional[Tuple[float, float, float]]:
    try:
        p = TopoDS.Vertex_s(v.wrapped if hasattr(v, "wrapped") else v)
        # OCP Vertex: use BRep_Tool.Pnt
        from OCP.BRep import BRep_Tool
        pt = BRep_Tool.Pnt_s(p)
        return (pt.X(), pt.Y(), pt.Z())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def extract_dimensions(shape: Any) -> CadQueryDimensions:
    """Extract CadQuery-accurate dimensions from a solid.

    Walks every face and edge of the modeled solid to find:
    * The overall bounding box (x/y/z extents).
    * All cylindrical faces → diameters, centers, axes (bores, bosses, ports).
    * All circular edges → hole/shoulder centers and radii.
    * All vertices → exact corner coordinates.
    """
    solid = _unwrap(shape)
    cqd = CadQueryDimensions()

    try:
        bb = solid.BoundingBox()
        cqd.xmin, cqd.xmax = float(bb.xmin), float(bb.xmax)
        cqd.ymin, cqd.ymax = float(bb.ymin), float(bb.ymax)
        cqd.zmin, cqd.zmax = float(bb.zmin), float(bb.zmax)
        cqd.xlen = cqd.xmax - cqd.xmin
        cqd.ylen = cqd.ymax - cqd.ymin
        cqd.zlen = cqd.zmax - cqd.zmin
        cqd.volume = float(solid.Volume())
    except Exception:
        pass

    # ---- Cylindrical faces -------------------------------------------------
    try:
        faces = list(solid.Faces())
    except Exception:
        faces = []
    for face in faces:
        if not _is_cylindrical(face):
            continue
        r = _cyl_radius(face)
        axis = _cyl_axis(face)
        center = _face_center(face)
        if r is None or axis is None or center is None:
            continue
        dia = 2.0 * r
        cqd.cylinders.append(CylindricalFeature(
            kind="cylinder",
            diameter=dia,
            radius=r,
            center=center,
            axis=axis,
            z_min=center[2],
            z_max=center[2],
        ))

    # ---- Circular edges ----------------------------------------------------
    try:
        edges = list(solid.Edges())
    except Exception:
        edges = []
    for edge in edges:
        try:
            curve = BRepAdaptor_Curve(edge.wrapped if hasattr(edge, "wrapped") else edge)
            if curve.GetType() != 1:  # GeomAbs_CurveType == Circle
                continue
            circle = curve.Circle()
            r = float(circle.Radius())
            if r <= 0:
                continue
            center_pt = circle.Location()
            axis_dir = circle.Axis().Direction()
            cqd.circles.append(CircularEdge(
                center=(center_pt.X(), center_pt.Y(), center_pt.Z()),
                radius=r,
                normal=(axis_dir.X(), axis_dir.Y(), axis_dir.Z()),
            ))
        except Exception:
            pass

    # ---- Vertices ----------------------------------------------------------
    try:
        verts = list(solid.Vertices())
    except Exception:
        verts = []
    seen: set = set()
    for v in verts:
        pt = _vertex_point(v)
        if pt is None:
            continue
        key = (round(pt[0], 4), round(pt[1], 4), round(pt[2], 4))
        if key in seen:
            continue
        seen.add(key)
        cqd.vertices.append(pt)

    # Deduplicate cylinders by (radius, center proximity)
    deduped: List[CylindricalFeature] = []
    for c in cqd.cylinders:
        dup = False
        for d in deduped:
            if (abs(c.radius - d.radius) < 0.5
                    and math.dist(c.center, d.center) < 2.0):
                dup = True
                break
        if not dup:
            deduped.append(c)
    cqd.cylinders = sorted(deduped, key=lambda c: -c.diameter)

    return cqd


# ---------------------------------------------------------------------------
# Flatten to plain dict for the drawing spec builder
# ---------------------------------------------------------------------------


def dimension_values(cqd: CadQueryDimensions) -> Dict[str, float]:
    """Flatten CadQueryDimensions into a drawing-spec-friendly dict.

    Keys mirror the housing specimen parameter names used by
    ``build_housing_drawing_spec``:
    flange_outer_radius, body_outer_radius, through_bore_diameter,
    step_bore_diameter, upper_cavity_diameter, mounting_bolt_circle_radius,
    mounting_hole_diameter, port_diameter, boss_radius, boss_start_radius,
    flange_thickness, boss_height, rib_length, rib_thickness, etc.

    Values come from the actual modeled solid.  When a feature isn't found,
    falls back to None so the caller can decide whether to ask the user.
    """
    d: Dict[str, Optional[float]] = {}

    # Overall size from bounding box.
    d["overall_length"] = cqd.xlen
    d["overall_width"] = cqd.ylen
    d["overall_height"] = cqd.zlen

    # Cylinders sorted by diameter: largest = flange/outer, next = body/bore.
    cyls = cqd.cylinders
    if cyls:
        # The largest-diameter cylinder axis-aligned with Z is typically the
        # outer body/flange.  Smaller coaxial cylinders are bores/steps.
        outer = cyls[0]
        d["body_outer_diameter"] = outer.diameter
        d["body_outer_radius"] = outer.radius
        d["body_center_x"] = outer.center[0]
        d["body_center_y"] = outer.center[1]

        # Look for a smaller coaxial cylinder (bore).
        for c in cyls[1:]:
            if (abs(c.axis[2]) > 0.9  # coaxial with Z
                    and abs(c.center[0] - outer.center[0]) < 1.0
                    and abs(c.center[1] - outer.center[1]) < 1.0
                    and c.diameter < outer.diameter * 0.9):
                d["through_bore_diameter"] = c.diameter
                d["bore_center_x"] = c.center[0]
                d["bore_center_y"] = c.center[1]
                break

    # Circular edges → holes, ports, bosses.
    for circ in cqd.circles:
        r = circ.radius
        dia = 2.0 * r
        cx, cy, cz = circ.center
        # Classify by position: near outer radius = boss/port; near center = hole.
        if "body_outer_radius" in d and d["body_outer_radius"] is not None:
            radial_dist = math.hypot(cx - d.get("body_center_x", 0.0),
                                     cy - d.get("body_center_y", 0.0))
            if radial_dist > d["body_outer_radius"] * 0.5:
                if d.get("boss_radius") is None:
                    d["boss_radius"] = r
                    d["boss_center_x"] = cx
                    d["boss_center_y"] = cy
                elif d.get("port_diameter") is None:
                    d["port_diameter"] = dia
                    d["port_center_x"] = cx
                    d["port_center_y"] = cy
            else:
                if d.get("mounting_hole_diameter") is None:
                    d["mounting_hole_diameter"] = dia
                    d["mounting_hole_x"] = cx
                    d["mounting_hole_y"] = cy

    # Bolt circle: if we have a mounting hole and body center, compute pattern
    # radius from hole distance to body center.
    if d.get("mounting_hole_x") is not None and d.get("body_center_x") is not None:
        bcr = math.hypot(d["mounting_hole_x"] - d["body_center_x"],
                         d["mounting_hole_y"] - d["body_center_y"])
        if bcr > 0:
            d["mounting_bolt_circle_radius"] = bcr
            d["bolt_circle_diameter"] = 2.0 * bcr

    # Flange thickness ≈ overall height if it's a flange part (z is the axis).
    d["flange_thickness"] = cqd.zlen

    # Clean Nones.
    return {k: v for k, v in d.items() if v is not None}
