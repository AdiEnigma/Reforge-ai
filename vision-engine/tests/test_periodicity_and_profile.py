"""
test_periodicity_and_profile.py — Test mathematical polar FFT periodicity and radial profile extraction.
"""
import math
import numpy as np
import cv2
import pytest

from vision.opencv_features import extract_features, _compute_advanced_symmetry, _extract_radial_profile


def test_polar_fft_detects_24_teeth_periodicity():
    """Create a synthetic 24-tooth gear contour and verify polar FFT extracts order 24."""
    img_size = 300
    canvas = np.zeros((img_size, img_size, 3), dtype=np.uint8)
    cx, cy = 150, 150
    base_r = 80.0
    mod_amp = 10.0
    num_teeth = 24

    # Draw continuous 24-sinusoid gear contour
    points = []
    for angle_deg in range(360):
        rad = math.radians(angle_deg)
        r = base_r + mod_amp * math.sin(num_teeth * rad)
        x = int(cx + r * math.cos(rad))
        y = int(cy + r * math.sin(rad))
        points.append([x, y])

    pts = np.array(points, dtype=np.int32)
    cv2.fillPoly(canvas, [pts], (220, 220, 220))
    cv2.circle(canvas, (cx, cy), 25, (0, 0, 0), -1)  # bore

    gray = cv2.cvtColor(canvas, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    circle_features = [{"cx_px": cx, "cy_px": cy, "radius_px": base_r, "confidence": 0.95}]

    sym = _compute_advanced_symmetry(gray, edges, circle_features, [])
    assert sym["rotational"] is True
    # Should detect 24-fold periodicity with high confidence
    assert sym["rotational_order"] == 24
    assert sym["spectral_confidence"] > 0.5


def test_extract_radial_profile_on_stepped_shaft():
    """Create a synthetic stepped shaft mask and verify radial profile extraction."""
    h, w = 200, 400
    mask = np.zeros((h, w), dtype=np.uint8)
    # Step 1: length 100, radius 20 (y from 80 to 120)
    mask[80:120, 50:150] = 255
    # Step 2: length 120, radius 40 (y from 60 to 140)
    mask[60:140, 150:270] = 255
    # Step 3: length 80, radius 25 (y from 75 to 125)
    mask[75:125, 270:350] = 255

    bbox = {
        "axis_aligned": [50.0, 60.0, 300.0, 80.0],
        "rotated_center_px": [200.0, 100.0],
        "rotated_size_px": [80.0, 300.0],  # aspect ratio 300/80 = 3.75
        "rotated_angle_deg": 0.0,
    }

    profile = _extract_radial_profile(mask, bbox)
    assert profile is not None
    assert profile["length_px"] >= 290
    assert profile["max_radius_px"] >= 35.0
    assert profile["min_radius_px"] <= 25.0
    assert len(profile["stations"]) >= 10
