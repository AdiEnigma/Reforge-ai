"""
feature_measurements.py â€” Measurement layer for the ReForge AI vision engine.

Turns generic OpenCV observations (contours, ellipses, symmetry hints) into
normalised geometric measurements that a CAD synthesiser can consume.

Design rules
------------
* No physical millimetres are produced here. Every length is a ratio relative
  to the detected outer feature (``radius / outer_radius`` or
  ``distance / outer_radius``). Scale is a separate concern handled downstream.
* No part-type branching. The module works from geometric primitives only:
  concentric circles, radial arrays of equal circles, silhouette profiles and
  simplified polygons.
* Pure functions where possible: the detector output is a plain dictionary, so
  measurements can be unit-tested without CUDA, SAM 2 or real photographs.
* Every measurement carries a confidence and the residuals used to derive it.
* The compact payload contains no pixel arrays (only per-image summaries).

Schema version: 1.0
"""
from __future__ import annotations

import math
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

SCHEMA_VERSION = "1.0"

_VIEW_LABELS = ("axial_face", "side_profile", "oblique", "unknown")

#: Minimum circularity for a contour to be treated as a circular feature.
_MIN_ELLIPSE_CIRCULARITY = 0.45
#: A contour is the outer body when it is the largest by area.
_MIN_OUTER_AREA_PX = 40.0
#: Duplicate contours from the two Canny edges of the same circle are merged.
_DEDUPE_CENTER_TOL = 0.02    # fraction of outer diameter
_DEDUPE_CENTER_MIN_PX = 3.0
_DEDUPE_RADIUS_TOL = 0.06    # fraction of ellipse major axis
_DEDUPE_RADIUS_MIN_PX = 2.5
#: A feature is concentric when its centre is this close to the body centre.
_CONCENTRIC_TOL = 0.06       # fraction of outer radius
#: Radius ratio above this is the outer body's own inner edge, not a bore.
_OUTER_EDGE_RATIO = 0.94
#: Circularity / axis-ratio thresholds used by view classification.
_AXIAL_MIN_CIRCULARITY = 0.72
_AXIAL_MIN_AXIS_RATIO = 0.82
_OBLIQUE_MIN_AXIS_RATIO = 0.32
_OBLIQUE_MIN_CIRCULARITY = 0.62
_SIDE_MAX_CIRCULARITY = 0.74
_SIDE_MIN_ASPECT = 1.18


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _round(value: Optional[float], digits: int = 5) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, digits)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _points_array(points: Any) -> Optional[np.ndarray]:
    if points is None:
        return None
    try:
        arr = np.asarray(points, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if arr.ndim != 2 or arr.shape[1] < 2 or arr.shape[0] < 1:
        return None
    return arr[:, :2]


def _bbox(points: np.ndarray) -> Tuple[float, float, float, float]:
    xs = points[:, 0]
    ys = points[:, 1]
    return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())


def _contour_metrics(points: np.ndarray) -> Dict[str, float]:
    try:
        import cv2  # type: ignore

        contour = points.reshape(-1, 1, 2).astype(np.float32)
        area = float(cv2.contourArea(contour))
        perimeter = float(cv2.arcLength(contour, True))
    except Exception:
        x0, y0, x1, y1 = _bbox(points)
        area = max(0.0, (x1 - x0) * (y1 - y0))
        perimeter = 0.0
    circularity = (
        4.0 * math.pi * area / (perimeter ** 2)
        if perimeter > 1e-6 else 0.0
    )
    return {
        "area": area,
        "perimeter": perimeter,
        "circularity": _clamp01(circularity),
    }


def _fit_ellipse(points: np.ndarray) -> Optional[Dict[str, float]]:
    """Fit an ellipse and normalise it so ``major >= minor``."""
    if points.shape[0] < 5:
        return None
    try:
        import cv2  # type: ignore

        contour = points.reshape(-1, 1, 2).astype(np.float32)
        ((cx, cy), (w, h), angle) = cv2.fitEllipse(contour)
    except Exception:
        return None
    if not all(math.isfinite(v) for v in (cx, cy, w, h, angle)):
        return None
    if w <= 0 or h <= 0:
        return None
    if w >= h:
        major, minor, major_angle = float(w), float(h), float(angle)
    else:
        major, minor, major_angle = float(h), float(w), float(angle) + 90.0
    major_angle = major_angle % 180.0
    return {
        "cx": float(cx),
        "cy": float(cy),
        "major": major,
        "minor": minor,
        "angle_deg": major_angle,
        "axis_ratio": _clamp01(minor / major) if major > 0 else 0.0,
    }


def _rotated_offset(
    dx: float, dy: float, angle_deg: float, foreshorten: float
) -> Tuple[float, float]:
    """Rotate an offset into the ellipse frame and undo minor-axis squash."""
    theta = math.radians(angle_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    u = dx * cos_t + dy * sin_t
    v = -dx * sin_t + dy * cos_t
    if foreshorten > 1e-3:
        v /= foreshorten
    return u, v


def _circular_distance_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _circular_median(angles: Sequence[float]) -> Optional[float]:
    if not angles:
        return None
    # Median of unit vectors, robust to wrap-around.
    radians = [math.radians(a) for a in angles]
    sx = sum(math.cos(r) for r in radians)
    sy = sum(math.sin(r) for r in radians)
    if abs(sx) < 1e-9 and abs(sy) < 1e-9:
        return None
    return math.degrees(math.atan2(sy, sx)) % 360.0


def _weighted_median(values: Iterable[Tuple[float, float]]) -> Optional[float]:
    pairs = [(float(v), max(0.0, float(w))) for v, w in values if math.isfinite(float(v))]
    if not pairs:
        return None
    pairs.sort(key=lambda pair: pair[0])
    total = sum(weight for _, weight in pairs)
    if total <= 0:
        return median([value for value, _ in pairs])
    target = total / 2.0
    running = 0.0
    for value, weight in pairs:
        running += weight
        if running >= target:
            return value
    return pairs[-1][0]


def _mean(values: Sequence[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _relative_spread(values: Sequence[float]) -> float:
    usable = [v for v in values if v is not None and math.isfinite(v)]
    if len(usable) < 2:
        return 0.0
    centre = abs(median(usable))
    if centre < 1e-9:
        return 0.0
    return (max(usable) - min(usable)) / centre


# ---------------------------------------------------------------------------
# Detection (OpenCV observations -> candidate primitives)
# ---------------------------------------------------------------------------

def _contour_records(cv_dict: Dict[str, Any]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for contour in cv_dict.get("contours") or []:
        points = _points_array(contour.get("points_px"))
        if points is None:
            continue
        metrics = _contour_metrics(points)
        if metrics["area"] < _MIN_OUTER_AREA_PX:
            continue
        x0, y0, x1, y1 = _bbox(points)
        ellipse = _fit_ellipse(points)
        records.append(
            {
                "points": points,
                "area": metrics["area"],
                "perimeter": metrics["perimeter"],
                "circularity": metrics["circularity"],
                "bbox": (x0, y0, x1, y1),
                "ellipse": ellipse,
                "touches_border": bool(
                    any("border" in str(w).lower() for w in contour.get("warnings", []))
                ),
            }
        )
    return records


def _select_outer(records: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not records:
        return None
    # Prefer contours that do not touch the border, then largest area.
    ordered = sorted(
        records,
        key=lambda r: (not r["touches_border"], r["area"]),
        reverse=True,
    )
    return ordered[0] if ordered[0]["area"] >= _MIN_OUTER_AREA_PX else None


def _point_in_ellipse(
    x: float, y: float, ellipse: Dict[str, float], margin: float = 1.08
) -> bool:
    theta = math.radians(ellipse["angle_deg"])
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    dx, dy = x - ellipse["cx"], y - ellipse["cy"]
    u = dx * cos_t + dy * sin_t
    v = -dx * sin_t + dy * cos_t
    a = max(ellipse["major"] / 2.0, 1e-6) * margin
    b = max(ellipse["minor"] / 2.0, 1e-6) * margin
    return (u / a) ** 2 + (v / b) ** 2 <= 1.0


def _circular_candidates(
    records: List[Dict[str, Any]], outer: Dict[str, Any]
) -> List[Dict[str, Any]]:
    outer_ellipse = outer["ellipse"]
    if outer_ellipse is None or outer_ellipse["major"] <= 0:
        return []
    candidates: List[Dict[str, Any]] = []
    for record in records:
        if record is outer:
            continue
        ellipse = record["ellipse"]
        if ellipse is None:
            continue
        if record["circularity"] < _MIN_ELLIPSE_CIRCULARITY:
            continue
        if record["area"] >= 0.9 * outer["area"]:
            continue
        if not _point_in_ellipse(ellipse["cx"], ellipse["cy"], outer_ellipse):
            continue
        if ellipse["major"] <= 2.0:
            continue
        candidates.append(
            {
                "cx": ellipse["cx"],
                "cy": ellipse["cy"],
                "major": ellipse["major"],
                "minor": ellipse["minor"],
                "angle_deg": ellipse["angle_deg"],
                "axis_ratio": ellipse["axis_ratio"],
                "circularity": record["circularity"],
            }
        )

    # Merge the duplicate contours produced by the two edges of one circle.
    candidates.sort(key=lambda c: c["major"])
    merged: List[Dict[str, Any]] = []
    diameter = outer_ellipse["major"]
    for candidate in candidates:
        match = None
        for existing in merged:
            centre_tol = max(_DEDUPE_CENTER_MIN_PX, _DEDUPE_CENTER_TOL * diameter)
            radius_tol = max(
                _DEDUPE_RADIUS_MIN_PX,
                _DEDUPE_RADIUS_TOL * max(candidate["major"], existing["major"]),
            )
            if (
                math.hypot(candidate["cx"] - existing["cx"], candidate["cy"] - existing["cy"])
                <= centre_tol
                and abs(candidate["major"] - existing["major"]) <= radius_tol
            ):
                match = existing
                break
        if match is None:
            merged.append(dict(candidate, support=1))
        else:
            support = match.get("support", 1) + 1
            weight = 1.0 / support
            for key in ("cx", "cy", "major", "minor", "axis_ratio"):
                match[key] = (1.0 - weight) * match[key] + weight * candidate[key]
            match["support"] = support
            match["circularity"] = max(match["circularity"], candidate["circularity"])
    return merged


# ---------------------------------------------------------------------------
# View classification
# ---------------------------------------------------------------------------

def classify_view(
    outer: Optional[Dict[str, Any]],
    bbox_aspect: float = 1.0,
    bilateral_symmetry: bool = False,
) -> Dict[str, Any]:
    """Classify a single image from the outer contour geometry only."""
    if outer is None or outer.get("ellipse") is None:
        return {
            "label": "unknown",
            "confidence": 0.1,
            "tilt_deg": None,
            "warnings": ["No usable outer contour; view could not be classified."],
        }
    ellipse = outer["ellipse"]
    circularity = _clamp01(outer["circularity"])
    axis_ratio = _clamp01(ellipse["axis_ratio"])
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, axis_ratio))))
    warnings: List[str] = []

    if (
        circularity >= _AXIAL_MIN_CIRCULARITY
        and axis_ratio >= _AXIAL_MIN_AXIS_RATIO
        and bbox_aspect <= 1.35
    ):
        confidence = (
            0.55
            + 0.25 * min(1.0, circularity)
            + 0.20 * axis_ratio
        )
        return {
            "label": "axial_face",
            "confidence": _round(_clamp01(confidence), 3),
            "tilt_deg": _round(tilt, 2),
            "warnings": warnings,
        }

    if (
        circularity >= _OBLIQUE_MIN_CIRCULARITY
        and axis_ratio >= _OBLIQUE_MIN_AXIS_RATIO
    ):
        confidence = 0.35 + 0.35 * axis_ratio + 0.20 * min(1.0, circularity)
        warnings.append(
            "Oblique view: ratios are corrected for foreshortening but parallax on raised features is not modelled."
        )
        return {
            "label": "oblique",
            "confidence": _round(_clamp01(confidence), 3),
            "tilt_deg": _round(tilt, 2),
            "warnings": warnings,
        }

    if circularity < _SIDE_MAX_CIRCULARITY and (
        bbox_aspect >= _SIDE_MIN_ASPECT or bilateral_symmetry
    ):
        confidence = (
            0.35
            + 0.30 * (1.0 - circularity)
            + 0.20 * min(1.0, max(0.0, bbox_aspect - 1.0))
            + (0.10 if bilateral_symmetry else 0.0)
        )
        return {
            "label": "side_profile",
            "confidence": _round(_clamp01(confidence), 3),
            "tilt_deg": None,
            "warnings": warnings,
        }

    warnings.append("Outer contour is neither clearly circular nor clearly a side silhouette.")
    return {
        "label": "unknown",
        "confidence": 0.2,
        "tilt_deg": _round(tilt, 2) if axis_ratio > 0 else None,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Axial-face measurement
# ---------------------------------------------------------------------------

def _measure_axial(
    outer: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    scale_px: Optional[float] = None,
    apply_rectification: bool = True,
) -> Dict[str, Any]:
    ellipse = outer["ellipse"]
    assert ellipse is not None
    outer_radius_px = float(scale_px) if scale_px else ellipse["major"] / 2.0
    foreshorten = max(1e-3, ellipse["axis_ratio"]) if apply_rectification else 1.0
    warnings: List[str] = []

    concentric: List[Dict[str, Any]] = []
    radial: List[Dict[str, Any]] = []
    for candidate in candidates:
        radius_ratio = candidate["major"] / max(2.0 * outer_radius_px, 1e-6)
        if radius_ratio >= _OUTER_EDGE_RATIO:
            continue
        dx = candidate["cx"] - ellipse["cx"]
        dy = candidate["cy"] - ellipse["cy"]
        if apply_rectification:
            u, v = _rotated_offset(dx, dy, ellipse["angle_deg"], foreshorten)
        else:
            u, v = dx, dy
        distance = math.hypot(u, v)
        distance_ratio = distance / max(outer_radius_px, 1e-6)
        item = {
            "radius_ratio": _round(radius_ratio),
            "distance_ratio": _round(distance_ratio),
            "angle_deg": _round(math.degrees(math.atan2(v, u)) % 360.0, 3),
            "x_ratio": _round(u / max(outer_radius_px, 1e-6)),
            "y_ratio": _round(v / max(outer_radius_px, 1e-6)),
            "axis_ratio": _round(candidate["axis_ratio"]),
            "circularity": _round(candidate["circularity"]),
            "support": int(candidate.get("support", 1)),
        }
        if distance_ratio <= _CONCENTRIC_TOL:
            concentric.append(item)
        elif 0.02 <= radius_ratio <= 0.35 and 0.08 <= distance_ratio <= 0.95:
            radial.append(item)

    # Deduplicate concentric radii that landed in several hierarchy levels.
    concentric.sort(key=lambda item: item["radius_ratio"])
    deduped: List[Dict[str, Any]] = []
    for item in concentric:
        if deduped and abs(item["radius_ratio"] - deduped[-1]["radius_ratio"]) <= 0.02:
            continue
        confidence = (
            0.45
            + 0.25 * min(1.0, item["circularity"])
            + 0.20 * min(1.0, item["axis_ratio"])
            + 0.10 * min(1.0, item["support"] / 2.0)
        )
        deduped.append(
            {
                "radius_ratio": item["radius_ratio"],
                "distance_ratio": item["distance_ratio"],
                "confidence": _round(_clamp01(confidence), 3),
                "provenance": "opencv_contour",
            }
        )
    concentric = deduped

    patterns = _cluster_radial_patterns(radial)
    holes = [
        {
            "x_ratio": item["x_ratio"],
            "y_ratio": item["y_ratio"],
            "radius_ratio": item["radius_ratio"],
            "confidence": _round(
                _clamp01(
                    0.40
                    + 0.30 * min(1.0, item["circularity"])
                    + 0.20 * min(1.0, item["axis_ratio"])
                    + 0.10 * min(1.0, item["support"] / 2.0)
                ),
                3,
            ),
            "provenance": "opencv_contour",
        }
        for item in radial
    ]

    if foreshorten < math.cos(math.radians(12.0)) and (concentric or patterns):
        warnings.append(
            "Tilt exceeds 12 degrees: raised features may show parallax offsets that are not corrected."
        )
    if not concentric and not patterns:
        warnings.append("No inner circular features were detected on this axial view.")

    return {
        "tilt_deg": _round(math.degrees(math.acos(foreshorten)), 2) if apply_rectification else None,
        "perspective_residual_deg": (
            _round(
                math.degrees(math.acos(foreshorten))
                - math.degrees(math.acos(ellipse["axis_ratio"])),
                3,
            )
            if apply_rectification
            else None
        ),
        "normalisation": "ellipse_major" if apply_rectification else "bbox_max_half",
        "concentric": concentric,
        "radial_patterns": patterns,
        "holes": holes,
        "warnings": warnings,
    }


def _cluster_radial_patterns(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group equal holes into radial arrays and verify near-uniform spacing."""
    clusters: List[List[Dict[str, Any]]] = []
    for item in sorted(items, key=lambda i: i["radius_ratio"]):
        placed = False
        for cluster in clusters:
            mean_r = sum(m["radius_ratio"] for m in cluster) / len(cluster)
            mean_d = sum(m["distance_ratio"] for m in cluster) / len(cluster)
            if (
                abs(item["radius_ratio"] - mean_r) <= max(0.2 * mean_r, 0.01)
                and abs(item["distance_ratio"] - mean_d) <= max(0.08 * mean_d, 0.02)
            ):
                cluster.append(item)
                placed = True
                break
        if not placed:
            clusters.append([item])

    patterns: List[Dict[str, Any]] = []
    for cluster in clusters:
        if len(cluster) < 3:
            continue
        angles = sorted(member["angle_deg"] for member in cluster)
        observed = len(angles)
        best = _best_uniform_fit(angles)
        if best is None:
            continue
        count, residual = best
        if residual > 4.0:
            continue  # irregular positions: keep as individual holes, not an array
        occluded = max(0, count - observed)
        mean_radius = sum(m["radius_ratio"] for m in cluster) / observed
        mean_distance = sum(m["distance_ratio"] for m in cluster) / observed
        mean_circularity = sum(m["circularity"] for m in cluster) / observed
        count_confidence = _clamp01(1.0 - residual / 45.0 - 0.12 * occluded)
        confidence = _clamp01(
            0.40
            + 0.30 * min(1.0, mean_circularity)
            + 0.20 * count_confidence
            + 0.10 * min(1.0, observed / 6.0)
        )
        pattern = {
            "count": count,
            "observed_count": observed,
            "occluded_estimate": occluded,
            "pattern_radius_ratio": _round(mean_distance),
            "hole_radius_ratio": _round(mean_radius),
            "start_angle_deg": _round(angles[0] % 360.0, 3),
            "angular_residual_deg": _round(residual, 3),
            "count_confidence": _round(count_confidence, 3),
            "confidence": _round(confidence, 3),
            "provenance": "opencv_contour",
        }
        if residual > 3.0:
            pattern["warning"] = "Angular spacing is irregular; treat as a candidate array."
        patterns.append(pattern)

    patterns.sort(key=lambda p: (p["count"], p["pattern_radius_ratio"]))
    return patterns


def _best_uniform_fit(angles: Sequence[float]) -> Optional[Tuple[int, float]]:
    """Return ``(count, mean angular residual)`` for the best uniform grid.

    The observed angles must all sit on the chosen grid; a larger count is only
    accepted when it explains occluded positions (the residual does not improve
    enough to justify inventing members otherwise).
    """
    if len(angles) < 3:
        return None
    observed = len(angles)
    best: Optional[Tuple[int, float]] = None
    for count in range(observed, min(64, observed + 2) + 1):
        step = 360.0 / count
        start = angles[0]
        residual_values = []
        for angle in angles:
            offset = (angle - start) / step
            nearest = round(offset)
            residual_values.append(abs(offset - nearest) * step)
        residual = sum(residual_values) / len(residual_values)
        candidate = (count, residual)
        if best is None or residual < best[1] - 0.25:
            best = candidate
    return best


# ---------------------------------------------------------------------------
# Side-profile measurement
# ---------------------------------------------------------------------------

def _simplify_profile(
    z_px: np.ndarray, r_px: np.ndarray, max_points: int = 12
) -> List[Tuple[float, float]]:
    points = np.column_stack([z_px, r_px]).astype(np.float32).reshape(-1, 1, 2)
    if len(points) < 2:
        return []
    try:
        import cv2  # type: ignore

        perimeter = float(cv2.arcLength(points, False))
        epsilon = max(0.5, 0.01 * perimeter)
        simplified = cv2.approxPolyDP(points, epsilon, False).reshape(-1, 2)
        while len(simplified) > max_points:
            epsilon *= 1.4
            simplified = cv2.approxPolyDP(points, epsilon, False).reshape(-1, 2)
        if len(simplified) < 2:
            simplified = points.reshape(-1, 2)
        return [(float(p[0]), float(p[1])) for p in simplified]
    except Exception:
        indices = np.linspace(0, len(z_px) - 1, min(max_points, len(z_px))).astype(int)
        return [(float(z_px[i]), float(r_px[i])) for i in indices]


def _measure_side_profile(outer: Dict[str, Any]) -> Dict[str, Any]:
    points = outer["points"]
    x0, _, x1, _ = outer["bbox"]
    axis_x = (x0 + x1) / 2.0
    warnings: List[str] = []

    radii = np.abs(points[:, 0] - axis_x)
    diameter_px = float(2.0 * np.max(radii))
    if diameter_px <= 1.0:
        return {
            "profile": [],
            "thickness_ratio": None,
            "height_ratio": None,
            "hub_height_ratio": None,
            "hub_radius_ratio": None,
            "step_count": 0,
            "confidence": 0.0,
            "warnings": ["Side silhouette is too small to measure."],
        }

    z_all = points[:, 1]
    z_min, z_max = float(np.min(z_all)), float(np.max(z_all))
    height_px = z_max - z_min
    bin_count = max(8, min(160, int(height_px / 3.0) or 8))
    edges = np.linspace(z_min, z_max, bin_count + 1)
    z_centres: List[float] = []
    r_max: List[float] = []
    for index in range(bin_count):
        lo, hi = edges[index], edges[index + 1]
        mask = (z_all >= lo) & (z_all <= hi)
        if not np.any(mask):
            continue
        z_centres.append(float((lo + hi) / 2.0))
        r_max.append(float(np.max(radii[mask])))
    if len(z_centres) < 2:
        return {
            "profile": [],
            "thickness_ratio": None,
            "height_ratio": None,
            "hub_height_ratio": None,
            "hub_radius_ratio": None,
            "step_count": 0,
            "confidence": 0.0,
            "warnings": ["Side silhouette could not be binned reliably."],
        }

    simplified = _simplify_profile(np.array(z_centres), np.array(r_max))
    profile = [
        {
            "z_ratio": _round((z - z_min) / diameter_px),
            "r_ratio": _round(r / (diameter_px / 2.0)),
        }
        for z, r in simplified
    ]
    profile.sort(key=lambda p: p["z_ratio"])

    radii_simplified = [r / (diameter_px / 2.0) for _, r in simplified]
    steps = sum(
        1
        for a, b in zip(radii_simplified, radii_simplified[1:])
        if abs(a - b) >= 0.06
    )

    # Base-plate thickness = axial span where the silhouette reaches its full
    # radius; total height includes raised hubs/steps.
    max_radius_px = max((r for _, r in simplified), default=0.0)
    plate_zs = [z for z, r in simplified if r >= 0.95 * max_radius_px]
    plate_thickness_px = (max(plate_zs) - min(plate_zs)) if plate_zs else height_px
    raised = [r for _, r in simplified if r < 0.95 * max_radius_px]
    hub_radius_ratio = (
        _round(max(raised) / (diameter_px / 2.0)) if raised else None
    )

    # Mirror-symmetry residual on the outer silhouette.
    symmetry_error = 0.0
    try:
        left = points[points[:, 0] >= axis_x]
        right = points[points[:, 0] < axis_x]
        if len(left) and len(right):
            r_left = np.abs(left[:, 0] - axis_x)
            r_right = np.abs(right[:, 0] - axis_x)
            symmetry_error = float(
                abs(np.median(r_left) - np.median(r_right))
                / max(0.5 * diameter_px, 1e-6)
            )
    except Exception:
        pass

    bbox_area = max(1.0, (x1 - x0) * (max(z_all) - min(z_all)))
    fill_ratio = _clamp01(outer["area"] / bbox_area)
    confidence = _clamp01(
        0.35
        + 0.30 * fill_ratio
        + 0.15 * (1.0 - min(1.0, symmetry_error))
        + 0.10 * min(1.0, height_px / 40.0)
        + 0.10 * min(1.0, len(z_centres) / 40.0)
    )
    if len(profile) < 2:
        warnings.append("Silhouette simplified to fewer than two points.")
    if steps > 0:
        warnings.append(
            f"Detected {steps} radial step(s) in the side silhouette; verify against the part."
        )

    return {
        "profile": profile,
        "thickness_ratio": _round(plate_thickness_px / diameter_px),
        "height_ratio": _round(height_px / diameter_px),
        "hub_height_ratio": _round((height_px - plate_thickness_px) / diameter_px),
        "hub_radius_ratio": hub_radius_ratio,
        "step_count": int(steps),
        "symmetry_error_ratio": _round(symmetry_error),
        "confidence": _round(confidence, 3),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Non-circular outline measurement
# ---------------------------------------------------------------------------

def _measure_polygon(outer: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    points = outer["points"].astype(np.float32).reshape(-1, 1, 2)
    x0, y0, x1, y1 = outer["bbox"]
    span = max(x1 - x0, y1 - y0)
    if span <= 1.0:
        return None
    try:
        import cv2  # type: ignore

        epsilon = 0.02 * float(cv2.arcLength(points, True))
        approx = cv2.approxPolyDP(points, epsilon, True).reshape(-1, 2)
        guard = 0
        while len(approx) > 12 and guard < 20:
            epsilon *= 1.25
            approx = cv2.approxPolyDP(points, epsilon, True).reshape(-1, 2)
            guard += 1
        while 0 < len(approx) < 3 and guard < 40:
            epsilon *= 0.8
            approx = cv2.approxPolyDP(points, epsilon, True).reshape(-1, 2)
            guard += 1
    except Exception:
        approx = outer["points"]
    if len(approx) < 3:
        return None
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    normalized = [
        {
            "x_ratio": _round((float(p[0]) - cx) / span),
            "y_ratio": _round((float(p[1]) - cy) / span),
        }
        for p in approx[:12]
    ]
    return {
        "points": normalized,
        "point_count": len(normalized),
        "confidence": _round(_clamp01(0.45 + 0.4 * outer["circularity"]), 3),
        "provenance": "opencv_contour",
    }


# ---------------------------------------------------------------------------
# Per-image measurement
# ---------------------------------------------------------------------------

def measure_image(
    cv_dict: Dict[str, Any],
    image_index: int = 0,
    view_override: Optional[str] = None,
) -> Dict[str, Any]:
    """Measure one image from its OpenCV observations.

    ``cv_dict`` is the dictionary returned by
    :func:`vision.opencv_features.extract_features` (pixels only).
    """
    records = _contour_records(cv_dict or {})
    outer = _select_outer(records)
    symmetry = (cv_dict or {}).get("symmetry_hints") or {}
    warnings: List[str] = []

    result: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "image_index": int(image_index),
        "view": {"label": "unknown", "confidence": 0.0, "tilt_deg": None, "warnings": []},
        "outer": None,
        "axial": None,
        "side": None,
        "polygon": None,
        "depth_hints": [],
        "warnings": warnings,
    }
    if outer is None:
        result["warnings"].append("No outer contour above the minimum area threshold.")
        return result

    x0, y0, x1, y1 = outer["bbox"]
    bbox_aspect = max(x1 - x0, y1 - y0) / max(1e-6, min(x1 - x0, y1 - y0))
    view = classify_view(outer, bbox_aspect, bool(symmetry.get("bilateral")))
    if view_override in _VIEW_LABELS:
        view = {
            "label": view_override,
            "confidence": 1.0,
            "tilt_deg": view.get("tilt_deg"),
            "warnings": list(view.get("warnings") or []),
            "source": "user_override",
        }
    result["view"] = view

    width, height = x1 - x0, y1 - y0
    non_circular = (
        view["label"] in ("axial_face", "oblique")
        and bbox_aspect > 1.25
        and outer["circularity"] < _AXIAL_MIN_CIRCULARITY + 0.10
    )

    ellipse = outer["ellipse"]
    if ellipse is not None:
        result["outer"] = {
            "shape": (
                "polygonal" if non_circular
                else "circular" if view["label"] in ("axial_face", "oblique")
                else "silhouette"
            ),
            "non_circular": bool(non_circular),
            "center_px": [_round(ellipse["cx"], 2), _round(ellipse["cy"], 2)],
            "major_axis_px": _round(ellipse["major"], 2),
            "minor_axis_px": _round(ellipse["minor"], 2),
            "angle_deg": _round(ellipse["angle_deg"], 3),
            "circularity": _round(outer["circularity"], 4),
            "confidence": view["confidence"],
        }

    if view["label"] in ("axial_face", "oblique"):
        candidates = _circular_candidates(records, outer)
        scale_px = max(width, height) / 2.0 if non_circular else None
        result["axial"] = _measure_axial(
            outer,
            candidates,
            scale_px=scale_px,
            apply_rectification=not non_circular,
        )
        if non_circular or view["label"] == "oblique":
            polygon = _measure_polygon(outer)
            if polygon is not None:
                result["polygon"] = polygon
    elif view["label"] == "side_profile":
        result["side"] = _measure_side_profile(outer)
        polygon = _measure_polygon(outer)
        if polygon is not None:
            result["polygon"] = polygon

    result["warnings"].extend(view.get("warnings") or [])
    if result["axial"]:
        result["warnings"].extend(result["axial"].get("warnings") or [])
    if result["side"]:
        result["warnings"].extend(result["side"].get("warnings") or [])
    return result


# ---------------------------------------------------------------------------
# Multi-image fusion
# ---------------------------------------------------------------------------

def _fuse_concentric(per_image: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    samples: List[Tuple[float, float, int]] = []
    for measurement in per_image:
        axial = measurement.get("axial")
        if not axial:
            continue
        for item in axial.get("concentric") or []:
            samples.append(
                (
                    float(item["radius_ratio"]),
                    float(item.get("confidence") or 0.5),
                    int(measurement.get("image_index", 0)),
                )
            )
    samples.sort(key=lambda sample: sample[0])

    clusters: List[List[Tuple[float, float, int]]] = []
    for sample in samples:
        if clusters:
            cluster = clusters[-1]
            mean = sum(item[0] for item in cluster) / len(cluster)
            if abs(sample[0] - mean) <= max(0.03 * mean, 0.008):
                cluster.append(sample)
                continue
        clusters.append([sample])

    fused: List[Dict[str, Any]] = []
    for cluster in clusters:
        values = [item[0] for item in cluster]
        weights = [(item[0], item[1]) for item in cluster]
        spread = _relative_spread(values)
        agreement = _clamp01(1.0 - spread / 0.10)
        confidence = _weighted_median([(item[1], 1.0) for item in cluster]) or 0.5
        confidence *= 0.85 + 0.15 * agreement
        fused.append(
            {
                "radius_ratio": _round(_weighted_median(weights)),
                "confidence": _round(_clamp01(confidence), 3),
                "image_count": len({item[2] for item in cluster}),
                "spread": _round(spread),
                "agreement": _round(agreement, 3),
                "provenance": "fused_measurement",
            }
        )
    fused.sort(key=lambda item: item["radius_ratio"])
    return fused


def _fuse_patterns(per_image: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    samples: List[Dict[str, Any]] = []
    for measurement in per_image:
        axial = measurement.get("axial")
        if not axial:
            continue
        for pattern in axial.get("radial_patterns") or []:
            item = dict(pattern)
            item["image_index"] = int(measurement.get("image_index", 0))
            samples.append(item)

    groups: List[List[Dict[str, Any]]] = []
    for sample in samples:
        placed = False
        for group in groups:
            reference = group[0]
            if sample["count"] != reference["count"]:
                continue
            mean_pattern = sum(g["pattern_radius_ratio"] for g in group) / len(group)
            mean_hole = sum(g["hole_radius_ratio"] for g in group) / len(group)
            if (
                abs(sample["pattern_radius_ratio"] - mean_pattern)
                <= max(0.08 * mean_pattern, 0.02)
                and abs(sample["hole_radius_ratio"] - mean_hole)
                <= max(0.2 * mean_hole, 0.01)
            ):
                group.append(sample)
                placed = True
                break
        if not placed:
            groups.append([sample])

    fused: List[Dict[str, Any]] = []
    for group in groups:
        pattern_spread = _relative_spread([g["pattern_radius_ratio"] for g in group])
        hole_spread = _relative_spread([g["hole_radius_ratio"] for g in group])
        agreement = _clamp01(1.0 - max(pattern_spread / 0.10, hole_spread / 0.20))
        confidence = (
            _weighted_median([(g["confidence"], 1.0) for g in group]) or 0.5
        ) * (0.85 + 0.15 * agreement)
        start = _circular_median([g["start_angle_deg"] for g in group])
        fused.append(
            {
                "count": int(group[0]["count"]),
                "observed_count": int(round(median(g["observed_count"] for g in group))),
                "occluded_estimate": int(round(median(g["occluded_estimate"] for g in group))),
                "pattern_radius_ratio": _round(
                    _weighted_median(
                        [(g["pattern_radius_ratio"], g["confidence"]) for g in group]
                    )
                ),
                "hole_radius_ratio": _round(
                    _weighted_median(
                        [(g["hole_radius_ratio"], g["confidence"]) for g in group]
                    )
                ),
                "start_angle_deg": _round(start, 3),
                "angular_residual_deg": _round(
                    max(g["angular_residual_deg"] for g in group), 3
                ),
                "count_confidence": _round(
                    _weighted_median(
                        [(g["count_confidence"], g["confidence"]) for g in group]
                    ),
                    3,
                ),
                "confidence": _round(_clamp01(confidence), 3),
                "image_count": len({g["image_index"] for g in group}),
                "agreement": _round(agreement, 3),
                "provenance": "fused_measurement",
            }
        )
    fused.sort(key=lambda p: (-p["count"], p["pattern_radius_ratio"]))
    return fused


def fuse_measurements(per_image: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Confidence-weighted fusion of per-image measurements."""
    usable = [m for m in per_image if isinstance(m, dict)]
    view_votes: Dict[str, float] = {}
    for measurement in usable:
        view = measurement.get("view") or {}
        label = view.get("label") or "unknown"
        view_votes[label] = view_votes.get(label, 0.0) + float(view.get("confidence") or 0.0)
    total_vote = sum(view_votes.values())
    if total_vote > 0:
        fused_label, fused_weight = max(view_votes.items(), key=lambda item: item[1])
    else:
        fused_label, fused_weight = "unknown", 0.0
    view_agreement = fused_weight / total_vote if total_vote else 0.0
    fused_view = {
        "label": fused_label,
        "confidence": _round(_clamp01(fused_weight / max(1, len(usable))), 3),
        "vote_agreement": _round(view_agreement, 3),
        "per_image": [
            {
                "image_index": m.get("image_index"),
                "label": (m.get("view") or {}).get("label", "unknown"),
                "confidence": (m.get("view") or {}).get("confidence", 0.0),
            }
            for m in usable
        ],
    }

    concentric = _fuse_concentric(usable)
    patterns = _fuse_patterns(usable)

    # Individual hole positions come from the highest-confidence axial view.
    # Their absolute rotation is not meaningful without a datum; patterns are
    # represented structurally instead of by raw coordinates.
    hole_source = max(
        (m for m in usable if m.get("axial")),
        key=lambda m: (m.get("view") or {}).get("confidence") or 0.0,
        default=None,
    )
    holes = (
        [dict(h, image_index=hole_source.get("image_index"))
         for h in (hole_source.get("axial") or {}).get("holes") or []]
        if hole_source else []
    )

    side_candidates = [
        m for m in usable
        if (m.get("side") or {}).get("profile")
    ]
    side_profile = None
    if side_candidates:
        best = max(side_candidates, key=lambda m: (m.get("side") or {}).get("confidence") or 0)
        side = best["side"]
        side_profile = {
            "points": side.get("profile") or [],
            "thickness_ratio": side.get("thickness_ratio"),
            "height_ratio": side.get("height_ratio"),
            "hub_height_ratio": side.get("hub_height_ratio"),
            "hub_radius_ratio": side.get("hub_radius_ratio"),
            "step_count": side.get("step_count", 0),
            "confidence": side.get("confidence"),
            "image_index": best.get("image_index"),
            "image_count": len(side_candidates),
            "provenance": "fused_measurement",
        }

    polygon = None
    polygon_candidates = [
        m for m in usable
        if m.get("polygon")
        and (m.get("view") or {}).get("label") in ("axial_face", "oblique")
    ]
    if polygon_candidates:
        best_polygon = max(
            polygon_candidates, key=lambda m: (m.get("polygon") or {}).get("confidence") or 0
        )
        polygon = dict(best_polygon["polygon"])
        polygon["image_index"] = best_polygon.get("image_index")

    conflicts: List[str] = []
    counts = {p["count"] for p in patterns}
    if len(counts) > 1:
        conflicts.append(
            f"Conflicting radial-pattern counts across images: {sorted(counts)}."
        )
    if (
        patterns
        and patterns[0]["pattern_radius_ratio"] is not None
        and len({round(p["pattern_radius_ratio"], 2) for p in patterns}) > 1
    ):
        conflicts.append("Multiple distinct radial patterns detected; verify which is the fastener array.")
    if fused_label in ("axial_face", "oblique") and not concentric and not patterns:
        conflicts.append("Axial view present but no inner circular features were corroborated.")

    feature_agreements = [p.get("agreement", 0.0) for p in patterns]
    if concentric:
        feature_agreements.extend(c.get("agreement", 0.0) for c in concentric)
    feature_agreement = _mean(feature_agreements)
    if feature_agreement is None:
        feature_agreement = 0.85 if (concentric or patterns or side_profile) else 0.0
    if len(usable) <= 1:
        # A single view cannot be corroborated across images.
        feature_agreement = min(feature_agreement, 0.9)
    agreement_score = _clamp01(0.4 * view_agreement + 0.6 * feature_agreement)

    needs_input: List[Dict[str, str]] = []
    if fused_label == "unknown":
        needs_input.append(
            {
                "parameter": "view",
                "question": "Add a straight-on photo of the largest face and a side-view photo.",
                "reason": "The uploaded views could not be classified confidently.",
            }
        )
    if side_profile is None and fused_label in ("axial_face", "oblique"):
        needs_input.append(
            {
                "parameter": "side_view",
                "question": "Add a side-view photo, or enter the thickness/height.",
                "reason": "Axial photos give radii but not thickness or raised-feature height.",
            }
        )

    has_features = bool(concentric or patterns or side_profile or polygon)
    if not has_features:
        status = "insufficient"
    elif fused_label == "unknown" or agreement_score < 0.5:
        status = "partial"
    else:
        status = "ok"

    return {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "view": fused_view,
        "outer": {
            "shape": (
                "polygonal" if polygon is not None and any(
                    (m.get("outer") or {}).get("non_circular") for m in usable
                )
                else "circular"
                if fused_label in ("axial_face", "oblique")
                else "silhouette"
                if fused_label == "side_profile"
                else "unknown"
            ),
            "non_circular": any(
                (m.get("outer") or {}).get("non_circular") for m in usable
            ),
            "confidence": fused_view["confidence"],
        },
        "concentric": concentric,
        "radial_patterns": patterns,
        "holes": holes,
        "side_profile": side_profile,
        "polygon": polygon,
        "depth_hints": [],
        "agreement_score": _round(agreement_score, 3),
        "conflicts": conflicts,
        "needs_input": needs_input,
        "images": [
            {
                "image_index": m.get("image_index"),
                "view": (m.get("view") or {}).get("label", "unknown"),
                "view_confidence": (m.get("view") or {}).get("confidence", 0.0),
                "concentric_count": len((m.get("axial") or {}).get("concentric") or []),
                "pattern_count": len((m.get("axial") or {}).get("radial_patterns") or []),
                "hole_count": len((m.get("axial") or {}).get("holes") or []),
                "has_side_profile": bool((m.get("side") or {}).get("profile")),
                "has_polygon": bool(m.get("polygon")),
                "warnings": list(m.get("warnings") or []),
            }
            for m in usable
        ],
        "warnings": sorted(
            {
                warning
                for m in usable
                for warning in (m.get("warnings") or [])
            }
        ),
    }
