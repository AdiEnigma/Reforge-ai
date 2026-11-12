"""Real-model combined pipeline check with a fixture-specific SAM2 point grid."""
import asyncio
import base64
import os
import time

import numpy as np
import pytest
import torch
from PIL import Image
from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator

import config
from schemas import ImageInput
from vision.depth_estimator import DepthEstimator
from vision.model_registry import registry
from vision.pipeline import process_images
from vision.segmentation import SAM2Segmentor


FIXTURE_PATH = os.path.join("tests", "fixtures", "spur_gear.png")
SAM2_CHECKPOINT = os.path.join(config.VISION_MODELS_DIR, config.SAM2_CHECKPOINT_FILENAME)
DEPTH_CHECKPOINT = os.path.join(config.VISION_MODELS_DIR, config.DEPTH_CHECKPOINT_FILENAME)


def test_pipeline_combines_real_models_and_opencv(monkeypatch):
    if not os.path.isdir(config.DEPTH_ANYTHING_V2_SOURCE_DIR):
        pytest.skip("Run scripts/install_depth_anything_v2.py to install the pinned official source")
    if not os.path.isfile(SAM2_CHECKPOINT) or not os.path.isfile(DEPTH_CHECKPOINT):
        pytest.skip("Download model checkpoints with scripts/download_models.py")

    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        rgb = np.asarray(Image.open(FIXTURE_PATH).convert("RGB"), dtype=np.uint8).copy()
        segmentor = SAM2Segmentor()
        assert segmentor.load("cpu") is True
        point_grid = [np.array([[0.5, 145 / rgb.shape[0]]], dtype=np.float32)]
        segmentor._mask_generator = SAM2AutomaticMaskGenerator(
            segmentor._mask_generator.predictor.model,
            points_per_side=None,
            point_grids=point_grid,
        )

        depth = DepthEstimator()
        assert depth.load("cpu") is True

        monkeypatch.setattr(registry, "_sam2", segmentor)
        monkeypatch.setattr(registry, "_sam2_loaded", True)
        monkeypatch.setattr(registry, "_depth", depth)
        monkeypatch.setattr(registry, "_depth_loaded", True)
        monkeypatch.setattr(registry, "_device", "cpu")
        monkeypatch.setattr(registry, "_initialized", True)
        monkeypatch.setattr(config, "VISION_SAM2_ENABLED", True)
        monkeypatch.setattr(config, "VISION_DEPTH_ENABLED", True)
        monkeypatch.setattr(config, "VISION_FAIL_OPEN", False)
        monkeypatch.setattr(config, "VISION_REQUEST_TIMEOUT_SECONDS", 120)

        with open(FIXTURE_PATH, "rb") as image_file:
            request = ImageInput(
                data=base64.b64encode(image_file.read()).decode("ascii"),
                mimeType="image/png",
                image_index=0,
            )

        started = time.perf_counter()
        response = asyncio.run(process_images([request], {"known_diameter_mm": 50.0}))
        assert time.perf_counter() - started < 120
    finally:
        torch.set_num_threads(previous_threads)

    image_result = response.images[0]
    assert response.device.sam2_loaded is True
    assert response.device.depth_loaded is True
    assert (image_result.width, image_result.height) == (rgb.shape[1], rgb.shape[0])
    assert image_result.segmentation.status == "ok"
    assert image_result.segmentation.candidate_count == 1
    assert 0.15 < image_result.segmentation.mask_area_ratio < 0.4
    x1, y1, x2, y2 = image_result.segmentation.bbox_xyxy_px
    assert x2 - x1 < 400 and y2 - y1 < 400
    assert (
        image_result.opencv.contours
        or image_result.opencv.circles
        or image_result.opencv.ellipses
        or image_result.opencv.lines
    )
    assert image_result.depth.status == "ok"
    assert image_result.depth.depth_type == "relative"
    assert image_result.depth.metric is False
