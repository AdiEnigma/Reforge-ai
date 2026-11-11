"""
image_io.py — Base64 decode, EXIF orient, format validation, quality metrics.

All public functions raise ValueError with a descriptive message on failure.
"""
from __future__ import annotations

import base64
import io
import struct
from typing import Tuple

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

try:
    from PIL import DecompressionBombError as _DBE
except ImportError:
    _DBE = Exception  # fallback for very old Pillow

import config
from schemas import ImageInput


# ---------------------------------------------------------------------------
# Magic-byte signatures
# ---------------------------------------------------------------------------
_JPEG_MAGIC = b"\xff\xd8"
_PNG_MAGIC = b"\x89PNG"
_WEBP_RIFF = b"RIFF"
_WEBP_WEBP = b"WEBP"

_ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}

# Default model inference target size (longest edge)
_MODEL_MAX_EDGE = 1024


def _verify_magic(raw: bytes, mime_type: str) -> None:
    """Raise ValueError if raw bytes do not match the declared MIME type."""
    if mime_type == "image/jpeg":
        if not raw[:2] == _JPEG_MAGIC:
            raise ValueError("Declared image/jpeg but magic bytes do not match JPEG signature (\\xff\\xd8)")
    elif mime_type == "image/png":
        if not raw[:4] == _PNG_MAGIC:
            raise ValueError("Declared image/png but magic bytes do not match PNG signature (\\x89PNG)")
    elif mime_type == "image/webp":
        if raw[:4] != _WEBP_RIFF or raw[8:12] != _WEBP_WEBP:
            raise ValueError("Declared image/webp but magic bytes do not match RIFF…WEBP signature")
    else:
        raise ValueError(f"Unsupported MIME type {mime_type!r}. Allowed: {_ALLOWED_MIME}")


def _decode_base64(data: str) -> bytes:
    """Strict base64 decode — no padding tricks, raises ValueError on failure."""
    # Strip optional data-URI prefix if present (e.g. "data:image/png;base64,")
    if "," in data:
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception as exc:
        raise ValueError(f"Invalid base64 encoding: {exc}") from exc
    if len(raw) == 0:
        raise ValueError("Image data is empty (zero bytes after base64 decode)")
    return raw


def _resize_for_model(image: Image.Image) -> Tuple[Image.Image, float, float]:
    """
    Resize image so that the longest edge is at most _MODEL_MAX_EDGE pixels.
    Returns (resized_image, scale_x, scale_y) where scale_* maps working coords
    back to original coords.
    """
    orig_w, orig_h = image.size
    longest = max(orig_w, orig_h)
    if longest <= _MODEL_MAX_EDGE:
        return image, 1.0, 1.0
    scale = _MODEL_MAX_EDGE / longest
    new_w = max(1, int(orig_w * scale))
    new_h = max(1, int(orig_h * scale))
    resized = image.resize((new_w, new_h), Image.LANCZOS)
    # scale_x/y: working → original
    scale_x = orig_w / new_w
    scale_y = orig_h / new_h
    return resized, scale_x, scale_y


def decode_and_validate_image(image_input: ImageInput) -> dict:
    """
    Decode and validate a single ImageInput.

    Returns a dict with keys:
        rgb              : np.ndarray  (H, W, 3)  uint8, full-resolution
        original_width   : int
        original_height  : int
        orientation_applied : bool
        working_rgb      : np.ndarray  (H', W', 3)  uint8, possibly resized
        scale_x          : float  (working → original X)
        scale_y          : float  (working → original Y)

    Raises ValueError with a descriptive message on any validation failure.
    """
    mime = image_input.mimeType

    # 1. Validate MIME type
    if mime not in _ALLOWED_MIME:
        raise ValueError(f"Unsupported MIME type {mime!r}. Allowed: {_ALLOWED_MIME}")

    # 2. Decode base64
    raw = _decode_base64(image_input.data)

    # 3. Verify magic bytes
    _verify_magic(raw, mime)

    # 4. Open with Pillow (catches decompression bombs)
    try:
        pil_img = Image.open(io.BytesIO(raw))
        pil_img.verify()  # consume the full stream to catch truncation
    except _DBE as exc:
        raise ValueError(f"Decompression bomb detected: {exc}") from exc
    except (UnidentifiedImageError, Exception) as exc:
        raise ValueError(f"Cannot open image (corrupt or unsupported format): {exc}") from exc

    # Re-open after verify (verify closes the file object)
    try:
        pil_img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise ValueError(f"Cannot re-open image after verify: {exc}") from exc

    # 5. Apply EXIF orientation
    orientation_applied = False
    try:
        exif = pil_img.getexif()
        # EXIF orientation tag is 0x0112 (274)
        if exif and 0x0112 in exif and exif[0x0112] not in (1, 0, None):
            transposed = ImageOps.exif_transpose(pil_img)
            if transposed is not pil_img:
                pil_img = transposed
                orientation_applied = True
    except Exception:
        pass  # If EXIF transpose fails, continue without it

    # 6. Convert to RGB
    if pil_img.mode != "RGB":
        pil_img = pil_img.convert("RGB")

    orig_w, orig_h = pil_img.size

    # 7. Check dimension limits
    if orig_w > config.VISION_MAX_IMAGE_WIDTH:
        raise ValueError(
            f"Image width {orig_w}px exceeds limit {config.VISION_MAX_IMAGE_WIDTH}px"
        )
    if orig_h > config.VISION_MAX_IMAGE_HEIGHT:
        raise ValueError(
            f"Image height {orig_h}px exceeds limit {config.VISION_MAX_IMAGE_HEIGHT}px"
        )
    if orig_w * orig_h > config.VISION_MAX_IMAGE_PIXELS:
        raise ValueError(
            f"Image pixel count {orig_w * orig_h} exceeds limit {config.VISION_MAX_IMAGE_PIXELS}"
        )

    # 8. Convert to numpy
    rgb = np.array(pil_img, dtype=np.uint8)

    # 9. Create working copy (downscale for model inference if needed)
    working_pil, scale_x, scale_y = _resize_for_model(pil_img)
    working_rgb = np.array(working_pil, dtype=np.uint8)

    return {
        "rgb": rgb,
        "original_width": orig_w,
        "original_height": orig_h,
        "orientation_applied": orientation_applied,
        "working_rgb": working_rgb,
        "scale_x": scale_x,
        "scale_y": scale_y,
    }
