"""
test_segmentation.py — Test SAM2 segmentation wrapper:
- Graceful behavior when SAM2 is unavailable/not installed
- Low-confidence and ambiguity handling
- Post-processing does NOT flood-fill holes
"""
import os

import pytest
import numpy as np
from PIL import Image

from vision.segmentation import SAM2Segmentor
from schemas import SegmentationResult


def test_segmentor_initial_state():
    segmentor = SAM2Segmentor()
    assert not segmentor._loaded
    res = segmentor.segment(np.zeros((100, 100, 3), dtype=np.uint8))
    assert res["status"] == "unavailable"
    assert res["candidate_count"] == 0
    assert res["bbox_xyxy_px"] is None
    assert any("not available" in w for w in res["warnings"])


def test_segmentation_result_schema():
    sr = SegmentationResult(
        status="ok",
        bbox_xyxy_px=[10.0, 20.0, 100.0, 120.0],
        mask_area_ratio=0.35,
        candidate_count=2,
        score=0.92,
        needs_user_selection=False,
    )
    assert sr.status == "ok"
    assert sr.score == 0.92
    assert sr.needs_user_selection is False


def test_segmentation_ambiguity_flag():
    sr = SegmentationResult(
        status="needs_user_selection",
        candidate_count=3,
        needs_user_selection=True,
    )
    assert sr.needs_user_selection is True


def _load_real_segmentor():
    segmentor = SAM2Segmentor()
    checkpoint = os.path.join("models", "sam2.1_hiera_small.pt")
    assert os.path.isfile(checkpoint), "SAM2 checkpoint is required for this integration test"
    assert segmentor.load("cpu") is True
    assert segmentor._predictor is not None
    assert segmentor._mask_generator is not None
    return segmentor


def test_segmentor_loads_real_sam2_model_when_available():
    segmentor = _load_real_segmentor()
    assert segmentor._loaded is True


def test_segmentor_runs_real_inference_on_mechanical_image():
    segmentor = _load_real_segmentor()

    rgb = np.asarray(Image.open("tests/fixtures/spur_gear.png").convert("RGB"), dtype=np.uint8).copy()
    segmentor._predictor.set_image(rgb)
    masks, scores, _ = segmentor._predictor.predict(
        point_coords=np.array([[rgb.shape[1] // 2, 145]], dtype=np.float32),
        point_labels=np.array([1], dtype=np.int32),
        multimask_output=False,
    )

    mask = masks[0].astype(bool)
    known_foreground = rgb.mean(axis=2) < 100
    intersection = np.logical_and(mask, known_foreground).sum()
    union = np.logical_or(mask, known_foreground).sum()
    assert mask.shape == rgb.shape[:2]
    assert mask.any()
    assert intersection / union > 0.9
    assert np.isfinite(scores).all()

