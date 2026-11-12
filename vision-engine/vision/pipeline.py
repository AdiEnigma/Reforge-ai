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


def _estimate_calibration(reference: Optional[dict], cv_dict: dict) -> CalibrationResult:
    """
    Attempt pixel-to-mm calibration if user provided known dimensions.
    If ambiguous or unsupported view, remains uncalibrated.
    """
    if not reference or not isinstance(reference, dict):
        return CalibrationResult(status="uncalibrated", confidence=0.0)

    known_diam = reference.get("outerDiameter") or reference.get("known_diameter_mm")
    circles = cv_dict.get("circles", [])

    if known_diam and circles:
        # Check if we have one dominant circle with high confidence
        high_conf_circles = [c for c in circles if c.get("confidence", 0) > 0.8]
        if len(high_conf_circles) == 1:
            r_px = high_conf_circles[0]["radius_px"]
            diam_px = 2.0 * r_px
            if diam_px > 5:
                mm_per_px = float(known_diam) / diam_px
                return CalibrationResult(
                    status="calibrated",
                    mm_per_pixel=round(mm_per_px, 4),
                    source="outerDiameter_to_circle",
                    confidence=0.85,
                    warnings=[]
                )
    
    return CalibrationResult(
        status="uncalibrated",
        mm_per_pixel=None,
        source=None,
        confidence=0.0,
        warnings=["No reliable single-view reference calibration match found; uncalibrated."]
    )


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
            seg_dict = registry.sam2.segment(working_rgb)
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
    cal_result = _estimate_calibration(reference, cv_dict)

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
