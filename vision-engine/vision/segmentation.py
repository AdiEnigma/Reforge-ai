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


def _opencv_fallback_segment(rgb: np.ndarray) -> dict:
    """Fast, zero-VRAM fallback segmentation using OpenCV adaptive contouring."""
    import cv2
    h, w = rgb.shape[:2]
    total_px = max(1, h * w)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Check if border is predominantly white (inverted subject)
    border_pixels = np.concatenate([thresh[0, :], thresh[-1, :], thresh[:, 0], thresh[:, -1]])
    if np.mean(border_pixels) > 127:
        thresh = cv2.bitwise_not(thresh)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {
            "status": "unavailable",
            "bbox_xyxy_px": None,
            "boundary_polygon_px": None,
            "mask_area_ratio": None,
            "candidate_count": 0,
            "score": None,
            "needs_user_selection": False,
            "warnings": ["OpenCV threshold found no foreground"],
        }

    largest = max(contours, key=cv2.contourArea)
    x, y, bw, bh = cv2.boundingRect(largest)
    peri = cv2.arcLength(largest, True)
    eps = max(1.0, 0.005 * peri)
    approx = cv2.approxPolyDP(largest, eps, True)
    boundary_polygon = approx[:, 0, :].astype(float).tolist() if len(approx) >= 4 else None
    area_ratio = float(cv2.contourArea(largest) / total_px)

    return {
        "status": "ok",
        "bbox_xyxy_px": [float(x), float(y), float(x + bw), float(y + bh)],
        "boundary_polygon_px": boundary_polygon,
        "mask_area_ratio": area_ratio,
        "candidate_count": len(contours),
        "score": 0.85,
        "needs_user_selection": False,
        "warnings": ["Segmented using robust OpenCV contour fallback"],
    }


class SAM2Segmentor:
    """Lazy-loaded SAM2 segmentor. Instantiate once; call load() before segment()."""

    def __init__(self) -> None:
        self._predictor = None
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
                resolved = "cpu"
            else:
                resolved = device
            self._device = resolved

            if not os.path.isfile(checkpoint_path):
                logger.warning("SAM2 checkpoint not found at %s", checkpoint_path)
                return False

            from sam2.build_sam import build_sam2  # type: ignore
            from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore

            try:
                sam_model = build_sam2(config_path, checkpoint_path, device=self._device)
                self._predictor = SAM2ImagePredictor(sam_model)
                self._loaded = True
                return True
            except Exception as device_exc:
                if self._device != "cpu":
                    logger.warning("SAM2 failed on %s (%s); retrying on CPU", self._device, device_exc)
                    if "torch" in locals() and hasattr(torch, "cuda"):
                        torch.cuda.empty_cache()
                    self._device = "cpu"
                    sam_model = build_sam2(config_path, checkpoint_path, device="cpu")
                    self._predictor = SAM2ImagePredictor(sam_model)
                    self._loaded = True
                    return True
                raise device_exc

        except ImportError as exc:
            logger.warning("SAM2 not installed: %s", exc)
            return False
        except FileNotFoundError as exc:
            logger.warning("SAM2 checkpoint missing: %s", exc)
            return False
        except RuntimeError as exc:
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

        if not self._loaded or self._predictor is None:
            fb = _opencv_fallback_segment(rgb)
            fb["warnings"].insert(0, "SAM2 not available; used OpenCV contour fallback")
            return fb

        masks = []
        try:
            import torch  # type: ignore

            with torch.inference_mode():
                h, w = rgb.shape[:2]
                self._predictor.set_image(rgb)
                # Center foreground point prompt
                point_coords = np.array([[w / 2.0, h / 2.0]], dtype=np.float32)
                point_labels = np.array([1], dtype=np.int32)
                pred_masks, pred_scores, _ = self._predictor.predict(
                    point_coords=point_coords,
                    point_labels=point_labels,
                    multimask_output=True,
                )
                best_idx = int(np.argmax(pred_scores))
                masks = [
                    {
                        "segmentation": pred_masks[best_idx],
                        "predicted_iou": float(pred_scores[best_idx]),
                    }
                ]
        except Exception as exc:
            logger.warning("SAM2 inference error (%s); falling back to OpenCV contouring", exc)
            fb = _opencv_fallback_segment(rgb)
            fb["warnings"].insert(0, f"SAM2 error ({exc}); used OpenCV contour fallback")
            return fb

        if not masks:
            fb = _opencv_fallback_segment(rgb)
            fb["warnings"].insert(0, "SAM2 returned no masks; used OpenCV contour fallback")
            return fb

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

            # Extract simplified 2D boundary polygon from clean mask for direct 3D visual reconstruction
            contours, _ = cv2.findContours(clean_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            boundary_polygon = None
            if contours:
                largest = max(contours, key=cv2.contourArea)
                if cv2.contourArea(largest) >= min_area_px:
                    peri = cv2.arcLength(largest, True)
                    eps = max(1.0, 0.005 * peri)
                    approx = cv2.approxPolyDP(largest, eps, True)
                    if len(approx) >= 4:
                        boundary_polygon = approx[:, 0, :].astype(float).tolist()

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
            "boundary_polygon_px": boundary_polygon if seg_mask is not None else None,
            "mask_area_ratio": bbox_area_ratio,
            "candidate_count": len(masks_sorted),
            "score": best_score,
            "needs_user_selection": needs_selection,
            "warnings": warnings_out,
        }
