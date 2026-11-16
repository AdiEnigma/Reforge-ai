"""
fit_loop.py — Image-fit check and capped silhouette refine loop.

Compares a tessellated CAD silhouette (orthographic projection) against a
segmentation mask (e.g. the SAM 2 mask) and searches for the scale multiplier
that maximises intersection-over-union (IoU).

The loop is deliberately bounded: at most ``max_iterations`` (3-5) evaluations.
It never edits geometry; it reports a scale correction plus a status so the
caller can decide between ``converged``, ``needs_input`` and ``failed``.
"""

from __future__ import annotations

import base64
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from cad.engineering_drawing import VIEW_AXES
from exports.mesh_preview import _collect_solids, _tessellate, _vertex_tuple

DEFAULT_VIEW = "front"
DEFAULT_TARGET_IOU = 0.85
DEFAULT_MIN_IOU = 0.50
DEFAULT_MIN_ITERATIONS = 3
DEFAULT_MAX_ITERATIONS = 5
DEFAULT_SCALE_BOUNDS = (0.60, 1.40)
MIN_MM_PER_PIXEL = 1e-5
MAX_MM_PER_PIXEL = 1e3


class ImageFitError(Exception):
    """Raised when the image-fit check cannot run (bad mask/calibration)."""


@dataclass
class FitLoopResult:
    status: str
    fit_score: float
    iou: float
    scale: float
    iterations: int
    reason: str
    history: List[Dict[str, Any]] = field(default_factory=list)
    view: str = DEFAULT_VIEW
    basis: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "fit_score": round(float(self.fit_score), 4),
            "iou": round(float(self.iou), 4),
            "scale": round(float(self.scale), 4),
            "iterations": int(self.iterations),
            "reason": self.reason,
            "history": self.history,
            "view": self.view,
            "basis": self.basis,
        }


def mask_from_payload(payload: Any) -> np.ndarray:
    """Decode a mask payload into a 2-D uint8 array.

    Accepts a 2-D list, ``{"base64": "..."}`` (raw PNG), or
    ``{"data": "<base64>", "mimeType": "image/png"}``.
    """
    if payload is None:
        raise ImageFitError("A segmentation mask is required for the image-fit check.")
    if isinstance(payload, dict):
        encoded = payload.get("base64") or payload.get("data")
        if not isinstance(encoded, str):
            raise ImageFitError("Mask payload must include base64 'data'.")
        encoded = encoded.split(",", 1)[-1]
        try:
            raw = base64.b64decode(encoded, validate=False)
        except Exception as exc:  # noqa: BLE001
            raise ImageFitError(f"Mask is not valid base64: {exc}") from exc
        array = _decode_image(raw)
    else:
        array = np.asarray(payload)
    if array.ndim == 3:
        array = array[..., 0]
    if array.ndim != 2 or array.size == 0:
        raise ImageFitError("Mask must decode to a non-empty 2-D array.")
    return (array > 0).astype(np.uint8)


def _decode_image(raw: bytes) -> np.ndarray:
    import cv2

    array = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
    if array is None:
        raise ImageFitError("Mask image data could not be decoded.")
    return array


def _as_positive_float(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ImageFitError(f"'{name}' must be a number.")
    if not math.isfinite(number) or number <= 0:
        raise ImageFitError(f"'{name}' must be a positive finite number.")
    return number


def _view_axes(view: str) -> Tuple[np.ndarray, np.ndarray]:
    main, xdir = VIEW_AXES.get(view, VIEW_AXES[DEFAULT_VIEW])
    normal = np.asarray(main, dtype=float)
    right = np.asarray(xdir, dtype=float)
    # Screen "up" is orthogonal to both the view normal and screen right.
    up = np.cross(normal, right)
    norm = np.linalg.norm(up)
    if norm <= 0:
        raise ImageFitError("Invalid view axis configuration.")
    return right, up / norm


def _projected_triangles(
    workplane: Any, view: str
) -> Tuple[np.ndarray, np.ndarray]:
    """Return (vertices_mm[N,2], triangles[M,3]) for a view."""
    solids = _collect_solids(workplane)
    if not solids:
        raise ImageFitError("Workplane has no solids to project.")

    vertices: List[Tuple[float, float, float]] = []
    triangles: List[Tuple[int, int, int]] = []
    for solid in solids:
        mesh_vertices, mesh_triangles = _tessellate(solid, 0.2, 0.3)
        offset = len(vertices)
        for vertex in mesh_vertices:
            triple = _vertex_tuple(vertex)
            if triple is None:
                raise ImageFitError("Tessellation produced a non-numeric vertex.")
            vertices.append(triple)
        for triangle in mesh_triangles:
            try:
                a, b, c = triangle
            except (TypeError, ValueError):
                continue
            triangles.append((int(a) + offset, int(b) + offset, int(c) + offset))

    if not vertices or not triangles:
        raise ImageFitError("Tessellation produced no triangles.")

    points = np.asarray(vertices, dtype=float)
    right, up = _view_axes(view)
    projected = np.column_stack((points @ right, points @ up))
    return projected, np.asarray(triangles, dtype=int)


def project_silhouette(
    workplane: Any,
    mask_shape: Tuple[int, int],
    mm_per_pixel: float,
    view: str = DEFAULT_VIEW,
    scale: float = 1.0,
    alignment: Optional[Tuple[float, float]] = None,
) -> np.ndarray:
    """Rasterise the CAD silhouette into a mask-sized uint8 image.

    ``alignment`` is the mask-space (cx, cy) that the CAD projection centre is
    mapped to; when omitted, the projected silhouette is centred in the frame.
    """
    import cv2

    mm_per_pixel = _as_positive_float(mm_per_pixel, "mm_per_pixel")
    if not (MIN_MM_PER_PIXEL <= mm_per_pixel <= MAX_MM_PER_PIXEL):
        raise ImageFitError("'mm_per_pixel' is outside the supported range.")
    scale = _as_positive_float(scale, "scale")

    height, width = int(mask_shape[0]), int(mask_shape[1])
    if height <= 0 or width <= 0:
        raise ImageFitError("Mask shape must be positive.")

    projected, triangles = _projected_triangles(workplane, view)
    mm_per_px = mm_per_pixel / scale
    pixels = projected / mm_per_px

    px_min, py_min = pixels.min(axis=0)
    px_max, py_max = pixels.max(axis=0)
    centre = np.array([(px_min + px_max) / 2.0, (py_min + py_max) / 2.0])
    target = (
        np.array([alignment[0], alignment[1]], dtype=float)
        if alignment is not None
        else np.array([width / 2.0, height / 2.0])
    )
    # Screen y grows downward; flip the projected up-axis.
    placed = np.column_stack((pixels[:, 0] - centre[0] + target[0],
                              -(pixels[:, 1] - centre[1]) + target[1]))

    canvas = np.zeros((height, width), dtype=np.uint8)
    for a, b, c in triangles:
        triangle = np.round(placed[[a, b, c]]).astype(np.int32)
        cv2.fillConvexPoly(canvas, triangle, 1)
    return canvas


def silhouette_iou(projected: np.ndarray, mask: np.ndarray) -> float:
    a = np.asarray(projected) > 0
    b = np.asarray(mask) > 0
    if a.shape != b.shape:
        raise ImageFitError(
            f"Shape mismatch: projected {a.shape} vs mask {b.shape}."
        )
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(a, b).sum() / union)


def _mask_alignment(mask: np.ndarray) -> Tuple[float, float]:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ImageFitError("Segmentation mask is empty.")
    return float(xs.mean()), float(ys.mean())


def run_image_fit(
    workplane: Any,
    mask: Any,
    mm_per_pixel: float,
    view: str = DEFAULT_VIEW,
    target_iou: float = DEFAULT_TARGET_IOU,
    min_iou: float = DEFAULT_MIN_IOU,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    min_iterations: int = DEFAULT_MIN_ITERATIONS,
    scale_bounds: Sequence[float] = DEFAULT_SCALE_BOUNDS,
) -> FitLoopResult:
    """Fit a global scale multiplier in ``scale_bounds`` to a mask.

    Runs between ``min_iterations`` and ``max_iterations`` evaluations and
    classifies the outcome as ``converged``, ``needs_input`` or ``failed``.
    """
    mask_array = mask if isinstance(mask, np.ndarray) else mask_from_payload(mask)
    mask_array = (mask_array > 0).astype(np.uint8)
    if mask_array.ndim != 2 or mask_array.size == 0:
        raise ImageFitError("Mask must be a non-empty 2-D array.")

    target_iou = _as_positive_float(target_iou, "target_iou")
    min_iou = _as_positive_float(min_iou, "min_iou")
    if min_iou > target_iou:
        raise ImageFitError("'min_iou' cannot exceed 'target_iou'.")

    max_iterations = int(max(1, min(int(max_iterations), 5)))
    min_iterations = int(max(1, min(int(min_iterations), max_iterations)))

    low, high = float(scale_bounds[0]), float(scale_bounds[1])
    if not (0 < low < high):
        raise ImageFitError("'scale_bounds' must be positive and increasing.")

    alignment = _mask_alignment(mask_array)
    history: List[Dict[str, Any]] = []
    best_iou = -1.0
    best_scale = 1.0

    def evaluate(scale: float) -> float:
        nonlocal best_iou, best_scale
        silhouette = project_silhouette(
            workplane,
            mask_array.shape,
            mm_per_pixel,
            view=view,
            scale=scale,
            alignment=alignment,
        )
        iou = silhouette_iou(silhouette, mask_array)
        history.append({"iteration": len(history) + 1,
                        "scale": round(scale, 4),
                        "iou": round(iou, 4)})
        if iou > best_iou:
            best_iou = iou
            best_scale = scale
        return iou

    # Start at the calibrated scale, then probe the bounds and midpoints.
    start_scale = float(np.clip(1.0, low, high))
    evaluate(start_scale)
    converged = best_iou >= target_iou and len(history) >= min_iterations

    probes = [
        low,
        high,
        (low + start_scale) / 2.0,
        (start_scale + high) / 2.0,
    ]
    for candidate in probes:
        if converged or len(history) >= max_iterations:
            break
        if any(abs(candidate - item["scale"]) < 1e-3 for item in history):
            continue
        evaluate(candidate)
        converged = best_iou >= target_iou and len(history) >= min_iterations

    # Local refinement around the best candidate while the budget allows.
    span = (high - low) / 8.0
    step = 1
    while not converged and len(history) < max_iterations:
        candidate = float(np.clip(best_scale + (span if step % 2 else -span),
                                  low, high))
        step += 1
        if any(abs(candidate - item["scale"]) < 1e-3 for item in history):
            span /= 2.0
            if span < 1e-3:
                break
            continue
        evaluate(candidate)
        span /= 2.0
        converged = best_iou >= target_iou and len(history) >= min_iterations

    basis = {
        "method": "orthographic_silhouette_iou",
        "view": view,
        "mm_per_pixel": round(float(mm_per_pixel), 6),
        "target_iou": round(target_iou, 4),
        "min_iou": round(min_iou, 4),
        "scale_bounds": [round(low, 4), round(high, 4)],
        "is_accuracy_metric": True,
        "note": ("IoU compares the projected CAD silhouette with the supplied "
                 "segmentation mask after centroid alignment."),
    }

    if best_iou >= target_iou:
        status = "converged"
        reason = "Projected silhouette matched the segmentation mask."
    elif best_iou >= min_iou:
        status = "needs_input"
        reason = ("Best silhouette overlap is below target; add a clearer "
                  "orthogonal photo, a reference dimension, or a better mask.")
    else:
        status = "failed"
        reason = ("Projected silhouette does not match the segmentation mask; "
                  "the selected component type or dimensions are likely wrong.")

    return FitLoopResult(
        status=status,
        fit_score=best_iou,
        iou=best_iou,
        scale=best_scale,
        iterations=len(history),
        reason=reason,
        history=history,
        view=view,
        basis=basis,
    )
