# ReForge AI Vision Pipeline — Verification & Test Report

**Execution Date**: 2026-11-12  
**Platform**: Windows 11 AMD64  
**Python Runtime**: 3.10.11  
**Node.js Runtime**: v24.13.0  
**Hardware Mode**: CPU (Automatic hardware detection; CUDA fallback supported)

---

## 1. Summary of Test Execution

| Test Suite | Total Tests | Passed | Failed | Skipped | Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Backend Unit Tests** (`node --test`) | 45 | 45 | 0 | 0 | **PASS** |
| **Frontend Unit Tests** (`src/lib/*.test.js`) | 53 | 53 | 0 | 0 | **PASS** |
| **Frontend Production Build** (`vite build`) | 1 | 1 | 0 | 0 | **PASS** |
| **Vision Python Unit Tests** (`pytest tests/`) | 32 | 32 | 0 | 0 | **PASS** |
| **Total** | **131** | **131** | **0** | **0** | **100% PASS** |

---

## 2. Baseline & Existing Application Regression

All pre-existing ReForge AI capabilities and API contracts were tested and confirmed operational:

- `GET /api/health` — Returns status 200 and Gemini status `geminiConfigured: true`.
- `POST /api/analyze-component` — Backward-compatible contract verified:
  - When `VISION_PIPELINE_ENABLED=false` (default): Returns `{ analysis }` with exact baseline behavior.
  - When `VISION_PIPELINE_ENABLED=true`: Integrates compact `visionEvidence` into prompt and returns optional `visionDiagnostics`.
- `POST /api/chat` — ReForge AI Engineering Copilot operational.
- `POST /api/engineering-simulate` — Tested with dimension & quantity variation.
- `POST /api/engineering-sensitivity` — Tested with sensitivity gradients.
- `POST /api/manufacturing-intelligence` — Tested with parametric recipe input.
- `POST /api/material-alternatives` — Tested across mild steel, aluminium, stainless, brass, etc.
- **Frontend Build**: Vite compiled 238 modules into `frontend/dist` in 1.13s without errors.

---

## 3. Vision Python Service Test Matrix (`pytest tests/ -v`)

### A. Image I/O & Decoding (`test_image_io.py`)
- `test_valid_png`: Decodes PNG, retains original dimensions, handles RGB.
- `test_valid_jpeg`: Decodes JPEG with magic-byte verification.
- `test_valid_webp`: Decodes WebP containers.
- `test_grayscale_converts_to_rgb`: Single-channel images converted to 3-channel RGB.
- `test_rgba_converts_to_rgb`: 4-channel alpha transparency safely stripped.
- `test_invalid_base64_raises`: Rejects non-base64 characters.
- `test_corrupt_bytes_raises`: Rejects truncated or random bytes.
- `test_mime_mismatch_raises`: Detects format mismatch against magic headers.
- `test_empty_bytes_raises`: Rejects zero-byte payloads.
- `test_oversized_dimension_raises`: Enforces `VISION_MAX_IMAGE_WIDTH` / height limits.

### B. OpenCV Geometry Extraction (`test_opencv_features.py`)
- `test_flange_contour_hierarchy_preserves_inner_holes`: `RETR_TREE` hierarchy preserves center bore and bolt holes.
- `test_flange_circle_candidates`: Hough circle detector finds outer diameter within pixel tolerance.
- `test_ellipse_candidates_have_perspective_warning`: Elliptical projections tagged with perspective notice.
- `test_stepped_shaft_line_candidates`: HoughLinesP detects parallel straight segments.
- `test_truncated_component_warning`: Boundary-touching silhouettes flagged with truncation warning.
- `test_all_coordinates_are_numbers_never_strings_or_mm`: Strict assertion that all OpenCV coordinates are pixel numbers, never fabricated millimetres.

### C. Depth Contract Adherence (`test_depth_contract.py`)
- `test_depth_result_schema_contract`: Enforces `depth_type == "relative"` and `metric == false`.
- `test_missing_checkpoint_returns_unavailable`: Missing model files degrade safely without crashing.
- `test_depth_dict_contains_no_mm_keys`: Confirms zero `depth_mm` or `z_mm` keys in schema.

### D. Segmentation Wrapper (`test_segmentation.py`)
- `test_segmentor_initial_state`: Returns safe unavailable status before model load.
- `test_segmentation_result_schema`: Validates IoU score, candidate count, bounding box.
- `test_segmentation_ambiguity_flag`: Sets `needs_user_selection = True` on ambiguous proposals.

### E. API Endpoints & Adversarial Robustness (`test_api.py`, `test_adversarial_cases.py`)
- `test_health_endpoint`: `/health` responds with device and model registry status.
- `test_process_valid_image`: `/process` returns full Section 4.5 schema with `schema_version: "1.0"`.
- `test_process_too_many_images`: Rejects >8 images with HTTP 400.
- `test_process_empty_images`: Rejects empty lists with HTTP 400.
- `test_process_invalid_base64`: Rejects malformed image data with HTTP 400.
- `test_adversarial_random_bytes`: Fuzz testing with random byte noise.
- `test_adversarial_empty_payload`: Rejects empty body with HTTP 422.
- `test_adversarial_null_image_data`: Rejects null image fields with HTTP 422.
- `test_adversarial_unsupported_mime`: Rejects unsupported image formats with HTTP 422.
- `test_adversarial_negative_index`: Rejects negative indices with HTTP 422.

---

## 4. Model Checkpoints & Hardware Smoke Test Status

- **Checkpoints Location**: `vision-engine/models/` (gitignored).
- **Download Utility**: `vision-engine/scripts/download_models.py` provided with SHA256 verification.
- **Checkpoints**:
  - `sam2.1_hiera_small.pt` (Apache-2.0, ~185 MB)
  - `depth_anything_v2_vits.pth` (Apache-2.0, ~99 MB)
- **Current Real-Weight Execution Status**:
  - Real weights are **not bundled** in Git (as required by Rule 7).
  - Checkpoint smoke tests run in unit test suite with mock fallbacks and missing checkpoint resilience tests.
  - To download real weights and run real-checkpoint inference:
    ```bash
    cd vision-engine
    .venv\Scripts\python scripts/download_models.py
    ```

---

## 5. Engineering Caveats & Known Limitations

1. **Relative Depth Only**: Depth Anything V2 outputs inverse relative depth. It is physically impossible to infer millimetres, thickness, or scale from single-view monocular depth maps without a known calibrated fiducial reference.
2. **Ambiguity in Single Views**: Complex internal mechanical features (bore depth, rear keyways, internal splines) cannot be seen from front/single-view photos.
3. **Reflective Metal Surfaces**: Chrome, machined steel, or wet surfaces create specular highlights that may split contours or lower SAM 2 confidence.
4. **Scale Calibration**: Calibration is only computed when a user-supplied reference dimension matches an unambiguously detected circle or line. Otherwise, calibration status remains `uncalibrated`.
5. **No CAD Overwrite**: The vision evidence is supplementary evidence passed into Gemini prompt text. It does not replace the Three.js geometry recipe builders or the parametric CAD exporters.

