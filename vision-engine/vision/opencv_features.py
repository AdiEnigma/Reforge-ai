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

from vision.tooth_count import detect_tooth_count

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

    circles_raw = None
    try:
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
    except Exception as e:
        logger.warning("HoughCircles skipped: %s", e)

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
    lines_raw = None
    try:
        lines_raw = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=math.pi / 180,
            threshold=_HOUGH_LINE_THRESHOLD,
            minLineLength=_HOUGH_LINE_MIN_LENGTH,
            maxLineGap=_HOUGH_LINE_MAX_GAP,
        )
    except Exception as e:
        logger.warning("HoughLinesP skipped: %s", e)

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
    # Symmetry hints and Periodicity Analysis (Polar FFT + Axis Moments)
    # ------------------------------------------------------------------
    symmetry_hints = _compute_advanced_symmetry(gray, edges, circle_features, contour_features)
    radial_profile = _extract_radial_profile(mask if mask is not None else gray, bounding_box)
    tooth_count = detect_tooth_count(rgb, mask=mask, image_index=image_index)

    return {
        "contours": contour_features,
        "circles": circle_features,
        "ellipses": ellipse_features,
        "lines": line_features,
        "bounding_box": bounding_box,
        "symmetry_hints": symmetry_hints,
        "radial_profile": radial_profile,
        "tooth_count": tooth_count,
        "warnings": warnings_out,
    }


def _compute_advanced_symmetry(
    gray: np.ndarray,
    edges: np.ndarray,
    circles: list[dict],
    contours: list[dict],
) -> dict:
    """
    Mathematical cyclic periodicity and rotational order detection via 1D Polar FFT
    and bilateral reflection analysis.
    """
    h, w = gray.shape[:2]
    bilateral = False
    rotational = False
    rotational_order = None
    spectral_confidence = 0.0
    detected_frequencies = []

    # 1. Bilateral symmetry check
    try:
        mid = w // 2
        left = gray[:, :mid].astype(float)
        right = np.fliplr(gray[:, w - mid:]).astype(float)
        if left.shape == right.shape and left.size > 0:
            diff = np.abs(left - right)
            bilateral = float(diff.mean()) < 12.0
    except Exception:
        pass

    # 2. Polar FFT Cyclic Symmetry around dominant concentric circle
    primary_circle = circles[0] if circles else None
    if primary_circle and primary_circle.get("radius_px", 0) > 20:
        cx = float(primary_circle["cx_px"])
        cy = float(primary_circle["cy_px"])
        max_r = float(primary_circle["radius_px"]) * 1.30
        if 0 < cx < w and 0 < cy < h and max_r > 15:
            try:
                # Warp to polar coordinates: rows=angles (360), cols=radii (max_r)
                polar = cv2.warpPolar(
                    gray,
                    (int(max_r), 360),
                    (cx, cy),
                    max_r,
                    cv2.WARP_POLAR_LINEAR,
                )
                if polar is not None and polar.shape[0] == 360:
                    # Otsu threshold on polar unwrap to extract radial boundary per angle
                    _, polar_bin = cv2.threshold(polar, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                    radii = np.sum(polar_bin > 128, axis=1).astype(float)

                    centered = radii - np.mean(radii)
                    if np.std(centered) > 1e-3:
                        fft_vals = np.abs(np.fft.rfft(centered))
                        # Evaluate candidate frequencies between k=3 and k=72 (standard mechanical tooth/hole counts)
                        freq_range = np.arange(len(fft_vals))
                        valid_mask = (freq_range >= 3) & (freq_range <= 72)
                        
                        valid_freqs = freq_range[valid_mask]
                        valid_amps = fft_vals[valid_mask]

                        if len(valid_amps) > 0:
                            peak_idx = int(np.argmax(valid_amps))
                            peak_freq = int(valid_freqs[peak_idx])
                            peak_amp = float(valid_amps[peak_idx])
                            mean_amp = float(np.mean(valid_amps)) + 1e-6

                            # Check prominence over noise floor
                            if peak_amp > 2.0 * mean_amp:
                                rotational = True
                                rotational_order = peak_freq
                                spectral_confidence = min(1.0, float(peak_amp / (3.5 * mean_amp)))
                                detected_frequencies.append({
                                    "order": peak_freq,
                                    "confidence": round(spectral_confidence, 3),
                                })
            except Exception as e:
                logger.debug("Polar FFT periodicity analysis skipped: %s", e)

    # 3. Fallback: 180-degree rotational symmetry
    if not rotational:
        try:
            rot180 = np.rot90(gray, 2)
            if gray.shape == rot180.shape:
                diff180 = np.abs(gray.astype(float) - rot180.astype(float))
                if float(diff180.mean()) < 15.0:
                    rotational = True
                    rotational_order = 2
                    spectral_confidence = 0.5
        except Exception:
            pass

    return {
        "bilateral": bilateral,
        "rotational": rotational,
        "rotational_order": rotational_order,
        "spectral_confidence": spectral_confidence,
        "detected_frequencies": detected_frequencies,
    }


def _extract_radial_profile(
    mask_or_gray: np.ndarray,
    bounding_box: Optional[dict],
) -> Optional[dict]:
    """
    Extracts continuous radial envelope R(s) along principal axis of elongated components.
    Identifies stepped transitions, journals, and collars.
    """
    if bounding_box is None:
        return None

    sz = bounding_box.get("rotated_size_px")
    if not sz or sz[0] <= 0 or sz[1] <= 0:
        return None

    w_box, h_box = sz
    aspect = max(w_box, h_box) / max(1.0, min(w_box, h_box))
    if aspect < 1.4:
        # Not elongated enough to form a stepped shaft/spindle profile
        return None

    angle = float(bounding_box.get("rotated_angle_deg", 0.0))
    center = bounding_box.get("rotated_center_px")
    if not center or len(center) != 2:
        return None

    h, w = mask_or_gray.shape[:2]
    try:
        # Rotate image to align principal axis along horizontal X
        rot_mat = cv2.getRotationMatrix2D((center[0], center[1]), angle, 1.0)
        aligned = cv2.warpAffine(
            (mask_or_gray > 15).astype(np.uint8) * 255,
            rot_mat,
            (w, h),
            flags=cv2.INTER_NEAREST,
        )

        # Bounding box along horizontal X
        pts = np.argwhere(aligned > 128)
        if len(pts) < 100:
            return None

        ys = pts[:, 0]
        xs = pts[:, 1]
        x_min, x_max = int(np.min(xs)), int(np.max(xs))
        total_len_px = x_max - x_min
        if total_len_px < 30:
            return None

        # Slices across X in 32 uniform stations
        num_stations = 32
        step = max(1, total_len_px // num_stations)
        stations = []
        for x_curr in range(x_min, x_max, step):
            col = pts[pts[:, 1] == x_curr, 0]
            if len(col) >= 2:
                r_px = float((np.max(col) - np.min(col)) / 2.0)
                stations.append({
                    "station_x_px": int(x_curr - x_min),
                    "radius_px": round(r_px, 1),
                })

        if len(stations) >= 4:
            return {
                "length_px": total_len_px,
                "stations": stations,
                "max_radius_px": max(s["radius_px"] for s in stations),
                "min_radius_px": min(s["radius_px"] for s in stations),
            }
    except Exception as e:
        logger.debug("Radial profile extraction skipped: %s", e)

    return None
