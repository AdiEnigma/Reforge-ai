"""
run_flange_report.py — Run the full vision pipeline on the flange test image
and save all outputs to report_case/flange/.

Outputs:
  input.png           copy of source image
  sam2-mask.png       SAM2 binary mask (white=component)
  sam2-overlay.png    SAM2 coloured mask overlaid on source
  depth.png           colour-mapped relative depth preview
  relative-depth.npy  raw float32 depth map
  opencv.png          OpenCV contour + circle + line overlay
  vision.json         full feature extraction payload (serialisable subset)
  vision-times.json   per-stage latency
  analysis-time.json  total wall time
  measurements.json   dimensional analysis from OpenCV circles/contours
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import warnings

import cv2
import numpy as np
from PIL import Image

# ── Paths ────────────────────────────────────────────────────────────────────
REPO_ROOT   = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INPUT_IMG   = os.path.join(REPO_ROOT, "test_images", "Screenshot 2026-11-16 170945.png")
OUT_DIR     = os.path.join(REPO_ROOT, "report_case", "flange")
VE_DIR      = os.path.dirname(__file__)   # vision-engine/

# Add vision-engine to path so we can import its modules
if VE_DIR not in sys.path:
    sys.path.insert(0, VE_DIR)

os.makedirs(OUT_DIR, exist_ok=True)

# ── Helpers ───────────────────────────────────────────────────────────────────
def save_json(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, default=str)

def to_serialisable(v):
    """Recursively convert numpy scalars/arrays to plain Python for JSON."""
    if isinstance(v, np.ndarray):
        return v.tolist()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, dict):
        return {k: to_serialisable(w) for k, w in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_serialisable(w) for w in v]
    return v

def colourmap_depth(depth_map: np.ndarray) -> np.ndarray:
    """Normalise depth to 0-255 and apply INFERNO colourmap. Returns RGB uint8."""
    d = depth_map.copy()
    mn, mx = d.min(), d.max()
    if mx > mn:
        d = (d - mn) / (mx - mn) * 255.0
    else:
        d = np.zeros_like(d)
    d_u8 = d.astype(np.uint8)
    coloured = cv2.applyColorMap(d_u8, cv2.COLORMAP_INFERNO)
    return cv2.cvtColor(coloured, cv2.COLOR_BGR2RGB)

# ── Load source image ─────────────────────────────────────────────────────────
print(f"[1/6] Loading source image: {INPUT_IMG}")
t_total_start = time.perf_counter()
rgb = np.asarray(Image.open(INPUT_IMG).convert("RGB"), dtype=np.uint8).copy()
h, w = rgb.shape[:2]
print(f"      Shape: {w}×{h} px")
shutil.copy2(INPUT_IMG, os.path.join(OUT_DIR, "input.png"))

times = {}

# ── SAM2 Segmentation ─────────────────────────────────────────────────────────
print("[2/6] Running SAM2 segmentation …")
from vision.segmentation import SAM2Segmentor
import config

seg_result = None
sam2_mask_arr = None
t0 = time.perf_counter()
try:
    segmentor = SAM2Segmentor()
    device = "cuda"
    loaded = segmentor.load(device)
    times["sam2_load_s"] = round(time.perf_counter() - t0, 4)
    if loaded:
        t1 = time.perf_counter()
        seg_result = segmentor.segment(rgb)
        times["sam2_generate_s"] = round(time.perf_counter() - t1, 4)
        print(f"      status={seg_result['status']}  candidates={seg_result['candidate_count']}  score={seg_result.get('score')}")
    else:
        times["sam2_generate_s"] = 0
        print("      SAM2 not loaded (checkpoint missing)")
except Exception as e:
    times["sam2_generate_s"] = round(time.perf_counter() - t0, 4)
    print(f"      SAM2 error: {e}")
    seg_result = {"status": "error", "candidate_count": 0, "warnings": [str(e)]}

# Build mask image from SAM2 result
if seg_result and seg_result.get("status") == "ok":
    bbox = seg_result.get("bbox_xyxy_px")
    # Try to get the raw mask from segmentor's last result
    raw_mask = getattr(segmentor, "_last_mask", None)
    if raw_mask is None and bbox:
        # Approximate mask from bounding box
        raw_mask = np.zeros((h, w), dtype=np.uint8)
        x1, y1, x2, y2 = [int(v) for v in bbox]
        raw_mask[y1:y2, x1:x2] = 255
    elif raw_mask is not None:
        raw_mask = (raw_mask * 255).astype(np.uint8)
    if raw_mask is not None:
        sam2_mask_arr = raw_mask
        Image.fromarray(raw_mask).save(os.path.join(OUT_DIR, "sam2-mask.png"))
        # Coloured overlay
        overlay = rgb.copy()
        green_mask = np.zeros_like(rgb)
        green_mask[:, :, 1] = raw_mask  # green channel
        overlay = cv2.addWeighted(overlay, 0.7, green_mask, 0.4, 0)
        Image.fromarray(overlay.astype(np.uint8)).save(os.path.join(OUT_DIR, "sam2-overlay.png"))
        print("      Saved sam2-mask.png and sam2-overlay.png")
    else:
        print("      SAM2 returned ok but no mask array available; saving bbox-only mask")
        raw_mask = np.zeros((h, w), dtype=np.uint8)
        if bbox:
            x1, y1, x2, y2 = [int(v) for v in bbox]
            raw_mask[y1:y2, x1:x2] = 255
        sam2_mask_arr = raw_mask
        Image.fromarray(raw_mask).save(os.path.join(OUT_DIR, "sam2-mask.png"))
        overlay = cv2.addWeighted(rgb, 0.7, cv2.merge([np.zeros_like(raw_mask), raw_mask, np.zeros_like(raw_mask)]), 0.4, 0)
        Image.fromarray(overlay.astype(np.uint8)).save(os.path.join(OUT_DIR, "sam2-overlay.png"))
else:
    # Unavailable — save blank placeholder mask
    blank = np.zeros((h, w), dtype=np.uint8)
    Image.fromarray(blank).save(os.path.join(OUT_DIR, "sam2-mask.png"))
    Image.fromarray(rgb).save(os.path.join(OUT_DIR, "sam2-overlay.png"))
    print("      SAM2 unavailable — saved blank mask")

# ── Depth Estimation ──────────────────────────────────────────────────────────
print("[3/6] Running Depth Anything V2 …")
from vision.depth_estimator import DepthEstimator
import sys as _sys

depth_result = None
depth_map = None
t0 = time.perf_counter()
try:
    # Add Depth-Anything-V2 source to path
    da2_src = config.DEPTH_ANYTHING_V2_SOURCE_DIR
    if da2_src and os.path.isdir(da2_src) and da2_src not in _sys.path:
        _sys.path.insert(0, da2_src)

    estimator = DepthEstimator()
    times["depth_load_s"] = round(time.perf_counter() - t0, 4)
    t1 = time.perf_counter()
    loaded_depth = estimator.load("cuda")
    times["depth_model_load_s"] = round(time.perf_counter() - t1, 4)
    if loaded_depth:
        t2 = time.perf_counter()
        depth_result = estimator.estimate(rgb)
        times["depth_inference_s"] = round(time.perf_counter() - t2, 4)
        print(f"      status={depth_result['status']}  depth_type={depth_result['depth_type']}  metric={depth_result['metric']}")
        # Try to get raw depth map from internal infer method
        t3 = time.perf_counter()
        depth_map = estimator._infer_depth_map(rgb)
        times["depth_map_extract_s"] = round(time.perf_counter() - t3, 4)
    else:
        times["depth_inference_s"] = 0
        print("      Depth model not loaded")
except Exception as e:
    times["depth_inference_s"] = round(time.perf_counter() - t0, 4)
    print(f"      Depth error: {e}")
    depth_result = {"status": "error", "depth_type": "relative", "metric": False, "warnings": [str(e)]}

# Save depth outputs
if depth_map is not None:
    np.save(os.path.join(OUT_DIR, "relative-depth.npy"), depth_map.astype(np.float32))
    depth_rgb = colourmap_depth(depth_map)
    Image.fromarray(depth_rgb).save(os.path.join(OUT_DIR, "depth.png"))
    print(f"      Saved depth.png ({depth_map.shape[1]}×{depth_map.shape[0]} px)  "
          f"min={depth_map.min():.4f} max={depth_map.max():.4f} std={depth_map.std():.4f}")
else:
    # Save a grey placeholder
    Image.fromarray(np.full((h, w), 128, dtype=np.uint8)).save(os.path.join(OUT_DIR, "depth.png"))
    print("      Depth map unavailable — saved grey placeholder")

# ── OpenCV Feature Extraction ─────────────────────────────────────────────────
print("[4/6] Running OpenCV feature extraction …")
from vision.opencv_features import extract_features

t0 = time.perf_counter()
try:
    cv_result = extract_features(rgb, mask=sam2_mask_arr, image_index=0)
    times["opencv_features_s"] = round(time.perf_counter() - t0, 4)
    print(f"      contours={len(cv_result.get('contours',[]))}  circles={len(cv_result.get('circles',[]))}  lines={len(cv_result.get('lines',[]))}")
except Exception as e:
    times["opencv_features_s"] = round(time.perf_counter() - t0, 4)
    print(f"      OpenCV error: {e}")
    cv_result = {"contours": [], "circles": [], "lines": [], "ellipses": [], "warnings": [str(e)]}

# Draw OpenCV overlays on a copy of the original
overlay_img = rgb.copy()
overlay_bgr = cv2.cvtColor(overlay_img, cv2.COLOR_RGB2BGR)

# Draw contours
for c in cv_result.get("contours", []):
    pts = np.array(c["points_px"], dtype=np.int32).reshape(-1, 1, 2)
    colour = (0, 255, 0) if c["type"] == "outer_contour" else (0, 165, 255)
    cv2.polylines(overlay_bgr, [pts], isClosed=True, color=colour, thickness=2)

# Draw circles
for circ in cv_result.get("circles", []):
    cx = int(circ["cx_px"])
    cy = int(circ["cy_px"])
    r  = int(circ["radius_px"])
    cv2.circle(overlay_bgr, (cx, cy), r, (255, 0, 0), 2)
    cv2.circle(overlay_bgr, (cx, cy), 3, (0, 0, 255), -1)

# Draw lines
for line in cv_result.get("lines", []):
    x1, y1, x2, y2 = int(line["x1_px"]), int(line["y1_px"]), int(line["x2_px"]), int(line["y2_px"])
    cv2.line(overlay_bgr, (x1, y1), (x2, y2), (0, 255, 255), 1)

opencv_rgb = cv2.cvtColor(overlay_bgr, cv2.COLOR_BGR2RGB)
Image.fromarray(opencv_rgb).save(os.path.join(OUT_DIR, "opencv.png"))
print("      Saved opencv.png")

# ── Dimensional Analysis from OpenCV ─────────────────────────────────────────
print("[5/6] Computing dimensional estimates from OpenCV circles …")

circles = cv_result.get("circles", [])
measurements = {
    "note": "All pixel measurements. Physical mm requires a known reference dimension.",
    "image_size_px": {"width": w, "height": h},
    "circle_candidates": [],
    "estimated_features": {}
}

if circles:
    # Sort by radius descending
    sorted_circles = sorted(circles, key=lambda c: c["radius_px"], reverse=True)
    for c in sorted_circles:
        measurements["circle_candidates"].append({
            "cx_px": round(c["cx_px"], 1),
            "cy_px": round(c["cy_px"], 1),
            "radius_px": round(c["radius_px"], 1),
            "diameter_px": round(c["radius_px"] * 2, 1),
            "confidence": round(c.get("confidence", 0), 3),
        })

    # Largest circle = flange OD estimate
    outer = sorted_circles[0]
    od_px = outer["radius_px"] * 2

    # Find centre bore (smallest near-centre circle)
    centre_x, centre_y = w / 2, h / 2
    near_centre = [c for c in sorted_circles
                   if abs(c["cx_px"] - centre_x) < od_px * 0.3
                   and abs(c["cy_px"] - centre_y) < od_px * 0.3
                   and c["radius_px"] < outer["radius_px"] * 0.7]
    bore = near_centre[-1] if near_centre else None  # smallest near-centre

    # Bolt holes = mid-sized circles not the OD or bore
    bolt_holes = [c for c in sorted_circles
                  if c is not outer
                  and (bore is None or c is not bore)
                  and c["radius_px"] < outer["radius_px"] * 0.4]

    measurements["estimated_features"] = {
        "flange_outer_diameter_px": round(od_px, 1),
        "centre_bore_diameter_px": round(bore["radius_px"] * 2, 1) if bore else "not detected",
        "bolt_hole_count_detected": len(bolt_holes),
        "bolt_hole_diameter_px_avg": round(
            sum(c["radius_px"] for c in bolt_holes) * 2 / len(bolt_holes), 1
        ) if bolt_holes else "n/a",
        "bolt_circle_diameter_px": "requires physical reference",
        "scale_note": (
            "To convert px→mm: measure OD with callipers, then "
            "mm_per_px = OD_mm / flange_outer_diameter_px"
        )
    }
    print(f"      OD={od_px:.1f} px  bore={bore['radius_px']*2:.1f} px  bolt_holes={len(bolt_holes)}")
else:
    print("      No circle candidates detected by OpenCV")

save_json(measurements, os.path.join(OUT_DIR, "measurements.json"))

# ── Timing summary ────────────────────────────────────────────────────────────
times["vision_pipeline_s"] = round(time.perf_counter() - t_total_start, 4)
times["device"] = "cuda"
save_json(times, os.path.join(OUT_DIR, "vision-times.json"))

analysis_time = {
    "submit_to_response_s": times["vision_pipeline_s"],
    "case": "flange"
}
save_json(analysis_time, os.path.join(OUT_DIR, "analysis-time.json"))

# ── Save vision.json (serialisable subset) ────────────────────────────────────
print("[6/6] Saving vision.json …")
vision_payload = {
    "segmentation": to_serialisable({
        "status": seg_result.get("status") if seg_result else "unavailable",
        "candidate_count": seg_result.get("candidate_count", 0) if seg_result else 0,
        "score": seg_result.get("score") if seg_result else None,
        "bbox_xyxy_px": seg_result.get("bbox_xyxy_px") if seg_result else None,
        "mask_area_ratio": seg_result.get("mask_area_ratio") if seg_result else None,
        "warnings": seg_result.get("warnings", []) if seg_result else [],
    }),
    "depth": to_serialisable({
        "status": depth_result.get("status") if depth_result else "unavailable",
        "depth_type": "relative",
        "metric": False,
        "depth_shape": list(depth_map.shape) if depth_map is not None else None,
        "depth_min": float(depth_map.min()) if depth_map is not None else None,
        "depth_max": float(depth_map.max()) if depth_map is not None else None,
        "depth_std": float(depth_map.std()) if depth_map is not None else None,
        "warnings": depth_result.get("warnings", []) if depth_result else ["depth unavailable"],
    }),
    "opencv": to_serialisable({
        "contour_count": len(cv_result.get("contours", [])),
        "circle_count": len(cv_result.get("circles", [])),
        "line_count": len(cv_result.get("lines", [])),
        "ellipse_count": len(cv_result.get("ellipses", [])),
        "contours": cv_result.get("contours", []),
        "circles": cv_result.get("circles", []),
        "lines": cv_result.get("lines", []),
        "ellipses": cv_result.get("ellipses", []),
        "warnings": cv_result.get("warnings", []),
    }),
    "timing": times,
}
save_json(vision_payload, os.path.join(OUT_DIR, "vision.json"))

print("\n✅  All outputs saved to:", OUT_DIR)
print(f"   Total pipeline time: {times['vision_pipeline_s']:.2f} s")
print(f"   SAM2 generate:       {times.get('sam2_generate_s', 'n/a')} s")
print(f"   Depth inference:     {times.get('depth_inference_s', 'n/a')} s")
print(f"   OpenCV features:     {times.get('opencv_features_s', 'n/a')} s")
