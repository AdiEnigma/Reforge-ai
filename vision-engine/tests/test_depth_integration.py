"""Real-model integration checks for the official Depth Anything V2 source."""
import os
import time

import numpy as np
import pytest
from PIL import Image

import config
from vision.depth_estimator import DepthEstimator


CHECKPOINT_PATH = os.path.join(config.VISION_MODELS_DIR, config.DEPTH_CHECKPOINT_FILENAME)
FIXTURE_PATH = os.path.join("tests", "fixtures", "spur_gear.png")


def _require_model_files():
    if not os.path.isdir(config.DEPTH_ANYTHING_V2_SOURCE_DIR):
        pytest.skip("Run scripts/install_depth_anything_v2.ps1 to install the pinned official source")
    if not os.path.isfile(CHECKPOINT_PATH):
        pytest.skip("Run scripts/download_models.py --model depth to obtain the checkpoint")


def test_depth_model_loads_official_checkpoint():
    _require_model_files()
    estimator = DepthEstimator()
    started = time.perf_counter()
    assert estimator.load("cpu") is True
    assert estimator._loaded is True
    assert type(estimator._model).__module__ == "depth_anything_v2.dpt"
    assert time.perf_counter() - started < 120


def test_depth_actual_inference_returns_finite_source_sized_map():
    _require_model_files()
    rgb = np.asarray(Image.open(FIXTURE_PATH).convert("RGB"), dtype=np.uint8).copy()
    estimator = DepthEstimator()
    assert estimator.load("cpu") is True

    started = time.perf_counter()
    depth_map = estimator._infer_depth_map(rgb)
    inference_seconds = time.perf_counter() - started
    result = estimator.estimate(rgb)

    assert depth_map.shape == rgb.shape[:2]
    assert np.isfinite(depth_map).all()
    assert float(depth_map.std()) > 0
    assert result["status"] == "ok"
    assert result["depth_type"] == "relative"
    assert result["metric"] is False
    assert inference_seconds < 120
