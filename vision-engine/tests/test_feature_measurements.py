"""
test_feature_measurements.py — ratio-based geometric measurement tests.

All expectations are normalised ratios (never mm). Synthetic ground truth is
rendered with 2x supersampling so the tolerances reflect detector error, not
integer drawing quantisation.
"""
import json
import math

import pytest

from vision.opencv_features import extract_features
from vision.feature_measurements import (
    SCHEMA_VERSION,
    fuse_measurements,
    measure_image,
)
from tests.fixtures.generate_synthetic_fixtures import (
    make_measurement_disc,
    make_measurement_non_circular,
    make_measurement_ring,
    make_measurement_side_profile,
    make_measurement_washer,
)


def _measure(img, image_index=0, **kwargs):
    return measure_image(
        extract_features(img, image_index=image_index),
        image_index=image_index,
        **kwargs,
    )


def _rel(measured, truth):
    return abs(float(measured) - float(truth)) / max(abs(float(truth)), 1e-9)


def _concentric_ratio(axial, truth):
    candidates = axial.get("concentric") or []
    assert candidates, "expected at least one concentric feature"
    return min(candidates, key=lambda c: abs(float(c["radius_ratio"]) - truth))[
        "radius_ratio"
    ]


def _single_pattern(axial):
    patterns = axial.get("radial_patterns") or []
    assert len(patterns) == 1, f"expected one radial pattern, got {patterns}"
    return patterns[0]


AXIAL_SCENARIOS = [
    ("ring_4", dict(hole_count=4), 0.0),
    ("ring_6", dict(hole_count=6), 0.0),
    ("ring_8", dict(hole_count=8), 0.0),
    ("ring_4_tilt10", dict(hole_count=4), 10.0),
    ("ring_6_tilt20", dict(hole_count=6), 20.0),
    ("ring_8_tilt25", dict(hole_count=8), 25.0),
    (
        "ring_6_degraded",
        dict(hole_count=6, blur=5, noise=6.0, lighting=0.15, seed=7),
        15.0,
    ),
    ("ring_hub", dict(hole_count=4, hub_ratio=0.52), 0.0),
]


def test_axial_accuracy_table():
    rows = []
    for name, kwargs, tilt in AXIAL_SCENARIOS:
        img, gt = make_measurement_ring(tilt_deg=tilt, **kwargs)
        measurement = _measure(img)
        assert measurement["view"]["label"] == "axial_face", name

        axial = measurement["axial"]
        bore = _concentric_ratio(axial, gt["bore_ratio"])
        pattern = _single_pattern(axial)

        bore_err = _rel(bore, gt["bore_ratio"])
        pattern_err = _rel(pattern["pattern_radius_ratio"], gt["pattern_radius_ratio"])
        hole_err = _rel(pattern["hole_radius_ratio"], gt["hole_radius_ratio"])
        tilt_meas = float(axial["tilt_deg"])
        tilt_err = abs(tilt_meas - gt["tilt_deg"])

        rows.append(
            (
                name,
                f"{gt['bore_ratio']:.3f}/{bore:.3f}",
                f"{bore_err * 100:.2f}%",
                f"{gt['pattern_radius_ratio']:.3f}/{pattern['pattern_radius_ratio']:.3f}",
                f"{pattern_err * 100:.2f}%",
                f"{gt['hole_radius_ratio']:.3f}/{pattern['hole_radius_ratio']:.3f}",
                f"{hole_err * 100:.2f}%",
                f"{gt['hole_count']}/{pattern['count']}",
                f"{tilt_meas:.2f}",
            )
        )

        assert bore_err <= 0.03, f"{name}: bore ratio {bore_err:.3%}"
        assert pattern_err <= 0.03, f"{name}: pattern radius {pattern_err:.3%}"
        assert hole_err <= 0.05, f"{name}: hole radius {hole_err:.3%}"
        assert pattern["count"] == gt["hole_count"], name
        assert pattern["angular_residual_deg"] <= 3.0, name
        assert tilt_err <= 3.0, f"{name}: tilt {tilt_meas:.2f} vs {tilt:g}"

    header = ("scenario", "bore gt/meas", "err", "pitch gt/meas", "err",
              "hole gt/meas", "err", "count", "tilt")
    print("\nAXIAL MEASUREMENT ACCURACY (normalised ratios)")
    print(" | ".join(header))
    for row in rows:
        print(" | ".join(str(cell) for cell in row))


def test_hub_is_reported_as_concentric_with_confidence():
    img, gt = make_measurement_ring(tilt_deg=0.0, hole_count=4, hub_ratio=0.52)
    axial = _measure(img)["axial"]
    ratios = sorted(c["radius_ratio"] for c in axial["concentric"])
    assert any(abs(r - gt["hub_ratio"]) <= 0.03 for r in ratios)
    assert all(0.0 < c["confidence"] <= 1.0 for c in axial["concentric"])


@pytest.mark.parametrize(
    "maker,expected_kind",
    [
        (make_measurement_disc, "disc"),
        (make_measurement_washer, "washer"),
    ],
)
def test_plain_round_parts(maker, expected_kind):
    img, gt = maker(tilt_deg=0.0)
    measurement = _measure(img)
    assert measurement["view"]["label"] == "axial_face"
    axial = measurement["axial"]
    assert not axial["radial_patterns"]
    bore = _concentric_ratio(axial, gt["bore_ratio"])
    assert _rel(bore, gt["bore_ratio"]) <= 0.03, expected_kind


def test_side_profile_measurement():
    img, gt = make_measurement_side_profile()
    measurement = _measure(img)
    assert measurement["view"]["label"] == "side_profile"
    side = measurement["side"]
    assert side["profile"], "side silhouette must produce a profile"

    assert _rel(side["thickness_ratio"], gt["thickness_ratio"]) <= 0.05
    assert _rel(side["height_ratio"], gt["height_ratio"]) <= 0.05
    assert _rel(side["hub_height_ratio"], gt["hub_height_ratio"]) <= 0.10
    assert side["step_count"] == 1
    assert all(0.0 < p["r_ratio"] for p in side["profile"])


def test_non_circular_plate_keeps_polygon_and_individual_holes():
    img, gt = make_measurement_non_circular()
    measurement = _measure(img)
    assert measurement["view"]["label"] in ("oblique", "unknown")

    polygon = measurement["polygon"]
    assert polygon is not None
    assert polygon["point_count"] == 4
    xs = [p["x_ratio"] for p in polygon["points"]]
    ys = [p["y_ratio"] for p in polygon["points"]]
    assert abs((max(xs) - min(xs)) - gt["polygon_width_ratio"]) <= 0.05
    assert abs((max(ys) - min(ys)) - gt["polygon_height_ratio"]) <= 0.06

    axial = measurement["axial"]
    bore = _concentric_ratio(axial, gt["bore_ratio"])
    assert _rel(bore, gt["bore_ratio"]) <= 0.03

    # Corner holes are not on a uniform bolt circle: they must stay individual
    # holes rather than being forced into an invented radial array.
    assert not axial["radial_patterns"]
    holes = axial["holes"]
    assert len(holes) == gt["hole_count"]
    for hole in holes:
        assert _rel(hole["radius_ratio"], gt["hole_radius_ratio"]) <= 0.05
        assert abs(abs(hole["x_ratio"]) - 0.5) <= 0.04
        assert abs(abs(hole["y_ratio"]) - 0.36) <= 0.04


def test_view_override_is_recorded():
    img, _ = make_measurement_side_profile()
    measurement = _measure(img, view_override="axial_face")
    assert measurement["view"]["label"] == "axial_face"
    assert measurement["view"]["source"] == "user_override"


def test_multi_image_fusion():
    axial_a, _ = make_measurement_ring(tilt_deg=0.0, hole_count=6)
    axial_b, _ = make_measurement_ring(tilt_deg=15.0, hole_count=6)
    side, side_gt = make_measurement_side_profile()

    per_image = [
        _measure(axial_a, image_index=0),
        _measure(axial_b, image_index=1),
        _measure(side, image_index=2),
    ]
    fused = fuse_measurements(per_image)

    assert fused["schema_version"] == SCHEMA_VERSION
    assert fused["status"] == "ok"
    assert fused["view"]["label"] == "axial_face"
    assert fused["agreement_score"] > 0.6
    assert not fused["conflicts"]

    bore = min(fused["concentric"], key=lambda c: abs(c["radius_ratio"] - 0.30))
    assert _rel(bore["radius_ratio"], 0.30) <= 0.03
    pattern = _single_pattern(fused)
    assert pattern["count"] == 6
    assert pattern["image_count"] == 2

    assert fused["side_profile"] is not None
    assert _rel(
        fused["side_profile"]["thickness_ratio"], side_gt["thickness_ratio"]
    ) <= 0.05
    # A side silhouette must never masquerade as a front-face polygon.
    assert fused["polygon"] is None

    assert len(fused["holes"]) == 6
    json.dumps(fused)  # compact, JSON-serialisable, no pixel arrays


def test_fusion_flags_missing_thickness():
    axial, _ = make_measurement_ring(tilt_deg=0.0, hole_count=4)
    fused = fuse_measurements([_measure(axial)])
    assert fused["side_profile"] is None
    assert any(
        "thickness" in f"{item.get('parameter', '')} {item.get('question', '')}".lower()
        for item in fused["needs_input"]
    )


def test_measurement_is_json_serialisable_and_pixel_free():
    img, _ = make_measurement_ring(tilt_deg=10.0, hole_count=4, hub_ratio=0.5)
    measurement = _measure(img)
    encoded = json.dumps(measurement)
    assert "points_px" not in encoded
    # Ratios are unitless; any *_px fields are diagnostic only.
    assert measurement["outer"]["shape"] == "circular"
    assert measurement["view"]["tilt_deg"] is not None
