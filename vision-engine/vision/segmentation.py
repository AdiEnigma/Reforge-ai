"""
segmentation.py — SAM2 wrapper with lazy loading and graceful fallback.

SAM2 may not be installed in all environments. All ImportErrors and missing
checkpoint errors are caught and surfaced as status="unavailable".
"""
from __future__ import annotations

import logging
import warnings
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_LOW_CONFIDENCE_THRESHOLD = 0.7
_AMBIGUITY_SCORE_DELTA = 0.1
_MIN_COMPONENT_AREA_RATIO = 0.001  # 0.1% of image — smaller components removed


class SAM2Segmentor:
    """Lazy-loaded SAM2 segmentor. Instantiate once; call load() before segment()."""

    def __init__(self) -> None:
        self._predictor = None
        self._mask_generator = None
        self._loaded = False
        self._device: str = "cpu"

    # ------------------------------------------------------------------
    def load(self, device: str) -> bool:
        """
        Lazy load SAM2 models.

        Args:
            device: "cpu", "cuda", "mps", or "auto"

        Returns:
            True if loaded successfully, False if unavailable.
        """
        import os
        import config

        self._device = device

        checkpoint_path = os.path.join(config.VISION_MODELS_DIR, config.SAM2_CHECKPOINT_FILENAME)
        config_path = config.SAM2_CONFIG_FILENAME

        try:
            import torch  # type: ignore

            # Resolve device
            if device == "auto":
                if torch.cuda.is_available():
                    resolved = "cuda"
                else:
                    resolved = "cpu"
            else:
                resolved = device
            self._device = resolved

            from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore
            from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # type: ignore

            if not os.path.isfile(checkpoint_path):
                logger.warning("SAM2 checkpoint not found at %s", checkpoint_path)
                return False

            # Build predictor from local checkpoint
            self._predictor = SAM2ImagePredictor.from_pretrained(
                model_id=None,
                # fall back to building from local files if from_pretrained not available
            )
        except TypeError:
            # from_pretrained may not accept None — try alternative approach
            try:
                from sam2.build_sam import build_sam2  # type: ignore
                sam_model = build_sam2(config_path, checkpoint_path, device=self._device)
                from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore
                self._predictor = SAM2ImagePredictor(sam_model)
                from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # type: ignore
                self._mask_generator = SAM2AutomaticMaskGenerator(sam_model)
                self._loaded = True
                return True
            except Exception as exc:
                logger.warning("SAM2 load failed (alternative): %s", exc)
                return False
        except ImportError as exc:
            logger.warning("SAM2 not installed: %s", exc)
            return False
        except FileNotFoundError as exc:
            logger.warning("SAM2 checkpoint missing: %s", exc)
            return False
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower() or "oom" in str(exc).lower():
                logger.warning("SAM2 OOM during load: %s", exc)
            else:
                logger.warning("SAM2 RuntimeError during load: %s", exc)
            return False
        except Exception as exc:
            logger.warning("SAM2 load failed: %s", exc)
            return False

        self._loaded = True
        return True

    # ------------------------------------------------------------------
    def segment(self, rgb: np.ndarray, hint=None) -> dict:
        """
        Segment the primary subject in an RGB image.

        Args:
            rgb:  np.ndarray (H, W, 3) uint8
            hint: optional point/box hint (currently unused — auto mode)

        Returns:
            dict with keys:
                status              : "ok" | "low_confidence" | "unavailable" | "ambiguous"
                bbox_xyxy_px        : list[float] | None
                mask_area_ratio     : float | None
                candidate_count     : int
                score               : float | None
                needs_user_selection: bool
                warnings            : list[str]
        """
        result_base = {
            "status": "unavailable",
            "bbox_xyxy_px": None,
            "mask_area_ratio": None,
            "candidate_count": 0,
            "score": None,
            "needs_user_selection": False,
            "warnings": [],
        }

        if not self._loaded or self._mask_generator is None:
            result_base["warnings"].append("SAM2 not available; segmentation skipped")
            return result_base

        try:
            import torch  # type: ignore

            # Choose autocast context — only on cuda/mps
            use_autocast = self._device in ("cuda", "mps")

            with torch.inference_mode():
                if use_autocast:
                    dtype = torch.float16 if self._device == "cuda" else torch.bfloat16
                    with torch.autocast(self._device, dtype=dtype):
                        masks = self._mask_generator.generate(rgb)
                else:
                    masks = self._mask_generator.generate(rgb)

        except RuntimeError as exc:
            msg = str(exc).lower()
            if "out of memory" in msg or "oom" in msg:
                result_base["warnings"].append("SAM2 OOM during inference; segmentation skipped")
            else:
                result_base["warnings"].append(f"SAM2 RuntimeError: {exc}")
            return result_base
        except Exception as exc:
            result_base["warnings"].append(f"SAM2 inference error: {exc}")
            return result_base

        if not masks:
            return {
                **result_base,
                "status": "low_confidence",
                "warnings": ["SAM2 returned no masks"],
            }

        # Sort by score descending
        masks_sorted = sorted(masks, key=lambda m: m.get("predicted_iou", 0.0), reverse=True)
        best = masks_sorted[0]
        best_score = float(best.get("predicted_iou", 0.0))

        h, w = rgb.shape[:2]
        total_pixels = h * w

        # Post-process: remove tiny components (< 0.1% of image area)
        seg_mask = best.get("segmentation")
        bbox_area_ratio = None
        bbox_xyxy = None
        if seg_mask is not None:
            import cv2  # type: ignore
            mask_uint8 = seg_mask.astype(np.uint8) * 255
            # Remove small isolated components
            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_uint8, connectivity=8)
            min_area_px = _MIN_COMPONENT_AREA_RATIO * total_pixels
            clean_mask = np.zeros_like(mask_uint8)
            for lbl in range(1, num_labels):
                if stats[lbl, cv2.CC_STAT_AREA] >= min_area_px:
                    clean_mask[labels == lbl] = 255
            # Bounding box from clean mask
            ys, xs = np.where(clean_mask > 0)
            if len(xs) > 0:
                x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
                bbox_xyxy = [float(x1), float(y1), float(x2), float(y2)]
                bbox_area_ratio = float(np.sum(clean_mask > 0) / total_pixels)

        # Determine status
        needs_selection = False
        if len(masks_sorted) >= 2:
            second_score = float(masks_sorted[1].get("predicted_iou", 0.0))
            if abs(best_score - second_score) < _AMBIGUITY_SCORE_DELTA:
                needs_selection = True

        status = "ok"
        warnings_out = []
        if best_score < _LOW_CONFIDENCE_THRESHOLD:
            status = "low_confidence"
            warnings_out.append(f"Best mask score {best_score:.3f} below threshold {_LOW_CONFIDENCE_THRESHOLD}")
        elif needs_selection:
            status = "ambiguous"
            warnings_out.append("Multiple candidate masks with similar scores; user selection recommended")

        return {
            "status": status,
            "bbox_xyxy_px": bbox_xyxy,
            "mask_area_ratio": bbox_area_ratio,
            "candidate_count": len(masks_sorted),
            "score": best_score,
            "needs_user_selection": needs_selection,
            "warnings": warnings_out,
        }
