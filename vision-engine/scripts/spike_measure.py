"""Throwaway Stage-1 measurement spike (NOT for commit).

Compares three pixel-space feature detectors on a folder of component photos:
  1. Hough circles        (vision.opencv_features.extract_features)
  2. Inner contours       (RETR_TREE hierarchy + ellipse/circle fit)
  3. SAM 2 automatic masks (per-mask contour + ellipse fit)

It writes overlay images plus a JSON/Markdown report. No millimetre values are
produced and no ground-truth accuracy is claimed; the report only records raw
candidate counts and cross-detector agreement.

Usage (from anywhere):
    python vision-engine/scripts/spike_measure.py --samples samples --out .spike_out
    python vision-engine/scripts/spike_measure.py --samples parts --device cuda

Outputs default to %TEMP%/reforge_spike_measure so the repo stays clean.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

# Resolve vision-engine as import root and set device BEFORE importing config.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VISION_ENGINE_DIR = os.path.dirname(SCRIPT_DIR)
REPO_ROOT = os.path.dirname(VISION_ENGINE_DIR)
if VISION_ENGINE_DIR not in sys.path:
    sys.path.insert(0, VISION_ENGINE_DIR)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage-1 feature-detector spike.")
    parser.add_argument(
        "--samples",
        default=os.path.join(REPO_ROOT, "samples"),
        help="Folder of component photos (default: <repo>/samples).",
    )
    parser.add_argument(
        "--out",
        default=os.path.join(tempfile.gettempdir(), "reforge_spike_measure"),
        help="Output folder for overlays and reports.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Override VISION_DEVICE (cpu, cuda, mps, auto).",
    )
    parser.add_argument(
        "--max-masks",
        type=int,
        default=40,
        help="Cap on SAM 2 masks evaluated per image.",
    )
    parser.add_argument(
        "--min-area-ratio",
        type=float,
        default=0.0005,
        help="Ignore candidates smaller than this fraction of image area.",
    )
    return parser.parse_args()


def _imread_unicode(path: str):
    import cv2
    import numpy as np

    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _imwrite_unicode(path: str, image) -> bool:
    import cv2

    ext = os.path.splitext(path)[1] or ".png"
    ok, buffer = cv2.imencode(ext, image)
    if not ok:
        return False
    buffer.tofile(path)
    return True


def _circularity(contour) -> float:
    import cv2

    area = float(cv2.contourArea(contour))
    perimeter = float(cv2.arcLength(contour, True))
    if perimeter <= 1e-6:
        return 0.0
    return max(0.0, min(1.0, 4.0 * math.pi * area / (perimeter * perimeter)))


def _valid_ellipse(ellipse: Optional[Dict[str, float]], diagonal_px: float) -> bool:
    if not ellipse:
        return False
    rx, ry = ellipse["rx"], ellipse["ry"]
    if rx <= 0.5 or ry <= 0.5:
        return False
    axis_ratio = min(rx, ry) / max(rx, ry)
    if axis_ratio < 0.2:
        return False
    if max(rx, ry) > 0.9 * diagonal_px:
        return False
    return True


def _ellipse_from_points(points) -> Optional[Dict[str, float]]:
    import cv2
    import numpy as np

    arr = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    if len(arr) < 5:
        return None
    try:
        (cx, cy), (minor, major), angle = cv2.fitEllipse(arr)
    except cv2.error:
        return None
    return {
        "cx": float(cx),
        "cy": float(cy),
        "rx": float(max(minor, major)) / 2.0,
        "ry": float(min(minor, major)) / 2.0,
        "angle_deg": float(angle),
    }


def _hough_candidates(features: Dict[str, Any], min_area_px: float) -> List[Dict[str, Any]]:
    out = []
    for circle in features.get("circles", []):
        radius = float(circle.get("radius_px") or 0.0)
        if radius <= 0:
            continue
        if math.pi * radius * radius < min_area_px:
            continue
        out.append(
            {
                "source": "hough",
                "cx": float(circle["cx_px"]),
                "cy": float(circle["cy_px"]),
                "r": radius,
                "circularity": None,
                "confidence": circle.get("confidence"),
                "axis_ratio": 1.0,
            }
        )
    return out


def _inner_contour_candidates(
    features: Dict[str, Any],
    min_area_px: float,
    diagonal_px: float,
    min_circularity: float = 0.55,
) -> Tuple[List[Dict[str, Any]], int]:
    out = []
    rejected = 0
    for contour in features.get("contours", []):
        if contour.get("type") != "inner_contour":
            continue
        area = float(contour.get("area_px2") or 0.0)
        if area < min_area_px:
            continue
        circ = float(contour.get("circularity") or 0.0)
        if circ < min_circularity:
            continue
        ellipse = _ellipse_from_points(contour.get("points_px") or [])
        if not _valid_ellipse(ellipse, diagonal_px):
            rejected += 1
            continue
        axis_ratio = ellipse["ry"] / ellipse["rx"] if ellipse["rx"] > 0 else 0.0
        out.append(
            {
                "source": "inner_contour",
                "cx": ellipse["cx"],
                "cy": ellipse["cy"],
                "r": (ellipse["rx"] + ellipse["ry"]) / 2.0,
                "circularity": circ,
                "confidence": circ,
                "axis_ratio": axis_ratio,
            }
        )
    return out, rejected


def _sam_candidates(
    segmentor,
    rgb,
    min_area_px: float,
    max_masks: int,
    diagonal_px: float,
) -> Tuple[List[Dict[str, Any]], Optional[str], int]:
    import cv2
    import numpy as np

    generator = getattr(segmentor, "_mask_generator", None)
    if generator is None:
        return [], "SAM2 mask generator unavailable", 0

    try:
        masks = generator.generate(rgb)
    except Exception as exc:  # noqa: BLE001 - spike must not crash
        return [], f"SAM2 automatic mask generation failed: {exc}", 0

    masks = sorted(
        masks or [],
        key=lambda m: float(m.get("predicted_iou", 0.0)),
        reverse=True,
    )[: max(1, max_masks)]

    out: List[Dict[str, Any]] = []
    rejected = 0
    for index, mask in enumerate(masks):
        seg = np.asarray(mask.get("segmentation"))
        if seg.ndim != 2:
            continue
        seg_u8 = (seg > 0).astype(np.uint8) * 255
        area = float(np.sum(seg_u8 > 0))
        if area < min_area_px:
            continue
        contours, _ = cv2.findContours(seg_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        ellipse = _ellipse_from_points(contour.reshape(-1, 2))
        if not _valid_ellipse(ellipse, diagonal_px):
            if ellipse is None:
                moments = cv2.moments(contour)
                if moments.get("m00", 0.0) <= 0:
                    rejected += 1
                    continue
                radius = math.sqrt(area / math.pi)
                if radius < 0.5 or radius > 0.9 * diagonal_px:
                    rejected += 1
                    continue
                ellipse = {
                    "cx": float(moments["m10"] / moments["m00"]),
                    "cy": float(moments["m01"] / moments["m00"]),
                    "rx": radius,
                    "ry": radius,
                    "angle_deg": 0.0,
                }
            else:
                rejected += 1
                continue
        axis_ratio = ellipse["ry"] / ellipse["rx"] if ellipse["rx"] > 0 else 0.0
        circ = _circularity(contour)
        out.append(
            {
                "source": "sam2",
                "mask_index": index,
                "cx": ellipse["cx"],
                "cy": ellipse["cy"],
                "r": (ellipse["rx"] + ellipse["ry"]) / 2.0,
                "circularity": circ,
                "confidence": float(mask.get("predicted_iou", 0.0)),
                "stability": float(mask.get("stability_score", 0.0)),
                "axis_ratio": axis_ratio,
                "area_px": area,
                "bbox_px": mask.get("bbox"),
            }
        )
    return out, None, rejected


def _cluster_candidates(
    candidates: List[Dict[str, Any]], tolerance_px: float
) -> List[Dict[str, Any]]:
    """Greedy agreement clustering by centre distance + radius similarity."""
    clusters: List[Dict[str, Any]] = []
    for cand in sorted(candidates, key=lambda c: float(c.get("confidence") or 0.0), reverse=True):
        placed = False
        for cluster in clusters:
            dx = float(cand["cx"]) - cluster["cx"]
            dy = float(cand["cy"]) - cluster["cy"]
            distance = math.hypot(dx, dy)
            radius_ratio = abs(float(cand["r"]) - cluster["r"]) / max(cluster["r"], 1e-6)
            if distance <= tolerance_px and radius_ratio <= 0.35:
                cluster["members"].append(cand)
                cluster["sources"].add(cand["source"])
                count = len(cluster["members"])
                cluster["cx"] = (cluster["cx"] * (count - 1) + float(cand["cx"])) / count
                cluster["cy"] = (cluster["cy"] * (count - 1) + float(cand["cy"])) / count
                cluster["r"] = (cluster["r"] * (count - 1) + float(cand["r"])) / count
                placed = True
                break
        if not placed:
            clusters.append(
                {
                    "cx": float(cand["cx"]),
                    "cy": float(cand["cy"]),
                    "r": float(cand["r"]),
                    "members": [cand],
                    "sources": {cand["source"]},
                }
            )
    for cluster in clusters:
        cluster["sources"] = sorted(cluster["sources"])
        cluster["agreement"] = len(cluster["sources"])
        cluster["member_count"] = len(cluster["members"])
    return clusters


def _draw_overlay(image, features, candidates, clusters, sam_masks):
    import cv2
    import numpy as np

    overlay = image.copy()

    # Inner contours (blue)
    for contour in features.get("contours", []):
        if contour.get("type") != "inner_contour":
            continue
        pts = np.asarray(contour.get("points_px") or [], dtype=np.int32)
        if pts.size:
            cv2.drawContours(overlay, [pts.reshape(-1, 1, 2)], -1, (255, 130, 0), 1)

    # SAM masks (red outline)
    for seg in sam_masks:
        arr = np.asarray(seg)
        if arr.ndim != 2:
            continue
        contours, _ = cv2.findContours(
            (arr > 0).astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if contours:
            cv2.drawContours(overlay, [max(contours, key=cv2.contourArea)], -1, (0, 0, 255), 1)

    # Candidate circles coloured by source
    colours = {
        "hough": (0, 220, 0),
        "inner_contour": (255, 160, 0),
        "sam2": (0, 0, 255),
    }
    for cand in candidates:
        colour = colours.get(cand["source"], (200, 200, 200))
        centre = (int(round(cand["cx"])), int(round(cand["cy"])))
        cv2.circle(overlay, centre, int(round(cand["r"])), colour, 2)
        cv2.drawMarker(overlay, centre, colour, cv2.MARKER_CROSS, 8, 1)

    # Agreement clusters (yellow)
    for cluster in clusters:
        if cluster["agreement"] < 2:
            continue
        centre = (int(round(cluster["cx"])), int(round(cluster["cy"])))
        cv2.circle(overlay, centre, int(round(cluster["r"])) + 3, (0, 255, 255), 2)

    return overlay


def _clean_number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def main() -> int:
    args = _parse_args()
    if args.device:
        os.environ["VISION_DEVICE"] = args.device
    os.makedirs(args.out, exist_ok=True)

    import cv2
    import numpy as np

    from vision.opencv_features import extract_features
    from vision.segmentation import SAM2Segmentor

    if not os.path.isdir(args.samples):
        print(f"[spike] Samples folder not found: {args.samples}")
        return 2

    image_paths = sorted(
        os.path.join(args.samples, name)
        for name in os.listdir(args.samples)
        if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"))
    )
    if not image_paths:
        print(f"[spike] No images in {args.samples}")
        return 2

    segmentor = SAM2Segmentor()
    device = args.device or os.environ.get("VISION_DEVICE", "auto")
    started = time.time()
    print(f"[spike] Loading SAM2 (device={device}) ...")
    sam_ok = segmentor.load(device)
    print(f"[spike] SAM2 loaded={sam_ok} resolved_device={segmentor._device}")

    report: Dict[str, Any] = {
        "samples_dir": os.path.abspath(args.samples),
        "output_dir": os.path.abspath(args.out),
        "sam2_loaded": bool(sam_ok),
        "sam2_device": getattr(segmentor, "_device", None),
        "note": "Pixel-space candidates only. No ground truth, so no accuracy is claimed.",
        "images": [],
    }

    for path in image_paths:
        name = os.path.basename(path)
        bgr = _imread_unicode(path)
        if bgr is None:
            report["images"].append({"image": name, "error": "could not decode"})
            print(f"[spike] {name}: decode failed")
            continue

        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        height, width = rgb.shape[:2]
        min_area_px = args.min_area_ratio * float(height * width)
        tolerance_px = max(4.0, 0.02 * float(min(height, width)))
        diagonal_px = math.hypot(float(width), float(height))

        t0 = time.time()
        features = extract_features(rgb, mask=None, image_index=0)
        hough = _hough_candidates(features, min_area_px)
        inner, inner_rejected = _inner_contour_candidates(
            features, min_area_px, diagonal_px
        )

        sam_candidates: List[Dict[str, Any]] = []
        sam_error: Optional[str] = None
        sam_rejected = 0
        sam_masks: List[Any] = []
        if sam_ok:
            sam_candidates, sam_error, sam_rejected = _sam_candidates(
                segmentor, rgb, min_area_px, args.max_masks, diagonal_px
            )

        candidates = hough + inner + sam_candidates
        clusters = _cluster_candidates(candidates, tolerance_px)
        corroborated = [c for c in clusters if c["agreement"] >= 2]

        overlay = _draw_overlay(bgr, features, candidates, clusters, sam_masks)
        overlay_name = f"{os.path.splitext(name)[0]}__overlay.png"
        _imwrite_unicode(os.path.join(args.out, overlay_name), overlay)

        elapsed = time.time() - t0
        entry = {
            "image": name,
            "width": width,
            "height": height,
            "elapsed_s": round(elapsed, 3),
            "hough_count": len(hough),
            "inner_contour_count": len(inner),
            "sam2_count": len(sam_candidates),
            "inner_degenerate_rejected": inner_rejected,
            "sam2_degenerate_rejected": sam_rejected,
            "sam2_error": sam_error,
            "candidate_total": len(candidates),
            "clusters_total": len(clusters),
            "corroborated_clusters": len(corroborated),
            "corroborated": [
                {
                    "cx": round(c["cx"], 1),
                    "cy": round(c["cy"], 1),
                    "r": round(c["r"], 1),
                    "sources": c["sources"],
                    "member_count": c["member_count"],
                }
                for c in corroborated
            ],
            "single_source_candidates": [
                {
                    "sources": c["sources"],
                    "cx": round(c["cx"], 1),
                    "cy": round(c["cy"], 1),
                    "r": round(c["r"], 1),
                    "confidence": _clean_number(c["members"][0].get("confidence")),
                    "circularity": _clean_number(c["members"][0].get("circularity")),
                    "axis_ratio": _clean_number(c["members"][0].get("axis_ratio")),
                }
                for c in clusters
                if c["agreement"] < 2
            ],
            "overlay": overlay_name,
        }
        report["images"].append(entry)
        print(
            f"[spike] {name}: hough={len(hough)} inner={len(inner)} sam2={len(sam_candidates)} "
            f"corroborated={len(corroborated)} overlay={overlay_name}"
        )

    # Aggregate
    totals = {
        "images": len(report["images"]),
        "hough": sum(int(img.get("hough_count", 0)) for img in report["images"]),
        "inner_contour": sum(int(img.get("inner_contour_count", 0)) for img in report["images"]),
        "sam2": sum(int(img.get("sam2_count", 0)) for img in report["images"]),
        "corroborated": sum(int(img.get("corroborated_clusters", 0)) for img in report["images"]),
        "single_source": sum(
            len(img.get("single_source_candidates", [])) for img in report["images"]
        ),
    }
    report["totals"] = totals
    pair_counts: Dict[str, int] = {}
    for img in report["images"]:
        for cluster in img.get("corroborated", []):
            key = "+".join(cluster["sources"])
            pair_counts[key] = pair_counts.get(key, 0) + 1
    report["corroboration_pairs"] = pair_counts
    report["total_elapsed_s"] = round(time.time() - started, 2)

    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)

    lines = [
        "# Stage 1 measurement spike",
        "",
        f"- Samples: `{report['samples_dir']}`",
        f"- SAM 2 loaded: `{report['sam2_loaded']}` on `{report['sam2_device']}`",
        f"- Total time: `{report['total_elapsed_s']} s`",
        "- Pixel-space candidates only; no ground truth, so no accuracy is claimed.",
        "",
        "| Image | Hough | Inner contour | SAM 2 | Corroborated |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for img in report["images"]:
        if "error" in img:
            lines.append(f"| {img['image']} | - | - | - | - (decode error) |")
            continue
        lines.append(
            f"| {img['image']} | {img['hough_count']} | {img['inner_contour_count']} | "
            f"{img['sam2_count']} | {img['corroborated_clusters']} |"
        )
    lines += [
        "",
        "## Totals",
        "",
        f"- Hough circles: `{totals['hough']}`",
        f"- Inner contours: `{totals['inner_contour']}`",
        f"- SAM 2 masks: `{totals['sam2']}`",
        f"- Corroborated clusters (>=2 sources): `{totals['corroborated']}`",
        f"- Single-source candidates: `{totals['single_source']}`",
    ]
    if report.get("corroboration_pairs"):
        lines.append("- Corroboration by source pair:")
        for pair, count in sorted(report["corroboration_pairs"].items()):
            lines.append(f"  - `{pair}`: `{count}`")
    lines += [
        "",
        "Overlay colours: Hough=green, inner contour=blue, SAM 2=red, corroborated=yellow.",
    ]
    with open(os.path.join(args.out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    print(f"[spike] wrote {os.path.join(args.out, 'report.json')}")
    print(f"[spike] wrote {os.path.join(args.out, 'report.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
