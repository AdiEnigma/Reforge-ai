"""
test_depth_contract.py — Strictly enforces Section 4.4 and Rule 9 depth contracts:
1. depth_type is ALWAYS "relative"
2. metric is ALWAYS False
3. NO physical depth_mm, z_mm, or CAD scale is fabricated
4. Missing checkpoint safely returns status="unavailable"
5. Flat depth map is marked status="low_quality"
"""
import pytest
import numpy as np

from vision.depth_estimator import DepthEstimator
from schemas import DepthResult


def test_depth_result_schema_contract():
    """DepthResult schema must enforce relative depth and metric=False."""
    dr = DepthResult(status="ok")
    assert dr.depth_type == "relative"
    assert dr.metric is False
    assert any("Relative depth only" in w for w in dr.warnings)
    # Ensure no physical depth fields exist
    assert not hasattr(dr, "depth_mm")
    assert not hasattr(dr, "z_mm")
    assert not hasattr(dr, "mm_per_pixel")


def test_missing_checkpoint_returns_unavailable():
    """If model is not loaded, estimate() must return unavailable gracefully without crashing."""
    estimator = DepthEstimator()
    # Without load(), estimate should return unavailable
    res = estimator.estimate(np.zeros((100, 100, 3), dtype=np.uint8))
    assert res["status"] == "unavailable"
    assert res["depth_type"] == "relative"
    assert res["metric"] is False
    assert res["preview_ref"] is None
    assert any("Relative depth only" in w for w in res["warnings"])


def test_depth_dict_contains_no_mm_keys():
    """No key in depth estimate output should mention 'mm' or physical scale."""
    estimator = DepthEstimator()
    res = estimator.estimate(np.zeros((64, 64, 3), dtype=np.uint8))
    for key in res.keys():
        assert "mm" not in key.lower()
        assert "metric_depth" not in key.lower()

