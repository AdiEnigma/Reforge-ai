"""
pipeline.py — Orchestrates image_io → quality → segmentation → opencv → depth per image.
Uses asyncio concurrency limits and per-request timeouts.
"""
from __future__ import annotations

import asyncio
import logging
from typing import List, Optional

import numpy as np

import config
from schemas import (
    ImageInput,
    ImageResult,
    ProcessResponse,
    Quality,
    SegmentationResult,
    OpenCVResult,
    DepthResult,
    CalibrationResult,
    DeviceInfo,
    ContourFeature,
    CircleCandidate,
    EllipseCandidate,
    LineCandidate,
    BoundingBox,
    SymmetryHint,
)
from vision.image_io import decode_and_validate_image
from vision.quality import compute_quality
from vision.opencv_features import extract_features
from vision.model_registry import registry

logger = logging.getLogger(__name__)

_semaphore: Optional[asyncio.Semaphore] = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(config.VISION_MAX_CONCURRENCY)
    return _semaphore


def _build_segmentation_result(seg_dict: dict) -> SegmentationResult:
    return SegmentationResult(
        status=seg_dict.get("status", "unavailable"),
        bbox_xyxy_px=seg_dict.get("bbox_xyxy_px"),
        mask_area_ratio=seg_dict.get("mask_area_ratio"),
        candidate_count=seg_dict.get("candidate_count", 0),
        score=seg_dict.get("score"),
        needs_user_selection=seg_dict.get("needs_user_selection", False),
        preview_ref=seg_dict.get("preview_ref"),
        warnings=seg_dict.get("warnings", []),
    )


def _build_opencv_result(cv_dict: dict) -> OpenCVResult:
    contours = [
        ContourFeature(
            type=c["type"],
            image_index=c["image_index"],
            points_px=c["points_px"],
            area_px2=c["area_px2"],
            perimeter_px=c["perimeter_px"],
            circularity=c["circularity"],
            solidity=c["solidity"],
            hierarchy_level=c["hierarchy_level"],
            confidence=c["confidence"],
            provenance=c.get("provenance", "opencv"),
            warnings=c.get("warnings", []),
        )
        for c in cv_dict.get("contours", [])
    ]
    circles = [
        CircleCandidate(
            type=c.get("type", "circle_candidate"),
            image_index=c["image_index"],
            cx_px=c["cx_px"],
            cy_px=c["cy_px"],
            radius_px=c["radius_px"],
            confidence=c["confidence"],
            provenance=c.get("provenance", "opencv"),
            warnings=c.get("warnings", []),
        )
        for c in cv_dict.get("circles", [])
    ]
    ellipses = [
        EllipseCandidate(
            type=c.get("type", "ellipse_candidate"),
            image_index=c["image_index"],
            cx_px=c["cx_px"],
            cy_px=c["cy_px"],
            axes_px=c["axes_px"],
            angle_deg=c["angle_deg"],
            confidence=c["confidence"],
            provenance=c.get("provenance", "opencv"),
            warnings=c.get("warnings", []),
        )
        for c in cv_dict.get("ellipses", [])
    ]
    lines = [
        LineCandidate(
            type=c.get("type", "line_candidate"),
            image_index=c["image_index"],
            x1_px=c["x1_px"],
            y1_px=c["y1_px"],
            x2_px=c["x2_px"],
            y2_px=c["y2_px"],
            length_px=c["length_px"],
            angle_deg=c["angle_deg"],
            confidence=c["confidence"],
            provenance=c.get("provenance", "opencv"),
            warnings=c.get("warnings", []),
        )
        for c in cv_dict.get("lines", [])
    ]
    bb_raw = cv_dict.get("bounding_box")
    bounding_box = None
    if bb_raw:
        bounding_box = BoundingBox(
            axis_aligned=bb_raw.get("axis_aligned"),
            rotated_center_px=bb_raw.get("rotated_center_px"),
            rotated_size_px=bb_raw.get("rotated_size_px"),
            rotated_angle_deg=bb_raw.get("rotated_angle_deg"),
        )
    sh_raw = cv_dict.get("symmetry_hints")
    symmetry_hints = None
    if sh_raw:
        symmetry_hints = SymmetryHint(
            bilateral=sh_raw.get("bilateral", False),
            rotational=sh_raw.get("rotational", False),
            rotational_order=sh_raw.get("rotational_order"),
        )
    return OpenCVResult(
        contours=contours,
        circles=circles,
        ellipses=ellipses,
        lines=lines,
        bounding_box=bounding_box,
        symmetry_hints=symmetry_hints,
        warnings=cv_dict.get("warnings", []),
    )


def _build_depth_result(depth_dict: dict) -> DepthResult:
    warnings = depth_dict.get("warnings") or ["Relative depth only; not a measurement in millimetres."]
    return DepthResult(
        status=depth_dict.get("status", "unavailable"),
        depth_type=depth_dict.get("depth_type", "relative"),
        metric=False,  # strictly non-metric
        preview_ref=depth_dict.get("preview_ref"),
        warnings=warnings,
    )


_MIN_CALIBRATION_CONFIDENCE = 0.35
_MIN_CIRCLE_DIAMETER_PX = 5.0
_MIN_MM_PER_PIXEL = 1e-5
_MAX_MM_PER_PIXEL = 1e3

# Reference keys that describe a physical length in millimetres.
_OUTER_DIAMETER_KEYS = ("outerDiameter", "known_diameter_mm")
_INNER_DIAMETER_KEYS = ("innerDiameter",)
_BBOX_LENGTH_KEYS = ("width", "known_width_mm", "height", "known_height_mm")
_DIAMETER_BBOX_KEYS = ("outerDiameter", "known_diameter_mm", "length", "known_height_mm", "height")


def _positive_float(value) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) and number > 0 else None


def _first_reference(reference: dict, keys) -> Optional[float]:
    for key in keys:
        value = _positive_float(reference.get(key))
        if value is not None:
            return value
    return None


def _valid_scale(mm_per_px: float) -> bool:
    return _MIN_MM_PER_PIXEL <= mm_per_px <= _MAX_MM_PER_PIXEL


def _rank_circles(circles: list) -> list:
    """Return usable circles sorted largest-radius first."""
    usable = []
    for circle in circles:
        radius = _positive_float(circle.get("radius_px"))
        if radius is None or radius * 2.0 < _MIN_CIRCLE_DIAMETER_PX:
            continue
        usable.append(
            {
                "radius_px": radius,
                "confidence": _positive_float(circle.get("confidence")) or 0.5,
            }
        )
    usable.sort(key=lambda item: item["radius_px"], reverse=True)
    return usable


def _circle_confidence(circle: dict, ranked: list) -> float:
    confidence = float(circle["confidence"])
    if len(ranked) >= 2:
        ratio = ranked[0]["radius_px"] / max(ranked[1]["radius_px"], 1e-6)
        # A clearly dominant outer circle is a more reliable calibration anchor.
        confidence += 0.05 if ratio >= 1.25 else -0.1
    if len(ranked) > 6:
        confidence -= 0.05
    return round(max(0.0, min(0.95, confidence)), 3)


def _calibrate_from_circles(
    known_mm: float, circles: list, prefer: str
) -> Optional[CalibrationResult]:
    ranked = _rank_circles(circles)
    if not ranked:
        return None
    circle = ranked[0] if prefer == "outer" else ranked[-1]
    diameter_px = 2.0 * circle["radius_px"]
    if diameter_px < _MIN_CIRCLE_DIAMETER_PX:
        return None
    mm_per_px = known_mm / diameter_px
    if not _valid_scale(mm_per_px):
        return None
    confidence = _circle_confidence(circle, ranked)
    if confidence < _MIN_CALIBRATION_CONFIDENCE:
        return None
    return CalibrationResult(
        status="calibrated",
        mm_per_pixel=round(mm_per_px, 6),
        source=f"{prefer}_diameter_to_circle",
        confidence=confidence,
        warnings=[],
    )


def _calibrate_from_bbox(
    known_mm: float, seg_dict: Optional[dict], cv_dict: dict, source_key: str
) -> Optional[CalibrationResult]:
    span_px = None
    if isinstance(seg_dict, dict):
        bbox = seg_dict.get("bbox_xyxy_px")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            width = abs(float(bbox[2]) - float(bbox[0]))
            height = abs(float(bbox[3]) - float(bbox[1]))
            span_px = max(width, height) or None
    if span_px is None:
        bbox = cv_dict.get("bounding_box") or {}
        axis_aligned = bbox.get("axis_aligned") if isinstance(bbox, dict) else None
        if isinstance(axis_aligned, (list, tuple)) and len(axis_aligned) >= 4:
            span_px = max(float(axis_aligned[2]), float(axis_aligned[3])) or None
    if span_px is None or span_px < _MIN_CIRCLE_DIAMETER_PX:
        return None
    mm_per_px = known_mm / span_px
    if not _valid_scale(mm_per_px):
        return None
    return CalibrationResult(
        status="calibrated",
        mm_per_pixel=round(mm_per_px, 6),
        source=f"{source_key}_to_bbox",
        confidence=0.45,
        warnings=["Calibration derived from the segmented bounding box; less precise than a circle match."],
    )


def _estimate_calibration(
    reference: Optional[dict],
    cv_dict: dict,
    seg_dict: Optional[dict] = None,
) -> CalibrationResult:
    """
    Attempt pixel-to-mm calibration from a user-provided known dimension.

    Preference order:
      1. Known outer diameter vs the largest concentric circle (bolt holes no
         longer break calibration — the outer circle wins).
      2. Known inner diameter vs the smallest reliable circle.
      3. Known linear size vs the segmented / OpenCV bounding box.

    Returns ``status="uncalibrated"`` when no reliable match exists.
    """
    if not reference or not isinstance(reference, dict):
        return CalibrationResult(status="uncalibrated", confidence=0.0)

    circles = cv_dict.get("circles", []) if isinstance(cv_dict, dict) else []

    known_outer = _first_reference(reference, _OUTER_DIAMETER_KEYS)
    if known_outer is not None:
        result = _calibrate_from_circles(known_outer, circles, prefer="outer")
        if result is not None:
            return result

    known_inner = _first_reference(reference, _INNER_DIAMETER_KEYS)
    if known_inner is not None:
        result = _calibrate_from_circles(known_inner, circles, prefer="inner")
        if result is not None:
            return result

    for key in _DIAMETER_BBOX_KEYS + _BBOX_LENGTH_KEYS:
        known = _positive_float(reference.get(key))
        if known is None:
            continue
        result = _calibrate_from_bbox(known, seg_dict, cv_dict, key)
        if result is not None:
            return result

    return CalibrationResult(
        status="uncalibrated",
        mm_per_pixel=None,
        source=None,
        confidence=0.0,
        warnings=["No reliable single-view reference calibration match found; uncalibrated."],
    )


def _derive_segmentation_hint(rgb: np.ndarray) -> Optional[dict]:
    """
    Cheap foreground hint for prompted SAM2: the largest external contour from an
    Otsu threshold. Returns a centre point + box, or None when nothing sensible
    is found. Keeps CPU SAM2 usable without the slow automatic mask generator.
    """
    try:
        import cv2  # type: ignore

        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        image_area = float(rgb.shape[0] * rgb.shape[1])
        best = None
        # Evaluate both polarities: parts can be darker or lighter than the
        # background. Reject near-full-frame contours (uniform background).
        for mode in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
            _, thresh = cv2.threshold(blurred, 0, 255, mode + cv2.THRESH_OTSU)
            contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                x, y, w, h = cv2.boundingRect(contour)
                ratio = (w * h) / image_area
                if w < 10 or h < 10 or ratio < 0.01 or ratio > 0.85:
                    continue
                area = float(cv2.contourArea(contour))
                if best is None or area > best[0]:
                    best = (area, x, y, w, h)
        if best is None:
            return None
        _, x, y, w, h = best
        return {
            "point": [float(x) + w / 2.0, float(y) + h / 2.0],
            "box": [float(x), float(y), float(x + w), float(y + h)],
        }
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Could not derive segmentation hint: %s", exc)
        return None


def _process_single_image(image_input: ImageInput, reference: Optional[dict]) -> ImageResult:
    """Process a single image end-to-end synchronously."""
    warnings: List[str] = []

    # --- decode & validate ---
    io_result = decode_and_validate_image(image_input)

    rgb: np.ndarray = io_result["rgb"]
    working_rgb: np.ndarray = io_result["working_rgb"]
    orig_w: int = io_result["original_width"]
    orig_h: int = io_result["original_height"]
    scale_x: float = io_result.get("scale_x", 1.0)
    scale_y: float = io_result.get("scale_y", 1.0)

    # --- quality ---
    quality_dict = compute_quality(rgb)
    quality = Quality(**quality_dict)

    # --- segmentation (SAM2) ---
    seg_dict = {
        "status": "unavailable",
        "bbox_xyxy_px": None,
        "mask_area_ratio": None,
        "candidate_count": 0,
        "score": None,
        "needs_user_selection": False,
        "warnings": [],
    }
    if config.VISION_SAM2_ENABLED and registry.sam2_loaded:
        try:
            seg_hint = _derive_segmentation_hint(working_rgb)
            seg_dict = registry.sam2.segment(working_rgb, hint=seg_hint)
            # Scale bbox back to original image coordinates if needed
            if seg_dict.get("bbox_xyxy_px") and (scale_x != 1.0 or scale_y != 1.0):
                x1, y1, x2, y2 = seg_dict["bbox_xyxy_px"]
                seg_dict["bbox_xyxy_px"] = [
                    round(x1 * scale_x, 1),
                    round(y1 * scale_y, 1),
                    round(x2 * scale_x, 1),
                    round(y2 * scale_y, 1),
                ]
        except Exception as exc:
            if config.VISION_FAIL_OPEN:
                warnings.append(f"SAM2 error (fail-open): {exc}")
            else:
                raise

    # --- opencv features ---
    mask: Optional[np.ndarray] = None
    bbox = seg_dict.get("bbox_xyxy_px")
    if bbox and len(bbox) == 4:
        x1, y1, x2, y2 = (int(v) for v in bbox)
        h, w = rgb.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        mask[max(0, y1):min(h, y2), max(0, x1):min(w, x2)] = 255

    cv_dict = extract_features(rgb, mask=mask, image_index=image_input.image_index)

    # --- depth ---
    depth_dict = {
        "status": "unavailable",
        "depth_type": "relative",
        "metric": False,
        "preview_ref": None,
        "warnings": ["Relative depth only; not a measurement in millimetres."],
    }
    if config.VISION_DEPTH_ENABLED and registry.depth_loaded:
        try:
            depth_dict = registry.depth.estimate(working_rgb, mask=mask)
        except Exception as exc:
            if config.VISION_FAIL_OPEN:
                warnings.append(f"Depth error (fail-open): {exc}")
            else:
                raise

    # --- calibration ---
    cal_result = _estimate_calibration(reference, cv_dict, seg_dict)

    return ImageResult(
        image_index=image_input.image_index,
        width=orig_w,
        height=orig_h,
        orientation_applied=io_result["orientation_applied"],
        quality=quality,
        segmentation=_build_segmentation_result(seg_dict),
        opencv=_build_opencv_result(cv_dict),
        depth=_build_depth_result(depth_dict),
        calibration=cal_result,
        warnings=warnings,
    )


def _make_error_result(image_index: int, error_msg: str) -> ImageResult:
    """Create a minimal ImageResult for a failed image."""
    return ImageResult(
        image_index=image_index,
        width=0,
        height=0,
        orientation_applied=False,
        quality=Quality(blur_score=0.0, contrast_score=0.0, clipped_fraction=0.0, foreground_occupancy=0.0),
        segmentation=SegmentationResult(status="unavailable", warnings=[error_msg]),
        opencv=OpenCVResult(warnings=[error_msg]),
        depth=DepthResult(
            status="unavailable",
            depth_type="relative",
            metric=False,
            warnings=["Relative depth only; not a measurement in millimetres.", error_msg],
        ),
        calibration=CalibrationResult(status="uncalibrated"),
        warnings=[error_msg],
    )


async def process_images(
    images: List[ImageInput],
    reference: Optional[dict] = None,
) -> ProcessResponse:
    """
    Orchestrate processing for all images in the request.
    Preserves original image_index order in output.
    """
    registry.initialize()

    sem = _get_semaphore()
    warnings: List[str] = []
    loop = asyncio.get_running_loop()

    async def _run_one(img_input: ImageInput) -> ImageResult:
        async with sem:
            try:
                return await asyncio.wait_for(
                    loop.run_in_executor(None, _process_single_image, img_input, reference),
                    timeout=config.VISION_REQUEST_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                raise TimeoutError(
                    f"Image {img_input.image_index} timed out after {config.VISION_REQUEST_TIMEOUT_SECONDS}s"
                )

    tasks = [_run_one(img) for img in images]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    image_results: List[ImageResult] = []
    for img, result in zip(images, results):
        if isinstance(result, Exception):
            if isinstance(result, ValueError):
                # Input validation errors (bad base64, corrupt bytes, excessive dimensions) raise 4xx
                raise result
            if config.VISION_FAIL_OPEN:
                warnings.append(f"Image {img.image_index} failed: {result}")
                image_results.append(_make_error_result(img.image_index, str(result)))
            else:
                raise result
        else:
            image_results.append(result)

    image_results.sort(key=lambda r: r.image_index)

    overall_status = "ok"
    if any(img.segmentation.status in ("ambiguous", "needs_user_selection") or img.segmentation.needs_user_selection for img in image_results):
        overall_status = "needs_review"
    elif any(img.segmentation.status == "low_confidence" for img in image_results):
        overall_status = "needs_review"
    elif warnings:
        overall_status = "partial"

    return ProcessResponse(
        schema_version="1.0",
        status=overall_status,
        device=DeviceInfo(
            requested=config.VISION_DEVICE,
            actual=registry.device,
            sam2_loaded=registry.sam2_loaded,
            depth_loaded=registry.depth_loaded,
        ),
        images=image_results,
        warnings=warnings,
    )
