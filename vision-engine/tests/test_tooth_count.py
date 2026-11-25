"""Tests for automatic gear tooth counting from a single photograph."""
import math

import cv2
import numpy as np
import pytest

from vision.opencv_features import extract_features
from vision.tooth_count import detect_tooth_count


def make_gear(
    teeth: int,
    size: int = 640,
    amplitude: float = 13.0,
    squash: float = 0.82,
    noise: float = 0.0,
    rotation_deg: float = 0.0,
    shadow: bool = False,
) -> np.ndarray:
    """Synthetic dark gear on a light background, with optional real-world artefacts."""
    center = size / 2.0
    angles = np.linspace(0, 2 * np.pi, 4000, endpoint=False)
    radius = 205.0 + amplitude * np.clip(np.cos(teeth * angles), -0.45, 1.0)
    points = np.column_stack([
        center + radius * np.cos(angles) * squash,
        center + radius * np.sin(angles),
    ]).astype(np.float32)

    if rotation_deg:
        matrix = cv2.getRotationMatrix2D((center, center), rotation_deg, 1.0)
        points = cv2.transform(points.reshape(-1, 1, 2), matrix).reshape(-1, 2)

    image = np.full((size, size, 3), 238, dtype=np.uint8)
    cv2.fillPoly(image, [points.astype(np.int32)], (72, 74, 78))
    cv2.circle(image, (int(center), int(center)), 36, (238, 238, 238), -1)

    if noise:
        rng = np.random.default_rng(17)
        image = np.clip(
            image.astype(np.int16) + rng.normal(0, noise, image.shape), 0, 255
        ).astype(np.uint8)

    if shadow:
        yy, xx = np.mgrid[:size, :size]
        shade = (0.62 + 0.38 * xx / size)[..., None]
        image = np.clip(image.astype(float) * shade, 0, 255).astype(np.uint8)
        cv2.ellipse(image, (int(center + 80), int(center - 95)), (48, 22), 25, 0, 360, (120, 72, 44), -1)

    return image


@pytest.mark.parametrize("teeth", [12, 18, 24, 31, 44, 83])
def test_counts_synthetic_gears_exactly(teeth):
    result = detect_tooth_count(make_gear(teeth), image_index=0)

    assert result["status"] == "ok"
    assert result["count"] == teeth
    assert result["confidence"] > 0.5
    assert len(result["teeth"]) == teeth
    assert result["teeth"][0]["x_px"] != result["teeth"][0]["y_px"]


def test_44_teeth_are_not_rounded_up_by_autocorrelation():
    result = detect_tooth_count(make_gear(44), image_index=0)

    assert result["status"] == "ok"
    assert result["count"] == 44
    assert len(result["teeth"]) == 44
    assert any(
        method["method"] == "autocorrelation" and method["count"] == 44
        for method in result["methods"]
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"noise": 9.0},
        {"shadow": True},
        {"squash": 0.72, "rotation_deg": 23.0},
        {"amplitude": 9.0, "noise": 6.0, "shadow": True},
    ],
)
def test_count_survives_shadows_noise_and_perspective(kwargs):
    result = detect_tooth_count(make_gear(36, **kwargs), image_index=0)

    assert result["status"] == "ok"
    assert result["count"] == 36
    assert len(result["teeth"]) == 36


def test_plain_circle_is_not_reported_as_a_gear():
    image = np.full((512, 512, 3), 238, dtype=np.uint8)
    cv2.circle(image, (256, 256), 170, (72, 74, 78), -1)

    result = detect_tooth_count(image, image_index=0)

    assert result["count"] is None
    assert result["status"] in {"uncertain", "unavailable"}
    assert result["teeth"] == []


def test_extract_features_exposes_schema_ready_tooth_count():
    result = extract_features(make_gear(21), image_index=0)

    tooth_count = result["tooth_count"]
    assert tooth_count["status"] == "ok"
    assert tooth_count["count"] == 21
    assert len(tooth_count["methods"]) >= 2
    assert all(0.0 <= method["confidence"] <= 1.0 for method in tooth_count["methods"])
