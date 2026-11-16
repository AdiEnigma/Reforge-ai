"""
mesh_preview.py — Lightweight JSON mesh exporter for ReForge AI.

Writes a renderer-friendly JSON file alongside STEP/STL so the frontend can
display the generated CAD solid in Three.js without parsing binary STL.

Output schema::

    {
      "units": "mm",
      "vertices": [x0, y0, z0, x1, y1, z1, ...],
      "triangles": [i0, j0, k0, i1, j1, k1, ...],
      "edges": [[x0, y0, z0, x1, y1, z1, ...], ...],
      "bbox": {"xmin": ..., "xmax": ..., ..., "xlen": ..., "ylen": ..., "zlen": ...},
      "volume": 1234.5,
      "solidCount": 1,
      "tolerance": 0.15,
      "angularTolerance": 0.3
    }

All coordinates are millimetres in the CAD coordinate system (Z-up).
The frontend is responsible for centering/scaling and Z-up to Y-up conversion.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Tuple


class MeshPreviewError(Exception):
    """Raised when the JSON mesh preview cannot be generated."""


DEFAULT_TOLERANCE = 0.15
DEFAULT_ANGULAR_TOLERANCE = 0.3
MAX_TRIANGLES = 300_000
MAX_EDGE_POINTS = 20_000


def _as_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, 6)


def _vertex_tuple(vertex: Any) -> Optional[Tuple[float, float, float]]:
    if vertex is None:
        return None
    for attr in ("x", "y", "z"):
        if hasattr(vertex, attr):
            x = _as_float(getattr(vertex, attr))
            break
    else:
        try:
            x, y, z = vertex
        except (TypeError, ValueError):
            return None
        x = _as_float(x)
        y = _as_float(y)
        z = _as_float(z)
        if x is None or y is None or z is None:
            return None
        return (x, y, z)
    y = _as_float(getattr(vertex, "y", None))
    z = _as_float(getattr(vertex, "z", None))
    if x is None or y is None or z is None:
        return None
    return (x, y, z)


def _collect_solids(workplane: Any) -> List[Any]:
    if workplane is None:
        return []
    try:
        solids = workplane.solids().vals()
        if solids:
            return list(solids)
    except Exception:
        pass
    try:
        value = workplane.val()
        if value is not None:
            return [value]
    except Exception:
        pass
    if hasattr(workplane, "tessellate"):
        return [workplane]
    return []


def _tessellate(solid: Any, tolerance: float, angular_tolerance: float):
    shape = solid
    if hasattr(solid, "wrapped") and not hasattr(solid, "tessellate"):
        shape = solid.wrapped
    if not hasattr(shape, "tessellate"):
        raise MeshPreviewError("Solid does not expose a tessellate() method.")
    result = shape.tessellate(tolerance, angular_tolerance)
    if not result or len(result) < 2:
        raise MeshPreviewError("Tessellation returned no geometry.")
    return result[0] or [], result[1] or []


def _edge_points(solid: Any, tolerance: float) -> List[List[float]]:
    edges: List[List[float]] = []
    total_points = 0
    try:
        cad_edges = list(solid.Edges())
    except Exception:
        return edges

    for edge in cad_edges:
        if total_points >= MAX_EDGE_POINTS:
            break
        try:
            length = float(edge.Length())
        except Exception:
            continue
        if not math.isfinite(length) or length <= 0:
            continue
        segments = int(max(2, min(64, math.ceil(length / max(tolerance * 4.0, 0.5)))))
        points: List[float] = []
        try:
            for index in range(segments + 1):
                point = edge.positionAt(index / segments)
                vertex = _vertex_tuple(point)
                if vertex is None:
                    points = []
                    break
                points.extend(vertex)
        except Exception:
            continue
        if len(points) >= 6:
            edges.append(points)
            total_points += len(points) // 3
    return edges


def export_mesh_preview(
    workplane: Any,
    file_path: str,
    tolerance: float = DEFAULT_TOLERANCE,
    angular_tolerance: float = DEFAULT_ANGULAR_TOLERANCE,
    include_edges: bool = True,
) -> str:
    """
    Exports a JSON mesh preview for the given CadQuery Workplane/Solid.

    Returns the absolute path to the written JSON file.
    Raises MeshPreviewError on failure so callers can treat the preview as
    non-fatal (STEP/STL remain the source of truth).
    """
    if not file_path:
        raise MeshPreviewError("No destination path provided for mesh preview.")
    if workplane is None:
        raise MeshPreviewError("Cannot export a mesh preview for None workplane.")

    solids = _collect_solids(workplane)
    if not solids:
        raise MeshPreviewError("No solids found on workplane.")

    vertices: List[float] = []
    triangles: List[int] = []
    active_tolerance = max(float(tolerance), 0.01)
    active_angular = max(float(angular_tolerance), 0.01)
    used_tolerance = active_tolerance

    for attempt in range(3):
        vertices = []
        triangles = []
        used_tolerance = active_tolerance * (2 ** attempt)
        for solid in solids:
            mesh_vertices, mesh_triangles = _tessellate(
                solid, used_tolerance, active_angular
            )
            offset = len(vertices) // 3
            for vertex in mesh_vertices:
                triple = _vertex_tuple(vertex)
                if triple is None:
                    raise MeshPreviewError("Tessellation produced a non-numeric vertex.")
                vertices.extend(triple)
            for triangle in mesh_triangles:
                try:
                    a, b, c = triangle
                except (TypeError, ValueError):
                    continue
                triangles.extend((int(a) + offset, int(b) + offset, int(c) + offset))
        if len(triangles) // 3 <= MAX_TRIANGLES:
            break
        if attempt == 2:
            raise MeshPreviewError(
                f"Tessellation produced too many triangles ({len(triangles) // 3})."
            )

    if len(vertices) < 9 or len(triangles) < 3:
        raise MeshPreviewError("Tessellation produced an empty mesh.")

    bbox: Dict[str, float] = {}
    volume = 0.0
    try:
        box = solids[0].BoundingBox()
        bbox = {
            "xmin": round(float(box.xmin), 6),
            "xmax": round(float(box.xmax), 6),
            "ymin": round(float(box.ymin), 6),
            "ymax": round(float(box.ymax), 6),
            "zmin": round(float(box.zmin), 6),
            "zmax": round(float(box.zmax), 6),
            "xlen": round(float(box.xlen), 6),
            "ylen": round(float(box.ylen), 6),
            "zlen": round(float(box.zlen), 6),
        }
    except Exception:
        bbox = _bbox_from_vertices(vertices)

    for solid in solids:
        try:
            volume += float(solid.Volume())
        except Exception:
            pass

    edges: List[List[float]] = []
    if include_edges:
        for solid in solids:
            edges.extend(_edge_points(solid, used_tolerance))

    payload = {
        "units": "mm",
        "vertices": vertices,
        "triangles": triangles,
        "edges": edges,
        "bbox": bbox,
        "volume": round(volume, 6),
        "solidCount": len(solids),
        "tolerance": used_tolerance,
        "angularTolerance": active_angular,
    }

    directory = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(directory, exist_ok=True)
    temporary = f"{file_path}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        os.replace(temporary, file_path)
    except Exception as exc:
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
        except OSError:
            pass
        raise MeshPreviewError(f"Failed to write mesh preview: {exc}") from exc

    if not os.path.exists(file_path) or os.path.getsize(file_path) == 0:
        raise MeshPreviewError(f"Mesh preview export produced an empty file: {file_path}")

    return os.path.abspath(file_path)


def _bbox_from_vertices(vertices: List[float]) -> Dict[str, float]:
    xs = vertices[0::3]
    ys = vertices[1::3]
    zs = vertices[2::3]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    zmin, zmax = min(zs), max(zs)
    return {
        "xmin": round(xmin, 6),
        "xmax": round(xmax, 6),
        "ymin": round(ymin, 6),
        "ymax": round(ymax, 6),
        "zmin": round(zmin, 6),
        "zmax": round(zmax, 6),
        "xlen": round(xmax - xmin, 6),
        "ylen": round(ymax - ymin, 6),
        "zlen": round(zmax - zmin, 6),
    }
