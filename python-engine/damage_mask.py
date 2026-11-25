"""
damage_mask.py — pixel-level surface damage segmentation for ReForge AI.

Reads a JSON payload from stdin and writes a JSON result to stdout. No model
coordinates, part types or damage locations are supplied by the caller: the
mask is derived from the photograph's own pixels.

Pipeline per image:
  1. Isolate the component silhouette with GrabCut (Otsu fallback).
  2. Score rust/corrosion from Lab/HSV warmth, saturation, darkness and local
     texture; score pitting from small high-contrast dark pits near rust.
  3. Refine high-confidence seeds with mask-constrained GrabCut so the overlay
     follows the actual corroded patch contour rather than a generic box.
  4. Export a transparent RGBA PNG in the original image coordinates.

Only OpenCV/NumPy are required. The backend adapter resolves Python from
DAMAGE_MASK_PYTHON, CAD_EXPORT_PYTHON, the repo .venv, then PATH.
"""
from __future__ import annotations

import base64
import json
import sys
from typing import Any, Dict, List, Optional, Sequence

import cv2
import numpy as np

MAX_PROCESS_DIM = 1024
MIN_DAMAGE_PIXELS = 12
LEVEL_NAMES = {1: "low", 2: "moderate", 3: "high", 4: "severe"}
LEVEL_COLORS_BGR = {
    1: (113, 204, 46),   # green
    2: (15, 196, 241),   # yellow
    3: (18, 156, 243),   # orange
    4: (60, 76, 231),    # red
}
PIT_TYPES = {"surface_pitting", "pitting", "pit", "pits"}


def decode_image(data: str) -> np.ndarray:
    """Decode a base64 image into a BGR array."""
    if not isinstance(data, str) or not data:
        raise ValueError("Image data is missing.")
    raw = base64.b64decode(data, validate=True)
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("Could not decode the supplied image.")
    return image


def _scaled(image: np.ndarray) -> tuple[np.ndarray, float]:
    h, w = image.shape[:2]
    scale = min(1.0, MAX_PROCESS_DIM / float(max(h, w)))
    if scale >= 1.0:
        return image.copy(), 1.0
    small = cv2.resize(image, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
    return small, scale


def _foreground_mask(image: np.ndarray) -> np.ndarray:
    """Component silhouette. Falls back to Otsu if GrabCut degenerates."""
    h, w = image.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
    bg_model = np.zeros((1, 65), dtype=np.float64)
    fg_model = np.zeros((1, 65), dtype=np.float64)

    rect = (
        max(0, int(round(w * 0.025))),
        max(0, int(round(h * 0.025))),
        max(1, int(round(w * 0.95))),
        max(1, int(round(h * 0.95))),
    )
    try:
        cv2.grabCut(image, mask, rect, bg_model, fg_model, 4, cv2.GC_INIT_WITH_RECT)
        foreground = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD))
    except cv2.error:
        foreground = np.zeros((h, w), dtype=bool)

    foreground = _keep_largest_regions(foreground, max(24, int(0.004 * h * w)))
    ratio = float(foreground.mean()) if foreground.size else 0.0
    if ratio < 0.015 or ratio > 0.985:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Pick the polarity with the more plausible foreground occupancy.
        inverted = 255 - otsu
        candidates = [otsu > 0, inverted > 0]
        candidates.sort(key=lambda m: abs(float(m.mean()) - 0.35))
        foreground = _keep_largest_regions(candidates[0], max(24, int(0.004 * h * w)))

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    foreground = cv2.morphologyEx(foreground.astype(np.uint8), cv2.MORPH_CLOSE, kernel) > 0
    return foreground


def _keep_largest_regions(mask: np.ndarray, min_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    kept = np.zeros(mask.shape, dtype=bool)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= min_area:
            kept |= labels == index
    return kept


def _damage_scores(image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return rust score, pit score and local luminance for an image."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    lightness = lab[:, :, 0]
    a = np.clip((lab[:, :, 1] - 128.0) / 100.0, 0.0, 1.0)
    b = np.clip((lab[:, :, 2] - 128.0) / 100.0, 0.0, 1.0)

    hue = hsv[:, :, 0].astype(np.float32)
    saturation = hsv[:, :, 1].astype(np.float32) / 255.0
    value = hsv[:, :, 2].astype(np.float32) / 255.0

    # Oxide is warm (red/yellow), saturated enough to be non-grey, and rarely
    # near-white. Grey/blue clean metal scores close to zero on both branches.
    warm_chroma = np.clip((a - 0.02) * 2.4, 0.0, 1.0) * np.clip((b - 0.02) * 2.0, 0.0, 1.0)
    warm_hue = (((hue <= 30.0) | (hue >= 170.0)).astype(np.float32)
                * np.clip((saturation - 0.22) / 0.45, 0.0, 1.0)
                * np.clip((0.95 - value) / 0.5, 0.0, 1.0)
                * np.clip((value - 0.08) / 0.22, 0.0, 1.0))
    color_score = np.maximum(warm_chroma, warm_hue)

    light_u8 = np.clip(lightness, 0, 255).astype(np.uint8)
    sigma = max(3.0, min(image.shape[:2]) * 0.012)
    mean = cv2.GaussianBlur(light_u8, (0, 0), sigma)
    mean_sq = cv2.GaussianBlur(light_u8.astype(np.float32) ** 2, (0, 0), sigma)
    local_std = np.sqrt(np.maximum(mean_sq - mean.astype(np.float32) ** 2, 0.0))
    texture = np.clip((local_std - 3.5) / 16.0, 0.0, 1.0)

    sobel_x = cv2.Sobel(light_u8, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(light_u8, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(sobel_x, sobel_y)
    edge = np.clip((gradient - 20.0) / 90.0, 0.0, 1.0)

    # Flat oxide patches must still score highly: colour alone is enough for a
    # seed. Texture/edges add confidence and sharpen boundaries on real photos.
    rust_score = color_score * (0.62 + 0.24 * texture + 0.14 * edge)

    # Pits are small, dark, locally textured depressions. They are only kept
    # later when they sit in/near a rust field or were explicitly observed.
    dark_relief = np.clip((mean.astype(np.float32) - lightness - 11.0) / 34.0, 0.0, 1.0)
    pit_score = dark_relief * texture * np.clip((0.55 - value) / 0.35, 0.0, 1.0)
    return np.clip(rust_score, 0, 1), np.clip(pit_score, 0, 1), mean.astype(np.float32)


def _refine_with_grabcut(image: np.ndarray, foreground: np.ndarray, seeds: np.ndarray, candidates: np.ndarray) -> np.ndarray:
    """Snap a seed mask to real colour/edge boundaries inside the silhouette."""
    if int(seeds.sum()) < 6:
        return candidates

    h, w = image.shape[:2]
    gc_mask = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
    gc_mask[candidates] = cv2.GC_PR_FGD
    gc_mask[seeds] = cv2.GC_FGD
    gc_mask[~foreground] = cv2.GC_BGD
    bg_model = np.zeros((1, 65), dtype=np.float64)
    fg_model = np.zeros((1, 65), dtype=np.float64)
    try:
        cv2.grabCut(image, gc_mask, None, bg_model, fg_model, 2, cv2.GC_INIT_WITH_MASK)
        refined = np.isin(gc_mask, (cv2.GC_FGD, cv2.GC_PR_FGD))
    except cv2.error:
        refined = candidates
    return refined & foreground


def _connected_stats(mask: np.ndarray) -> tuple[int, int, float, float]:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    areas = stats[1:, cv2.CC_STAT_AREA] if count > 1 else np.array([], dtype=np.int32)
    total = int(mask.sum())
    y_indices, x_indices = np.nonzero(mask)
    if total == 0 or len(areas) == 0:
        return 0, 0, 0.0, 0.0
    spread = float((x_indices.max() - x_indices.min() + 1) * (y_indices.max() - y_indices.min() + 1)) / float(mask.size)
    return int(len(areas)), int(areas.max()), float(areas.max()) / float(total), spread


def _severity_from_coverage(ratio: float) -> Optional[str]:
    if ratio < 0.003:
        return None
    if ratio < 0.025:
        return "minor"
    if ratio < 0.10:
        return "moderate"
    return "severe"


def _extent_from_coverage(ratio: float, regions: int, spread: float) -> str:
    # Region count alone must not make a small cluster "widespread": a rusty
    # patch can split into many connected components. Require either a large
    # share of the silhouette or a large bounding footprint.
    if ratio >= 0.12 or spread >= 0.30 or (regions >= 8 and spread >= 0.20):
        return "widespread"
    return "localized"


def _level_map(damage: np.ndarray, score: np.ndarray) -> np.ndarray:
    sigma = max(3.0, min(damage.shape) * 0.014)
    density = cv2.GaussianBlur(damage.astype(np.float32), (0, 0), sigma)
    density = np.clip(density * 6.0, 0.0, 1.0)
    level = np.ones(damage.shape, dtype=np.uint8)
    level[(score >= 0.44) | (density >= 0.12)] = 2
    level[(score >= 0.62) | (density >= 0.38)] = 3
    level[(score >= 0.78) & (density >= 0.58)] = 4
    level[~damage] = 0
    return level


def _encode_mask(level: np.ndarray, alpha: np.ndarray) -> str:
    h, w = level.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for value, color in LEVEL_COLORS_BGR.items():
        selected = level == value
        rgba[selected, 0] = color[0]
        rgba[selected, 1] = color[1]
        rgba[selected, 2] = color[2]
    soft = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 0.65)
    rgba[:, :, 3] = np.clip(soft, 0, 255).astype(np.uint8)
    rgba[level == 0, 3] = 0
    ok, encoded = cv2.imencode(".png", rgba)
    if not ok:
        raise RuntimeError("Failed to encode damage mask PNG.")
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def generate_mask_from_bgr(image: np.ndarray, observed_types: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """Generate one pixel-level damage mask. Used by the CLI and unit tests."""
    if image is None or image.size == 0:
        raise ValueError("Empty image supplied to damage segmentation.")
    original_h, original_w = image.shape[:2]
    work, scale = _scaled(image)
    h, w = work.shape[:2]

    foreground = _foreground_mask(work)
    rust_score, pit_score, _ = _damage_scores(work)
    rust_score = rust_score * foreground
    pit_score = pit_score * foreground

    min_area = max(6, int(0.00006 * h * w))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    rust_seeds = cv2.morphologyEx((rust_score > 0.52).astype(np.uint8), cv2.MORPH_CLOSE, kernel).astype(bool)
    rust_seeds = _keep_largest_regions(rust_seeds & foreground, min_area)
    rust_candidates = ((rust_score > 0.30) & (cv2.dilate(rust_seeds.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0) & foreground)
    rust_mask = _refine_with_grabcut(work, foreground, rust_seeds, rust_candidates)

    # Pits are kept only where they accompany corrosion, unless pitting was
    # explicitly reported by the visual assessor.
    near_rust = cv2.dilate(rust_mask.astype(np.uint8), np.ones((11, 11), np.uint8)) > 0
    pit_seeds = _keep_largest_regions((pit_score > 0.54).astype(np.uint8), max(4, min_area // 2)).astype(bool)
    allow_pits = bool(set(t.lower() for t in (observed_types or [])) & PIT_TYPES)
    pit_mask = pit_seeds & (near_rust if not allow_pits else foreground)

    damage = (rust_mask | pit_mask) & foreground
    score = np.maximum(rust_score, pit_score * 0.92)

    component_pixels = int(foreground.sum())
    damage_pixels = int(damage.sum())
    component_ratio = damage_pixels / max(1, component_pixels)
    regions, largest, largest_ratio, spread = _connected_stats(damage)
    severity = _severity_from_coverage(component_ratio)
    extent = _extent_from_coverage(component_ratio, regions, spread) if severity else "localized"

    level = _level_map(damage, score)
    level_counts = {name: int((level == value).sum()) for value, name in LEVEL_NAMES.items()}

    if scale < 1.0:
        target = (original_w, original_h)
        damage_full = cv2.resize(damage.astype(np.uint8), target, interpolation=cv2.INTER_LINEAR) > 0
        level_full = cv2.resize(level, target, interpolation=cv2.INTER_NEAREST)
        score_full = cv2.resize(score, target, interpolation=cv2.INTER_LINEAR)
        alpha_full = np.where(damage_full, 95 + 95 * np.clip(score_full, 0, 1), 0).astype(np.float32)
        level = level_full
        damage = damage_full
    else:
        alpha_full = np.where(damage, 95 + 95 * np.clip(score, 0, 1), 0).astype(np.float32)

    damage_pixels = int(damage.sum())
    confidence = float(np.clip(0.55 + 0.35 * min(1.0, component_ratio / 0.15) + 0.10 * min(1.0, regions / 8.0), 0, 1))

    detected_types: List[str] = []
    if severity:
        reported = [str(t).lower() for t in (observed_types or [])]
        if "surface_pitting" in reported and int(pit_mask.sum()) >= min_area:
            detected_types.append("surface_pitting")
        if "surface_roughness" in reported and component_ratio >= 0.06:
            detected_types.append("surface_roughness")
        if any(t in reported for t in ("rust", "corrosion")):
            detected_types.append("rust" if "rust" in reported else "corrosion")
        elif int(rust_mask.sum()) >= min_area:
            detected_types.append("rust")
        if not detected_types:
            detected_types.append("surface_roughness")

    return {
        "width": int(original_w),
        "height": int(original_h),
        "dataUrl": _encode_mask(level, alpha_full),
        "stats": {
            "componentPixels": component_pixels,
            "maskedPixels": damage_pixels,
            "componentPixelRatio": round(float(component_pixels) / float(original_w * original_h), 5),
            "damagePixelRatio": round(damage_pixels / float(original_w * original_h), 5),
            "damageRatioOfComponent": round(component_ratio, 5),
            "connectedRegions": regions,
            "largestRegionRatio": round(largest_ratio, 5),
            "largestRegionPixels": largest,
            "spread": round(spread, 5),
            "severity": severity,
            "extent": extent,
            "confidence": round(confidence, 3),
            "levelCounts": level_counts,
            "types": detected_types,
        },
    }


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        images = payload.get("images") or []
        observed_types = payload.get("observedTypes") or []
        masks = []
        for index, image_input in enumerate(images):
            image = decode_image(image_input.get("data", ""))
            result = generate_mask_from_bgr(image, observed_types)
            result["imageIndex"] = int(image_input.get("imageIndex", index))
            masks.append(result)
        print(json.dumps({"ok": True, "masks": masks}))
    except Exception as exc:  # noqa: BLE001 - CLI must always return JSON
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
