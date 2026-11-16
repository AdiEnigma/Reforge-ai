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

            if not os.path.isfile(checkpoint_path):
                logger.warning("SAM2 checkpoint not found at %s", checkpoint_path)
                return False

            from sam2.build_sam import build_sam2  # type: ignore
            from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore
            from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # type: ignore

            sam_model = build_sam2(config_path, checkpoint_path, device=self._device)
            self._predictor = SAM2ImagePredictor(sam_model)
            self._mask_generator = SAM2AutomaticMaskGenerator(sam_model)
            self._loaded = True
            return True
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
    def _predict_with_hint(self, rgb: np.ndarray, hint: dict) -> list:
        """Run the prompted predictor using a point and/or box hint."""
        import numpy as np  # type: ignore

        self._predictor.set_image(rgb)
        box = hint.get("box")
        # A box already pins the object, so ask SAM2 for a single mask; point-only
        # prompts keep multimask output so callers can pick a granularity.
        kwargs = {"multimask_output": box is None}

        points = hint.get("points")
        if points is None and hint.get("point") is not None:
            points = [hint["point"]]
        if points:
            point_array = np.array(points, dtype=np.float32)
            if point_array.ndim == 1:
                point_array = point_array.reshape(1, 2)
            labels = hint.get("labels")
            label_array = (
                np.array(labels, dtype=np.int32)
                if labels
                else np.ones(len(point_array), dtype=np.int32)
            )
            kwargs["point_coords"] = point_array
            kwargs["point_labels"] = label_array

        box = hint.get("box")
        if box is not None:
            kwargs["box"] = np.array(box, dtype=np.float32)

        masks, scores, _ = self._predictor.predict(**kwargs)
        if masks is None:
            return []
        if masks.ndim == 2:
            masks = masks[None, ...]
        score_array = np.atleast_1d(scores) if scores is not None else None
        results = []
        for index, mask in enumerate(masks):
            score = (
                float(score_array[index])
                if score_array is not None and index < len(score_array)
                else _LOW_CONFIDENCE_THRESHOLD
            )
            results.append({"segmentation": mask, "predicted_iou": score})
        return results

    # ------------------------------------------------------------------
    def segment(self, rgb: np.ndarray, hint=None) -> dict:
        """
        Segment the primary subject in an RGB image.

        Args:
            rgb:  np.ndarray (H, W, 3) uint8
            hint: optional {"point": [x, y] | "points": [[x, y], ...], "labels": [...], "box": [x1, y1, x2, y2]}

        On CPU the full-grid automatic mask generator is skipped (too slow and
        unreliable); a prompted predictor is used when a hint is supplied. On
        CUDA/MPS auto mode remains available.

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

        if not self._loaded or self._predictor is None:
            result_base["warnings"].append("SAM2 not available; segmentation skipped")
            return result_base

        hint = hint if isinstance(hint, dict) else {}
        has_hint = bool(hint.get("point") or hint.get("points") or hint.get("box"))
        cpu_without_hint = self._device == "cpu" and not has_hint

        if cpu_without_hint:
            result_base["warnings"].append(
                "SAM2 automatic mode is disabled on CPU; segmentation skipped (no prompt available)."
            )
            return result_base

        try:
            import torch  # type: ignore

            use_autocast = self._device in ("cuda", "mps")
            with torch.inference_mode():
                if use_autocast:
                    dtype = torch.float16 if self._device == "cuda" else torch.bfloat16
                    with torch.autocast(self._device, dtype=dtype):
                        masks = (
                            self._predict_with_hint(rgb, hint)
                            if has_hint
                            else self._mask_generator.generate(rgb)
                        )
                else:
                    masks = (
                        self._predict_with_hint(rgb, hint)
                        if has_hint
                        else self._mask_generator.generate(rgb)
                    )
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
            mask_uint8 = np.asarray(seg_mask).astype(np.uint8)
            if mask_uint8.max() <= 1:
                mask_uint8 = mask_uint8 * 255
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
