"""
calibration.py — Automatic Fiducial Reference & A4 Paper Calibration Engine.

Detects standardized reference benchmarks in photographs:
- ISO 216 A4 Paper (210.0 mm x 297.0 mm, aspect ratio 1 : sqrt(2) ~ 1.4142)
- Rectangular reference targets & grid mats
- User-specified reference objects (e.g. calibration ruler, known diameter)

Uses OpenCV contour analysis, polygon approximation (cv2.approxPolyDP),
corner ordering, and 4-point perspective homography (cv2.getPerspectiveTransform)
to compute true planar metric scale (mm_per_pixel) and planar rectification.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger("reforge.vision.calibration")

# Standard physical dimensions in millimeters
A4_WIDTH_MM = 210.0
A4_HEIGHT_MM = 297.0
A4_ASPECT_RATIO = A4_HEIGHT_MM / A4_WIDTH_MM  # ~1.4142857


def order_quad_points(pts: np.ndarray) -> np.ndarray:
    """
    Orders 4 quadrilateral 2D corner coordinates clockwise starting from top-left:
    [top-left, top-right, bottom-right, bottom-left].
    """
    pts = pts.reshape(4, 2).astype(np.float32)
    rect = np.zeros((4, 2), dtype=np.float32)

    # Top-left has smallest sum (x + y), bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Top-right has smallest diff (y - x), bottom-left has largest diff
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect


def detect_a4_paper_corners(
    image: np.ndarray,
    min_area_ratio: float = 0.05,
    max_area_ratio: float = 0.98,
) -> Optional[Dict[str, Any]]:
    """
    Detects an A4 sheet of paper in an RGB or Grayscale image.
    Returns:
        dict with:
            - corners_px: List of 4 ordered corners [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
            - mm_per_pixel: float
            - homography_matrix: 3x3 list of floats
            - confidence: float [0..1]
            - orientation: 'portrait' | 'landscape'
        or None if no confident A4 sheet is detected.
    """
    if image is None or image.size == 0:
        return None

    h, w = image.shape[:2]
    total_area = float(w * h)

    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY if image.shape[2] == 3 else cv2.COLOR_RGB2GRAY)
    else:
        gray = image

    # Blur to suppress texture on paper and background
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Multi-threshold & edge detection to catch light paper against varied backgrounds
    candidates = []

    # 1. Canny edge detector with morphological closing
    edges = cv2.Canny(blurred, 30, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Find external and nested contours
    contours, _ = cv2.findContours(closed, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    # 2. Also try adaptive / Otsu thresholding for white paper on darker surface
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    otsu_contours, _ = cv2.findContours(otsu, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    all_contours = list(contours) + list(otsu_contours)

    for cnt in all_contours:
        area = cv2.contourArea(cnt)
        if area < total_area * min_area_ratio or area > total_area * max_area_ratio:
            continue

        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.025 * peri, True)

        # We need a 4-vertex convex polygon
        if len(approx) == 4 and cv2.isContourConvex(approx):
            pts = approx.reshape(4, 2)
            ordered = order_quad_points(pts)

            # Measure edge lengths in pixels
            tl, tr, br, bl = ordered
            top_w = float(np.linalg.norm(tr - tl))
            bot_w = float(np.linalg.norm(br - bl))
            left_h = float(np.linalg.norm(bl - tl))
            right_h = float(np.linalg.norm(br - tr))

            avg_w = (top_w + bot_w) / 2.0
            avg_h = (left_h + right_h) / 2.0

            if avg_w < 20 or avg_h < 20:
                continue

            aspect = max(avg_w, avg_h) / min(avg_w, avg_h)

            # Check aspect ratio tolerance against A4 standard (1.4142 +/- 18% perspective tolerance)
            aspect_err = abs(aspect - A4_ASPECT_RATIO) / A4_ASPECT_RATIO
            if aspect_err <= 0.18:
                # Determine orientation
                is_portrait = avg_h >= avg_w
                phys_w = A4_WIDTH_MM if is_portrait else A4_HEIGHT_MM
                phys_h = A4_HEIGHT_MM if is_portrait else A4_WIDTH_MM

                # Target coordinates in true millimeters
                dst_pts = np.array([
                    [0.0, 0.0],
                    [phys_w, 0.0],
                    [phys_w, phys_h],
                    [0.0, phys_h],
                ], dtype=np.float32)

                # Homography: image pixels -> physical mm
                H, _ = cv2.findHomography(ordered, dst_pts)

                # Mean scale in mm per pixel
                mm_per_px_x = phys_w / avg_w
                mm_per_px_y = phys_h / avg_h
                mean_mm_per_px = (mm_per_px_x + mm_per_px_y) / 2.0

                confidence = max(0.5, min(0.98, 1.0 - (aspect_err * 2.0)))

                candidates.append({
                    "corners_px": ordered.tolist(),
                    "mm_per_pixel": float(round(mean_mm_per_px, 5)),
                    "homography_matrix": H.tolist() if H is not None else None,
                    "confidence": float(round(confidence, 3)),
                    "orientation": "portrait" if is_portrait else "landscape",
                    "area_px2": float(area),
                    "aspect_ratio": float(round(aspect, 3)),
                })

    if not candidates:
        return None

    # Choose candidate closest to expected A4 aspect ratio and largest reasonable area
    candidates.sort(key=lambda c: (c["confidence"], c["area_px2"]), reverse=True)
    best = candidates[0]
    return best
