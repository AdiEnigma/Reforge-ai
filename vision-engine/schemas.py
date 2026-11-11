"""
schemas.py — Pydantic v2 request/response models for the ReForge AI Vision Engine.
Schema version: 1.0
Conforms to Section 4.5 of ReForge Vision Pipeline Integration Specification.
"""
from __future__ import annotations

from typing import Any, List, Optional
from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ImageInput(BaseModel):
    """A single image to process, encoded as base64."""
    data: str = Field(..., description="Base64-encoded image bytes (no data-URI prefix)")
    mimeType: str = Field(..., description="MIME type, e.g. image/jpeg, image/png, image/webp")
    image_index: int = Field(..., ge=0, description="Zero-based index; preserved in output")

    @field_validator("mimeType")
    @classmethod
    def validate_mime(cls, v: str) -> str:
        allowed = {"image/jpeg", "image/png", "image/webp"}
        if v not in allowed:
            raise ValueError(f"mimeType must be one of {allowed}, got {v!r}")
        return v


class ReferenceInput(BaseModel):
    """Optional reference dimensions (all values in mm provided by caller)."""
    known_width_mm: Optional[float] = Field(None, gt=0)
    known_height_mm: Optional[float] = Field(None, gt=0)
    known_diameter_mm: Optional[float] = Field(None, gt=0)
    outerDiameter: Optional[float] = Field(None, gt=0)
    innerDiameter: Optional[float] = Field(None, gt=0)
    height: Optional[float] = Field(None, gt=0)
    thickness: Optional[float] = Field(None, gt=0)
    width: Optional[float] = Field(None, gt=0)
    length: Optional[float] = Field(None, gt=0)
    extra: Optional[dict[str, float]] = Field(None)


class ProcessRequest(BaseModel):
    """Top-level request payload."""
    images: List[ImageInput] = Field(..., min_length=1, max_length=8)
    reference: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class Quality(BaseModel):
    """Per-image quality metrics."""
    blur_score: float = Field(..., description="Laplacian variance — higher = sharper")
    contrast_score: float = Field(..., description="Grayscale standard deviation")
    clipped_fraction: float = Field(..., ge=0.0, le=1.0, description="Fraction of near-black/white pixels")
    foreground_occupancy: float = Field(0.0, ge=0.0, le=1.0, description="Estimated foreground fraction via Otsu")


class SegmentationResult(BaseModel):
    """SAM2 segmentation result."""
    status: str = Field(..., description="ok | low_confidence | needs_user_selection | unavailable")
    bbox_xyxy_px: Optional[List[float]] = Field(None, description="[x1, y1, x2, y2] in pixels")
    mask_area_ratio: Optional[float] = Field(None, ge=0.0, le=1.0)
    candidate_count: int = Field(0)
    score: Optional[float] = Field(None)
    needs_user_selection: bool = False
    preview_ref: Optional[str] = None
    warnings: List[str] = Field(default_factory=list)


class ContourFeature(BaseModel):
    type: str
    image_index: int
    points_px: List[List[float]]
    area_px2: float
    perimeter_px: float
    circularity: float
    solidity: float
    hierarchy_level: int
    confidence: float
    provenance: str = "opencv"
    warnings: List[str] = Field(default_factory=list)


class CircleCandidate(BaseModel):
    type: str = "circle_candidate"
    image_index: int
    cx_px: float
    cy_px: float
    radius_px: float
    confidence: float
    provenance: str = "opencv"
    warnings: List[str] = Field(default_factory=list)


class EllipseCandidate(BaseModel):
    type: str = "ellipse_candidate"
    image_index: int
    cx_px: float
    cy_px: float
    axes_px: List[float]
    angle_deg: float
    confidence: float
    provenance: str = "opencv"
    warnings: List[str] = Field(default_factory=list)


class LineCandidate(BaseModel):
    type: str = "line_candidate"
    image_index: int
    x1_px: float
    y1_px: float
    x2_px: float
    y2_px: float
    length_px: float
    angle_deg: float
    confidence: float
    provenance: str = "opencv"
    warnings: List[str] = Field(default_factory=list)


class BoundingBox(BaseModel):
    axis_aligned: Optional[List[float]] = Field(None, description="[x, y, w, h]")
    rotated_center_px: Optional[List[float]] = None
    rotated_size_px: Optional[List[float]] = None
    rotated_angle_deg: Optional[float] = None


class SymmetryHint(BaseModel):
    bilateral: bool = False
    rotational: bool = False
    rotational_order: Optional[int] = None


class OpenCVResult(BaseModel):
    """All OpenCV-extracted geometric features (pixels only — never mm)."""
    contours: List[ContourFeature] = Field(default_factory=list)
    circles: List[CircleCandidate] = Field(default_factory=list)
    ellipses: List[EllipseCandidate] = Field(default_factory=list)
    lines: List[LineCandidate] = Field(default_factory=list)
    bounding_box: Optional[BoundingBox] = None
    symmetry_hints: Optional[SymmetryHint] = None
    warnings: List[str] = Field(default_factory=list)


class DepthResult(BaseModel):
    """Depth Anything V2 result. ALWAYS relative — never metric."""
    status: str = Field(..., description="ok | low_quality | unavailable")
    depth_type: str = Field("relative", description="Always 'relative'")
    metric: bool = Field(False, description="Always False — relative depth only; not a measurement in mm")
    preview_ref: Optional[str] = Field(None, description="No large tensors in API responses")
    warnings: List[str] = Field(default_factory=lambda: ["Relative depth only; not a measurement in millimetres."])


class CalibrationResult(BaseModel):
    """Pixel-to-mm calibration state."""
    status: str = Field("uncalibrated", description="uncalibrated | calibrated | ambiguous")
    mm_per_pixel: Optional[float] = None
    source: Optional[str] = None
    confidence: float = 0.0
    warnings: List[str] = Field(default_factory=list)


class ImageResult(BaseModel):
    """Full processing result for a single image, matching Section 4.5."""
    image_index: int
    width: int
    height: int
    orientation_applied: bool = False
    quality: Quality
    segmentation: SegmentationResult
    opencv: OpenCVResult
    depth: DepthResult
    calibration: CalibrationResult = Field(default_factory=CalibrationResult)
    warnings: List[str] = Field(default_factory=list)

    # Backwards-compatible aliases if callers request them
    @property
    def original_width(self) -> int:
        return self.width

    @property
    def original_height(self) -> int:
        return self.height

    @property
    def opencv_features(self) -> OpenCVResult:
        return self.opencv


class DeviceInfo(BaseModel):
    requested: str = "auto"
    actual: str = "cpu"
    sam2_loaded: bool = False
    depth_loaded: bool = False


class ProcessResponse(BaseModel):
    """Top-level response from /process."""
    schema_version: str = Field("1.0", description="Schema version")
    status: str = Field(..., description="ok | partial | unavailable | needs_review")
    device: DeviceInfo
    images: List[ImageResult]
    warnings: List[str] = Field(default_factory=list)
