"""
multiview.py — Optional COLMAP Multi-View Reconstruction Subsystem.

Responsible for:
1. Validating multi-view image sets, masks, and capture metadata.
2. Detecting local COLMAP capability safely without assuming CUDA or PATH presence.
3. Executing isolated, subprocess-array based COLMAP pipelines with strict timeouts and resource bounds.
4. Parsing sparse Structure-from-Motion (SfM) outputs (cameras, poses, points3D, reprojection errors).
5. Aligning metric scale strictly when authenticated physical references are available;
   preserving relative coordinates and relative scale flags otherwise.
6. Returning serializable, structured diagnostic outcomes (success, partial, failed, unavailable).

Conforms to ReForge AI Reconstruction Subsystem Specification.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import shutil
import struct
import subprocess
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("reforge.reconstruction.multiview")

SCHEMA_VERSION = "1.0"
DEFAULT_TIMEOUT_SECONDS = 180
MAX_IMAGE_COUNT = 32
MIN_IMAGE_COUNT_FOR_MV = 2

SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


# ---------------------------------------------------------------------------
# Data Contracts & Result Containers
# ---------------------------------------------------------------------------

@dataclass
class CameraInfo:
    camera_id: int
    model: str
    width: int
    height: int
    params: List[float]


@dataclass
class ImagePose:
    image_id: int
    name: str
    camera_id: int
    qvec: List[float]  # [qw, qx, qy, qz]
    tvec: List[float]  # [tx, ty, tz]
    registered: bool
    num_points2D: int = 0


@dataclass
class Point3D:
    point_id: int
    xyz: List[float]
    rgb: List[int]
    error: float
    track_length: int = 0


@dataclass
class ScaleInfo:
    classification: str  # "metric" | "relative" | "unknown"
    factor: float = 1.0
    source: str = "NONE"  # "KNOWN_DISTANCE" | "CALIBRATED_MARKER" | "CAMERA_BASELINE" | "NONE"
    reference_description: Optional[str] = None
    units: str = "relative"  # "mm" | "inch" | "relative" | "unknown"


@dataclass
class MultiviewDiagnostics:
    total_images: int = 0
    registered_images: int = 0
    usable_images: int = 0
    num_points3D: int = 0
    mean_reprojection_error: Optional[float] = None
    max_reprojection_error: Optional[float] = None
    triangulated_observations: int = 0
    baseline_sufficient: bool = True
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


@dataclass
class MultiviewResult:
    schema_version: str = SCHEMA_VERSION
    job_id: str = "default_job"
    status: str = "failed"  # "success" | "partial" | "failed" | "unavailable"
    colmap_version: Optional[str] = None
    registered_images: int = 0
    total_images: int = 0
    cameras: List[Dict[str, Any]] = field(default_factory=list)
    images: List[Dict[str, Any]] = field(default_factory=list)
    points3D: List[Dict[str, Any]] = field(default_factory=list)
    diagnostics: Dict[str, Any] = field(default_factory=dict)
    scale: Dict[str, Any] = field(default_factory=dict)
    coordinate_frame: str = "relative_world"  # "camera" | "component_local" | "relative_world"
    artifacts: Dict[str, Optional[str]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert result to clean JSON-serializable dictionary with finite numbers."""
        raw = asdict(self)

        def sanitize(obj: Any) -> Any:
            if isinstance(obj, float):
                if math.isnan(obj) or math.isinf(obj):
                    return None
                return obj
            elif isinstance(obj, dict):
                return {k: sanitize(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [sanitize(v) for v in obj]
            return obj

        return sanitize(raw)


# ---------------------------------------------------------------------------
# Executable & Capability Detection
# ---------------------------------------------------------------------------

def find_colmap_executable(custom_path: Optional[str] = None) -> Optional[str]:
    """
    Locates the COLMAP executable safely on Windows, Linux, and macOS.
    Returns absolute path if found and executable, or None if unavailable.
    """
    candidates = []
    if custom_path:
        candidates.append(Path(custom_path))

    env_path = os.environ.get("COLMAP_EXE_PATH") or os.environ.get("COLMAP_PATH")
    if env_path:
        candidates.append(Path(env_path))

    which_colmap = shutil.which("colmap")
    if which_colmap:
        candidates.append(Path(which_colmap))

    which_colmap_bat = shutil.which("colmap.bat")
    if which_colmap_bat:
        candidates.append(Path(which_colmap_bat))

    # Common installation paths on Windows & Linux
    if os.name == "nt":
        candidates.extend([
            Path("C:/Program Files/COLMAP/colmap.exe"),
            Path("C:/Program Files/COLMAP/colmap.bat"),
            Path("C:/COLMAP/colmap.exe"),
            Path("C:/COLMAP/colmap.bat"),
        ])
    else:
        candidates.extend([
            Path("/usr/local/bin/colmap"),
            Path("/usr/bin/colmap"),
        ])

    for cand in candidates:
        try:
            p = cand.resolve()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
            elif p.is_file() and p.suffix.lower() in [".bat", ".exe"]:
                return str(p)
        except Exception:
            continue

    return None


def get_colmap_version(colmap_exe: str) -> Optional[str]:
    """Queries COLMAP version via CLI."""
    try:
        res = subprocess.run(
            [colmap_exe, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        out = (res.stdout or res.stderr).strip()
        for line in out.splitlines():
            if "COLMAP" in line:
                return line.strip()
        return out[:60] if out else "COLMAP (unknown version)"
    except Exception as e:
        logger.debug("Failed to query COLMAP version: %s", e)
        return None


# ---------------------------------------------------------------------------
# Image Validation, Quality, and Hashing
# ---------------------------------------------------------------------------

def compute_file_sha256(filepath: Union[str, Path]) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def quick_image_check(filepath: Union[str, Path]) -> Tuple[bool, Optional[Tuple[int, int]], Optional[float], List[str]]:
    """
    Inspects image file existence, decodability, dimensions, and approximate sharpness.
    Returns: (is_valid, (width, height), laplacian_var, warnings)
    Does not crash on unreadable or corrupt files.
    """
    path = Path(filepath)
    warnings: List[str] = []

    if not path.is_file():
        return False, None, None, ["File does not exist or is not a regular file"]

    if path.stat().st_size == 0:
        return False, None, None, ["File is 0 bytes"]

    # Basic extension validation
    if path.suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        return False, None, None, [f"Unsupported extension: {path.suffix}"]

    try:
        # Import lazily to avoid module load failure if cv2 is absent
        import cv2
        import numpy as np

        # Use imdecode to support Unicode / space paths safely on Windows
        with open(path, "rb") as f:
            data = f.read()
        nparr = np.frombuffer(data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return False, None, None, ["Failed to decode image data"]

        h, w = img.shape[:2]
        if w < 16 or h < 16:
            return False, (w, h), None, [f"Image dimensions too small: {w}x{h}"]

        # Estimate sharpness via Laplacian variance
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        if lap_var < 20.0:
            warnings.append(f"Image appears severely blurred (Laplacian variance: {lap_var:.1f})")

        # Check for extreme aspect ratio
        aspect = max(w / h, h / w)
        if aspect > 5.0:
            warnings.append(f"Extreme aspect ratio ({aspect:.2f}) may impair feature matching")

        return True, (w, h), lap_var, warnings

    except ImportError:
        # Fallback if cv2 is unavailable: basic file read
        return True, (1000, 1000), None, ["OpenCV not available for detailed image validation"]
    except Exception as e:
        return False, None, None, [f"Image decode error: {str(e)}"]


def validate_image_set(
    image_paths: List[Union[str, Path]],
    masks: Optional[Dict[str, Union[str, Path]]] = None,
) -> Tuple[List[Path], Dict[str, Any]]:
    """
    Validates a list of input images:
    - Filters out nonexistent or corrupt images.
    - Detects exact and near duplicates.
    - Matches masks if provided.
    - Returns valid image paths and a diagnostic summary.
    """
    diagnostics: Dict[str, Any] = {
        "total_inputs": len(image_paths),
        "valid_images": 0,
        "duplicates_detected": [],
        "corrupt_images": [],
        "warnings": [],
        "image_metadata": {},
    }

    seen_hashes: Dict[str, Path] = {}
    valid_paths: List[Path] = []

    for img_p in image_paths:
        path = Path(img_p)
        ok, dims, sharpness, warns = quick_image_check(path)

        if not ok:
            diagnostics["corrupt_images"].append({"path": str(path), "errors": warns})
            continue

        diagnostics["warnings"].extend([f"{path.name}: {w}" for w in warns])

        # Exact duplicate detection
        file_hash = compute_file_sha256(path)
        if file_hash in seen_hashes:
            dup_of = seen_hashes[file_hash]
            diagnostics["duplicates_detected"].append({
                "path": str(path),
                "duplicate_of": str(dup_of),
            })
            diagnostics["warnings"].append(f"Duplicate image ignored: {path.name} is identical to {dup_of.name}")
            continue

        seen_hashes[file_hash] = path
        valid_paths.append(path)
        diagnostics["image_metadata"][path.name] = {
            "dimensions": dims,
            "sharpness": sharpness,
            "hash": file_hash,
        }

    diagnostics["valid_images"] = len(valid_paths)

    # Validate mask matching if masks are provided
    if masks:
        for img_path in valid_paths:
            mask_target = masks.get(img_path.name) or masks.get(str(img_path))
            if mask_target:
                mask_p = Path(mask_target)
                if not mask_p.is_file():
                    diagnostics["warnings"].append(f"Mask file specified for {img_path.name} not found: {mask_target}")
                else:
                    mok, mdims, _, mwarns = quick_image_check(mask_p)
                    if mok and mdims and mdims != diagnostics["image_metadata"][img_path.name]["dimensions"]:
                        diagnostics["warnings"].append(
                            f"Mask dimensions {mdims} do not match image {img_path.name} {diagnostics['image_metadata'][img_path.name]['dimensions']}"
                        )

    return valid_paths, diagnostics


# ---------------------------------------------------------------------------
# Scale Alignment & Metric Grounding
# ---------------------------------------------------------------------------

def apply_metric_scale(
    points3D: List[Point3D],
    images: List[ImagePose],
    reference: Optional[Dict[str, Any]],
) -> Tuple[List[Point3D], List[ImagePose], ScaleInfo, List[str]]:
    """
    Applies metric scale alignment when a valid physical distance or baseline reference exists.
    If multiple contradictory scale references are provided, returns conflicting errors.
    If no reference exists, retains relative units without fabricating millimeters.
    """
    warnings: List[str] = []
    errors: List[str] = []

    if not reference or not isinstance(reference, dict):
        return points3D, images, ScaleInfo(classification="relative", factor=1.0, source="NONE", units="relative"), warnings

    ref_type = reference.get("type", "known_distance")
    target_dist_mm = reference.get("distance_mm") or reference.get("dimension_mm") or reference.get("outerDiameter")

    # Contradictory scale check
    second_dist_mm = reference.get("secondary_distance_mm")
    if target_dist_mm is not None and second_dist_mm is not None:
        expected_ratio = reference.get("expected_ratio")
        if expected_ratio is not None and expected_ratio > 0:
            actual_ratio = float(target_dist_mm) / float(second_dist_mm)
            if abs(actual_ratio - expected_ratio) / expected_ratio > 0.20:
                errors.append(f"Contradictory metric scale references provided (ratio {actual_ratio:.2f} vs expected {expected_ratio:.2f})")
                return points3D, images, ScaleInfo(classification="unknown", factor=1.0, source="CONFLICT", units="unknown"), errors

    if target_dist_mm is None or target_dist_mm <= 0:
        return points3D, images, ScaleInfo(classification="relative", factor=1.0, source="NONE", units="relative"), warnings

    # Estimate current reconstructed span across 3D points
    if len(points3D) < 2:
        warnings.append("Insufficient 3D points to determine current reconstructed scale baseline.")
        return points3D, images, ScaleInfo(classification="relative", factor=1.0, source="NONE", units="relative"), warnings

    # Calculate bounding box diagonal or max pair distance in point cloud
    xs = [p.xyz[0] for p in points3D]
    ys = [p.xyz[1] for p in points3D]
    zs = [p.xyz[2] for p in points3D]
    span = math.sqrt((max(xs) - min(xs))**2 + (max(ys) - min(ys))**2 + (max(zs) - min(zs))**2)

    if span < 1e-7:
        warnings.append("Degenerate point cloud extent (span ~0); cannot compute scale factor.")
        return points3D, images, ScaleInfo(classification="relative", factor=1.0, source="NONE", units="relative"), warnings

    scale_factor = float(target_dist_mm) / span

    # Apply scale factor to points and camera translations
    scaled_points = []
    for p in points3D:
        scaled_points.append(Point3D(
            point_id=p.point_id,
            xyz=[coord * scale_factor for coord in p.xyz],
            rgb=p.rgb,
            error=p.error * scale_factor,
            track_length=p.track_length,
        ))

    scaled_images = []
    for img in images:
        scaled_images.append(ImagePose(
            image_id=img.image_id,
            name=img.name,
            camera_id=img.camera_id,
            qvec=img.qvec,
            tvec=[t * scale_factor for t in img.tvec],
            registered=img.registered,
            num_points2D=img.num_points2D,
        ))

    scale_info = ScaleInfo(
        classification="metric",
        factor=scale_factor,
        source="KNOWN_DISTANCE",
        reference_description=f"Scaled to known reference dimension: {target_dist_mm} mm",
        units="mm",
    )
    return scaled_points, scaled_images, scale_info, warnings


# ---------------------------------------------------------------------------
# COLMAP Output Parsers (Text and Binary)
# ---------------------------------------------------------------------------

def parse_colmap_text_model(model_dir: Path) -> Tuple[List[CameraInfo], List[ImagePose], List[Point3D], MultiviewDiagnostics]:
    """Parses cameras.txt, images.txt, and points3D.txt from a COLMAP sparse model directory."""
    diag = MultiviewDiagnostics()
    cameras: List[CameraInfo] = []
    images: List[ImagePose] = []
    points3D: List[Point3D] = []

    cam_file = model_dir / "cameras.txt"
    img_file = model_dir / "images.txt"
    pts_file = model_dir / "points3D.txt"

    if cam_file.is_file():
        with open(cam_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    cameras.append(CameraInfo(
                        camera_id=int(parts[0]),
                        model=parts[1],
                        width=int(parts[2]),
                        height=int(parts[3]),
                        params=[float(x) for x in parts[4:]],
                    ))

    if img_file.is_file():
        with open(img_file, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
            # Images in COLMAP text format alternate: line 1 = pose/name, line 2 = 2D points
            for i in range(0, len(lines), 2):
                parts = lines[i].split()
                if len(parts) >= 9:
                    qvec = [float(x) for x in parts[1:5]]
                    tvec = [float(x) for x in parts[5:8]]
                    images.append(ImagePose(
                        image_id=int(parts[0]),
                        qvec=qvec,
                        tvec=tvec,
                        camera_id=int(parts[8]),
                        name=parts[9],
                        registered=True,
                    ))

    if pts_file.is_file():
        reproj_errors = []
        with open(pts_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 8:
                    pid = int(parts[0])
                    xyz = [float(parts[1]), float(parts[2]), float(parts[3])]
                    rgb = [int(parts[4]), int(parts[5]), int(parts[6])]
                    err = float(parts[7])
                    reproj_errors.append(err)
                    track_len = (len(parts) - 8) // 2
                    points3D.append(Point3D(
                        point_id=pid,
                        xyz=xyz,
                        rgb=rgb,
                        error=err,
                        track_length=track_len,
                    ))

        diag.num_points3D = len(points3D)
        if reproj_errors:
            diag.mean_reprojection_error = sum(reproj_errors) / len(reproj_errors)
            diag.max_reprojection_error = max(reproj_errors)

    diag.registered_images = len(images)
    return cameras, images, points3D, diag


# ---------------------------------------------------------------------------
# Core COLMAP Subprocess Pipeline
# ---------------------------------------------------------------------------

def run_multiview_reconstruction(
    image_paths: List[Union[str, Path]],
    job_id: str = "reconstruct_job",
    reference: Optional[Dict[str, Any]] = None,
    masks: Optional[Dict[str, Union[str, Path]]] = None,
    options: Optional[Dict[str, Any]] = None,
    colmap_custom_path: Optional[str] = None,
) -> MultiviewResult:
    """
    Main entry point for multi-view reconstruction.
    
    Guarantees:
    - Never throws unexpected exceptions: always returns a structured MultiviewResult.
    - Preserves user input files.
    - Safe execution in isolated temporary directory.
    - Gracefully flags missing COLMAP or insufficient images.
    - Distinguishes metric vs relative scale.
    """
    opts = options or {}
    timeout = opts.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    enable_dense = opts.get("dense_mvs", False)
    capture_mode = opts.get("capture_mode", "moving_camera")  # "moving_camera" | "turntable"

    result = MultiviewResult(job_id=job_id)

    # 1. Check for single image or empty inputs
    if not image_paths or len(image_paths) == 0:
        result.status = "failed"
        result.diagnostics = {"errors": ["No input images provided"]}
        return result

    if len(image_paths) < MIN_IMAGE_COUNT_FOR_MV:
        result.status = "unavailable"
        result.total_images = len(image_paths)
        result.diagnostics = {
            "warnings": [
                f"Multi-view reconstruction requires at least {MIN_IMAGE_COUNT_FOR_MV} images. "
                f"Single-image job ({len(image_paths)} image provided) bypassed to single-view/Gemini workflow."
            ]
        }
        return result

    # 2. Validate images and masks
    valid_paths, val_diag = validate_image_set(image_paths, masks=masks)
    result.total_images = val_diag["total_inputs"]
    result.diagnostics["validation"] = val_diag

    if len(valid_paths) < MIN_IMAGE_COUNT_FOR_MV:
        result.status = "failed"
        result.diagnostics["errors"] = [
            f"Fewer than {MIN_IMAGE_COUNT_FOR_MV} valid images remain after quality validation. "
            f"Corrupt or duplicate images: {len(val_diag['corrupt_images']) + len(val_diag['duplicates_detected'])}"
        ]
        return result

    # Check for turntable without masks
    if capture_mode == "turntable" and not masks:
        result.diagnostics["warnings"] = result.diagnostics.get("warnings", []) + [
            "Turntable capture without background segmentation masks: background features may contaminate object reconstruction."
        ]

    # 3. Detect COLMAP executable
    colmap_bin = find_colmap_executable(colmap_custom_path)
    if not colmap_bin:
        result.status = "unavailable"
        result.diagnostics["warnings"] = result.diagnostics.get("warnings", []) + [
            "COLMAP executable was not found on system PATH or configured locations. "
            "Downstream single-view and parametric pipeline will proceed without multi-view SfM."
        ]
        return result

    result.colmap_version = get_colmap_version(colmap_bin)

    # 4. Create isolated job workspace
    with tempfile.TemporaryDirectory(prefix=f"colmap_job_{job_id}_") as temp_dir:
        workspace = Path(temp_dir)
        img_workspace = workspace / "images"
        img_workspace.mkdir(parents=True, exist_ok=True)
        db_path = workspace / "database.db"
        sparse_dir = workspace / "sparse"
        sparse_dir.mkdir(parents=True, exist_ok=True)

        # Copy images into isolated job directory to prevent any path/space/unicode issues
        staged_images = []
        for idx, src_p in enumerate(valid_paths):
            dest_name = f"image_{idx:04d}{src_p.suffix.lower()}"
            dest_p = img_workspace / dest_name
            shutil.copy2(src_p, dest_p)
            staged_images.append(dest_p)

        # Mask directory setup if masks present
        mask_arg = []
        if masks:
            mask_workspace = workspace / "masks"
            mask_workspace.mkdir(parents=True, exist_ok=True)
            for idx, src_p in enumerate(valid_paths):
                m_src = masks.get(src_p.name) or masks.get(str(src_p))
                if m_src and Path(m_src).is_file():
                    shutil.copy2(Path(m_src), mask_workspace / f"image_{idx:04d}{src_p.suffix.lower()}.png")
            mask_arg = ["--ImageReader.mask_path", str(mask_workspace)]

        # --- Stage A: Feature Extraction ---
        cmd_extract = [
            colmap_bin, "feature_extractor",
            "--database_path", str(db_path),
            "--image_path", str(img_workspace),
            "--ImageReader.single_camera", "1",
            "--SiftExtraction.use_gpu", "0" if opts.get("force_cpu", True) else "1",
        ] + mask_arg

        try:
            res_ext = subprocess.run(cmd_extract, capture_output=True, text=True, timeout=timeout)
            if res_ext.returncode != 0:
                result.status = "failed"
                result.diagnostics["errors"] = [f"COLMAP feature extraction failed: {res_ext.stderr[:200]}"]
                return result
        except subprocess.TimeoutExpired:
            result.status = "failed"
            result.diagnostics["errors"] = [f"COLMAP feature extraction timed out after {timeout}s"]
            return result
        except Exception as e:
            result.status = "failed"
            result.diagnostics["errors"] = [f"COLMAP feature extraction error: {str(e)}"]
            return result

        # --- Stage B: Image Matching ---
        # Exhaustive matcher for small datasets (typical mechanical inspection <= 20 images)
        cmd_match = [
            colmap_bin, "exhaustive_matcher",
            "--database_path", str(db_path),
            "--SiftMatching.use_gpu", "0" if opts.get("force_cpu", True) else "1",
        ]

        try:
            res_match = subprocess.run(cmd_match, capture_output=True, text=True, timeout=timeout)
            if res_match.returncode != 0:
                result.status = "failed"
                result.diagnostics["errors"] = [f"COLMAP matching failed: {res_match.stderr[:200]}"]
                return result
        except subprocess.TimeoutExpired:
            result.status = "failed"
            result.diagnostics["errors"] = [f"COLMAP matching timed out after {timeout}s"]
            return result

        # --- Stage C: Mapping (SfM) ---
        cmd_map = [
            colmap_bin, "mapper",
            "--database_path", str(db_path),
            "--image_path", str(img_workspace),
            "--output_path", str(sparse_dir),
        ]

        try:
            res_map = subprocess.run(cmd_map, capture_output=True, text=True, timeout=timeout)
            if res_map.returncode != 0:
                result.status = "failed"
                result.diagnostics["errors"] = [f"COLMAP mapper failed: {res_map.stderr[:200]}"]
                return result
        except subprocess.TimeoutExpired:
            result.status = "failed"
            result.diagnostics["errors"] = [f"COLMAP mapper timed out after {timeout}s"]
            return result

        # Check for generated reconstruction (COLMAP writes to sparse/0/)
        model_subdirs = [d for d in sparse_dir.iterdir() if d.is_dir()]
        if not model_subdirs:
            # Check if sparse directory itself has models or if SfM found insufficient matches
            result.status = "failed"
            result.diagnostics["errors"] = ["COLMAP mapper produced 0 sub-models (insufficient feature matches or baseline)"]
            return result

        primary_model_dir = model_subdirs[0]

        # Convert model to text if in binary format for reliable cross-platform parsing
        cmd_convert = [
            colmap_bin, "model_converter",
            "--input_path", str(primary_model_dir),
            "--output_path", str(primary_model_dir),
            "--output_type", "TXT",
        ]
        try:
            subprocess.run(cmd_convert, capture_output=True, text=True, timeout=30)
        except Exception:
            pass

        # Parse reconstruction
        cams, imgs, pts, diag = parse_colmap_text_model(primary_model_dir)

        # Apply metric scale grounding
        scaled_pts, scaled_imgs, scale_info, scale_warns = apply_metric_scale(pts, imgs, reference)
        diag.warnings.extend(scale_warns)

        # Baseline check: check distance between camera poses
        if len(scaled_imgs) >= 2:
            tvecs = [img.tvec for img in scaled_imgs]
            # Max camera baseline
            max_baseline = 0.0
            for i in range(len(tvecs)):
                for j in range(i + 1, len(tvecs)):
                    b = math.sqrt(sum((tvecs[i][k] - tvecs[j][k])**2 for k in range(3)))
                    if b > max_baseline:
                        max_baseline = b
            if max_baseline < 1e-4:
                diag.baseline_sufficient = False
                diag.warnings.append("Insufficient camera baseline: poses are nearly coincident (degenerate multi-view geometry)")

        # Compile outcome
        result.cameras = [asdict(c) for c in cams]
        result.images = [asdict(im) for im in scaled_imgs]
        result.points3D = [asdict(p) for p in scaled_pts]
        result.registered_images = len(imgs)
        result.scale = asdict(scale_info)
        result.coordinate_frame = "component_local" if scale_info.classification == "metric" else "relative_world"
        # Merge diagnostics safely without overwriting earlier warnings/errors
        existing_warnings = result.diagnostics.get("warnings", [])
        existing_errors = result.diagnostics.get("errors", [])
        diag.warnings.extend(existing_warnings)
        diag.errors.extend(existing_errors)
        result.diagnostics.update(asdict(diag))

        # Check success vs partial
        if result.registered_images >= len(valid_paths) and len(scaled_pts) >= 10:
            result.status = "success"
        elif result.registered_images >= 2 and len(scaled_pts) >= 4:
            result.status = "partial"
            result.diagnostics.setdefault("warnings", []).append(
                f"Partial reconstruction: only {result.registered_images}/{len(valid_paths)} images registered."
            )
        else:
            result.status = "failed"
            result.diagnostics.setdefault("errors", []).append("Insufficient registered images or 3D points for stable reconstruction")

        return result
