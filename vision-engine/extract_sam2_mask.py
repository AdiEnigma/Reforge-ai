"""Extract SAM2 raw masks for the flange image and save to report_case/flange/."""
import sys, os, json, time
import numpy as np
from PIL import Image
import cv2

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR   = os.path.join(REPO_ROOT, "report_case", "flange")
INPUT_IMG = os.path.join(REPO_ROOT, "test_images", "Screenshot 2026-11-16 170945.png")
sys.path.insert(0, os.path.dirname(__file__))

rgb = np.asarray(Image.open(INPUT_IMG).convert("RGB"), dtype=np.uint8).copy()
h, w = rgb.shape[:2]

# SAM2 - access raw masks directly
from vision.segmentation import SAM2Segmentor
import torch, config

# add Depth-Anything-V2 source for depth later
da2_src = config.DEPTH_ANYTHING_V2_SOURCE_DIR
if da2_src and os.path.isdir(da2_src) and da2_src not in sys.path:
    sys.path.insert(0, da2_src)

seg = SAM2Segmentor()
t0 = time.perf_counter()
seg.load("cuda")
load_s = round(time.perf_counter() - t0, 4)

t1 = time.perf_counter()
with torch.inference_mode():
    dtype = torch.float16
    with torch.autocast("cuda", dtype=dtype):
        masks = seg._mask_generator.generate(rgb)
generate_s = round(time.perf_counter() - t1, 4)

masks_sorted = sorted(masks, key=lambda m: m.get("predicted_iou", 0.0), reverse=True)
best = masks_sorted[0]
best_score = float(best["predicted_iou"])
print(f"Best score: {best_score:.4f}  area_px: {best['area']}  bbox(xywh): {best['bbox']}")
print(f"Total candidates: {len(masks_sorted)}")
print(f"SAM2 load: {load_s}s  generate: {generate_s}s")

# --- Build clean mask (remove tiny components < 0.1% of image) ---
seg_mask_raw = best["segmentation"].astype(np.uint8) * 255
num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(seg_mask_raw, connectivity=8)
min_area_px = 0.001 * h * w
clean_mask = np.zeros_like(seg_mask_raw)
for lbl in range(1, num_labels):
    if stats[lbl, cv2.CC_STAT_AREA] >= min_area_px:
        clean_mask[labels == lbl] = 255

mask_area_px   = int(np.sum(clean_mask > 0))
mask_area_ratio = round(mask_area_px / (h * w), 4)
print(f"Clean mask: {mask_area_px} px  ratio={mask_area_ratio}")

# Save binary mask
Image.fromarray(clean_mask).save(os.path.join(OUT_DIR, "sam2-mask.png"))
print("Saved sam2-mask.png")

# Save coloured overlay (green tint on detected component)
green_layer = np.zeros((h, w, 3), dtype=np.uint8)
green_layer[:, :, 1] = clean_mask
overlay = cv2.addWeighted(rgb, 0.65, green_layer, 0.5, 0)
Image.fromarray(overlay.astype(np.uint8)).save(os.path.join(OUT_DIR, "sam2-overlay.png"))
print("Saved sam2-overlay.png")

# Save top-3 candidates for reference
for i, m in enumerate(masks_sorted[:3]):
    candidate_mask = m["segmentation"].astype(np.uint8) * 255
    Image.fromarray(candidate_mask).save(os.path.join(OUT_DIR, f"sam2-candidate-{i+1}.png"))
    print(f"Saved sam2-candidate-{i+1}.png  score={m['predicted_iou']:.4f}  area={m['area']}px")

# Update vision-times.json with accurate sam2 timings
times_path = os.path.join(OUT_DIR, "vision-times.json")
with open(times_path) as f:
    times = json.load(f)
times["sam2_load_s"]     = load_s
times["sam2_generate_s"] = generate_s
times["sam2_candidate_count"] = len(masks_sorted)
times["sam2_best_score"] = round(best_score, 6)
times["sam2_mask_area_ratio"] = mask_area_ratio
with open(times_path, "w") as f:
    json.dump(times, f, indent=2)
print("Updated vision-times.json")

# Also update vision.json segmentation block
vision_path = os.path.join(OUT_DIR, "vision.json")
with open(vision_path) as f:
    vision = json.load(f)
ys_arr, xs_arr = np.where(clean_mask > 0)
bbox_xyxy = [int(xs_arr.min()), int(ys_arr.min()), int(xs_arr.max()), int(ys_arr.max())] if len(xs_arr) > 0 else None
vision["segmentation"] = {
    "status": "ambiguous",
    "candidate_count": len(masks_sorted),
    "score": round(best_score, 6),
    "bbox_xyxy_px": bbox_xyxy,
    "mask_area_ratio": mask_area_ratio,
    "needs_user_selection": True,
    "warnings": ["Multiple candidate masks with similar scores; user selection recommended"],
    "all_candidates": [
        {"rank": i+1, "predicted_iou": round(float(m["predicted_iou"]), 4), "area_px": int(m["area"])}
        for i, m in enumerate(masks_sorted)
    ]
}
with open(vision_path, "w") as f:
    json.dump(vision, f, indent=2, default=str)
print("Updated vision.json segmentation block")
print("Done.")
