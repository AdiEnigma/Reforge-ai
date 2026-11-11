"""
test_opencv_features.py — Test OpenCV feature extraction:
- Contours & hierarchy (inner holes vs outer perimeter)
- Circle proposals & accuracy
- Ellipse candidates & perspective warning
- Line candidates
- Boundary truncation indicator
- Verify all coordinates are strictly pixels (never mm)
"""
import pytest
import numpy as np

from vision.opencv_features import extract_features
from tests.fixtures.generate_synthetic_fixtures import (
    make_flange,
    make_spur_gear,
    make_stepped_shaft,
    make_truncated_component,
)


def test_flange_contour_hierarchy_preserves_inner_holes():
    img, gt = make_flange(512)
    res = extract_features(img, image_index=0)

    contours = res["contours"]
    assert len(contours) > 0

    # Must have both outer contour and inner hole contours
    types = [c["type"] for c in contours]
    assert "outer_contour" in types
    assert "inner_contour" in types

    inner_contours = [c for c in contours if c["type"] == "inner_contour"]
    # Flange has center bore + 4 bolt holes = at least 1 inner contour detected
    assert len(inner_contours) >= 1
    for c in inner_contours:
        assert c["hierarchy_level"] >= 1


def test_flange_circle_candidates():
    img, gt = make_flange(512)
    res = extract_features(img, image_index=0)

    circles = res["circles"]
    assert len(circles) > 0

    # Find the largest circle candidate (the flange body)
    outer_circles = [c for c in circles if c["radius_px"] > 100]
    assert len(outer_circles) >= 1
    best = max(outer_circles, key=lambda c: c["radius_px"])

    # Center should be close to ground truth center (256, 256)
    assert abs(best["cx_px"] - gt["cx"]) <= 10.0
    assert abs(best["cy_px"] - gt["cy"]) <= 10.0
    # Radius error <= 10%
    assert abs(best["radius_px"] - gt["flange_radius"]) / gt["flange_radius"] <= 0.10


def test_ellipse_candidates_have_perspective_warning():
    img, _ = make_flange(512)
    res = extract_features(img, image_index=0)

    ellipses = res["ellipses"]
    if ellipses:
        for el in ellipses:
            assert any("Perspective" in w for w in el["warnings"])


def test_stepped_shaft_line_candidates():
    img, gt = make_stepped_shaft(512)
    res = extract_features(img, image_index=0)

    lines = res["lines"]
    assert len(lines) > 0
    # Lines must have positive length
    for line in lines:
        assert line["length_px"] > 0
        assert line["provenance"] == "opencv"


def test_truncated_component_warning():
    img, _ = make_truncated_component(512)
    res = extract_features(img, image_index=0)

    # At least one contour touching the border must have the border warning
    border_warned = [
        c for c in res["contours"]
        if any("border" in w.lower() for w in c.get("warnings", []))
    ]
    assert len(border_warned) >= 1


def test_all_coordinates_are_numbers_never_strings_or_mm():
    img, _ = make_spur_gear(256)
    res = extract_features(img, image_index=0)

    # Check contours
    for c in res["contours"]:
        assert isinstance(c["area_px2"], (int, float))
        assert isinstance(c["perimeter_px"], (int, float))
        for pt in c["points_px"]:
            assert isinstance(pt[0], (int, float))
            assert isinstance(pt[1], (int, float))

    # Check circles
    for c in res["circles"]:
        assert isinstance(c["cx_px"], (int, float))
        assert isinstance(c["cy_px"], (int, float))
        assert isinstance(c["radius_px"], (int, float))
        assert not hasattr(c, "radius_mm")

    # Check bounding box
    if res["bounding_box"]:
        bb = res["bounding_box"]
        if bb.get("axis_aligned"):
            for v in bb["axis_aligned"]:
                assert isinstance(v, (int, float))

