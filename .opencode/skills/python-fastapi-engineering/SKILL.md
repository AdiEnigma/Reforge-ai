---
name: python-fastapi-engineering
description: Maintain the Python engineering services (vision-engine and python-engine). Covers FastAPI application architecture, endpoint design, Pydantic validation, image upload handling, Node.js integration, background execution, file management, logging, exception handling, dependency management, and GPU resource management.
---

# Python FastAPI Engineering

## Purpose

Maintain the two Python FastAPI services in the ReForge AI project: the **vision-engine** (port 8765) and the **python-engine** (port 8766). Ensure consistent API design, Pydantic validation, error handling, and integration with the Node.js backend.

## When to use

- When adding or modifying FastAPI endpoints.
- When defining request/response schemas with Pydantic.
- When handling image uploads or file management.
- When integrating with the Node.js backend.
- When managing dependencies or GPU resources.
- When debugging Python service issues.

## Project context

ReForge AI has two independent Python FastAPI services:

### Vision Engine (`vision-engine/`, port 8765)

**Purpose:** Image preprocessing — SAM 2 segmentation, OpenCV feature extraction, Depth Anything V2 depth estimation.

**Key files:**
- `app.py` — FastAPI application with `/process` and `/health` endpoints
- `config.py` — Environment variable configuration
- `schemas.py` — Pydantic v2 request/response models
- `vision/pipeline.py` — Orchestrates image processing
- `vision/model_registry.py` — Singleton model cache
- `vision/segmentation.py` — SAM2 wrapper
- `vision/depth_estimator.py` — Depth Anything V2 wrapper
- `vision/opencv_features.py` — OpenCV feature extraction
- `vision/image_io.py` — Image decoding and validation
- `vision/quality.py` — Image quality metrics

**Endpoints:**
- `POST /process` — Process 1-8 images
- `GET /health` — Health check

### Reconstruction Engine (`python-engine/`, port 8766)

**Purpose:** Geometric reconstruction and CAD generation — COLMAP SfM, SciPy solver, CadQuery CAD generation, STEP/STL export.

**Key files:**
- `app.py` — FastAPI application with reconstruction and CAD endpoints
- `recipe_validator.py` — Legacy recipe validation
- `reconstruction/multiview.py` — COLMAP SfM pipeline
- `reconstruction/geometry_solver.py` — SciPy geometric solver
- `cad/cad_generator.py` — Legacy CAD generator
- `cad/feature_modeller.py` — Advanced feature modeller
- `exports/step_export.py` — STEP export
- `exports/mesh_export.py` — STL export

**Endpoints:**
- `GET /health` — Health check
- `POST /reconstruct/multiview` — COLMAP SfM
- `POST /reconstruct/solve` — SciPy solver
- `POST /reconstruct` — End-to-end reconstruction
- `POST /cad/generate` — Legacy CAD generation
- `POST /cad/generate-advanced` — Advanced feature-based CAD generation

### FastAPI application architecture

**Standard pattern:**
```python
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(
    title="Service Name",
    description="Service description",
    version="1.0.0",
)

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors()), "error": "Invalid request payload"},
    )
```

### Request/response schemas

**Pydantic v2 models:**
```python
from pydantic import BaseModel, Field, field_validator

class ImageInput(BaseModel):
    data: str = Field(..., description="Base64-encoded image bytes")
    mimeType: str = Field(..., description="MIME type")
    image_index: int = Field(..., ge=0)

    @field_validator("mimeType")
    @classmethod
    def validate_mime(cls, v: str) -> str:
        allowed = {"image/jpeg", "image/png", "image/webp"}
        if v not in allowed:
            raise ValueError(f"mimeType must be one of {allowed}, got {v!r}")
        return v
```

**Response models:**
```python
class ProcessResponse(BaseModel):
    schema_version: str = Field("1.0")
    status: str = Field(...)
    device: DeviceInfo
    images: List[ImageResult]
    warnings: List[str] = Field(default_factory=list)
```

### Image upload handling

**Base64 decoding:**
- Images sent as base64-encoded strings (no data-URI prefix)
- Decoded to numpy arrays (H, W, 3) uint8
- Validation: MIME type, base64 validity, dimensions

**File management:**
- Temporary files cleaned up immediately
- Artifacts directory configurable via `VISION_ARTIFACTS_DIR`
- Model checkpoints in `VISION_MODELS_DIR`

### Integration with Node.js

**HTTP communication:**
- Node.js backend calls Python services via HTTP
- Adapters: `vision-adapter.js`, `reconstruction-adapter.js`
- Fail-open pattern: Node.js adapters always resolve, return `null` on failure

**Request format:**
```json
{
  "images": [
    {
      "data": "base64-data",
      "mimeType": "image/jpeg",
      "image_index": 0
    }
  ],
  "reference": { ... }
}
```

**Response format:**
```json
{
  "schema_version": "1.0",
  "status": "ok",
  "images": [ ... ],
  "warnings": [ ... ]
}
```

### Background execution

**For expensive operations:**
- Use `asyncio.wait_for()` with timeout
- Use `asyncio.Semaphore` for concurrency control
- Use `loop.run_in_executor()` for CPU-bound work
- Return immediately with job ID for long-running tasks

**Example:**
```python
async def _run_one(img_input: ImageInput) -> ImageResult:
    async with sem:
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, _process_single_image, img_input, reference),
                timeout=config.VISION_REQUEST_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            raise TimeoutError(f"Image {img_input.image_index} timed out")
```

### Logging and exception handling

**Logging:**
```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("service-name")
```

**Exception handling:**
- Custom exceptions with `to_dict()` methods
- Structured error responses with `status`, `stage`, `error` fields
- HTTP status codes: 400 (bad request), 422 (validation), 500 (server error)

### Dependency management

**Vision Engine (`requirements.txt`):**
- Pinned versions for reproducibility
- FastAPI, Pydantic, OpenCV, NumPy, Pillow, Uvicorn
- PyTorch, TorchVision, SAM 2 installed separately (hardware-specific)

**Reconstruction Engine (`requirements-cad.txt`):**
- CadQuery
- cq_gears (optional, from GitHub)

### GPU resource management

**Device selection:**
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

**Memory management:**
- Lazy loading: models loaded once per process
- Singleton registry: `registry.sam2_loaded`, `registry.depth_loaded`
- OOM handling: catch `RuntimeError` with "out of memory" message
- Autocast: use `torch.autocast` on CUDA/MPS for memory efficiency

## Best practices

1. **Use Pydantic v2** — All request/response schemas must use Pydantic v2 models
2. **Validate at boundaries** — Validate all inputs at API boundaries
3. **Fail-open by default** — Optional services should degrade gracefully
4. **Use structured errors** — Return consistent error shapes with `status`, `stage`, `error`
5. **Log at appropriate levels** — INFO for normal operations, WARNING for degraded, ERROR for failures
6. **Pin dependencies** — Use pinned versions in requirements files
7. **Manage GPU resources** — Lazy load models, handle OOM gracefully
8. **Use async where appropriate** — Async endpoints for I/O-bound operations

## Common mistakes to avoid

- **Using Pydantic v1 syntax** — The project uses Pydantic v2 (`field_validator`, not `validator`)
- **Not handling model loading failures** — Models may not be installed; always check `loaded` status
- **Ignoring OOM errors** — Catch and handle `RuntimeError` with "out of memory"
- **Creating unnecessary microservices** — The project has exactly two Python services; do not add more
- **Not using fail-open pattern** — Optional services must never break the core workflow
- **Hardcoding ports** — Use environment variables (`VISION_SERVICE_PORT`, etc.)
- **Not cleaning up temporary files** — Always clean up artifacts after processing

## Validation checklist

- [ ] FastAPI app starts correctly
- [ ] All endpoints respond with correct status codes
- [ ] Pydantic validation works for all request/response models
- [ ] Image upload handling works correctly
- [ ] Fail-open behavior tested
- [ ] Logging is informative and structured
- [ ] Exception handling returns structured errors
- [ ] Dependencies are pinned and reproducible
- [ ] GPU resource management works (device selection, OOM handling)
- [ ] Integration with Node.js backend works correctly