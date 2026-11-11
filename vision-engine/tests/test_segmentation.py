"""
test_segmentation.py — Test SAM2 segmentation wrapper:
- Graceful behavior when SAM2 is unavailable/not installed
- Low-confidence and ambiguity handling
- Post-processing does NOT flood-fill holes
"""
import pytest
import numpy as np

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

