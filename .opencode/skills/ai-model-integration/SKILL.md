---
name: ai-model-integration
description: Manage pretrained AI models efficiently. Covers loading pretrained checkpoints, SAM 2 inference, optional Depth Anything V2 inference, model compatibility and version pinning, GPU/CPU selection, VRAM and RAM management, lazy loading, inference batching, model lifecycle management, licensing verification, and avoiding redundant model integration.
---

# AI Model Integration

## Purpose

Manage pretrained AI models efficiently in the ReForge AI project. Ensure models are loaded correctly, used appropriately, and managed throughout their lifecycle without redundant integration or unnecessary training.

## When to use

- When loading or managing AI models.
- When adding new model integrations.
- When configuring GPU/CPU selection.
- When managing VRAM/RAM usage.
- When verifying model licenses.
- When debugging model loading or inference issues.

## Project context

ReForge AI integrates two pretrained AI models:

### SAM 2.1 (Segment Anything Model 2.1)

**Purpose:** Component segmentation — isolate mechanical components from uploaded photographs.

**Configuration:**
- Variant: `sam2.1_hiera_small` (~46M parameters)
- Checkpoint: `sam2.1_hiera_small.pt` (~185 MB)
- Config: `sam2.1_hiera_s.yaml`
- License: Apache-2.0
- Download URL: `https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt`
- SHA256: `47333a5cf0f23ba5b550dd7eb762b322a30ba5be669b7b9db893444458514930`

**Code location:** `vision-engine/vision/segmentation.py`

**Loading:**
```python
class SAM2Segmentor:
    def load(self, device: str) -> bool:
        # Loads checkpoint from VISION_MODELS_DIR
        # Returns True if loaded successfully, False otherwise
```

**Inference:**
```python
result = registry.sam2.segment(rgb)
# Returns dict with status, bbox_xyxy_px, mask_area_ratio, candidate_count, score, etc.
```

### Depth Anything V2 Small

**Purpose:** Relative depth estimation — provides depth cues for geometric reasoning.

**Configuration:**
- Variant: `vits` (Small only, ~24.8M parameters)
- Checkpoint: `depth_anything_v2_vits.pth` (~99 MB)
- License: Apache-2.0 (Small variant only)
- Download URL: `https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth`
- SHA256: `5c4232ec39178c772e0989f6d4d12543e33918aa08381dd00676451e6ba5f617`

**CRITICAL LICENSING CONSTRAINT:**
- Only Small (`vits`) checkpoint is Apache-2.0 licensed
- Base, Large, and Giant checkpoints are CC-BY-NC-4.0 (non-commercial)
- **Never download or substitute Base, Large, or Giant checkpoints**

**Code location:** `vision-engine/vision/depth_estimator.py`

**Inference:**
```python
result = registry.depth.estimate(rgb, mask=mask)
# Returns dict with status, depth_type="relative", metric=False, etc.
```

**CRITICAL USAGE CONSTRAINT:**
- Depth Anything V2 produces **relative inverse-depth**, NOT metric measurements
- Output values are unitless rankings of relative distance
- Must NEVER be interpreted as millimetres (mm)
- All API responses explicitly return `depth_type: "relative"` and `metric: false`

### Gemini API

**Purpose:** Interpret geometric evidence and generate structured feature hypotheses.

**Configuration:**
- Model: `gemini-2.0-flash` (default, configurable via `GEMINI_MODEL`)
- API key: `GEMINI_API_KEY` environment variable (server-side only)
- SDK: `@google/generative-ai` (`^0.24.1`)

**Code location:** `backend/gemini.js`

**Usage:**
- Gemini interprets visual evidence and returns structured analysis
- Gemini does NOT generate final CAD geometry
- Gemini generates feature hypotheses and recipe data

### Model loading and lifecycle

**Lazy loading:**
- Models loaded once per process at startup
- Singleton registry: `registry.sam2_loaded`, `registry.depth_loaded`
- Models not loaded until `registry.initialize()` is called

**Device resolution:**
```python
def _resolve_device() -> str:
    device = config.VISION_DEVICE
    if device != "auto":
        return device
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"
```

**Model status:**
- Health endpoint reports `sam2_loaded`, `depth_loaded`, device
- Models excluded from git via `.gitignore`
- Checkpoints downloaded via `python scripts/download_models.py`

### GPU/CPU selection

**Device options:**
- `auto` — Automatically select best available device
- `cuda` — NVIDIA GPU
- `mps` — Apple Silicon GPU
- `cpu` — CPU only

**VRAM management:**
- Lazy loading: models loaded once per process
- Autocast: use `torch.autocast` on CUDA/MPS for memory efficiency
- OOM handling: catch `RuntimeError` with "out of memory" message
- Concurrency limit: `VISION_MAX_CONCURRENCY` (default 2)

### Model compatibility and version pinning

**Pinned versions:**
- SAM 2: commit `2b90b9f5ceec907a1c18123530e92e794ad901a4`
- Depth Anything V2: commit `a561b849ebae10a6f5ef49e26c83cbbcd36c71bf`
- PyTorch: `torch==2.14.1 torchvision==0.29.2` (CPU pair)

**Version verification:**
- Checkpoint SHA256 verification during download
- Model config version matching
- Dependency version pinning in requirements files

### Licensing verification

**SAM 2.1:** Apache-2.0 — Commercial use permitted
**Depth Anything V2 Small:** Apache-2.0 — Commercial use permitted
**Depth Anything V2 Base/Large/Giant:** CC-BY-NC-4.0 — Non-commercial only

**Verification steps:**
1. Only download Small (`vits`) variant of Depth Anything V2
2. Verify SHA256 checksums after download
3. Check model licenses before commercial deployment
4. Document model provenance in MODEL_NOTICES.md

### Avoiding redundant model integration

**Do not integrate:**
- TripoSR — Not part of core reconstruction pipeline
- Hunyuan3D — Not part of core reconstruction pipeline
- TRELLIS — Not part of core reconstruction pipeline
- Custom vision models — Do not train custom models during initial implementation

**Do integrate:**
- SAM 2 — Component segmentation
- Depth Anything V2 — Relative depth estimation (optional)
- Gemini — Geometric evidence interpretation

## Best practices

1. **Use pretrained checkpoints** — Do not train custom models during initial implementation
2. **Pin model versions** — Use specific commits and checkpoint versions
3. **Verify licenses** — Check licenses before commercial deployment
4. **Lazy load models** — Load models once per process, not per request
5. **Manage GPU resources** — Use autocast, handle OOM, limit concurrency
6. **Fail-open** — Model failures should not break user analysis
7. **Verify checkpoints** — Check SHA256 checksums after download
8. **Document provenance** — Record model sources and licenses

## Common mistakes to avoid

- **Training custom models** — Do not train custom vision models during initial implementation
- **Integrating unnecessary 3D-generation models** — Do not integrate TripoSR, Hunyuan3D, or TRELLIS
- **Using wrong Depth Anything V2 variant** — Only Small (`vits`) is Apache-2.0 licensed
- **Interpreting relative depth as metric** — Depth Anything V2 is relative only
- **Loading models per request** — Use singleton registry for lazy loading
- **Not handling OOM** — Catch and handle out-of-memory errors
- **Not verifying checkpoints** — Always verify SHA256 checksums

## Validation checklist

- [ ] SAM 2 model loads correctly on target device
- [ ] Depth Anything V2 loads correctly on target device
- [ ] Model licenses verified (Apache-2.0 for both)
- [ ] Checkpoint SHA256 checksums verified
- [ ] Lazy loading works correctly
- [ ] OOM handling works correctly
- [ ] Fail-open behavior tested
- [ ] Model status reported in health endpoint
- [ ] No redundant model integrations
- [ ] No custom model training