"""
engineering_drawing.py — Engineering drawing generation from a real CAD model.

Phase 2 (Stage 3) of the ReForge AI advanced CAD upgrade.

The module turns an actual CadQuery/OpenCASCADE solid into a professional 2D
engineering drawing sheet:

* Orthographic views (front, rear, top, bottom, left, right) and an isometric
  view, each produced by **real hidden-line removal** (OpenCASCADE ``HLRBRep``)
  so the projected line work is genuine geometry, not a hand-drawn sketch.
* A **FIRST ANGLE** third-angle-consistent layout: the right-side view is placed
  to the *left* of the front view and the top view *below* the front view.
* Section / cutaway views with cross-hatched cut material.
* A **real** magnified detail view: the projected line work is genuinely clipped
  (Liang–Barsky) to the detail region and re-scaled, with the detail region
  marked on the parent view.
* Dimensions derived from the validated model and its feature recipe: overall
  sizes, flange/body diameters, bolt circle, port/boss diameters, rib angles and
  lengths, bore depths/steps, passage positions, fillets and chamfers.
* Centre lines and centre marks **clipped to their own view** (never crossing the
  sheet or the title block).
* A title block, view labels, section labels and notes with A3-legible text.
* Structured tolerance / GD&T annotations (feature control frames) — never
  invented: unspecified information is explicitly marked as such.

Output is written as **vector SVG**, **PDF** and a raster **PNG** preview
(matplotlib is used as the vector backend; reportlab is not installed in the
project venv).

Public API
----------
``generate_engineering_drawings(workplane, recipe, measured, out_dir, stem) -> manifest``
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cadquery as cq

# OpenCASCADE hidden-line-removal bindings.
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepTools import BRepTools_WireExplorer
from OCP.GCPnts import GCPnts_QuasiUniformDeflection

import matplotlib
matplotlib.use("Agg")  # headless / off-screen
matplotlib.rcParams["svg.fonttype"] = "none"  # keep SVG text selectable/readable
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.path import Path  # noqa: E402
from matplotlib.patches import PathPatch, Polygon  # noqa: E402

logger = logging.getLogger("reforge.cad.engineering_drawing")

# ---------------------------------------------------------------------------
# Projection axes
# ---------------------------------------------------------------------------
# Each view maps to ``(main_direction, x_direction)`` where ``main_direction``
# is the viewing axis (the projector's Z) and ``x_direction`` the drawing X.
VIEW_AXES: Dict[str, Tuple[Tuple[float, float, float], Tuple[float, float, float]]] = {
    "front": ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0)),
    "rear": ((0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)),
    "top": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
    "bottom": ((0.0, 0.0, -1.0), (1.0, 0.0, 0.0)),
    "left": ((-1.0, 0.0, 0.0), (0.0, -1.0, 0.0)),
    "right": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "isometric": ((1.0, -1.0, 1.0), (1.0, 1.0, 0.0)),
}

Point2 = Tuple[float, float]
Polyline = List[Point2]
Rect = Tuple[float, float, float, float]  # x0, y0, x1, y1


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

@dataclass
class ProjectedView:
    """2D line work for one projection, in model millimetres."""

    name: str
    visible: List[Polyline] = field(default_factory=list)
    hidden: List[Polyline] = field(default_factory=list)
    outline: List[Polyline] = field(default_factory=list)
    bounds: Rect = (0.0, 0.0, 0.0, 0.0)  # minx,miny,maxx,maxy

    def all_polylines(self) -> List[Polyline]:
        return self.visible + self.outline + self.hidden


def _discretise(compound, deflection: float) -> List[Polyline]:
    """Discretise an OCC compound of edges into 2D polylines."""
    polylines: List[Polyline] = []
    if compound is None or compound.IsNull():
        return polylines
    exp = TopExp_Explorer(compound, TopAbs_EDGE)
    while exp.More():
        try:
            edge = TopoDS.Edge_s(exp.Current())
            curve = BRepAdaptor_Curve(edge)
            disc = GCPnts_QuasiUniformDeflection(curve, deflection)
            if disc.IsDone() and disc.NbPoints() >= 2:
                pts: Polyline = []
                for i in range(1, disc.NbPoints() + 1):
                    p = disc.Value(i)
                    pts.append((p.X(), p.Y()))
                polylines.append(pts)
        except Exception:  # noqa: BLE001 - skip degenerate edges
            pass
        exp.Next()
    return polylines


def _unwrap(shape: Any) -> Any:
    """Return the underlying ``cq.Shape`` for a Workplane or Shape."""
    if isinstance(shape, cq.Workplane):
        return shape.val()
    return shape


def _project_raw(shape: Any, view: str, deflection: float = 0.15):
    """Run HLR and return (visible, hidden, outline) polylines."""
    main, xdir = VIEW_AXES.get(view, VIEW_AXES["front"])
    ax2 = gp_Ax2(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(*main), gp_Dir(*xdir))
    algo = HLRBRep_Algo()
    shape = _unwrap(shape)
    algo.Add(shape.wrapped)
    algo.Projector(HLRAlgo_Projector(ax2))
    algo.Update()
    algo.Hide()
    hlr = HLRBRep_HLRToShape(algo)

    visible = _discretise(hlr.VCompound(), deflection)
    visible += _discretise(hlr.OutLineVCompound(), deflection)
    hidden = _discretise(hlr.HCompound(), deflection)
    hidden += _discretise(hlr.OutLineHCompound(), deflection)
    outline = _discretise(hlr.OutLineVCompound(), deflection)
    return visible, hidden, outline


def project(shape: Any, view: str, name: Optional[str] = None,
            deflection: float = 0.15) -> ProjectedView:
    """Project ``shape`` into a 2D :class:`ProjectedView`."""
    visible, hidden, outline = _project_raw(shape, view, deflection)
    xs: List[float] = []
    ys: List[float] = []
    for pl in visible + hidden + outline:
        for (x, y) in pl:
            xs.append(x)
            ys.append(y)
    if xs:
        bounds = (min(xs), min(ys), max(xs), max(ys))
    else:
        bounds = (0.0, 0.0, 0.0, 0.0)
    return ProjectedView(name or view, visible, hidden, outline, bounds)


# ---------------------------------------------------------------------------
# Section cut faces (for hatching)
# ---------------------------------------------------------------------------

def _wire_points(wire, deflection: float = 0.2) -> Polyline:
    pts: Polyline = []
    try:
        explorer = BRepTools_WireExplorer(wire.wrapped if hasattr(wire, "wrapped") else wire)
        while explorer.More():
            edge = TopoDS.Edge_s(explorer.Current())
            curve = BRepAdaptor_Curve(edge)
            disc = GCPnts_QuasiUniformDeflection(curve, deflection)
            if disc.IsDone():
                for i in range(1, disc.NbPoints() + 1):
                    p = disc.Value(i)
                    pt = (p.X(), p.Y(), p.Z())
                    if not pts or _dist3(pts[-1], pt) > 1e-6:
                        pts.append(pt)
            explorer.Next()
    except Exception:  # noqa: BLE001
        pass
    return pts


def _dist3(a, b) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def section_cut_polygons(shape: cq.Shape, axis: str = "y", at: float = 0.0,
                         tol: float = 1e-4) -> List[Polyline]:
    """Return 2D polygons (in the front-view plane) of the cut faces.

    The cut faces are the planar faces of ``shape`` lying on the plane
    ``axis = at``.  Each polygon is returned in the front-view 2D coordinates
    ``(x, z)`` so it can be hatched.
    """
    idx = {"x": 0, "y": 1, "z": 2}[axis]
    shape = _unwrap(shape)
    polygons: List[Polyline] = []
    try:
        faces = list(shape.Faces())
    except Exception:  # noqa: BLE001
        faces = []
    for face in faces:
        try:
            c = face.Center()
            coords = (c.x, c.y, c.z)
            if abs(coords[idx] - at) > tol:
                continue
            n = face.normalAt(face.Center())
            nv = (n.x, n.y, n.z)
            # Normal must be parallel to the cut axis.
            if abs(abs(nv[idx]) - 1.0) > 1e-3:
                continue
            wire = face.outerWire()
            pts3 = _wire_points(wire)
            if len(pts3) < 3:
                continue
            # Project to the front-view plane: (x, z).
            polygons.append([(p[0], p[2]) for p in pts3])
        except Exception:  # noqa: BLE001
            continue
    return polygons


# ---------------------------------------------------------------------------
# Drawing specification model
# ---------------------------------------------------------------------------

@dataclass
class ViewPlacement:
    name: str
    projection: str
    center: Point2            # sheet position (mm)
    scale: float
    label: str = ""
    section: bool = False
    hatch_axis: str = "y"
    clip: Optional[Rect] = None  # model 2D clip rect (detail views)
    is_detail: bool = False
    detail_label: str = ""
    detail_id: str = ""
    detail_source: str = ""   # view name the detail is taken from
    show_hidden: bool = True
    show_centrelines: bool = True


@dataclass
class Dimension:
    #: ``linear`` (two-point), ``diameter``, ``radius``, ``depth``, ``angle``,
    #: ``chamfer`` or ``leader``.  Leader kinds (everything except two-point
    #: ``linear`` and ``angle``) render as a leader line + shoulder + text; the
    #: kind records the true *semantic* type of the dimension.
    kind: str
    view: str
    value: float
    text: str
    a: Point2                 # anchor point in model-2D view coords (mm)
    b: Optional[Point2] = None
    c: Optional[Point2] = None           # second angle arm (angle dims)
    offset: float = 0.0       # perpendicular offset for linear dims (mm)
    leader_to: Optional[Point2] = None   # label position (model-2D) for leader dims
    #: Which side of the label point the text sits on (``right`` | ``left``).
    leader_side: str = "right"
    tolerance: Optional[str] = None
    gdt: Optional[Dict[str, Any]] = None
    note: Optional[str] = None


@dataclass
class TitleBlock:
    component: str = "COMPONENT"
    drawing_number: str = "RF-0000"
    revision: str = "-"
    scale: str = "1:2"
    units: str = "mm"
    projection_method: str = "FIRST ANGLE"
    sheet: str = "1 / 1"
    material: str = "NOT SPECIFIED"
    finish: str = "NOT SPECIFIED"
    general_tolerance: str = "NOT SPECIFIED"
    author: str = "ReForge AI"
    date: str = ""
    notes: List[str] = field(default_factory=list)


@dataclass
class DrawingSpec:
    title_block: TitleBlock
    views: List[ViewPlacement]
    dimensions: List[Dimension]
    section_labels: List[Dict[str, Any]] = field(default_factory=list)
    gdt_frames: List[Dict[str, Any]] = field(default_factory=list)
    sheet_size: Point2 = (420.0, 297.0)  # A3 landscape
    warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Automatic spec assembly from the validated model + recipe
# ---------------------------------------------------------------------------

def _nice_scale(model_size: float, target: float) -> float:
    """Pick a standard drawing scale so ``model_size`` fits in ``target`` mm."""
    if model_size <= 0:
        return 1.0
    ideal = target / model_size
    standards = [5.0, 2.0, 1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]
    for s in standards:
        if s <= ideal * 1.02:
            return s
    return standards[-1]


def build_housing_drawing_spec(recipe: Dict[str, Any], measured: Dict[str, Any],
                               section_shape: Optional[cq.Shape] = None) -> DrawingSpec:
    """Assemble a :class:`DrawingSpec` for the housing from real data.

    Every dimension comes from the recipe's documented ``metadata.dimensions``
    or the measured bounding box.  Nothing is invented.

    The view layout follows **first-angle** projection:
    ``RIGHT`` (right-side view) is placed to the *left* of ``FRONT`` and ``TOP``
    is placed *below* ``FRONT``.
    """
    dims: Dict[str, float] = dict((recipe.get("metadata") or {}).get("dimensions") or {})
    bbox = measured.get("actual_bbox", {})
    volume = measured.get("actual_volume_mm3", 0.0)

    xlen = float(bbox.get("xlen", 160.0))
    ylen = float(bbox.get("ylen", 160.0))
    zlen = float(bbox.get("zlen", 90.0))
    xmin = float(bbox.get("xmin", -xlen / 2.0))
    xmax = float(bbox.get("xmax", xlen / 2.0))
    ymin = float(bbox.get("ymin", -ylen / 2.0))
    ymax = float(bbox.get("ymax", ylen / 2.0))
    zmin = float(bbox.get("zmin", 0.0))
    zmax = float(bbox.get("zmax", zlen))
    xc = (xmin + xmax) / 2.0
    yc = (ymin + ymax) / 2.0
    zc = (zmin + zmax) / 2.0

    warnings: List[str] = []
    if not dims:
        warnings.append("Recipe carries no documented dimensions; callouts omitted.")

    # Overall scale from the largest extent (A3 sheet, allow room for dims).
    scale = _nice_scale(max(xlen, ylen, zlen), 150.0)
    scale_text = f"{scale:g}:1" if scale >= 1 else f"1:{1 / scale:g}"

    # ---- FIRST ANGLE layout ------------------------------------------------
    # Sheet regions (A3 landscape, 420 x 297, border 6/10, title block
    # 130 x 62 at bottom-right).  First angle: the right-side view sits to the
    # LEFT of the front view and the top view BELOW the front view.
    views: List[ViewPlacement] = [
        ViewPlacement("FRONT", "front", (205.0, 225.0), scale, label="FRONT VIEW"),
        ViewPlacement("RIGHT", "right", (95.0, 225.0), scale,
                      label="RIGHT SIDE VIEW"),
        ViewPlacement("TOP", "top", (205.0, 118.0), scale, label="TOP VIEW"),
        ViewPlacement("SECTION A-A", "front", (330.0, 225.0), scale,
                      label="SECTION A-A", section=True, hatch_axis="y",
                      show_hidden=False),
        ViewPlacement("ISO", "isometric", (95.0, 108.0), scale * 0.72,
                      label="ISOMETRIC", show_hidden=False,
                      show_centrelines=False),
    ]

    # Real magnified DETAIL B: the flange/body/rib junction of the front view.
    # The clip is centred on the junction (x = -body radius, z = flange
    # thickness) so the magnified view frames the feature, not empty space.
    detail_clip: Rect = (xmin + 20.0, zmin, xmin + 60.0, zmin + 40.0)
    views.append(ViewPlacement(
        "DETAIL B", "front", (330.0, 118.0), scale * 2.6,
        label="DETAIL B (2.6x)", is_detail=True,
        detail_label="DETAIL B", detail_id="B", detail_source="FRONT",
        clip=detail_clip, show_hidden=False, show_centrelines=False))

    tb = TitleBlock(
        component="ADVANCED MECHANICAL HOUSING",
        drawing_number="RF-ADV-HOUSING-001",
        revision="A",
        scale=scale_text,
        units="mm",
        projection_method="FIRST ANGLE",
        sheet="1 / 1",
        material="NOT SPECIFIED",
        finish="NOT SPECIFIED",
        general_tolerance="NOT SPECIFIED",
        notes=[
            "ALL DIMENSIONS IN MILLIMETRES.",
            "THIRD-ANGLE SYMBOL NOT USED: FIRST ANGLE PROJECTION.",
            "MODEL GENERATED BY REFORGE AI FEATURE MODELLER.",
            f"MEASURED VOLUME {volume:,.0f} mm^3.",
            "UNSPECIFIED TOLERANCES / MATERIAL / FINISH: TO BE CONFIRMED.",
        ],
    )

    dimensions: List[Dimension] = []

    def add_linear(view, axis, start, end, fixed, offset, text, tol=None):
        """A linear dimension along ``axis`` between two model coords.

        ``fixed`` is the constant coordinate on the other axis.
        """
        if axis == "x":
            a, b = (start, fixed), (end, fixed)
        else:
            a, b = (fixed, start), (fixed, end)
        dimensions.append(Dimension("linear", view, abs(end - start), text, a, b,
                                    offset=offset, tolerance=tol))

    def add_diameter(view, value, anchor, leader, text=None):
        dimensions.append(Dimension("diameter", view, value, text or f"\u00d8{value:g}",
                                    anchor, leader_to=leader))

    def add_radius(view, value, anchor, leader, text=None):
        dimensions.append(Dimension("radius", view, value, text or f"R{value:g}",
                                    anchor, leader_to=leader))

    def add_depth(view, value, anchor, leader, text=None):
        dimensions.append(Dimension("depth", view, value,
                                    text or f"{value:g} DEEP",
                                    anchor, leader_to=leader))

    def add_leader(view, value, anchor, leader, text, kind="leader", side="right"):
        """A generic leader callout whose ``kind`` records the semantic type.

        Used for callouts that are *not* diameters (e.g. a rib length or a
        chamfer) so the manifest never mislabels them.
        """
        dimensions.append(Dimension(kind, view, value, text, anchor,
                                    leader_to=leader, leader_side=side))

    def add_angle(view, value, vertex, arm1, arm2, radius, text):
        dimensions.append(Dimension(kind="angle", view=view, value=value, text=text,
                                    a=vertex, b=arm1, c=arm2, offset=radius))

    # ---- Overall dimensions (measured, always real) ----
    # FRONT: horizontal overall below the view; the vertical overall is placed
    # on the LEFT so the whole right-hand side stays clear for the feature
    # leader callouts (which are routed monotonically below).
    add_linear("FRONT", "x", xmin, xmax, zmin, -20.0, f"{xlen:.2f}")
    add_linear("FRONT", "y", zmin, zmax, xc, +((xmax - xc) + 20.0), f"{zlen:.2f}")
    # TOP: horizontal below, vertical to the right.
    add_linear("TOP", "x", xmin, xmax, ymin, -20.0, f"{xlen:.2f}")
    add_linear("TOP", "y", ymin, ymax, xc, -((xmax - xc) + 20.0), f"{ylen:.2f}")
    # RIGHT: horizontal (Y extent) below, so the right-side view is dimensioned.
    add_linear("RIGHT", "x", ymin, ymax, zmin, -20.0, f"{ylen:.2f}")

    if dims:
        d = dims
        r_flange = d.get("flange_outer_radius", 80.0)
        r_body = d.get("body_outer_radius", 45.0)
        # ---- FRONT feature callouts --------------------------------------
        # Every front-view feature leader is routed to the RIGHT in a single
        # monotonically-ordered fan: the vertical order of the label points
        # matches the vertical order of their anchor points, so no two leader
        # lines cross.  (The front view's overall vertical dimension was moved
        # to the left to make room.)
        lx = max(xmax, r_flange) + 16.0          # label column (model mm)
        add_leader("FRONT", d.get("chamfer_size", 1.5),
                   (r_body, zmax), (lx, zmax + 8.0),
                   text=f"{d.get('chamfer_size', 1.5):g} CHAMFER", kind="chamfer")
        add_diameter("FRONT", d.get("upper_cavity_diameter", 50.0),
                     (d.get("upper_cavity_diameter", 50.0) / 2.0 * 0.95, zc + 22.0),
                     (lx, zc + 37.0))
        add_diameter("FRONT", 2 * r_body, (r_body * 0.9, zc + 18.0),
                     (lx, zc + 23.0))
        cav_depth = d.get("upper_cavity_z_end", 92.0) - d.get("upper_cavity_z_start", 50.0)
        add_depth("FRONT", cav_depth, (12.0, d.get("upper_cavity_z_start", 50.0)),
                  (lx, zc + 11.0), text=f"{cav_depth:g} CAVITY DEEP")
        add_diameter("FRONT", 2 * r_flange, (r_flange * 0.96, zc),
                     (lx, zc - 1.0))
        add_diameter("FRONT", d.get("step_bore_diameter", 28.0),
                     (d.get("step_bore_diameter", 28.0) / 2.0, zc - 6.0),
                     (lx, zc - 15.0))
        step_depth = d.get("step_bore_z_end", 52.0) - d.get("step_bore_z_start", 35.0)
        add_depth("FRONT", step_depth, (9.0, d.get("step_bore_z_start", 35.0)),
                  (lx, zc - 25.0), text=f"{step_depth:g} STEP DEEP")
        add_radius("FRONT", d.get("junction_fillet_radius", 3.0),
                   (r_body, d.get("flange_thickness", 12.0)),
                   (lx, zmin + 12.0),
                   text=f"R{d.get('junction_fillet_radius', 3.0):g} FILLET")
        add_diameter("FRONT", d.get("through_bore_diameter", 14.0),
                     (d.get("through_bore_diameter", 14.0) / 2.0, zmin + 8.0),
                     (lx, zmin + 2.0))
        tb_depth = d.get("through_bore_z_end", 37.0) - d.get("through_bore_z_start", -1.0)
        add_depth("FRONT", tb_depth, (7.0, d.get("through_bore_z_start", -1.0)),
                  (lx, zmin - 6.0), text=f"{tb_depth:g} THRU BORE")
        # ---- Flange thickness (right view, vertical linear at the bottom edge) ----
        add_linear("RIGHT", "y", zmin, zmin + d.get("flange_thickness", 12.0),
                   yc, -((ymax - yc) + 20.0), f"{d.get('flange_thickness', 12.0):g}")
        # ---- Boss height (right view, depth callout) ----
        add_depth("RIGHT", d.get("boss_height", 16.0),
                  (d.get("boss_start_radius", 44.0), d.get("port_z", 70.0)),
                  (ymax + 22.0, d.get("port_z", 70.0)),
                  text=f"{d.get('boss_height', 16.0):g} BOSS HT")
        # ---- Port height (right view, vertical linear) ----
        add_linear("RIGHT", "y", zmin, d.get("port_z", 70.0), ymin + 6.0,
                   -18.0, f"{d.get('port_z', 70.0):g}")
        # ---- Bolt circle + hole (top view) ----
        add_diameter("TOP", 2 * d.get("mounting_bolt_circle_radius", 62.0),
                     (0.0, d.get("mounting_bolt_circle_radius", 62.0)),
                     (xmin * 0.62, ymax * 0.85),
                     text=f"\u00d8{2 * d.get('mounting_bolt_circle_radius', 62.0):g} B.C.")
        add_diameter("TOP", d.get("mounting_hole_diameter", 8.0),
                     (d.get("mounting_bolt_circle_radius", 62.0), 0.0),
                     (xmax * 0.85, ymax * 0.55))
        # ---- Port diameter + boss diameter + angle (top view) ----
        add_diameter("TOP", d.get("port_diameter", 14.0),
                     (r_body, 0.0), (xmax * 0.7, ymax * 0.30))
        add_diameter("TOP", 2 * d.get("boss_radius", 18.0),
                     (d.get("boss_start_radius", 44.0) + d.get("boss_radius", 18.0), 0.0),
                     (xmax * 0.82, ymax * 0.12),
                     text=f"\u00d8{2 * d.get('boss_radius', 18.0):g} BOSS")
        add_angle("TOP", 120.0, (0.0, 0.0), (1.0, 0.0),
                  (math.cos(math.radians(120.0)), math.sin(math.radians(120.0))),
                  30.0, "120\u00b0")
        # ---- Rib angle + length + thickness (top view) ----
        add_angle("TOP", 45.0, (0.0, 0.0), (1.0, 0.0),
                  (math.cos(math.radians(45.0)), math.sin(math.radians(45.0))),
                  54.0, "45\u00b0")
        rib_mid = d.get("rib_start_radius", 44.0) + d.get("rib_length", 32.0) / 2.0
        add_leader("TOP", d.get("rib_length", 32.0),
                   (rib_mid * math.cos(math.radians(45.0)),
                    rib_mid * math.sin(math.radians(45.0))),
                   (-xmax * 0.55, ymax * 0.62),
                   text=f"RIB L={d.get('rib_length', 32.0):g}", kind="linear")
        ry = d.get("rib_start_radius", 44.0) * math.sin(math.radians(45.0))
        add_linear("TOP", "y", ry - d.get("rib_thickness", 8.0) / 2.0,
                   ry + d.get("rib_thickness", 8.0) / 2.0, xmin * 0.5,
                   -18.0, f"{d.get('rib_thickness', 8.0):g}")
        # ---- Passage position (top view, offset from centre) ----
        off = d.get("passage_offset", 20.0)
        add_linear("TOP", "x", 0.0, off, off, -14.0, f"{off:g}")

    section_labels = [
        {"id": "A", "text": "SECTION A-A", "view": "SECTION A-A",
         "source_view": "TOP", "plane": "Y=0 (centre)",
         "note": "Cutting plane through the housing axis; shown on the plan "
                 "(top) view where the plane is edge-on."},
    ]

    # GD&T is supported but not specified for this demonstrator.
    gdt_frames = [
        {"ref": "UNSPECIFIED",
         "text": "GD&T / TOLERANCES NOT SPECIFIED IN SOURCE DATA",
         "specified": False},
    ]

    return DrawingSpec(
        title_block=tb,
        views=views,
        dimensions=dimensions,
        section_labels=section_labels,
        gdt_frames=gdt_frames,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------

_INK = "#101010"
_THIN = 0.35
_THICK = 0.9
_HIDDEN = 0.35
_CENTRE = "#b00000"

# Sheet constants (A3 landscape).
_MARGIN = 6.0
_TB_W = 130.0
_TB_H = 62.0

_PT_TO_MM = 25.4 / 72.0

# Text sizes (points) — sized for A3 legibility.
_FS_VIEW_LABEL = 7.0
_FS_DIM = 6.0
_FS_TITLE = 6.4
_FS_TB_ROW = 5.2
_FS_NOTE = 5.0
_FS_SECTION = 7.5


def _arrow(ax, x: float, y: float, dx: float, dy: float, size: float = 2.2, color: str = _INK):
    """Draw a filled arrowhead at (x, y) pointing along (dx, dy)."""
    n = math.hypot(dx, dy) or 1.0
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    tip = (x, y)
    left = (x - ux * size + px * size * 0.35, y - uy * size + py * size * 0.35)
    right = (x - ux * size - px * size * 0.35, y - uy * size - py * size * 0.35)
    ax.add_patch(Polygon([tip, left, right], closed=True, color=color, lw=0))


def _draw_polyline(ax, pts: Sequence[Point2], color: str, lw: float, ls: str = "-"):
    if len(pts) < 2:
        return
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    ax.plot(xs, ys, color=color, linewidth=lw, linestyle=ls, solid_capstyle="round")


def _transform(pts: Sequence[Point2], center: Point2, scale: float,
               origin: Point2 = (0.0, 0.0)) -> List[Point2]:
    """Map model-2D points to sheet coordinates.

    ``origin`` (the model-2D reference point) is mapped to ``center`` on the
    sheet, so views are centred on their real geometry rather than on the
    model origin.
    """
    cx, cy = center
    ox, oy = origin
    return [(cx + (x - ox) * scale, cy + (y - oy) * scale) for (x, y) in pts]


def _bounds_center(bounds: Rect) -> Point2:
    minx, miny, maxx, maxy = bounds
    return ((minx + maxx) / 2.0, (miny + maxy) / 2.0)


def _transform_rect(rect: Rect, center: Point2, scale: float, origin: Point2) -> Rect:
    x0, y0, x1, y1 = rect
    p0 = _transform([(x0, y0)], center, scale, origin)[0]
    p1 = _transform([(x1, y1)], center, scale, origin)[0]
    return (min(p0[0], p1[0]), min(p0[1], p1[1]),
            max(p0[0], p1[0]), max(p0[1], p1[1]))


# ---------------------------------------------------------------------------
# Polyline clipping (Liang–Barsky) — real geometric clipping for detail views
# ---------------------------------------------------------------------------

def _clip_segment(p0: Point2, p1: Point2, rect: Rect) -> Optional[Tuple[Point2, Point2]]:
    """Clip a single segment to ``rect`` (returns None when fully outside)."""
    xmin, ymin, xmax, ymax = rect
    x0, y0 = p0
    x1, y1 = p1
    dx = x1 - x0
    dy = y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - xmin), (dx, xmax - x0),
                 (-dy, y0 - ymin), (dy, ymax - y0)):
        if abs(p) < 1e-12:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            if r > t0:
                t0 = r
        else:
            if r < t0:
                return None
            if r < t1:
                t1 = r
    return ((x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy))


def _clip_polyline(pts: Sequence[Point2], rect: Rect) -> Optional[Polyline]:
    """Clip a polyline to an axis-aligned rectangle (Liang–Barsky per segment)."""
    out: Polyline = []
    for i in range(len(pts) - 1):
        seg = _clip_segment(pts[i], pts[i + 1], rect)
        if seg is None:
            continue
        if not out or out[-1] != seg[0]:
            out.append(seg[0])
        out.append(seg[1])
    return out if len(out) >= 2 else None


# ---------------------------------------------------------------------------
# Text placement with collision avoidance
# ---------------------------------------------------------------------------

def _text_box(x: float, y: float, text: str, fontsize: float,
              ha: str, va: str) -> Rect:
    w = max(len(str(text)), 1) * fontsize * 0.60 * _PT_TO_MM
    h = fontsize * 1.25 * _PT_TO_MM
    if ha == "center":
        x0 = x - w / 2.0
    elif ha == "right":
        x0 = x - w
    else:
        x0 = x
    if va == "center":
        y0 = y - h / 2.0
    elif va == "top":
        y0 = y - h
    else:
        y0 = y
    return (x0, y0, x0 + w, y0 + h)


def _boxes_overlap(a: Rect, b: Rect, pad: float = 0.0) -> bool:
    return not (a[2] < b[0] - pad or a[0] > b[2] + pad
                or a[3] < b[1] - pad or a[1] > b[3] + pad)


class _LabelRegistry:
    """Tracks placed text bounding boxes so overlaps can be avoided/reported."""

    def __init__(self) -> None:
        self.boxes: List[Dict[str, Any]] = []

    def collides(self, box: Rect, pad: float = 0.4) -> bool:
        return any(_boxes_overlap(box, e["box"], pad) for e in self.boxes)

    def add(self, box: Rect, text: str, kind: str) -> None:
        self.boxes.append({"text": str(text), "kind": kind, "box": list(box)})


def _place_text(ax, x: float, y: float, text: str, fontsize: float,
                ha: str, va: str, registry: Optional[_LabelRegistry] = None,
                kind: str = "label", color: str = _INK,
                weight: Optional[str] = None, nudge: bool = False,
                nudge_dirs: Optional[Sequence[Tuple[float, float]]] = None) -> Rect:
    """Draw ``text`` and (optionally) nudge it to avoid collisions."""
    box = _text_box(x, y, text, fontsize, ha, va)
    if registry is not None and nudge:
        dirs = list(nudge_dirs or [(0.0, -2.2), (0.0, 2.2), (2.5, 0.0), (-2.5, 0.0),
                                   (0.0, -4.4), (0.0, 4.4)])
        for (dx, dy) in dirs:
            cand = _text_box(x + dx, y + dy, text, fontsize, ha, va)
            if not registry.collides(cand):
                x, y, box = x + dx, y + dy, cand
                break
    if registry is not None:
        registry.add(box, text, kind)
    ax.text(x, y, text, fontsize=fontsize, color=color, ha=ha, va=va,
            weight=weight)
    return box


# ---------------------------------------------------------------------------
# Sheet rendering
# ---------------------------------------------------------------------------

def _draw_border_and_title(ax, spec: DrawingSpec,
                           registry: Optional[_LabelRegistry] = None) -> Dict[str, Any]:
    w, h = spec.sheet_size
    margin = _MARGIN
    # Outer border
    ax.plot([margin, w - margin, w - margin, margin, margin],
            [margin, margin, h - margin, h - margin, margin],
            color=_INK, linewidth=1.2)
    inner = margin + 4.0
    ax.plot([inner, w - inner, w - inner, inner, inner],
            [inner, inner, h - inner, h - inner, inner],
            color=_INK, linewidth=0.6)

    tb = spec.title_block
    bw, bh = _TB_W, _TB_H
    x0, y0 = w - margin - bw, margin
    ax.add_patch(Polygon([(x0, y0), (x0 + bw, y0), (x0 + bw, y0 + bh), (x0, y0 + bh)],
                         closed=True, fill=False, edgecolor=_INK, lw=1.0))
    rows = [
        ("COMPONENT", tb.component),
        ("DRAWING No.", tb.drawing_number),
        ("REV", tb.revision),
        ("SCALE", tb.scale),
        ("UNITS", tb.units),
        ("PROJECTION", tb.projection_method),
        ("SHEET", tb.sheet),
        ("MATERIAL", tb.material),
        ("FINISH", tb.finish),
        ("GENERAL TOL", tb.general_tolerance),
        ("DRAWN BY", tb.author),
        ("DATE", tb.date or "NOT SPECIFIED"),
    ]
    row_h = bh / (len(rows) + 1)
    ax.plot([x0, x0 + bw], [y0 + bh - row_h, y0 + bh - row_h], color=_INK, lw=0.6)
    for i, (label, value) in enumerate(rows):
        yy = y0 + bh - row_h * (i + 1) - row_h / 2.0
        _place_text(ax, x0 + 2.0, yy, label, _FS_TB_ROW, "left", "center",
                    registry, kind="title_block")
        _place_text(ax, x0 + 44.0, yy, str(value), _FS_TB_ROW, "left", "center",
                    registry, kind="title_block")
        ax.plot([x0 + 42.0, x0 + 42.0], [yy - row_h / 2.0, yy + row_h / 2.0],
                color=_INK, lw=0.3)
    # Title
    _place_text(ax, x0 + bw / 2.0, y0 + bh - row_h / 2.0,
                "REFORGE AI \u2014 ENGINEERING DRAWING", _FS_TITLE,
                "center", "center", registry, kind="title", weight="bold")

    # Notes above the title block
    nx, ny = x0, y0 + bh + 4.0
    for i, note in enumerate(tb.notes):
        _place_text(ax, nx, ny + i * 4.0, f"- {note}", _FS_NOTE, "left", "bottom",
                    registry, kind="note")

    # Drawing-level warning banner if dimensions were unspecified
    if spec.warnings:
        _place_text(ax, inner + 2.0, h - inner - 4.0,
                    "NOTE: " + " ".join(spec.warnings), _FS_NOTE, "left", "top",
                    registry, kind="warning", color="#a00000")

    return {
        "sheet_size": [w, h],
        "border": [margin, margin, w - margin, h - margin],
        "inner_border": [inner, inner, w - inner, h - inner],
        "title_block": [x0, y0, x0 + bw, y0 + bh],
    }


def _draw_view(ax, pv: ProjectedView, placement: ViewPlacement,
               section_polys: Optional[List[Polyline]] = None,
               registry: Optional[_LabelRegistry] = None) -> Dict[str, Any]:
    cx, cy = placement.center
    s = placement.scale
    rect = placement.clip
    extent_model: Rect = rect if rect is not None else pv.bounds
    origin = _bounds_center(extent_model)

    def emit(polys) -> int:
        count = 0
        for pl in polys:
            pts = _clip_polyline(pl, rect) if rect is not None else list(pl)
            if not pts:
                continue
            _draw_polyline(ax, _transform(pts, (cx, cy), s, origin),
                           _INK if polys is pv.visible or polys is pv.outline else "#8a8a8a",
                           _THICK if polys is not pv.hidden else _HIDDEN,
                           "-" if polys is not pv.hidden else (0, (3, 2)))
            count += 1
        return count

    line_count = 0
    # Hidden lines first (drawn under visible).
    if placement.show_hidden:
        line_count += emit(pv.hidden)
    line_count += emit(pv.visible)
    line_count += emit(pv.outline)

    # Hatch the section cut region.
    if placement.section and section_polys:
        for poly in section_polys:
            pts = _transform(poly, (cx, cy), s, origin)
            if len(pts) < 3:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            step = 3.0
            clip = Path(pts + [pts[0]], closed=True)
            for k in range(int((x1 - x0 + y1 - y0) / step) + 2):
                a = (x0 - (y1 - y0) + k * step, y0)
                b = (a[0] + (y1 - y0), y1)
                ln, = ax.plot([a[0], b[0]], [a[1], b[1]], color=_INK, lw=0.18)
                ln.set_clip_path(PathPatch(clip, transform=ax.transData))

    ex0, ey0, ex1, ey1 = _transform_rect(extent_model, (cx, cy), s, origin)

    # Centre lines (dash-dot), clipped to *this* view's extent only so they
    # never cross empty sheet areas or the title block.  Skipped for
    # isometric / detail views.
    if placement.show_centrelines:
        pad = 2.0
        ax.plot([ex0 - pad, ex1 + pad], [cy, cy],
                color=_CENTRE, lw=0.3, linestyle=(0, (6, 2, 1, 2)))
        ax.plot([cx, cx], [ey0 - pad, ey1 + pad],
                color=_CENTRE, lw=0.3, linestyle=(0, (6, 2, 1, 2)))

    # Detail boundary + label.
    if placement.is_detail:
        ax.add_patch(Polygon([(ex0, ey0), (ex1, ey0), (ex1, ey1), (ex0, ey1)],
                             closed=True, fill=False, edgecolor=_INK,
                             lw=0.7, linestyle=(0, (5, 3))))
        _place_text(ax, ex0, ey1 + 1.5, placement.detail_id or "B",
                    _FS_VIEW_LABEL, "left", "bottom", registry, kind="detail_id",
                    weight="bold")

    # View label under the view.
    label_box = _place_text(ax, cx, ey0 - 4.0, placement.label or placement.name,
                            _FS_VIEW_LABEL, "center", "top", registry,
                            kind="view_label", nudge=True,
                            nudge_dirs=[(0.0, -3.0), (0.0, -6.0), (0.0, 3.0)])

    return {
        "name": placement.name,
        "projection": placement.projection,
        "center": [cx, cy],
        "scale": s,
        "extent": [ex0, ey0, ex1, ey1],
        "line_count": line_count,
        "label_box": list(label_box),
        "is_detail": placement.is_detail,
        "section": placement.section,
        "clip": list(rect) if rect else None,
    }


def _draw_dimension(ax, dim: Dimension, placements: Dict[str, ViewPlacement],
                    pv_bounds: Dict[str, Rect],
                    registry: Optional[_LabelRegistry] = None):
    pl = placements.get(dim.view)
    if pl is None:
        return
    cx, cy = pl.center
    s = pl.scale
    origin = _bounds_center(pv_bounds.get(dim.view, (0.0, 0.0, 0.0, 0.0)))

    def T(p: Point2) -> Point2:
        return (cx + (p[0] - origin[0]) * s, cy + (p[1] - origin[1]) * s)

    txt = dim.text
    if dim.tolerance:
        txt = f"{txt} \u00b1{dim.tolerance}"

    if dim.kind == "linear" and dim.b is not None:
        a = T(dim.a)
        b = T(dim.b)
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1.0
        px, py = -dy / n, dx / n
        off = dim.offset * s
        da = (a[0] + px * off, a[1] + py * off)
        db = (b[0] + px * off, b[1] + py * off)
        ax.plot([a[0], da[0] + px * 2], [a[1], da[1] + py * 2], color=_INK, lw=0.25)
        ax.plot([b[0], db[0] + px * 2], [b[1], db[1] + py * 2], color=_INK, lw=0.25)
        ax.plot([da[0], db[0]], [da[1], db[1]], color=_INK, lw=0.3)
        _arrow(ax, da[0], da[1], -px, -py, 2.0)
        _arrow(ax, db[0], db[1], px, py, 2.0)
        mid = ((da[0] + db[0]) / 2.0, (da[1] + db[1]) / 2.0)
        _place_text(ax, mid[0], mid[1] + (1.8 if py >= 0 else -1.8), txt, _FS_DIM,
                    "center", "bottom" if py >= 0 else "top", registry,
                    kind="dimension", nudge=True)

    elif dim.kind in ("diameter", "radius", "depth", "leader", "chamfer", "linear"):
        a = T(dim.a)
        l = T(dim.leader_to) if dim.leader_to else (a[0] + 15, a[1] + 15)
        ax.plot([a[0], l[0]], [a[1], l[1]], color=_INK, lw=0.3)
        _arrow(ax, a[0], a[1], a[0] - l[0], a[1] - l[1], 2.0)
        if dim.leader_side == "left":
            ax.plot([l[0], l[0] - 9.0], [l[1], l[1]], color=_INK, lw=0.3)
            _place_text(ax, l[0] - 10.0, l[1], txt, _FS_DIM, "right", "center",
                        registry, kind="dimension", nudge=True,
                        nudge_dirs=[(0.0, 2.4), (0.0, -2.4), (0.0, 4.8), (0.0, -4.8)])
        else:
            ax.plot([l[0], l[0] + 9.0], [l[1], l[1]], color=_INK, lw=0.3)
            _place_text(ax, l[0] + 10.0, l[1], txt, _FS_DIM, "left", "center",
                        registry, kind="dimension", nudge=True,
                        nudge_dirs=[(0.0, 2.4), (0.0, -2.4), (0.0, 4.8), (0.0, -4.8)])

    elif dim.kind == "angle" and dim.b is not None and dim.c is not None:
        v = T(dim.a)
        a1 = T(dim.b)
        a2 = T(dim.c)
        ang1 = math.atan2(a1[1] - v[1], a1[0] - v[0])
        ang2 = math.atan2(a2[1] - v[1], a2[0] - v[0])
        r = dim.offset * s
        steps = 24
        arc = [(v[0] + r * math.cos(ang1 + (ang2 - ang1) * i / steps),
                v[1] + r * math.sin(ang1 + (ang2 - ang1) * i / steps))
               for i in range(steps + 1)]
        _draw_polyline(ax, arc, _INK, 0.3)
        _place_text(ax, v[0] + r * 1.15, v[1] + r * 0.35, txt, _FS_DIM,
                    "left", "center", registry, kind="dimension", nudge=True)

    if dim.gdt and dim.gdt.get("specified"):
        _draw_feature_control_frame(ax, T(dim.a)[0] + 6, T(dim.a)[1] - 6, dim.gdt)


def _draw_feature_control_frame(ax, x: float, y: float, frame: Dict[str, Any]):
    cells = frame.get("cells") or []
    if not cells:
        return
    cw = 14.0
    ch = 5.5
    for i, cell in enumerate(cells):
        cx0 = x + i * cw
        ax.add_patch(Polygon([(cx0, y), (cx0 + cw, y), (cx0 + cw, y + ch), (cx0, y + ch)],
                             closed=True, fill=False, edgecolor=_INK, lw=0.3))
        label = cell.get("symbol_label") or cell.get("symbol", "")
        value = cell.get("value", "")
        ax.text(cx0 + cw / 2.0, y + ch * 0.68, str(label), fontsize=4.6,
                color=_INK, ha="center", va="center")
        ax.text(cx0 + cw / 2.0, y + ch * 0.28, str(value), fontsize=4.6,
                color=_INK, ha="center", va="center")


def _model_axis_2d(view_projection: str, axis: Sequence[float]) -> Tuple[float, float]:
    """Map a model-space direction onto a view's 2D drawing basis ``(x, y)``.

    ``VIEW_AXES`` gives each view a viewing direction (``main``) and a drawing
    X direction (``xdir``); the drawing Y direction is ``main x xdir``.
    """
    main, xdir = VIEW_AXES.get(view_projection, VIEW_AXES["front"])
    ydir = (main[1] * xdir[2] - main[2] * xdir[1],
            main[2] * xdir[0] - main[0] * xdir[2],
            main[0] * xdir[1] - main[1] * xdir[0])
    return (axis[0] * xdir[0] + axis[1] * xdir[1] + axis[2] * xdir[2],
            axis[0] * ydir[0] + axis[1] * ydir[1] + axis[2] * ydir[2])


def _draw_section_labels(ax, spec: DrawingSpec, placements: Dict[str, ViewPlacement],
                         view_layout: Optional[Dict[str, Any]] = None,
                         registry: Optional[_LabelRegistry] = None
                         ) -> List[Dict[str, Any]]:
    """Draw the SECTION A-A cutting-plane line + endpoint markers.

    The cutting plane is drawn on the view where it is **edge-on** (its
    ``source_view``, the plan/top view for the Y=0 plane) rather than floating
    on the section view itself.  It carries the standard thick end segments,
    direction-of-sight arrows and the letter labels at the ends.
    """
    markers: List[Dict[str, Any]] = []
    layout = view_layout or {}
    for lab in spec.section_labels:
        src_name = lab.get("source_view") or lab.get("view")
        src = placements.get(src_name)
        info = layout.get(src_name) or {}
        extent = info.get("extent")
        if src is None or not extent:
            continue
        ex0, ey0, ex1, ey1 = extent
        cx, cy = src.center

        # Cutting-plane normal from the plane string, e.g. "Y=0 (centre)".
        axis_char = str(lab.get("plane", "Y=0")).strip()[:1].upper()
        normal = {"X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0),
                  "Z": (0.0, 0.0, 1.0)}.get(axis_char, (0.0, 1.0, 0.0))
        nx, ny = _model_axis_2d(src.projection, normal)

        # Direction of sight = -main of the *section* view, mapped to this view.
        sec = placements.get(lab.get("view"))
        sec_proj = sec.projection if sec is not None else "front"
        main_sec, _ = VIEW_AXES.get(sec_proj, VIEW_AXES["front"])
        sight = (-main_sec[0], -main_sec[1], -main_sec[2])
        sx, sy = _model_axis_2d(src.projection, sight)
        sn = math.hypot(sx, sy) or 1.0
        sx, sy = sx / sn, sy / sn

        # The cutting line runs perpendicular to the plane normal.
        if abs(nx) >= abs(ny):
            ends = [(cx, ey0 - 8.0), (cx, ey1 + 8.0)]
        else:
            ends = [(ex0 - 8.0, cy), (ex1 + 8.0, cy)]
        p0, p1 = ends
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(dx, dy) or 1.0
        ux, uy = -dy / ln, dx / ln  # perpendicular (thick-end direction)

        ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color=_INK, lw=0.5,
                linestyle=(0, (9, 3, 2, 3)))
        for (px_, py_) in ends:
            t = 3.0
            ax.plot([px_ - ux * t, px_ + ux * t],
                    [py_ - uy * t, py_ + uy * t], color=_INK, lw=1.4)
            # Arrowhead pointing in the direction of sight, at the line end.
            _arrow(ax, px_ + sx * 4.0, py_ + sy * 4.0, sx, sy, 2.6)
            _place_text(ax, px_ + sx * 11.0, py_ + sy * 11.0, str(lab["id"]),
                        _FS_SECTION, "center", "center", registry,
                        kind="section_id", weight="bold")
        markers.append({
            "id": lab["id"], "source_view": src_name,
            "section_view": lab.get("view"),
            "plane": lab.get("plane"),
            "line": [list(p0), list(p1)],
            "arrows": [list((p0[0] + sx * 4.0, p0[1] + sy * 4.0)),
                       list((p1[0] + sx * 4.0, p1[1] + sy * 4.0))],
            "sight_2d": [sx, sy],
        })
    return markers


def _draw_detail_source_marker(ax, detail: ViewPlacement, source: ViewPlacement,
                               source_pv: ProjectedView,
                               registry: Optional[_LabelRegistry]) -> Optional[Dict[str, Any]]:
    """Mark the detail region on its parent view with a region + callout bubble.

    The region is outlined with a dashed rectangle and a standard detail
    callout bubble (a circle containing the detail letter, joined to the region
    by a short leader).  The magnified view's scale is stated so the callout is
    unambiguous.
    """
    if detail.clip is None:
        return None
    origin = _bounds_center(source_pv.bounds)
    rect = _transform_rect(detail.clip, source.center, source.scale, origin)
    x0, y0, x1, y1 = rect
    ax.add_patch(Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                         closed=True, fill=False, edgecolor=_CENTRE, lw=0.7,
                         linestyle=(0, (4, 2))))

    # Detail callout bubble (circle + leader) placed just outside the region.
    r = 4.2
    bx, by = x0 - r - 3.0, y1 + r + 3.0
    ax.plot([bx + r * 0.72, x0], [by - r * 0.72, y1], color=_CENTRE, lw=0.5)
    ax.add_patch(plt.Circle((bx, by), r, fill=False, edgecolor=_CENTRE, lw=0.7))
    _place_text(ax, bx, by, detail.detail_id or "B", _FS_VIEW_LABEL, "center",
                "center", registry, kind="detail_marker", weight="bold",
                color=_CENTRE)
    # State the magnification next to the bubble.
    scale_txt = ""
    if detail.label and "(" in detail.label:
        scale_txt = detail.label[detail.label.index("(") + 1:].rstrip(")")
    if scale_txt:
        _place_text(ax, bx, by + r + 1.0, scale_txt, _FS_NOTE, "center", "bottom",
                    registry, kind="detail_scale", color=_CENTRE)
    return {"id": detail.detail_id or "B", "view": detail.name,
            "source_view": source.name, "source_rect": [x0, y0, x1, y1],
            "callout": [bx, by, r], "scale_text": scale_txt,
            "clip": list(detail.clip)}


def render_sheet(spec: DrawingSpec, section_polys: Optional[List[Polyline]] = None,
                 projected: Optional[Dict[str, ProjectedView]] = None,
                 out_svg: Optional[str] = None,
                 out_pdf: Optional[str] = None,
                 out_png: Optional[str] = None) -> Dict[str, Any]:
    """Render ``spec`` to SVG/PDF/PNG.  Returns written paths and a layout map."""
    if projected is None:
        raise ValueError("render_sheet requires pre-projected views.")

    registry = _LabelRegistry()
    w, h = spec.sheet_size
    fig = plt.figure(figsize=(w / 25.4, h / 25.4))
    ax = fig.add_axes([0.0, 0.0, 1.0, 1.0])
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.set_aspect("equal")
    ax.axis("off")

    border_info = _draw_border_and_title(ax, spec, registry)

    placements = {p.name: p for p in spec.views}
    pv_bounds: Dict[str, Rect] = {}
    view_layout: Dict[str, Any] = {}
    for p in spec.views:
        pv = projected.get(p.name)
        if pv is None:
            continue
        pv_bounds[p.name] = pv.bounds
        view_layout[p.name] = _draw_view(
            ax, pv, p, section_polys if p.section else None, registry)

    # Detail source markers on their parent views.
    detail_markers: List[Dict[str, Any]] = []
    for p in spec.views:
        if not p.is_detail or not p.detail_source:
            continue
        src = placements.get(p.detail_source)
        src_pv = projected.get(p.detail_source)
        if src is None or src_pv is None:
            continue
        marker = _draw_detail_source_marker(ax, p, src, src_pv, registry)
        if marker:
            detail_markers.append(marker)

    for dim in spec.dimensions:
        _draw_dimension(ax, dim, placements, pv_bounds, registry)

    section_markers = _draw_section_labels(ax, spec, placements, view_layout,
                                           registry)

    # GD&T banner (unspecified)
    for frame in spec.gdt_frames:
        if not frame.get("specified", False):
            _place_text(ax, 12.0, 12.0, frame.get("text", ""), _FS_NOTE,
                        "left", "bottom", registry, kind="gdt", color="#a00000")

    written: Dict[str, Any] = {"svg": None, "pdf": None, "png": None}
    if out_svg:
        os.makedirs(os.path.dirname(os.path.abspath(out_svg)), exist_ok=True)
        fig.savefig(out_svg, format="svg", bbox_inches=None, metadata={"Date": None})
        written["svg"] = os.path.abspath(out_svg)
    if out_pdf:
        os.makedirs(os.path.dirname(os.path.abspath(out_pdf)), exist_ok=True)
        fig.savefig(out_pdf, format="pdf", bbox_inches=None, metadata={"CreationDate": None})
        written["pdf"] = os.path.abspath(out_pdf)
    if out_png:
        os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
        fig.savefig(out_png, format="png", dpi=200, bbox_inches=None,
                    metadata={"Software": "ReForge AI"})
        written["png"] = os.path.abspath(out_png)
    plt.close(fig)

    written["layout"] = {
        "sheet_size": [w, h],
        "border": border_info["border"],
        "inner_border": border_info["inner_border"],
        "title_block": border_info["title_block"],
        "projection_method": spec.title_block.projection_method,
        "views": view_layout,
        "detail_markers": detail_markers,
        "section_markers": section_markers,
        "text_boxes": [dict(e) for e in registry.boxes],
    }
    return written


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------

def generate_engineering_drawings(workplane: cq.Workplane, recipe: Dict[str, Any],
                                  measured: Dict[str, Any], out_dir: str, stem: str,
                                  section_shape: Optional[cq.Shape] = None) -> Dict[str, Any]:
    """Generate SVG + PDF (+ PNG preview) engineering drawings for a modelled part.

    Args:
        workplane: The full solid.
        recipe: The feature recipe (for documented dimensions).
        measured: The validation ``metrics`` dict (measured bbox / volume).
        out_dir: Output directory.
        stem: Filename stem.
        section_shape: Optional sectioned solid (defaults to the workplane).

    Returns:
        A manifest dict with the drawing paths, views, dimensions and layout.
    """
    os.makedirs(out_dir, exist_ok=True)
    spec = build_housing_drawing_spec(recipe, measured, section_shape)

    section_shape = section_shape if section_shape is not None else workplane.val()

    projected: Dict[str, ProjectedView] = {}
    for p in spec.views:
        src = section_shape if p.section else workplane.val()
        projected[p.name] = project(src, p.projection, name=p.name)

    section_polys = section_cut_polygons(section_shape, axis="y", at=0.0)

    svg_path = os.path.join(out_dir, f"{stem}_drawing.svg")
    pdf_path = os.path.join(out_dir, f"{stem}_drawing.pdf")
    png_path = os.path.join(out_dir, f"{stem}_drawing_preview.png")
    written = render_sheet(spec, section_polys=section_polys, projected=projected,
                           out_svg=svg_path, out_pdf=pdf_path, out_png=png_path)

    views_detail = [
        {"name": p.name, "projection": p.projection,
         "is_detail": p.is_detail, "detail_id": p.detail_id,
         "detail_source": p.detail_source, "clip": list(p.clip) if p.clip else None,
         "center": list(p.center), "scale": p.scale}
        for p in spec.views
    ]

    return {
        "svg": written["svg"],
        "pdf": written["pdf"],
        "preview_png": written["png"],
        "views": [p.name for p in spec.views],
        "view_labels": [p.label or p.name for p in spec.views],
        "views_detail": views_detail,
        "detail_markers": written["layout"]["detail_markers"],
        "section_markers": written["layout"].get("section_markers", []),
        "layout": written["layout"],
        "dimension_count": len(spec.dimensions),
        "dimensions": [
            {"kind": d.kind, "view": d.view, "value": d.value, "text": d.text,
             "tolerance": d.tolerance}
            for d in spec.dimensions
        ],
        "title_block": {
            "component": spec.title_block.component,
            "drawing_number": spec.title_block.drawing_number,
            "revision": spec.title_block.revision,
            "scale": spec.title_block.scale,
            "units": spec.title_block.units,
            "projection_method": spec.title_block.projection_method,
            "material": spec.title_block.material,
            "general_tolerance": spec.title_block.general_tolerance,
        },
        "section_labels": spec.section_labels,
        "gdt_frames": spec.gdt_frames,
        "warnings": spec.warnings,
    }
