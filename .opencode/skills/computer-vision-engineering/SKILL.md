---
name: computer-vision-engineering
description: Implement the image-processing pipeline using SAM 2 for component segmentation, OpenCV for geometric feature extraction, and Depth Anything V2 for relative depth estimation. Covers model loading, inference, preprocessing, mask validation, and integration with Node.js backend.
---

# Computer Vision Engineering

## Purpose

Implement the image-processing pipeline that converts uploaded component photographs into structured geometric evidence for the Gemini analysis pipeline. Covers SAM 2 integration, OpenCV feature extraction, Depth Anything V2 depth estimation, and efficient GPU/CPU execution.

## When to use

- When building or modifying the vision preprocessing service.
- When adding new image features to the pipeline.
- When integrating vision evidence into Gemini prompts.
- When handling model loading, inference, and error cases.
- When configuring environment variables and device selection.

## Project context

The vision preprocessing service runs as a separate FastAPI microservice on `127.0.0.1:8765`. It is **optional and fail-open** — when disabled or unavailable, the Gemini-only path continues unchanged. The pipeline processes 1-8 images per request through SAM 2 segmentation, OpenCV feature extraction, and Depth Anything V2 depth estimation.

### Pipeline overview

```
POST /process
    │
    ▼
image_io.decode_and_validate_image()
    │
    ▼
compute_quality(rgb) → Quality metrics
    │
    ▼
SAM2 segmentation → SegmentationResult
    │
    ▼
OpenCV feature extraction → OpenCVResult
    │
    ▼
Depth Anything V2 → DepthResult (relative only!)
    │
    ▼
_calibration(reference, cv_dict) → CalibrationResult
    │
    ▼
ImageResult (full structured output)
```

### Model loading and lifecycle

**SAM 2.1 Small checkpoint:**
- Filename: `sam2.1_hiera_small.pt` (~185 MB)
- Config: `sam2.1_hiera_s.yaml`
- Loaded via `SAM2Segmentor.load(device)` → returns bool
- Device resolution: `config.VISION_DEVICE` (auto, cuda, mps, cpu)
- Lazy loading: singleton `registry.sam2_loaded` tracks status
- Models excluded from git via `.gitignore`

**Depth Anything V2 Small checkpoint:**
- Filename: `depth_anything_v2_vits.pth` (~99 MB)
- Only Small variant is Apache-2.0 licensed
- Base/Large/Giant under CC-BY-NC-4.0 — **never substitute**
- Loaded via `DepthEstimator.load(device)` → returns bool
- Device resolution same as SAM 2
- Source checkout from pinned commit `a561b849ebae10a6f5ef49e26c83cbbcd36c71bf`

### Environment configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_PIPELINE_ENABLED` | `false` | Enable vision preprocessing |
| `VISION_SAM2_ENABLED` | `true` | Enable SAM2 segmentation |
| `VISION_DEPTH_ENABLED` | `true` | Enable Depth Anything V2 |
| `VISION_DEVICE` | `auto` | Target device |
| `VISION_MAX_CONCURRENCY` | `2` | Semaphore bound |
| `VISION_REQUEST_TIMEOUT_SECONDS` | `60` | Per-request timeout |
| `VISION_FAIL_OPEN` | `true` | Fail-open behavior |
| `VISION_SERVICE_HOST` | `127.0.0.1` | Bind address |
| `VISION_SERVICE_PORT` | `8765` | Service port |
| `DEPTH_ANYTHING_V2_SOURCE_DIR` | `./.dependencies/Depth-Anything-V2` | Source checkout path |

### Image preprocessing

**RGB/BGR handling:**
- Images decoded from base64 → numpy array (H, W, 3) uint8
- Working copy for model inference
- Original dimensions preserved for coordinate scaling

**Mask scaling:**
- SAM2 bbox scaled back to original image coordinates if downsampling occurred
- Scale factors from `image_io.decode_and_validate_image()`

**Mask validation:**
- Remove small isolated components (< 0.1% of image area)
- Connected components with 8-connectivity
- Bounding box from clean mask

### OpenCV feature extraction

**Edge detection and contours:**
- Contour extraction via `cv2.findContours`
- Feature metadata: type, image_index, points_px, area_px², perimeter_px, circularity, solidity, hierarchy_level, confidence

**Circle detection:**
- `cv2.HoughCircles` or equivalent
- CircleCandidate: cx_px, cy_px, radius_px, confidence, provenance

**Ellipse detection:**
- EllipseCandidate: cx_px, cy_px, axes_px, angle_deg, confidence

**Line detection:**
- LineCandidate: x1_px, y1_px, x2_px, y2_px, length_px, angle_deg, confidence

**Bounding box:**
- Axis-aligned or rotated bounding box around primary component

**Symmetry hints:**
- Bilateral / rotational symmetry detection

### Depth Anything V2 integration

**CRITICAL: Relative depth only — never metric**

```python
DepthResult fields:
  status: "ok" | "low_quality" | "unavailable"
  depth_type: "relative"  # Always!
  metric: False  # Always False!
  warnings: ["Relative depth only; not a measurement in millimetres."]
```

- Output values are unitless rankings of relative distance
- Must NEVER be interpreted as millimetres (mm)
- All API responses explicitly return `depth_type: "relative"` and `metric: false`
- Never use for establishing CAD dimensions, plate thickness, face width, or bore depth

### Feature candidates and image-coordinate preservation

**Coordinate scaling:**
- SAM2 operates on potentially downsampled working_rgb
- Bounding boxes scaled back to original image coordinates using scale_x, scale_y
- All pixel coordinates must preserve original image coordinate system

**Mask preservation:**
- SAM2 masks scaled to original image dimensions
- Used as ROI for OpenCV feature extraction
- bbox_xyxy_px in original coordinates

### Integration with Node.js backend

**HTTP communication:**
- Vision service: `POST /process` on `VISION_SERVICE_URL` (default `127.0.0.1:8765`)
- Backend adapter: `vision-adapter.js` with fail-open pattern

**Request payload:**
```json
{
  "images": [
    {
      "data": "base64-data",
      "mimeType": "image/jpeg",
      "image_index": 0
    }
  ],
  "reference": {
    "outerDiameter": 20.0,
    "innerDiameter": 5.0
  }
}
```

**Response schema:**
```json
{
  "schema_version": "1.0",
  "status": "ok",
  "device": {
    "requested": "auto",
    "actual": "cpu",
    "sam2_loaded": true,
    "depth_loaded": true
  },
  "images": [
    {
      "image_index": 0,
      "width": 1920,
      "height": 1080,
      "quality": { ... },
      "segmentation": {
        "status": "ok",
        "bbox_xyxy_px": [x1, y1, x2, y2],
        "mask_area_ratio": 0.65,
        "candidate_count": 1,
        "score": 0.98,
        "needs_user_selection": false
      },
      "opencv": {
        "contour_count": 5,
        "circle_count": 1,
        "ellipse_count": 0,
        "line_count": 3,
        "bounding_box": { ... },
        "symmetry_hints": { ... }
      },
      "depth": {
        "status": "ok",
        "depth_type": "relative",
        "metric": false,
        "warnings": ["Relative depth only; not a measurement in millimetres."]
      },
      "calibration": {
        "status": "uncalibrated",
        "mm_per_pixel": null,
        "source": null,
        "confidence": 0.0,
        "warnings": ["No reliable single-view reference calibration match found; uncalibrated."]
      }
    }
  ],
  "warnings": ["Vision processing took 4.2s"]
}
```

### Error handling and fail-open

**Always resolves (never rejects):**
- `callVisionService()` in `vision-adapter.js` always resolves, returns `null` on any failure
- `process_images()` in `pipeline.py` uses `VISION_FAIL_OPEN` flag
- If `VISION_FAIL_OPEN=true` (default): errors degrade gracefully, analysis continues with Gemini only
- If `VISION_FAIL_OPEN=false`: errors propagate as 500

**Error categories:**
- SAM2 OOM during inference → warning, return unavailable status
- Depth Anything V2 error → warning, return unavailable status
- Model not loaded → status "unavailable"
- Invalid input → 400 error (not fail-open)
- Timeout → handled via asyncio.wait_for

### Best practices

1. **Never interpret monocular depth as real-world dimensions** — Depth Anything V2 is relative only
2. **Use fail-open by default** — Vision errors should not break user analysis
3. **Preserve image coordinates** — Scale all pixel values back to original image dimensions
4. **Track model loading status** — `sam2_loaded`, `depth_loaded` must be checked before inference
5. **Limit concurrency** — Use semaphore (`VISION_MAX_CONCURRENCY`, default 2)
6. **Set reasonable timeouts** — Per-request timeout via `VISION_REQUEST_TIMEOUT_SECONDS` (default 60s)
7. **Log model status** — Health endpoint reports `sam2_loaded`, `depth_loaded`, device

### Common mistakes to avoid

- **Interpreting relative depth as metric measurements** — This is the most critical error; all depth data has explicit warnings
- **Loading models without checking device availability** — Always check `torch.cuda.is_available()` or `torch.backends.mps.is_available()`
- **Skipping model checkpoint downloads** — Checkpoints must be downloaded via `python scripts/download_models.py`
- **Using Base/Large/Giant Depth Anything V2 checkpoints** — Only Small (`vits`) is Apache-2.0 licensed
- **Overriding fail-open behavior without understanding consequences** — `VISION_FAIL_OPEN=false` will cause errors to propagate
- **Not preserving coordinate scaling** — SAM2 operates on potentially downsampled images; all outputs must be scaled back
- **Running both vision services on the same port** — Vision Engine uses 8765, Reconstruction uses 8766; do not conflict

## Validation checklist

- [ ] SAM 2 model loads and segments correctly
- [ ] Depth Anything V2 loads and returns relative depth only
- [ ] OpenCV features extracted and counted correctly
- [ ] All pixel coordinates preserve original image dimensions
- [ ] Calibration only occurs with reliable single-view reference match
- [ ] Feature confidence scores properly tracked
- [ ] Warnings about relative depth included in all responses
- [ ] Model loading status reported in health endpoint
- [ ] Fail-open behavior tested and working
- [ ] Concurrency limited by semaphore
- [ ] Timeouts handled correctly
- [ ] Environment variables configured with safe defaults