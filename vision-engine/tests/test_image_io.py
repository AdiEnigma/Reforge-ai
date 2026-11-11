"""
test_image_io.py — Test image decoding, validation, format handling, and error rejection.
"""
import base64
import io
import pytest
from PIL import Image

from schemas import ImageInput
from vision.image_io import decode_and_validate_image


def make_b64_image(format: str = "PNG", size: tuple[int, int] = (100, 100), mode: str = "RGB", color="red") -> str:
    img = Image.new(mode, size, color=color)
    buf = io.BytesIO()
    img.save(buf, format=format)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_valid_png():
    b64 = make_b64_image("PNG", (200, 150))
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    res = decode_and_validate_image(inp)
    assert res["original_width"] == 200
    assert res["original_height"] == 150
    assert res["rgb"].shape == (150, 200, 3)
    assert res["orientation_applied"] is False


def test_valid_jpeg():
    b64 = make_b64_image("JPEG", (120, 80))
    inp = ImageInput(data=b64, mimeType="image/jpeg", image_index=1)
    res = decode_and_validate_image(inp)
    assert res["original_width"] == 120
    assert res["original_height"] == 80
    assert res["rgb"].shape == (80, 120, 3)


def test_valid_webp():
    b64 = make_b64_image("WEBP", (90, 90))
    inp = ImageInput(data=b64, mimeType="image/webp", image_index=2)
    res = decode_and_validate_image(inp)
    assert res["original_width"] == 90
    assert res["original_height"] == 90


def test_grayscale_converts_to_rgb():
    b64 = make_b64_image("PNG", (64, 64), mode="L", color=128)
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    res = decode_and_validate_image(inp)
    assert res["rgb"].ndim == 3
    assert res["rgb"].shape == (64, 64, 3)


def test_rgba_converts_to_rgb():
    b64 = make_b64_image("PNG", (64, 64), mode="RGBA", color=(255, 0, 0, 128))
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    res = decode_and_validate_image(inp)
    assert res["rgb"].shape == (64, 64, 3)


def test_invalid_base64_raises():
    inp = ImageInput(data="not_valid_base64!@#$%", mimeType="image/png", image_index=0)
    with pytest.raises(ValueError, match="Invalid base64"):
        decode_and_validate_image(inp)


def test_corrupt_bytes_raises():
    b64 = base64.b64encode(b"random-non-image-data-string").decode("ascii")
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    with pytest.raises(ValueError, match="magic bytes do not match"):
        decode_and_validate_image(inp)


def test_mime_mismatch_raises():
    # JPEG bytes declared as PNG
    b64 = make_b64_image("JPEG", (50, 50))
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    with pytest.raises(ValueError, match="magic bytes do not match"):
        decode_and_validate_image(inp)


def test_empty_bytes_raises():
    b64 = base64.b64encode(b"").decode("ascii")
    inp = ImageInput(data=b64, mimeType="image/jpeg", image_index=0)
    with pytest.raises(ValueError, match="empty"):
        decode_and_validate_image(inp)


def test_oversized_dimension_raises(monkeypatch):
    import config
    monkeypatch.setattr(config, "VISION_MAX_IMAGE_WIDTH", 100)
    b64 = make_b64_image("PNG", (200, 50))
    inp = ImageInput(data=b64, mimeType="image/png", image_index=0)
    with pytest.raises(ValueError, match="width.*exceeds limit"):
        decode_and_validate_image(inp)

