"""
advanced_preview.py — Visual evidence generation for feature-based CAD models.

Produces real preview images from an actual CadQuery/OpenCASCADE model:

* **SVG** orthographic projections (isometric, front, side, top) using CadQuery's
  built-in SVG exporter (no extra dependencies).
* **PNG** raster previews rendered off-screen from the exported STL mesh using
  VTK (already available through the CadQuery stack).  If VTK is unavailable the
  module degrades gracefully to SVG-only output.
* **Section / cutaway** previews: the model is intersected with a half-space so
  internal cavities, bores and passages become visible.

Everything here is deterministic and driven by the model geometry itself; no
synthetic or fallback shapes are ever drawn in place of real geometry.
"""

from __future__ import annotations

import logging
import math
import os
import tempfile
from typing import Any, Dict, List, Optional, Tuple

import cadquery as cq

logger = logging.getLogger("reforge.cad.advanced_preview")

# ---------------------------------------------------------------------------
# View definitions
# ---------------------------------------------------------------------------

#: Named view -> camera/projection direction (unit-ish vectors are fine).
VIEW_DIRECTIONS: Dict[str, Tuple[float, float, float]] = {
    "isometric": (1.0, 1.0, 1.0),
    "front": (0.0, -1.0, 0.0),
    "side": (1.0, 0.0, 0.0),
    "top": (0.0, 0.0, 1.0),
}

DEFAULT_SVG_SIZE = (900, 700)
DEFAULT_PNG_SIZE = (1000, 800)


# ---------------------------------------------------------------------------
# SVG projections (CadQuery native)
# ---------------------------------------------------------------------------

def export_view_svg(workplane: cq.Workplane, path: str, view: str = "isometric",
                    size: Tuple[int, int] = DEFAULT_SVG_SIZE) -> str:
    """Export a single orthographic SVG projection of ``workplane``.

    Args:
        workplane: The modelled part.
        path: Destination ``.svg`` path.
        view: One of :data:`VIEW_DIRECTIONS`.
        size: ``(width, height)`` in pixels.

    Returns:
        The absolute path of the written SVG file.
    """
    if workplane is None:
        raise ValueError("Cannot export a preview of None geometry.")
    direction = VIEW_DIRECTIONS.get(view, VIEW_DIRECTIONS["isometric"])
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    cq.exporters.export(
        workplane,
        path,
        cq.exporters.ExportTypes.SVG,
        opt={
            "width": size[0],
            "height": size[1],
            "marginLeft": 20,
            "marginTop": 20,
            "showAxes": False,
            "projectionDir": direction,
            "strokeWidth": 0.4,
            "strokeColor": (20, 20, 20),
            "hiddenColor": (170, 170, 170),
            "showHidden": False,
        },
    )
    return os.path.abspath(path)


def export_all_svg_views(workplane: cq.Workplane, out_dir: str, stem: str,
                         views: Optional[List[str]] = None,
                         size: Tuple[int, int] = DEFAULT_SVG_SIZE) -> Dict[str, str]:
    """Export SVG projections for several views.  Returns ``{view: path}``."""
    views = views or ["isometric", "front", "side", "top"]
    os.makedirs(out_dir, exist_ok=True)
    result: Dict[str, str] = {}
    for v in views:
        p = os.path.join(out_dir, f"{stem}_{v}.svg")
        result[v] = export_view_svg(workplane, p, v, size)
    return result


# ---------------------------------------------------------------------------
# Section / cutaway
# ---------------------------------------------------------------------------

def make_half_section(workplane: cq.Workplane, axis: str = "y",
                      keep: str = "positive", margin: float = 50.0) -> cq.Workplane:
    """Cut a model with a half-space to expose internal geometry.

    Args:
        workplane: The part to section.
        axis: ``"x"``, ``"y"`` or ``"z"`` — the normal of the cutting plane.
        keep: ``"positive"`` keeps the material on the positive side of the axis
            (removes the negative half) and vice versa.
        margin: How far the cutting box extends beyond the model bounding box.

    Returns:
        A new workplane containing the sectioned solid.
    """
    if workplane is None:
        raise ValueError("Cannot section None geometry.")
    bb = workplane.val().BoundingBox()
    cx = (bb.xmin + bb.xmax) / 2.0
    cy = (bb.ymin + bb.ymax) / 2.0
    cz = (bb.zmin + bb.zmax) / 2.0
    sx = (bb.xlen + 2 * margin)
    sy = (bb.ylen + 2 * margin)
    sz = (bb.zlen + 2 * margin)
    sign = 1.0 if keep == "positive" else -1.0

    if axis == "x":
        # Box covering the negative (or positive) X half.
        box = cq.Workplane("XY").box(sx, sy, sz).translate(
            (cx - sign * sx / 2.0, cy, cz))
    elif axis == "z":
        box = cq.Workplane("XY").box(sx, sy, sz).translate(
            (cx, cy, cz - sign * sz / 2.0))
    else:  # y
        box = cq.Workplane("XY").box(sx, sy, sz).translate(
            (cx, cy - sign * sy / 2.0, cz))

    sectioned = workplane.cut(box)
    solids = sectioned.solids().vals()
    if len(solids) == 0:
        # The half-space removed everything; fall back to the original model so a
        # preview is still produced (never a synthetic substitute).
        logger.warning("Half-section removed all material; returning original body.")
        return workplane
    return sectioned


def export_section_svg(workplane: cq.Workplane, path: str,
                       axis: str = "y", keep: str = "positive",
                       view: str = "isometric",
                       size: Tuple[int, int] = DEFAULT_SVG_SIZE) -> str:
    """Export a sectioned SVG projection."""
    sectioned = make_half_section(workplane, axis=axis, keep=keep)
    return export_view_svg(sectioned, path, view, size)


# ---------------------------------------------------------------------------
# PNG rasterisation via VTK (offscreen)
# ---------------------------------------------------------------------------

def _vtk_available() -> bool:
    try:
        import vtk  # noqa: F401
        return True
    except Exception:
        return False


def render_png_from_stl(stl_path: str, out_path: str, view: str = "isometric",
                        size: Tuple[int, int] = DEFAULT_PNG_SIZE,
                        background: Tuple[float, float, float] = (1.0, 1.0, 1.0),
                        color: Tuple[float, float, float] = (0.72, 0.76, 0.82)) -> Optional[str]:
    """Render an STL mesh to a PNG off-screen using VTK.

    Returns the output path, or ``None`` if VTK is unavailable / rendering fails.
    """
    if not _vtk_available():
        logger.info("VTK not available; skipping PNG rasterisation.")
        return None
    try:
        import vtk

        reader = vtk.vtkSTLReader()
        reader.SetFileName(stl_path)
        reader.Update()

        normals = vtk.vtkPolyDataNormals()
        normals.SetInputConnection(reader.GetOutputPort())
        normals.SetFeatureAngle(45.0)
        normals.Update()

        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(normals.GetOutputPort())
        mapper.ScalarVisibilityOff()

        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.GetProperty().SetColor(*color)
        actor.GetProperty().SetInterpolationToPhong()
        actor.GetProperty().SetSpecular(0.25)
        actor.GetProperty().SetSpecularPower(24.0)

        renderer = vtk.vtkRenderer()
        renderer.AddActor(actor)
        renderer.SetBackground(*background)
        renderer.SetBackground2(0.92, 0.94, 0.97)
        renderer.GradientBackgroundOn()

        window = vtk.vtkRenderWindow()
        window.SetOffScreenRendering(1)
        window.AddRenderer(renderer)
        window.SetSize(size[0], size[1])

        # Frame the model from the requested direction.
        bounds = reader.GetOutput().GetBounds()
        cx = (bounds[0] + bounds[1]) / 2.0
        cy = (bounds[2] + bounds[3]) / 2.0
        cz = (bounds[4] + bounds[5]) / 2.0
        diag = math.sqrt((bounds[1] - bounds[0]) ** 2 +
                         (bounds[3] - bounds[2]) ** 2 +
                         (bounds[5] - bounds[4]) ** 2)
        dist = max(diag * 1.9, 1.0)

        direction = VIEW_DIRECTIONS.get(view, VIEW_DIRECTIONS["isometric"])
        length = math.sqrt(sum(d * d for d in direction)) or 1.0
        dx, dy, dz = (d / length for d in direction)

        camera = renderer.GetActiveCamera()
        camera.SetFocalPoint(cx, cy, cz)
        camera.SetPosition(cx + dx * dist, cy + dy * dist, cz + dz * dist)
        if abs(dx) < 1e-6 and abs(dy) < 1e-6:
            # Looking straight down: set a sensible view-up.
            camera.SetViewUp(0.0, -1.0, 0.0)
        else:
            camera.SetViewUp(0.0, 0.0, 1.0)
        renderer.ResetCamera()
        camera.Zoom(1.15)
        renderer.ResetCameraClippingRange()

        window.Render()

        w2i = vtk.vtkWindowToImageFilter()
        w2i.SetInput(window)
        w2i.SetInputBufferTypeToRGB()
        w2i.ReadFrontBufferOff()
        w2i.Update()

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        writer = vtk.vtkPNGWriter()
        writer.SetFileName(out_path)
        writer.SetInputConnection(w2i.GetOutputPort())
        writer.Write()
        return os.path.abspath(out_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("VTK PNG rendering failed: %s", e)
        return None


def render_png_views(workplane: cq.Workplane, out_dir: str, stem: str,
                     views: Optional[List[str]] = None,
                     size: Tuple[int, int] = DEFAULT_PNG_SIZE,
                     workplane_for_mesh: Optional[cq.Workplane] = None) -> Dict[str, Optional[str]]:
    """Export STL meshes and render PNG previews for several views.

    Args:
        workplane: The (possibly sectioned) geometry to render.
        out_dir: Output directory.
        stem: Filename stem.
        views: Views to render (defaults to all four).
        size: PNG size in pixels.
        workplane_for_mesh: Optional separate geometry to mesh (e.g. the full
            body when ``workplane`` is a section); defaults to ``workplane``.

    Returns:
        ``{view: png_path_or_None}``.
    """
    views = views or ["isometric", "front", "side", "top"]
    os.makedirs(out_dir, exist_ok=True)
    mesh_wp = workplane_for_mesh if workplane_for_mesh is not None else workplane

    stl_path = os.path.join(out_dir, f"{stem}.stl")
    cq.exporters.export(mesh_wp, stl_path, cq.exporters.ExportTypes.STL)

    result: Dict[str, Optional[str]] = {}
    for v in views:
        png_path = os.path.join(out_dir, f"{stem}_{v}.png")
        result[v] = render_png_from_stl(stl_path, png_path, v, size)
    return result


# ---------------------------------------------------------------------------
# High-level evidence bundle
# ---------------------------------------------------------------------------

def generate_preview_bundle(workplane: cq.Workplane, out_dir: str, stem: str,
                            include_section: bool = True) -> Dict[str, Any]:
    """Generate the full visual evidence set for a model.

    Produces SVG + PNG for isometric/front/side/top views and, when
    ``include_section`` is set, a half-section cutaway (SVG + PNG) that exposes
    internal cavities and passages.

    Returns a manifest dict describing the generated files.
    """
    os.makedirs(out_dir, exist_ok=True)
    views = ["isometric", "front", "side", "top"]

    svg = export_all_svg_views(workplane, out_dir, stem, views)
    png = render_png_views(workplane, out_dir, stem, views)

    manifest: Dict[str, Any] = {
        "stem": stem,
        "svg": svg,
        "png": png,
        "section": {},
    }

    if include_section:
        section_wp = make_half_section(workplane, axis="y", keep="positive")
        sec_svg = os.path.join(out_dir, f"{stem}_section.svg")
        export_view_svg(section_wp, sec_svg, "isometric")
        # A second, front-on section view best shows the internal bores.
        sec_front_svg = os.path.join(out_dir, f"{stem}_section_front.svg")
        export_view_svg(section_wp, sec_front_svg, "front")

        sec_stl = os.path.join(out_dir, f"{stem}_section.stl")
        cq.exporters.export(section_wp, sec_stl, cq.exporters.ExportTypes.STL)
        sec_png = render_png_from_stl(
            sec_stl, os.path.join(out_dir, f"{stem}_section.png"), "isometric")
        sec_front_png = render_png_from_stl(
            sec_stl, os.path.join(out_dir, f"{stem}_section_front.png"), "front")

        manifest["section"] = {
            "svg": os.path.abspath(sec_svg),
            "svg_front": os.path.abspath(sec_front_svg),
            "png": sec_png,
            "png_front": sec_front_png,
            "axis": "y",
            "keep": "positive",
        }

    return manifest
