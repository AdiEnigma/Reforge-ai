"""
model_registry.py — Singleton model cache for SAM2 and Depth Anything V2.
Models are loaded once per process and reused across requests.
"""
from __future__ import annotations

import logging

import config
from vision.segmentation import SAM2Segmentor
from vision.depth_estimator import DepthEstimator

logger = logging.getLogger(__name__)


def _resolve_device() -> str:
    """Resolve 'auto' to a concrete device string."""
    device = config.VISION_DEVICE
    if device != "auto":
        return device
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return "cuda"
        # MPS check (Apple Silicon)
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


class ModelRegistry:
    """Singleton that owns the loaded model instances."""

    def __init__(self) -> None:
        self._sam2: SAM2Segmentor = SAM2Segmentor()
        self._depth: DepthEstimator = DepthEstimator()
        self._sam2_loaded: bool = False
        self._depth_loaded: bool = False
        self._device: str = "cpu"
        self._initialized: bool = False

    def initialize(self) -> None:
        """Load all enabled models. Called once at startup."""
        if self._initialized:
            return
        self._initialized = True
        self._device = _resolve_device()
        logger.info("Vision model registry initializing on device: %s", self._device)

        if config.VISION_SAM2_ENABLED:
            self._sam2_loaded = self._sam2.load(self._device)
            logger.info("SAM2 loaded: %s", self._sam2_loaded)
        else:
            logger.info("SAM2 disabled via VISION_SAM2_ENABLED=false")

        if config.VISION_DEPTH_ENABLED:
            self._depth_loaded = self._depth.load(self._device)
            logger.info("Depth Anything V2 loaded: %s", self._depth_loaded)
        else:
            logger.info("Depth Anything V2 disabled via VISION_DEPTH_ENABLED=false")

    @property
    def sam2(self) -> SAM2Segmentor:
        return self._sam2

    @property
    def depth(self) -> DepthEstimator:
        return self._depth

    @property
    def sam2_loaded(self) -> bool:
        return self._sam2_loaded

    @property
    def depth_loaded(self) -> bool:
        return self._depth_loaded

    @property
    def device(self) -> str:
        return self._device


# Global singleton
registry = ModelRegistry()
