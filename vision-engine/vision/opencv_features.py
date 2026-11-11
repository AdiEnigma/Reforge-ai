"""
opencv_features.py — Contours, circles, ellipses, lines, bounding boxes, symmetry hints.

All coordinates are in PIXELS only. No mm units are ever returned.
No GUI calls (headless only).
"""
from __future__ import annotations

import logging
import math
from typing import List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_CIRCULARITY_THRESHOLD = 0.75   # For considering a contour circle-like enough to fit ellipse
_MIN_CONTOUR_AREA = 50          # px² — ignore dust
_HOUGH_CIRCLE_DP = 1.2
_HOUGH_LINE_THRESHOLD = 50      # votes
_HOUGH_LINE_MIN_LENGTH = 30     # px
_HOUGH_LINE_MAX_GAP = 10        # px


def _circularity(area: float, perimeter: float) -> float:
    if perimeter < 1e-6:
        return 0.0
    return float(4 * math.pi * area / (perimeter ** 2))


def _solidity(area: float, hull_area: float) -> float:
    if hull_area < 1e-6:
        return 0.0
    return float(area / hull_area)


def _angle_deg(x1: float, y1: float, x2: float, y2: float) -> float:
    return float(math.degrees(math.atan2(y2 - y1, x2 - x1)))


def _touches_border(contour: np.ndarray, h: int, w: int, margin: int = 2) -> bool:
    xs = contour[:, 0, 0]
    ys = contour[:, 0, 1]
    return bool(
        np.any(xs <= margin) or np.any(xs >= w - margin) or
        np.any(ys <= margin) or np.any(ys >= h - margin)
    )


def _prepare_working_image(rgb: np.ndarray, mask: Optional[np.ndarray]) -> np.ndarray:
    """Return grayscale image, optionally masked."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if mask is not None:
        gray = cv2.bitwise_and(gray, gray, mask=mask.astype(np.uint8))
    return gray


def extract_features(rgb: np.ndarray, mask: Optional[np.ndarray] = None, image_index: int = 0) -> dict:
    """
    Extract geometric features from an RGB image using OpenCV.

    Args:
        rgb:         (H, W, 3) uint8 RGB image
        mask:        optional (H, W) uint8/bool mask (nonzero = ROI)
        image_index: image_index to embed in every feature record

    Returns:
        dict with keys: contours, circles, ellipses, lines,
                        bounding_box, symmetry_hints, warnings
    All coordinate values are numeric pixel values, never strings with "mm".
    """
    h, w = rgb.shape[:2]
    warnings_out: List[str] = []

    gray = _prepare_working_image(rgb, mask)

    # ------------------------------------------------------------------
    # Edge detection
    # ------------------------------------------------------------------
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)

    # ------------------------------------------------------------------
    # Contours (RETR_TREE preserves hierarchy — outer + inner bores)
    # ------------------------------------------------------------------
    contours_raw, hierarchy = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    contour_features = []
    for idx, cnt in enumerate(contours_raw):
        area = float(cv2.contourArea(cnt))
        if area < _MIN_CONTOUR_AREA:
            continue
        perimeter = float(cv2.arcLength(cnt, True))
        circ = _circularity(area, perimeter)
        hull = cv2.convexHull(cnt)
        hull_area = float(cv2.contourArea(hull))
        sol = _solidity(area, hull_area)

        # Hierarchy: [Next, Prev, First_Child, Parent]
        hier = hierarchy[0][idx]
        # hierarchy_level: 0 = outer, 1 = child (inner bore), etc.
        hier_level = 0 if hier[3] < 0 else 1  # simplified: outer=0, child=1

        truncated = _touches_border(cnt, h, w)
        feature_warnings = []
        if truncated:
            feature_warnings.append("Contour touches image border — may be truncated")

        # Determine type
        c_type = "inner_contour" if hier_level > 0 else "outer_contour"

        points = cnt[:, 0, :].tolist()  # Nx2 pixel coords

        contour_features.append({
            "type": c_type,
            "image_index": image_index,
            "points_px": points,
            "area_px2": area,
            "perimeter_px": perimeter,
            "circularity": circ,
            "solidity": sol,
            "hierarchy_level": hier_level,
            "confidence": min(1.0, circ),  # heuristic
            "provenance": "opencv",
            "warnings": feature_warnings,
        })

    # ------------------------------------------------------------------
    # Circles — HoughCircles
    # ------------------------------------------------------------------
    circle_features = []
    min_radius = max(5, min(h, w) // 20)
    max_radius = min(h, w) // 2

    circles_raw = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=_HOUGH_CIRCLE_DP,
        minDist=max(10, min(h, w) // 10),
        param1=100,
        param2=30,
        minRadius=min_radius,
        maxRadius=max_radius,
    )

    if circles_raw is not None:
        for cx, cy, r in np.round(circles_raw[0]).astype(int):
            # Confidence: inverse of how close to edge the circle is
            dist_to_border = min(int(cx), int(cy), w - int(cx), h - int(cy))
            conf = min(1.0, dist_to_border / (r + 1e-6))
            circle_warnings = []
            if conf < 0.5:
                circle_warnings.append("Circle partially outside image bounds")
            circle_features.append({
                "type": "circle_candidate",
                "image_index": image_index,
                "cx_px": float(cx),
                "cy_px": float(cy),
                "radius_px": float(r),
                "confidence": float(conf),
                "provenance": "opencv",
                "warnings": circle_warnings,
            })

    # ------------------------------------------------------------------
    # Ellipses — fitEllipse on circular-ish contours
    # ------------------------------------------------------------------
    ellipse_features = []
    for cnt_dict in contour_features:
        if cnt_dict["circularity"] < _CIRCULARITY_THRESHOLD:
            continue
        points_arr = np.array(cnt_dict["points_px"], dtype=np.int32).reshape(-1, 1, 2)
        if len(points_arr) < 5:
            continue
        try:
            ellipse = cv2.fitEllipse(points_arr)
            (ex, ey), (ma, MB), angle = ellipse
            confidence = cnt_dict["circularity"]
            ellipse_features.append({
                "type": "ellipse_candidate",
                "image_index": image_index,
                "cx_px": float(ex),
                "cy_px": float(ey),
                "axes_px": [float(ma), float(MB)],
                "angle_deg": float(angle),
                "confidence": float(confidence),
                "provenance": "opencv",
                "warnings": ["Perspective projection may project circles as ellipses"],
            })
        except cv2.error:
            pass

    # ------------------------------------------------------------------
    # Lines — HoughLinesP
    # ------------------------------------------------------------------
    line_features = []
    lines_raw = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=math.pi / 180,
        threshold=_HOUGH_LINE_THRESHOLD,
        minLineLength=_HOUGH_LINE_MIN_LENGTH,
        maxLineGap=_HOUGH_LINE_MAX_GAP,
    )

    if lines_raw is not None:
        for x1, y1, x2, y2 in lines_raw[:, 0]:
            length = math.hypot(x2 - x1, y2 - y1)
            angle = _angle_deg(x1, y1, x2, y2)
            line_features.append({
                "type": "line_candidate",
                "image_index": image_index,
                "x1_px": float(x1),
                "y1_px": float(y1),
                "x2_px": float(x2),
                "y2_px": float(y2),
                "length_px": float(length),
                "angle_deg": float(angle),
                "confidence": min(1.0, length / max(h, w)),
                "provenance": "opencv",
                "warnings": [],
            })

    # ------------------------------------------------------------------
    # Bounding box (axis-aligned and rotated)
    # ------------------------------------------------------------------
    bounding_box = None
    all_points = []
    for cnt_dict in contour_features:
        all_points.extend(cnt_dict["points_px"])

    if all_points:
        pts = np.array(all_points, dtype=np.int32)
        x, y, bw, bh = cv2.boundingRect(pts)
        rect = cv2.minAreaRect(pts)
        center, size, angle = rect
        bounding_box = {
            "axis_aligned": [float(x), float(y), float(bw), float(bh)],
            "rotated_center_px": [float(center[0]), float(center[1])],
            "rotated_size_px": [float(size[0]), float(size[1])],
            "rotated_angle_deg": float(angle),
        }

    # ------------------------------------------------------------------
    # Symmetry hints (heuristic)
    # ------------------------------------------------------------------
    symmetry_hints = _compute_symmetry_hints(gray)

    return {
        "contours": contour_features,
        "circles": circle_features,
        "ellipses": ellipse_features,
        "lines": line_features,
        "bounding_box": bounding_box,
        "symmetry_hints": symmetry_hints,
        "warnings": warnings_out,
    }


def _compute_symmetry_hints(gray: np.ndarray) -> dict:
    """Heuristic bilateral and rotational symmetry detection."""
    h, w = gray.shape

    # Bilateral symmetry: compare left half with flipped right half
    bilateral = False
    try:
        mid = w // 2
        left = gray[:, :mid].astype(float)
        right = np.fliplr(gray[:, w - mid:]).astype(float)
        if left.shape == right.shape and left.size > 0:
            diff = np.abs(left - right)
            bilateral = float(diff.mean()) < 10.0  # threshold: low mean diff
    except Exception:
        pass

    # Rotational symmetry: compare 180° rotation
    rotational = False
    rotational_order = None
    try:
        rot180 = np.rot90(gray, 2)
        if gray.shape == rot180.shape:
            diff180 = np.abs(gray.astype(float) - rot180.astype(float))
            if float(diff180.mean()) < 15.0:
                rotational = True
                rotational_order = 2
    except Exception:
        pass

    return {
        "bilateral": bilateral,
        "rotational": rotational,
        "rotational_order": rotational_order,
    }
