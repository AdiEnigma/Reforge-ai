"""
test_a4_calibration.py — Verification of ISO 216 A4 Paper Fiducial Calibration.
"""

import math
import cv2
import numpy as np
import pytest

from vision.calibration import (
    A4_WIDTH_MM,
    A4_HEIGHT_MM,
    detect_a4_paper_corners,
    order_quad_points,
)
from vision.pipeline import _estimate_calibration


def create_synthetic_a4_scene(
    image_shape=(800, 1000),
    paper_rect_px=((150, 100), (700, 100), (700, 878), (150, 878)), # 550 x 778 px ~ aspect 1.4145
    add_object=True,
):
    """Generates an image with a white A4 sheet on a darker surface, plus an optional gear/disc object."""
    img = np.full((image_shape[0], image_shape[1], 3), 40, dtype=np.uint8) # Dark wooden desk

    # Draw white A4 paper
    pts = np.array(paper_rect_px, dtype=np.int32)
    cv2.fillPoly(img, [pts], (245, 245, 245))
    # Border
    cv2.polylines(img, [pts], True, (210, 210, 210), 1)

    if add_object:
        # Draw a dark mechanical gear disc on top of the paper (e.g. center (425, 489), radius 80px)
        cv2.circle(img, (425, 489), 80, (60, 60, 60), -1) # Outer gear
        cv2.circle(img, (425, 489), 25, (245, 245, 245), -1) # Bore hole showing white paper through

    return img


def test_order_quad_points():
    pts = np.array([[100, 200], [200, 100], [300, 300], [100, 300]])
    ordered = order_quad_points(pts)
    assert ordered.shape == (4, 2)
    # top-left
    assert ordered[0][0] <= ordered[1][0]
    assert ordered[0][1] <= ordered[3][1]


def test_detect_a4_paper_portrait():
    # True A4: 210 mm x 297 mm
    # In pixels: 420 px width x 594 px height -> exactly 0.500 mm / pixel
    img = create_synthetic_a4_scene(
        image_shape=(800, 800),
        paper_rect_px=((190, 103), (610, 103), (610, 697), (190, 697)),
    )

    res = detect_a4_paper_corners(img)
    assert res is not None
    assert res["orientation"] == "portrait"
    assert abs(res["mm_per_pixel"] - 0.500) < 0.02
    assert res["confidence"] >= 0.85
    assert len(res["corners_px"]) == 4


def test_detect_a4_paper_landscape_perspective():
    # Slightly rotated / perspective quadrangle
    img = create_synthetic_a4_scene(
        image_shape=(900, 1000),
        paper_rect_px=((205, 160), (795, 140), (815, 560), (185, 580)),
    )

    res = detect_a4_paper_corners(img)
    assert res is not None
    assert res["orientation"] == "landscape"
    assert res["confidence"] >= 0.70


def test_estimate_calibration_pipeline_integration():
    img = create_synthetic_a4_scene(
        image_shape=(800, 800),
        paper_rect_px=((190, 103), (610, 103), (610, 697), (190, 697)),
    )
    cv_dict = {"circles": [{"radius_px": 80, "confidence": 0.95}]}

    cal = _estimate_calibration(reference=None, cv_dict=cv_dict, rgb=img)
    assert cal.status == "calibrated"
    assert cal.source == "iso_216_a4_paper"
    assert cal.reference_type == "a4_paper"
    assert abs(cal.mm_per_pixel - 0.500) < 0.02
    assert cal.homography_matrix is not None
