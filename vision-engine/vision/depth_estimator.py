"""
depth_estimator.py — Depth Anything V2 Small wrapper.

ALWAYS returns relative depth. NEVER returns metric depth (mm).
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_FLAT_DEPTH_STD_THRESHOLD = 0.01  # below this → low_quality


class DepthEstimator:
    """Lazy-loaded Depth Anything V2 Small estimator."""

    def __init__(self) -> None:
        self._model = None
        self._loaded = False
        self._device = "cpu"

    def load(self, device: str) -> bool:
        """
        Lazy load Depth Anything V2 Small.

        Returns:
            True if loaded, False if unavailable (ImportError / missing checkpoint).
        """
        import config

        checkpoint_path = os.path.join(config.VISION_MODELS_DIR, config.DEPTH_CHECKPOINT_FILENAME)
        source_dir = config.DEPTH_ANYTHING_V2_SOURCE_DIR
        if source_dir and os.path.isdir(source_dir) and source_dir not in sys.path:
            sys.path.insert(0, source_dir)

        try:
            import torch  # type: ignore

            if device == "auto":
                resolved = "cuda" if torch.cuda.is_available() else "cpu"
            else:
                resolved = device
            self._device = resolved

            if not os.path.isfile(checkpoint_path):
                logger.warning("Depth Anything V2 checkpoint not found at %s", checkpoint_path)
                return False

            # Try HuggingFace approach first
            try:
                from depth_anything_v2.dpt import DepthAnythingV2  # type: ignore

                model_configs = {
                    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
                }
                encoder = "vits"
                self._model = DepthAnythingV2(**model_configs[encoder])
                state_dict = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
                self._model.load_state_dict(state_dict)
                self._model.to(resolved)
                self._model.eval()
                self._loaded = True
                return True
            except ImportError:
                pass  # Fall through to manual load

            # Manual torch.load approach
            logger.info("depth_anything_v2 not installed; attempting raw torch.load")
            state_dict = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
            # Cannot instantiate without the module — mark unavailable
            logger.warning("depth_anything_v2 package not installed; cannot construct model")
            return False

        except ImportError as exc:
            logger.warning("torch not installed; depth estimation unavailable: %s", exc)
            return False
        except FileNotFoundError as exc:
            logger.warning("Depth checkpoint missing: %s", exc)
            return False
        except RuntimeError as exc:
            logger.warning("Depth Anything V2 RuntimeError during load: %s", exc)
            return False
        except Exception as exc:
            logger.warning("Depth Anything V2 load failed: %s", exc)
            return False

    def estimate(self, rgb: np.ndarray, mask: Optional[np.ndarray] = None) -> dict:
        """
        Estimate relative depth for the given RGB image.

        Returns a dict. NEVER includes depth_mm, z_mm, or mm_per_pixel.
        depth_type is ALWAYS "relative". metric is ALWAYS False.

        Args:
            rgb:  (H, W, 3) uint8 RGB image
            mask: optional (H, W) foreground mask (unused currently)

        Returns:
            {
                status:     "ok" | "low_quality" | "unavailable",
                depth_type: "relative",
                metric:     False,
                preview_ref: None,
                warnings:   list[str],
            }
        """
        base_result = {
            "status": "unavailable",
            "depth_type": "relative",
            "metric": False,
            "preview_ref": None,
            "warnings": ["Relative depth only; not a measurement in millimetres."],
        }

        if not self._loaded or self._model is None:
            return base_result

        try:
            depth_np = self._infer_depth_map(rgb)
            if not np.isfinite(depth_np).all():
                return {
                    **base_result,
                    "status": "low_quality",
                    "warnings": base_result["warnings"] + ["Depth map contains non-finite values."],
                }

            # Quality check: flat map
            depth_std = float(np.std(depth_np))
            zeros_fraction = float(np.sum(depth_np == 0) / depth_np.size) if depth_np.size > 0 else 1.0

            status = "ok"
            warnings = ["Relative depth only; not a measurement in millimetres."]
            if depth_std < _FLAT_DEPTH_STD_THRESHOLD or zeros_fraction > 0.9:
                status = "low_quality"
                warnings.append(f"Depth map appears flat (std={depth_std:.4f}, zeros={zeros_fraction:.2%})")

            # Return statistics only — no raw tensors
            return {
                "status": status,
                "depth_type": "relative",
                "metric": False,
                "preview_ref": None,
                "warnings": warnings,
            }

        except ImportError as exc:
            logger.warning("torchvision not installed: %s", exc)
            return {**base_result, "warnings": base_result["warnings"] + [f"torchvision unavailable: {exc}"]}
        except RuntimeError as exc:
            msg = str(exc).lower()
            warn = base_result["warnings"] + [f"Runtime error during depth estimation: {exc}"]
            if "out of memory" in msg:
                warn.append("OOM during depth inference")
            return {**base_result, "warnings": warn}
        except Exception as exc:
            return {**base_result, "warnings": base_result["warnings"] + [f"Depth inference error: {exc}"]}

    def _infer_depth_map(self, rgb: np.ndarray) -> np.ndarray:
        """Run official Depth Anything V2 preprocessing and return source-sized relative depth."""
        import torch  # type: ignore
        import cv2  # type: ignore
        from torchvision.transforms import Compose  # type: ignore
        from depth_anything_v2.util.transform import NormalizeImage, PrepareForNet, Resize  # type: ignore

        transform = Compose([
            Resize(
                width=518,
                height=518,
                resize_target=False,
                keep_aspect_ratio=True,
                ensure_multiple_of=14,
                resize_method="lower_bound",
                image_interpolation_method=cv2.INTER_CUBIC,
            ),
            NormalizeImage(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            PrepareForNet(),
        ])
        image = rgb.astype(np.float32) / 255.0
        inp = torch.from_numpy(transform({"image": image})["image"]).unsqueeze(0).to(self._device)

        with torch.inference_mode():
            depth_tensor = self._model(inp)

        if isinstance(depth_tensor, (tuple, list)):
            depth_tensor = depth_tensor[0]

        depth_tensor = torch.nn.functional.interpolate(
            depth_tensor.unsqueeze(1),
            size=rgb.shape[:2],
            mode="bilinear",
            align_corners=True,
        ).squeeze(1)
        return depth_tensor.squeeze().cpu().numpy()
