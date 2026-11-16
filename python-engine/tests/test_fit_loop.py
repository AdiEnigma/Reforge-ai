"""Tests for the image-fit silhouette check and capped refine loop."""

from __future__ import annotations

import base64
import math

import numpy as np
import pytest

import cadquery as cq

from cad.fit_loop import (
    FitLoopResult,
    ImageFitError,
    mask_from_payload,
    project_silhouette,
    run_image_fit,
    silhouette_iou,
)


def _cylinder():
    return cq.Workplane("XY").circle(10.0).extrude(20.0)


def _ground_truth_mask(mm_per_pixel=0.2, scale=1.0, shape=(256, 256)):
    return project_silhouette(
        _cylinder(), shape, mm_per_pixel=mm_per_pixel, scale=scale
    )


def test_silhouette_iou_is_one_for_identical_masks():
    mask = _ground_truth_mask()
    assert silhouette_iou(mask, mask) == pytest.approx(1.0)


def test_project_silhouette_is_centered_and_filled():
    mask = _ground_truth_mask(mm_per_pixel=0.2)
    ys, xs = np.nonzero(mask)
    assert xs.size > 0
    # 20 mm wide at 0.2 mm/px -> ~100 px, centred in a 256 px frame.
    assert xs.min() == pytest.approx(78, abs=3)
    assert xs.max() == pytest.approx(178, abs=3)
    assert ys.min() == pytest.approx(78, abs=3)
    assert ys.max() == pytest.approx(178, abs=3)
    assert mask.mean() > 0.1


def test_run_image_fit_converges_at_calibrated_scale():
    mask = _ground_truth_mask()
    result = run_image_fit(_cylinder(), mask, mm_per_pixel=0.2)

    assert isinstance(result, FitLoopResult)
    assert result.status == "converged"
    assert result.scale == pytest.approx(1.0, abs=0.05)
    assert result.fit_score >= 0.85
    assert 1 <= result.iterations <= 5
    assert result.basis["is_accuracy_metric"] is True


def test_run_image_fit_recovers_a_scale_correction():
    mask = _ground_truth_mask(scale=1.25)
    result = run_image_fit(_cylinder(), mask, mm_per_pixel=0.2)

    assert result.status == "converged"
    assert result.scale == pytest.approx(1.25, abs=0.12)
    assert result.fit_score >= 0.8


def test_run_image_fit_reports_failure_for_wrong_geometry():
    mask = np.zeros((256, 256), dtype=np.uint8)
    mask[10:30, 10:30] = 1
    result = run_image_fit(_cylinder(), mask, mm_per_pixel=0.2)

    assert result.status == "failed"
    assert result.fit_score < 0.5
    assert "does not match" in result.reason
    assert result.iterations <= 5


def test_iteration_budget_is_capped():
    mask = np.zeros((256, 256), dtype=np.uint8)
    mask[10:30, 10:30] = 1
    result = run_image_fit(
        _cylinder(), mask, mm_per_pixel=0.2, max_iterations=3, min_iterations=3
    )
    assert result.iterations <= 3


def test_mask_from_payload_accepts_arrays_and_png_base64():
    array = _ground_truth_mask() * 255
    decoded = mask_from_payload(array.tolist())
    assert decoded.dtype == np.uint8
    assert decoded.shape == array.shape

    import cv2

    ok, encoded = cv2.imencode(".png", array)
    assert ok
    payload = "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode()
    decoded_png = mask_from_payload({"mimeType": "image/png", "data": payload})
    assert decoded_png.shape == array.shape
    assert decoded_png.sum() > 0


def test_run_image_fit_requires_calibration():
    with pytest.raises(ImageFitError):
        run_image_fit(_cylinder(), _ground_truth_mask(), mm_per_pixel=0)
    with pytest.raises(ImageFitError):
        run_image_fit(_cylinder(), np.zeros((0, 0), dtype=np.uint8), mm_per_pixel=0.2)
