# ReForge AI — Vision Preprocessing Engine

The ReForge Vision Preprocessing Engine is an internal microservice providing **SAM 2.1** component segmentation, **OpenCV** geometric feature extraction, and **Depth Anything V2 Small** relative depth estimation to supply high-confidence visual evidence to ReForge AI's Gemini analysis pipeline.

> [!NOTE]
> This service is optional and designed to **fail open**. If this service is offline or models are unavailable, ReForge AI seamlessly uses the direct Gemini multimodal pipeline.

---

## 1. System Requirements

- **Python**: `3.13` (the repository uses one shared root virtual environment)
- **RAM**: Minimum 8 GB (16 GB recommended for local GPU/CUDA execution)
- **Disk Space**: ~2 GB for model weights
- **OS**:
  - Linux (Ubuntu 22.04+ recommended)
  - Windows 10/11 (CUDA PyTorch runs natively; SAM2 recommends WSL2 for its optional CUDA extension)
  - macOS (Apple Silicon / MPS supported)

---

## 2. Setup & Installation

### Step 1: Use the shared repository virtual environment
```powershell
# From the repository root (Python 3.13 must be installed):
uv venv .venv --python 3.13
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

### Step 2: Install dependencies
```powershell
# Install the CUDA PyTorch pair on NVIDIA Windows systems:
uv pip install --python .venv/Scripts/python.exe torch torchvision --index-url https://download.pytorch.org/whl/cu128

# Install the pinned SAM 2.1 code. On Windows, skip building SAM2's optional CUDA extension:
$env:SAM2_BUILD_CUDA = "0"
uv pip install --python .venv/Scripts/python.exe -r vision-engine/requirements-vision-ml.txt
```

The shared root requirements include the Vision, reconstruction and CAD runtime packages. Keep these services in the same `.venv`; their Python packages were resolved together for Python 3.13.

The official Depth Anything V2 repository has no `pyproject.toml` or `setup.py`; its documented setup is a source checkout plus its requirements. ReForge pins the official source to commit `a561b849ebae10a6f5ef49e26c83cbbcd36c71bf` in the ignored project-local `.dependencies/Depth-Anything-V2` path. With Git available, run from `vision-engine`:

```powershell
..\.venv\Scripts\python.exe .\scripts\install_depth_anything_v2.py
```

At runtime `vision/depth_estimator.py` imports `depth_anything_v2.dpt.DepthAnythingV2` and the official `depth_anything_v2.util.transform` preprocessing classes from that checkout. Its transitive source imports include `dinov2.py`, `dinov2_layers/*`, and `util/blocks.py`. The model's inference dependencies (`torch`, `torchvision`, OpenCV, and NumPy) are already project requirements; upstream Gradio demo packages are not needed by this service. The default source path is resolved from the project directory, so no `PYTHONPATH` or temporary `C:\Temp` checkout is required. `DEPTH_ANYTHING_V2_SOURCE_DIR` remains an optional override.

---

## 3. Download Model Weights

Run the official download utility with checksum verification:

```powershell
..\.venv\Scripts\python.exe .\scripts\download_models.py
```

This downloads:
- `sam2.1_hiera_small.pt` (~185 MB) into `vision-engine/models/`
- `depth_anything_v2_vits.pth` (~99 MB) into `vision-engine/models/`

> See [MODEL_NOTICES.md](../MODEL_NOTICES.md) for full licensing information (both models Apache-2.0).

---

## 4. Running the Service

Start the Uvicorn server bound to localhost (`127.0.0.1:8765`):

```bash
..\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
```

### Verify Health
```bash
curl http://127.0.0.1:8765/health
```

Expected response:
```json
{
  "ok": true,
  "service": "reforge-vision-engine",
  "device": {
    "requested": "auto",
    "actual": "cpu",
    "sam2_loaded": false,
    "depth_loaded": false
  },
  "config": {
    "pipeline_enabled": false,
    "fail_open": true,
    "max_concurrency": 2,
    "request_timeout": 60
  }
}
```

---

## 5. Environment Configuration

All settings can be configured via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VISION_SERVICE_HOST` | `127.0.0.1` | Bind address (loopback only) |
| `VISION_SERVICE_PORT` | `8765` | Service port |
| `VISION_PIPELINE_ENABLED` | `false` | Enable or disable vision preprocessing |
| `VISION_FAIL_OPEN` | `true` | If true, errors degrade safely without failing user analysis |
| `VISION_DEVICE` | `auto` | Target device: `auto`, `cuda`, `mps`, or `cpu` |
| `VISION_MAX_CONCURRENCY` | `2` | Bounded semaphore for simultaneous inferences |
| `VISION_REQUEST_TIMEOUT_SECONDS` | `60` | Per-request timeout |
| `VISION_SAM2_ENABLED` | `true` | Enable SAM2 segmentation when model is present |
| `VISION_DEPTH_ENABLED` | `true` | Enable Depth Anything V2 when model is present |
| `DEPTH_ANYTHING_V2_SOURCE_DIR` | `vision-engine/.dependencies/Depth-Anything-V2` | Optional override for the pinned official Depth Anything V2 source checkout |

---

## 6. Running Tests

```bash
cd vision-engine

# Generate synthetic mechanical fixtures
python tests/fixtures/generate_synthetic_fixtures.py

# Run all test suites
pytest tests/ -v
```

---

## 7. Integration with Node.js Backend

In `backend/.env.local`, set:
```env
VISION_PIPELINE_ENABLED=true
VISION_SERVICE_URL=http://127.0.0.1:8765
VISION_FAIL_OPEN=true
```

When enabled, `POST /api/analyze-component` automatically queries the vision service, extracts compact geometry hints, and embeds structured visual evidence into the Gemini prompt.

