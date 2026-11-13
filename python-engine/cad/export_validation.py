"""
export_validation.py — Stage 4 export validation for the ReForge AI CAD layer.

This module validates CAD *exports* by re-reading them, rather than trusting
that a file merely exists.  It complements the existing exporters in
``exports/step_export.py`` and ``exports/mesh_export.py`` (whose public
interfaces are unchanged) by verifying what those exporters produced.

Checks performed
----------------
STEP:
    * re-import with CadQuery / OpenCASCADE,
    * solid count and per-solid validity,
    * total volume and bounding box compared with the source model.

STL:
    * re-import / parse the mesh (binary and ASCII supported),
    * finite vertices, valid triangle faces,
    * watertightness (edge-manifold analysis) where applicable,
    * degenerate triangle detection,
    * facet normal validity (unit length + winding consistency),
    * bounds and enclosed volume compared with the source model.

Drawings:
    * non-empty SVG / PDF output,
    * presence of required views, title-block fields, units and dimensions,
    * preservation of any supplied tolerance text,
    * **rendered-layout geometry checks** (when the manifest carries a
      ``layout`` block): every declared view must contain real line work (a
      detail view that renders only its label fails), no significant text-box
      collisions, no view-extent overlaps, no view overflowing the drawing
      border, no view intersecting the title block, and view placement must
      agree with the declared FIRST/THIRD-angle convention.

Manifest:
    * every exported artefact recorded with its exact size and SHA-256,
    * ``build_export_manifest(..., base_dir=...)`` records **relative**
      (forward-slash) paths so a package carries no absolute Windows paths,
    * ``verify_export_manifest`` re-reads the files and confirms the recorded
      sizes and hashes still match.

Everything returns structured results with explicit diagnostics; a failed or
inconclusive check always lowers ``valid`` rather than being silently ignored.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cadquery as cq
import numpy as np

DEFAULT_VOLUME_TOL = 0.02     # 2 % relative volume agreement (STEP vs source)
DEFAULT_BBOX_TOL = 0.02       # 2 % relative bbox agreement
DEFAULT_STL_VOLUME_TOL = 0.05  # 5 % (mesh approximation of curved surfaces)
DEFAULT_STL_BBOX_TOL = 0.02
DEFAULT_DEGENERATE_AREA = 1e-9  # mm^2


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _bbox_dict(bb) -> Dict[str, float]:
    return {
        "xmin": float(bb.xmin), "xmax": float(bb.xmax), "xlen": float(bb.xlen),
        "ymin": float(bb.ymin), "ymax": float(bb.ymax), "ylen": float(bb.ylen),
        "zmin": float(bb.zmin), "zmax": float(bb.zmax), "zlen": float(bb.zlen),
    }


def describe_shape(shape_or_wp: Any) -> Dict[str, Any]:
    """Summarise a CadQuery workplane / shape: solids, validity, volume, bbox."""
    shape = shape_or_wp
    if isinstance(shape_or_wp, cq.Workplane):
        shape = shape_or_wp.val()
    solids: List[Any] = []
    try:
        solids = cq.Workplane("XY").newObject([shape]).solids().vals()
    except Exception:
        try:
            solids = list(shape.Solids())
        except Exception:
            solids = []
    info: Dict[str, Any] = {
        "solid_count": len(solids),
        "all_valid": True,
        "volumes": [],
        "volume": 0.0,
        "bbox": {},
    }
    for s in solids:
        try:
            v = float(s.Volume())
        except Exception:
            v = 0.0
        info["volumes"].append(v)
        info["volume"] += v
        try:
            if not bool(s.isValid()):
                info["all_valid"] = False
        except Exception:
            info["all_valid"] = False
    try:
        info["bbox"] = _bbox_dict(shape.BoundingBox())
    except Exception:
        info["bbox"] = {}
    return info


def _rel_diff(a: float, b: float) -> float:
    denom = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denom


# ---------------------------------------------------------------------------
# STEP validation
# ---------------------------------------------------------------------------

def validate_step_export(step_path: str, source: Any,
                         volume_tol: float = DEFAULT_VOLUME_TOL,
                         bbox_tol: float = DEFAULT_BBOX_TOL) -> Dict[str, Any]:
    """Re-import a STEP file and compare it with the source model.

    Args:
        step_path: Path to the exported STEP file.
        source: The source ``cq.Workplane`` / shape that was exported.
        volume_tol: Allowed relative volume difference.
        bbox_tol: Allowed relative bounding-box difference per axis.

    Returns:
        A structured result with ``valid``, ``checks``, ``issues``, ``metrics``.
    """
    issues: List[str] = []
    checks: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}

    if not step_path or not os.path.exists(step_path):
        return {"valid": False, "checks": checks,
                "issues": [f"STEP file missing: {step_path}"], "metrics": metrics}
    size = os.path.getsize(step_path)
    metrics["step_path"] = os.path.abspath(step_path)
    metrics["step_size_bytes"] = size
    metrics["step_sha256"] = _sha256(step_path)
    if size == 0:
        return {"valid": False, "checks": checks,
                "issues": ["STEP file is empty."], "metrics": metrics}

    src = describe_shape(source)
    metrics["source"] = src

    try:
        imported = cq.importers.importStep(step_path)
    except Exception as e:  # noqa: BLE001
        issues.append(f"STEP re-import failed: {e}")
        return {"valid": False, "checks": checks, "issues": issues, "metrics": metrics}

    reimp = describe_shape(imported)
    metrics["reimported"] = reimp

    # ---- solid count ----------------------------------------------------
    count_ok = reimp["solid_count"] == src["solid_count"] and reimp["solid_count"] > 0
    checks["solid_count"] = {"source": src["solid_count"],
                             "reimported": reimp["solid_count"], "ok": count_ok}
    if not count_ok:
        issues.append(
            f"STEP solid count mismatch: source {src['solid_count']}, "
            f"re-imported {reimp['solid_count']}.")

    # ---- validity -------------------------------------------------------
    checks["reimported_valid"] = bool(reimp["all_valid"])
    if not reimp["all_valid"]:
        issues.append("Re-imported STEP contains one or more invalid solids.")

    # ---- volume ---------------------------------------------------------
    v_ok = True
    if src["volume"] > 0:
        v_rel = _rel_diff(src["volume"], reimp["volume"])
        v_ok = v_rel <= volume_tol
        checks["volume"] = {"source": src["volume"], "reimported": reimp["volume"],
                            "relative_error": v_rel, "tolerance": volume_tol, "ok": v_ok}
        if not v_ok:
            issues.append(
                f"STEP volume differs by {v_rel * 100:.3f}% "
                f"(> {volume_tol * 100:.1f}%): source {src['volume']:.3f}, "
                f"re-imported {reimp['volume']:.3f}.")
    else:
        checks["volume"] = {"ok": False, "note": "source volume not positive"}

    # ---- bounding box ---------------------------------------------------
    bbox_ok = True
    bbox_diffs: Dict[str, float] = {}
    if src["bbox"] and reimp["bbox"]:
        for dim in ("xlen", "ylen", "zlen"):
            d = _rel_diff(src["bbox"][dim], reimp["bbox"][dim])
            bbox_diffs[dim] = d
            if d > bbox_tol:
                bbox_ok = False
    checks["bbox"] = {"relative_errors": bbox_diffs, "tolerance": bbox_tol, "ok": bbox_ok}
    if not bbox_ok:
        issues.append(f"STEP bounding box differs by more than {bbox_tol * 100:.1f}% on one or more axes: {bbox_diffs}.")

    valid = bool(count_ok and reimp["all_valid"] and v_ok and bbox_ok)
    return {"valid": valid, "checks": checks, "issues": issues, "metrics": metrics}


# ---------------------------------------------------------------------------
# STL parsing / validation
# ---------------------------------------------------------------------------

def _parse_binary_stl(data: bytes) -> Tuple[np.ndarray, np.ndarray]:
    n = struct.unpack_from("<I", data, 80)[0]
    expected = 84 + n * 50
    if expected > len(data):
        raise ValueError(
            f"Binary STL declared {n} triangles ({expected} bytes) "
            f"but file is only {len(data)} bytes.")
    arr = np.frombuffer(data, dtype=np.uint8, count=n * 50, offset=84)
    arr = arr.reshape(n, 50)
    floats = arr[:, :48].copy().view("<f4").reshape(n, 12)
    normals = floats[:, 0:3].astype(np.float64)
    verts = floats[:, 3:12].astype(np.float64).reshape(n, 3, 3)
    return normals, verts


def _parse_ascii_stl(text: str) -> Tuple[np.ndarray, np.ndarray]:
    normals: List[Tuple[float, float, float]] = []
    tris: List[Tuple[Tuple[float, float, float], ...]] = []
    cur_n: Optional[Tuple[float, float, float]] = None
    cur_v: List[Tuple[float, float, float]] = []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "facet" and len(parts) >= 5:
            cur_n = (float(parts[2]), float(parts[3]), float(parts[4]))
        elif parts[0] == "vertex" and len(parts) >= 4:
            cur_v.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "endfacet":
            if len(cur_v) == 3:
                tris.append(tuple(cur_v))
                normals.append(cur_n or (0.0, 0.0, 0.0))
            cur_v = []
            cur_n = None
    return np.array(normals, dtype=np.float64), np.array(tris, dtype=np.float64)


def parse_stl(stl_path: str) -> Dict[str, Any]:
    """Parse a binary or ASCII STL file into facet normals and triangles."""
    with open(stl_path, "rb") as fh:
        data = fh.read()
    if len(data) == 0:
        raise ValueError("STL file is empty.")
    is_binary = True
    if data[:5] == b"solid" and b"\x00" not in data[:512]:
        # Could still be binary that happens to start with 'solid'; verify size.
        head = data[:512].decode("ascii", errors="ignore").lower()
        if "facet" in head or "endsolid" in head:
            is_binary = False
    if is_binary:
        normals, verts = _parse_binary_stl(data)
    else:
        normals, verts = _parse_ascii_stl(data.decode("ascii", errors="ignore"))
    return {"binary": is_binary, "normals": normals, "triangles": verts,
            "num_triangles": int(verts.shape[0])}


def _weld_vertices(tris: np.ndarray, tol: float = 1e-4) -> Tuple[np.ndarray, np.ndarray]:
    """Weld duplicated STL vertices into an indexed mesh.

    Returns ``(vertices, faces)`` where ``faces`` are integer indices.
    """
    flat = tris.reshape(-1, 3)
    key = np.round(flat / tol).astype(np.int64)
    uniq, inverse = np.unique(key, axis=0, return_inverse=True)
    verts = uniq.astype(np.float64) * tol
    faces = inverse.reshape(-1, 3)
    return verts, faces


def validate_stl_export(stl_path: str, source: Any,
                        volume_tol: float = DEFAULT_STL_VOLUME_TOL,
                        bbox_tol: float = DEFAULT_STL_BBOX_TOL,
                        degenerate_area: float = DEFAULT_DEGENERATE_AREA) -> Dict[str, Any]:
    """Re-import / parse an STL file and validate the mesh against the source."""
    issues: List[str] = []
    checks: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}

    if not stl_path or not os.path.exists(stl_path):
        return {"valid": False, "checks": checks,
                "issues": [f"STL file missing: {stl_path}"], "metrics": metrics}
    size = os.path.getsize(stl_path)
    metrics["stl_path"] = os.path.abspath(stl_path)
    metrics["stl_size_bytes"] = size
    metrics["stl_sha256"] = _sha256(stl_path)
    if size == 0:
        return {"valid": False, "checks": checks,
                "issues": ["STL file is empty."], "metrics": metrics}

    try:
        parsed = parse_stl(stl_path)
    except Exception as e:  # noqa: BLE001
        issues.append(f"STL parse/re-import failed: {e}")
        return {"valid": False, "checks": checks, "issues": issues, "metrics": metrics}

    normals: np.ndarray = parsed["normals"]
    tris: np.ndarray = parsed["triangles"]
    n_tri = parsed["num_triangles"]
    metrics["binary"] = parsed["binary"]
    metrics["num_triangles"] = n_tri
    checks["non_empty"] = {"num_triangles": n_tri, "ok": n_tri > 0}
    if n_tri == 0:
        issues.append("STL contains no triangles.")
        return {"valid": False, "checks": checks, "issues": issues, "metrics": metrics}

    # ---- finite vertices ------------------------------------------------
    finite = bool(np.isfinite(tris).all())
    checks["finite_vertices"] = {"ok": finite}
    if not finite:
        issues.append("STL contains non-finite (NaN/Inf) vertex coordinates.")

    # ---- degenerate triangles ------------------------------------------
    v0, v1, v2 = tris[:, 0, :], tris[:, 1, :], tris[:, 2, :]
    cross = np.cross(v1 - v0, v2 - v0)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    n_degenerate = int(np.sum(areas <= degenerate_area))
    checks["degenerate_triangles"] = {"count": n_degenerate, "ok": n_degenerate == 0}
    if n_degenerate:
        issues.append(f"STL contains {n_degenerate} degenerate triangle(s) (area <= {degenerate_area}).")

    # ---- normals --------------------------------------------------------
    n_len = np.linalg.norm(normals, axis=1)
    zero_normals = int(np.sum(n_len < 1e-9))
    unit_ok = bool(np.all(np.abs(n_len - 1.0) <= 1e-3)) if n_tri else False
    # Winding consistency: facet normal should agree with geometric normal.
    geo = cross / np.clip(np.linalg.norm(cross, axis=1, keepdims=True), 1e-12, None)
    dots = np.einsum("ij,ij->i", geo, normals)
    consistent = int(np.sum(dots > 0.0))
    checks["normals"] = {
        "zero_normals": zero_normals,
        "unit_length_ok": unit_ok,
        "consistent_with_winding": consistent,
        "consistency_fraction": round(consistent / n_tri, 4) if n_tri else 0.0,
        "ok": zero_normals == 0 and consistent == n_tri,
    }
    if zero_normals:
        issues.append(f"STL contains {zero_normals} zero-length facet normal(s).")
    if n_tri and consistent != n_tri:
        issues.append(
            f"STL facet normals are inconsistent with triangle winding for "
            f"{n_tri - consistent}/{n_tri} triangles.")

    # ---- watertightness (edge manifold) --------------------------------
    verts, faces = _weld_vertices(tris)
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0)
    edges = np.sort(edges, axis=1)
    uniq_edges, counts = np.unique(edges, axis=0, return_counts=True)
    n_boundary = int(np.sum(counts == 1))
    n_nonmanifold = int(np.sum(counts > 2))
    watertight = bool(n_boundary == 0 and n_nonmanifold == 0)
    v_count = int(verts.shape[0])
    e_count = int(uniq_edges.shape[0])
    euler = v_count - e_count + n_tri
    checks["watertight"] = {
        "welded_vertices": v_count,
        "unique_edges": e_count,
        "boundary_edges": n_boundary,
        "nonmanifold_edges": n_nonmanifold,
        "euler_characteristic": euler,
        "ok": watertight,
    }
    if not watertight:
        issues.append(
            f"STL mesh is not watertight: {n_boundary} boundary edge(s), "
            f"{n_nonmanifold} non-manifold edge(s).")

    # ---- volume / bounds ------------------------------------------------
    signed = np.einsum("ij,ij->i", v0, np.cross(v1, v2))
    mesh_volume = float(abs(np.sum(signed)) / 6.0)
    mn = verts.min(axis=0)
    mx = verts.max(axis=0)
    mesh_bbox = {
        "xmin": float(mn[0]), "xmax": float(mx[0]), "xlen": float(mx[0] - mn[0]),
        "ymin": float(mn[1]), "ymax": float(mx[1]), "ylen": float(mx[1] - mn[1]),
        "zmin": float(mn[2]), "zmax": float(mx[2]), "zlen": float(mx[2] - mn[2]),
    }
    metrics["mesh_volume_mm3"] = mesh_volume
    metrics["mesh_bbox"] = mesh_bbox

    src = describe_shape(source)
    metrics["source"] = src

    v_ok = True
    if src["volume"] > 0:
        v_rel = _rel_diff(src["volume"], mesh_volume)
        v_ok = v_rel <= volume_tol
        checks["volume"] = {"source": src["volume"], "mesh": mesh_volume,
                            "relative_error": v_rel, "tolerance": volume_tol, "ok": v_ok}
        if not v_ok:
            issues.append(
                f"STL mesh volume differs from source by {v_rel * 100:.3f}% "
                f"(> {volume_tol * 100:.1f}%).")
    else:
        checks["volume"] = {"ok": False, "note": "source volume not positive"}

    bbox_ok = True
    bbox_diffs: Dict[str, float] = {}
    if src["bbox"]:
        for dim in ("xlen", "ylen", "zlen"):
            d = _rel_diff(src["bbox"][dim], mesh_bbox[dim])
            bbox_diffs[dim] = d
            if d > bbox_tol:
                bbox_ok = False
    checks["bbox"] = {"relative_errors": bbox_diffs, "tolerance": bbox_tol, "ok": bbox_ok}
    if not bbox_ok:
        issues.append(f"STL bounds differ from source by more than {bbox_tol * 100:.1f}%: {bbox_diffs}.")

    # Watertightness is only *required* for a closed solid; report but let
    # volume+bbox+validity decide hard validity.
    valid = bool(finite and n_tri > 0 and v_ok and bbox_ok
                 and checks["normals"]["ok"] and n_degenerate == 0 and watertight)
    return {"valid": valid, "checks": checks, "issues": issues, "metrics": metrics}


# ---------------------------------------------------------------------------
# Drawing layout validation (real geometry / collisions / projection)
# ---------------------------------------------------------------------------

# A text collision is only reported when the overlap is significant (more than
# this fraction of the smaller box); a hairline touch is not a collision.
TEXT_COLLISION_FRAC = 0.45
# Two view extents must overlap by more than this area (mm^2) to be a collision.
VIEW_OVERLAP_AREA = 1.0


def _rect_area(r: Sequence[float]) -> float:
    return max(0.0, float(r[2]) - float(r[0])) * max(0.0, float(r[3]) - float(r[1]))


def _overlap_area(a: Sequence[float], b: Sequence[float]) -> float:
    ix = min(float(a[2]), float(b[2])) - max(float(a[0]), float(b[0]))
    iy = min(float(a[3]), float(b[3])) - max(float(a[1]), float(b[1]))
    if ix <= 0.0 or iy <= 0.0:
        return 0.0
    return ix * iy


def _rect_within(inner: Sequence[float], outer: Sequence[float],
                 tol: float = 0.5) -> bool:
    return (float(inner[0]) >= float(outer[0]) - tol
            and float(inner[1]) >= float(outer[1]) - tol
            and float(inner[2]) <= float(outer[2]) + tol
            and float(inner[3]) <= float(outer[3]) + tol)


def validate_drawing_layout(layout: Dict[str, Any],
                            projection_method: Optional[str] = None) -> Dict[str, Any]:
    """Validate the rendered sheet layout produced by ``render_sheet``.

    Unlike the text-based checks, this inspects the *geometry* the renderer
    actually produced, so a view that renders only its label (e.g. a detail
    view with no clipped line work) is reported as empty:

    * every declared view must contain real line work (``line_count > 0``),
    * no significant text-box collisions,
    * no view-extent overlaps,
    * no view overflowing the drawing border,
    * no view intersecting the title block,
    * the view layout must agree with the declared projection convention.
    """
    issues: List[str] = []
    checks: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}

    if not isinstance(layout, dict) or not layout:
        return {"valid": True, "checks": {"layout_present": False},
                "issues": [], "metrics": {}, "note": "no layout supplied"}

    views = layout.get("views") or {}
    inner_border = layout.get("inner_border")
    title_block = layout.get("title_block")

    # ---- 1. real geometry present per declared view ---------------------
    empty_views: List[str] = []
    view_line_counts: Dict[str, int] = {}
    for name, vinfo in views.items():
        lc = int((vinfo or {}).get("line_count", 0))
        view_line_counts[name] = lc
        if lc <= 0:
            empty_views.append(name)
    checks["view_geometry"] = {
        "line_counts": view_line_counts,
        "empty_views": empty_views,
        "ok": not empty_views and bool(views),
    }
    metrics["view_line_counts"] = view_line_counts
    if not views:
        issues.append("Drawing layout declares no views.")
    for name in empty_views:
        issues.append(f"View '{name}' rendered no geometry (label only).")

    # ---- 2. text collisions ---------------------------------------------
    boxes = layout.get("text_boxes") or []
    collisions: List[Dict[str, Any]] = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            ab = a.get("box")
            bb = b.get("box")
            if not ab or not bb:
                continue
            area = _overlap_area(ab, bb)
            if area <= 0.0:
                continue
            smaller = min(_rect_area(ab), _rect_area(bb))
            frac = area / smaller if smaller > 0 else 0.0
            if frac > TEXT_COLLISION_FRAC:
                collisions.append({
                    "a": str(a.get("text", "")), "b": str(b.get("text", "")),
                    "overlap_area": round(area, 3), "overlap_fraction": round(frac, 3),
                })
    checks["text_collisions"] = {"count": len(collisions),
                                 "collisions": collisions[:20],
                                 "ok": not collisions}
    metrics["text_box_count"] = len(boxes)
    for c in collisions[:10]:
        issues.append(f"Text collision: '{c['a']}' overlaps '{c['b']}' "
                      f"({c['overlap_fraction'] * 100:.0f}% of the smaller label).")

    # ---- 3. view overlaps -----------------------------------------------
    named = [(n, (v or {}).get("extent")) for n, v in views.items()]
    named = [(n, e) for n, e in named if e]
    overlaps: List[Dict[str, Any]] = []
    for i in range(len(named)):
        for j in range(i + 1, len(named)):
            na, ea = named[i]
            nb, eb = named[j]
            area = _overlap_area(ea, eb)
            if area > VIEW_OVERLAP_AREA:
                overlaps.append({"a": na, "b": nb, "overlap_area": round(area, 2)})
    checks["view_overlaps"] = {"count": len(overlaps), "overlaps": overlaps,
                               "ok": not overlaps}
    for o in overlaps:
        issues.append(f"Views '{o['a']}' and '{o['b']}' overlap "
                      f"({o['overlap_area']} mm^2).")

    # ---- 4. page-boundary overflow --------------------------------------
    overflow: List[str] = []
    if inner_border:
        for name, extent in named:
            if not _rect_within(extent, inner_border):
                overflow.append(name)
    checks["page_overflow"] = {"views": overflow, "ok": not overflow}
    for name in overflow:
        issues.append(f"View '{name}' extends beyond the drawing border.")

    # ---- 5. title-block intersection ------------------------------------
    tb_hits: List[str] = []
    if title_block:
        for name, extent in named:
            if _overlap_area(extent, title_block) > VIEW_OVERLAP_AREA:
                tb_hits.append(name)
    checks["title_block_intersection"] = {"views": tb_hits, "ok": not tb_hits}
    for name in tb_hits:
        issues.append(f"View '{name}' intersects the title block.")

    # ---- 6. projection-consistency vs declared convention ---------------
    method = str(projection_method
                 or layout.get("projection_method") or "").upper()
    proj = {"method": method, "ok": True, "notes": []}
    centers = {n: (v or {}).get("center") for n, v in views.items()}
    projections = {n: (v or {}).get("projection") for n, v in views.items()}

    def _find(view_names, projection):
        for n in view_names:
            if n in views and projections.get(n) == projection:
                return n
        return None

    front_name = _find(views.keys(), "front")
    right_name = _find(views.keys(), "right")
    top_name = _find(views.keys(), "top")
    if "FIRST" in method:
        if front_name and right_name and centers.get(front_name) and centers.get(right_name):
            if centers[right_name][0] >= centers[front_name][0]:
                proj["ok"] = False
                proj["notes"].append(
                    "FIRST ANGLE: right-side view must be placed LEFT of the front view.")
        if front_name and top_name and centers.get(front_name) and centers.get(top_name):
            if centers[top_name][1] >= centers[front_name][1]:
                proj["ok"] = False
                proj["notes"].append(
                    "FIRST ANGLE: top view must be placed BELOW the front view.")
    elif "THIRD" in method:
        if front_name and right_name and centers.get(front_name) and centers.get(right_name):
            if centers[right_name][0] <= centers[front_name][0]:
                proj["ok"] = False
                proj["notes"].append(
                    "THIRD ANGLE: right-side view must be placed RIGHT of the front view.")
        if front_name and top_name and centers.get(front_name) and centers.get(top_name):
            if centers[top_name][1] <= centers[front_name][1]:
                proj["ok"] = False
                proj["notes"].append(
                    "THIRD ANGLE: top view must be placed ABOVE the front view.")
    else:
        proj["notes"].append("No recognised projection convention declared; "
                             "placement consistency not enforced.")
    checks["projection_consistency"] = proj
    issues.extend(proj["notes"]) if not proj["ok"] else None

    valid = bool(checks["view_geometry"]["ok"] and checks["text_collisions"]["ok"]
                 and checks["view_overlaps"]["ok"] and checks["page_overflow"]["ok"]
                 and checks["title_block_intersection"]["ok"]
                 and checks["projection_consistency"]["ok"])
    return {"valid": valid, "checks": checks, "issues": issues, "metrics": metrics}


def validate_drawing_export(svg_path: Optional[str], pdf_path: Optional[str],
                            drawing_manifest: Optional[Dict[str, Any]] = None,
                            required_views: Optional[Sequence[str]] = None,
                            required_texts: Optional[Sequence[str]] = None,
                            required_units: str = "mm",
                            preview_path: Optional[str] = None) -> Dict[str, Any]:
    """Validate SVG / PDF drawing outputs and their annotation content.

    In addition to the text-level checks, when the drawing manifest carries a
    ``layout`` block (as produced by ``engineering_drawing.render_sheet``) the
    rendered *geometry* is validated: every declared view must contain real
    line work, and text collisions / view overlaps / page overflow /
    title-block intersections / projection consistency are checked.
    """
    issues: List[str] = []
    checks: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}
    manifest = drawing_manifest or {}

    # ---- files exist and are non-empty ---------------------------------
    svg_ok = bool(svg_path and os.path.exists(svg_path) and os.path.getsize(svg_path) > 0)
    pdf_ok = bool(pdf_path and os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0)
    checks["svg_present"] = {"path": svg_path, "size": os.path.getsize(svg_path) if svg_ok else 0, "ok": svg_ok}
    checks["pdf_present"] = {"path": pdf_path, "size": os.path.getsize(pdf_path) if pdf_ok else 0, "ok": pdf_ok}
    if not svg_ok:
        issues.append(f"Drawing SVG missing or empty: {svg_path}")
    if not pdf_ok:
        issues.append(f"Drawing PDF missing or empty: {pdf_path}")

    svg_text = ""
    if svg_ok:
        with open(svg_path, encoding="utf-8", errors="ignore") as fh:
            svg_text = fh.read()
        metrics["svg_size_bytes"] = os.path.getsize(svg_path)
        metrics["svg_sha256"] = _sha256(svg_path)
    if pdf_ok:
        with open(pdf_path, "rb") as fh:
            head = fh.read(5)
        metrics["pdf_size_bytes"] = os.path.getsize(pdf_path)
        metrics["pdf_sha256"] = _sha256(pdf_path)
        checks["pdf_header"] = {"header": head.decode("latin-1"), "ok": head == b"%PDF-"}

    # ---- required views -------------------------------------------------
    req_views = list(required_views or manifest.get("views") or [])
    view_labels = list(manifest.get("view_labels") or [])
    missing_views = [v for v in req_views if v not in svg_text]
    checks["views"] = {"required": req_views, "missing": missing_views, "ok": not missing_views}
    if missing_views:
        issues.append(f"Drawing is missing required view label(s): {missing_views}")

    # ---- required free text (title block etc.) -------------------------
    req_texts = list(required_texts or [])
    missing_texts = [t for t in req_texts if t not in svg_text]
    checks["texts"] = {"required": req_texts, "missing": missing_texts, "ok": not missing_texts}
    if missing_texts:
        issues.append(f"Drawing is missing required text: {missing_texts}")

    # ---- dimensions -----------------------------------------------------
    dims = manifest.get("dimensions") or []
    dim_texts = [str(d.get("text", "")) for d in dims]
    missing_dims = [t for t in dim_texts if t and t not in svg_text]
    checks["dimensions"] = {
        "count": len(dims),
        "in_manifest": dim_texts,
        "missing_from_svg": missing_dims,
        "ok": len(dims) > 0 and not missing_dims,
    }
    if not dims:
        issues.append("Drawing manifest declares no dimensions.")
    if missing_dims:
        issues.append(f"Dimension callout(s) not found in SVG: {missing_dims}")

    # ---- tolerances preserved ------------------------------------------
    tols = [d.get("tolerance") for d in dims if d.get("tolerance")]
    tol_ok = all(str(t) in svg_text for t in tols)
    checks["tolerances"] = {"declared": tols, "ok": tol_ok}
    if tols and not tol_ok:
        issues.append("One or more supplied tolerances were not preserved in the drawing.")

    # ---- units ----------------------------------------------------------
    units_ok = required_units in svg_text
    checks["units"] = {"required": required_units, "ok": units_ok}
    if not units_ok:
        issues.append(f"Drawing does not state required units '{required_units}'.")

    # ---- rendered layout (geometry, collisions, projection) -------------
    layout = manifest.get("layout") or {}
    layout_res = validate_drawing_layout(
        layout, projection_method=manifest.get("title_block", {}).get(
            "projection_method") if isinstance(manifest.get("title_block"), dict) else None)
    checks["layout"] = layout_res["checks"]
    issues.extend(layout_res["issues"])
    layout_ok = bool(layout_res["valid"])

    # ---- optional raster preview artifact -------------------------------
    preview_ok = True
    if preview_path is not None:
        preview_ok = bool(os.path.exists(preview_path)
                          and os.path.getsize(preview_path) > 0)
        checks["preview"] = {"path": preview_path, "ok": preview_ok,
                             "size": os.path.getsize(preview_path) if preview_ok else 0}
        if not preview_ok:
            issues.append(f"Drawing preview PNG missing or empty: {preview_path}")

    valid = bool(svg_ok and pdf_ok and not missing_views and not missing_texts
                 and checks["dimensions"]["ok"] and tol_ok and units_ok
                 and layout_ok and preview_ok)
    return {"valid": valid, "checks": checks, "issues": issues, "metrics": metrics}


# ---------------------------------------------------------------------------
# Export manifest
# ---------------------------------------------------------------------------

def _relative_posix(path: str, base_dir: Optional[str]) -> str:
    """Return ``path`` relative to ``base_dir`` using forward slashes.

    Falls back to an absolute path only when no base directory is supplied (so
    existing callers keep working), never emitting a raw Windows backslash path.
    """
    if base_dir:
        try:
            rel = os.path.relpath(os.path.abspath(path), os.path.abspath(base_dir))
            return rel.replace("\\", "/")
        except Exception:
            pass
    return os.path.abspath(path).replace("\\", "/")


def _portable_string(value: str, base_dir: str) -> str:
    """Rewrite one absolute filesystem path string to a relative POSIX path."""
    if not value or not base_dir:
        return value
    # Only touch strings that plausibly are paths.
    if not (os.path.isabs(value) or "\\" in value):
        return value
    try:
        if not os.path.isabs(value):
            return value
        abs_v = os.path.abspath(value)
        base = os.path.abspath(base_dir)
        if os.path.commonpath([abs_v, base]) == base:
            return os.path.relpath(abs_v, base).replace("\\", "/")
    except Exception:  # noqa: BLE001 - different drives / odd values
        pass
    return value


def to_portable_paths(obj: Any, base_dir: str) -> Any:
    """Recursively rewrite absolute paths under ``base_dir`` to relative POSIX.

    Applied to a drawing manifest / validation report before it is written so a
    packaged deliverable carries no absolute Windows paths.  Non-path strings,
    numbers and structure are left untouched; the rewrite is purely lexical so
    sizes and hashes are unaffected.
    """
    if isinstance(obj, dict):
        return {k: to_portable_paths(v, base_dir) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_portable_paths(v, base_dir) for v in obj]
    if isinstance(obj, str):
        return _portable_string(obj, base_dir)
    return obj


def _file_entry(path: Optional[str], description: str,
                base_dir: Optional[str] = None) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "description": description,
        "path": _relative_posix(path, base_dir) if path else path,
    }
    if not path or not os.path.exists(path):
        entry["exists"] = False
        return entry
    entry.update({
        "exists": True,
        "size_bytes": os.path.getsize(path),
        "sha256": _sha256(path),
    })
    return entry


def build_export_manifest(entries: Dict[str, Optional[str]],
                          validation: Optional[Dict[str, Any]] = None,
                          base_dir: Optional[str] = None) -> Dict[str, Any]:
    """Build a manifest of exported artefacts with sizes and hashes.

    When ``base_dir`` is supplied every ``path`` is recorded **relative** to it
    (forward-slash form), so the manifest is portable and contains no absolute
    Windows paths.  Sizes and SHA-256 are read from the exact files on disk.
    """
    manifest: Dict[str, Any] = {
        "format": "reforge-export-manifest",
        "version": "1.0",
        "files": {name: _file_entry(path, name, base_dir)
                  for name, path in entries.items()},
    }
    if base_dir:
        manifest["base_dir_relative_to"] = os.path.basename(
            os.path.abspath(base_dir).replace("\\", "/")) or "."
    if validation is not None:
        manifest["validation_summary"] = {
            "valid": validation.get("valid"),
            "step_valid": (validation.get("step") or {}).get("valid"),
            "stl_valid": (validation.get("stl") or {}).get("valid"),
            "drawing_valid": (validation.get("drawing") or {}).get("valid"),
        }
    return manifest


def build_package_manifest(files: Sequence[str], base_dir: str,
                           package_name: Optional[str] = None,
                           extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """List every file that will be packaged, with relative path + size + hash.

    Keyed by the package-relative POSIX arcname so the manifest itself documents
    exactly what the ZIP contains.  ``extra`` fields (e.g. the excluded
    container name) are merged in.
    """
    entries: Dict[str, Any] = {}
    for path in files:
        rel = _relative_posix(path, base_dir)
        entries[rel] = _file_entry(path, rel, base_dir)
    manifest: Dict[str, Any] = {
        "format": "reforge-package-manifest",
        "version": "1.0",
        "package": package_name,
        "file_count": len(entries),
        "files": entries,
    }
    if extra:
        manifest.update(extra)
    return manifest


def verify_export_manifest(manifest: Dict[str, Any],
                           base_dir: Optional[str] = None) -> Dict[str, Any]:
    """Re-verify a manifest against the actual files on disk.

    Every entry recorded as existing must still exist, and its recorded
    ``size_bytes`` / ``sha256`` must match a fresh read.  Relative paths are
    resolved against ``base_dir``.
    """
    issues: List[str] = []
    checks: Dict[str, Any] = {}
    files = (manifest or {}).get("files") or {}
    if not files:
        return {"valid": False, "checks": {}, "issues": ["Manifest lists no files."],
                "metrics": {}}

    for name, entry in files.items():
        path = (entry or {}).get("path")
        exists = bool((entry or {}).get("exists"))
        resolved = path
        if path and base_dir and not os.path.isabs(path):
            resolved = os.path.join(base_dir, path.replace("/", os.sep))
        actual_exists = bool(resolved and os.path.exists(resolved))
        check: Dict[str, Any] = {
            "declared_exists": exists,
            "actual_exists": actual_exists,
            "path": path,
        }
        ok = True
        if exists and not actual_exists:
            issues.append(f"Manifest entry '{name}' recorded as present but is missing: {path}")
            ok = False
        elif exists and actual_exists:
            size = os.path.getsize(resolved)
            digest = _sha256(resolved)
            size_ok = size == (entry or {}).get("size_bytes")
            hash_ok = digest == (entry or {}).get("sha256")
            check["size_ok"] = size_ok
            check["sha256_ok"] = hash_ok
            if not size_ok:
                issues.append(f"Manifest size mismatch for '{name}': "
                              f"{entry.get('size_bytes')} != {size}.")
                ok = False
            if not hash_ok:
                issues.append(f"Manifest SHA-256 mismatch for '{name}'.")
                ok = False
        check["ok"] = ok
        checks[name] = check

    return {"valid": not issues, "checks": checks, "issues": issues,
            "metrics": {"file_count": len(files),
                        "verified": sum(1 for c in checks.values() if c.get("ok"))}}


def validate_exports(step_path: str, stl_path: str, source: Any,
                     svg_path: Optional[str] = None,
                     pdf_path: Optional[str] = None,
                     drawing_manifest: Optional[Dict[str, Any]] = None,
                     required_views: Optional[Sequence[str]] = None,
                     required_texts: Optional[Sequence[str]] = None,
                     preview_path: Optional[str] = None) -> Dict[str, Any]:
    """Run all export validations and return a combined report."""
    step = validate_step_export(step_path, source)
    stl = validate_stl_export(stl_path, source)
    drawing: Dict[str, Any] = {"valid": True, "checks": {}, "issues": [], "metrics": {}}
    if svg_path or pdf_path:
        drawing = validate_drawing_export(
            svg_path, pdf_path, drawing_manifest,
            required_views=required_views, required_texts=required_texts,
            preview_path=preview_path)

    all_issues = (list(step["issues"]) + list(stl["issues"]) + list(drawing["issues"]))
    valid = bool(step["valid"] and stl["valid"] and drawing["valid"])
    return {
        "valid": valid,
        "step": step,
        "stl": stl,
        "drawing": drawing,
        "issues": all_issues,
    }
