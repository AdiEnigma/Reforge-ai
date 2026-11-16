"""Tests for single-view pixel-to-mm calibration heuristics."""
from __future__ import annotations

from vision.pipeline import _estimate_calibration


def test_no_reference_is_uncalibrated():
    result = _estimate_calibration(None, {"circles": []})
    assert result.status == "uncalibrated"
    assert result.mm_per_pixel is None
    assert result.confidence == 0.0


def test_outer_diameter_prefers_largest_circle_despite_bolt_holes():
    # A high-confidence bolt hole must not hijack calibration; the outer circle wins.
    circles = [
        {"cx_px": 200, "cy_px": 200, "radius_px": 100, "confidence": 0.7},
        {"cx_px": 150, "cy_px": 200, "radius_px": 10, "confidence": 0.95},
        {"cx_px": 250, "cy_px": 200, "radius_px": 10, "confidence": 0.95},
    ]
    result = _estimate_calibration({"outerDiameter": 50}, {"circles": circles})
    assert result.status == "calibrated"
    assert result.source == "outer_diameter_to_circle"
    # 50 mm / 200 px diameter
    assert result.mm_per_pixel == 0.25
    assert result.confidence > 0.5


def test_outer_diameter_handles_single_circle():
    circles = [{"cx_px": 100, "cy_px": 100, "radius_px": 62.5, "confidence": 0.9}]
    result = _estimate_calibration({"outerDiameter": 100}, {"circles": circles})
    assert result.status == "calibrated"
    assert result.mm_per_pixel == 0.8


def test_inner_diameter_uses_smallest_circle():
    circles = [
        {"cx_px": 200, "cy_px": 200, "radius_px": 100, "confidence": 0.8},
        {"cx_px": 200, "cy_px": 200, "radius_px": 20, "confidence": 0.8},
    ]
    result = _estimate_calibration({"innerDiameter": 10}, {"circles": circles})
    assert result.status == "calibrated"
    assert result.source == "inner_diameter_to_circle"
    # 10 mm / 40 px diameter
    assert result.mm_per_pixel == 0.25


def test_bbox_fallback_when_no_circles():
    seg = {"bbox_xyxy_px": [10, 20, 210, 220]}
    result = _estimate_calibration({"width": 40}, {"circles": []}, seg)
    assert result.status == "calibrated"
    assert result.source == "width_to_bbox"
    # 40 mm / 200 px span
    assert result.mm_per_pixel == 0.2
    assert any("bounding box" in warning for warning in result.warnings)


def test_tiny_circle_is_rejected():
    circles = [{"cx_px": 10, "cy_px": 10, "radius_px": 0.5, "confidence": 0.99}]
    result = _estimate_calibration({"outerDiameter": 50}, {"circles": circles})
    assert result.status == "uncalibrated"


def test_out_of_range_scale_is_rejected():
    circles = [{"cx_px": 10, "cy_px": 10, "radius_px": 1e6, "confidence": 0.99}]
    result = _estimate_calibration({"outerDiameter": 0.01}, {"circles": circles})
    assert result.status == "uncalibrated"
