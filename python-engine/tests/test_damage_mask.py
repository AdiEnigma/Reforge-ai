import base64

import cv2
import numpy as np

from damage_mask import decode_image, generate_mask_from_bgr, _extent_from_coverage


def _alpha_from_data_url(data_url: str) -> np.ndarray:
    encoded = data_url.split(",", 1)[1]
    rgba = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), dtype=np.uint8), cv2.IMUNCHANGED if hasattr(cv2, "IMUNCHANGED") else cv2.IMREAD_UNCHANGED)
    return rgba[:, :, 3]


def _synthetic_rust_image() -> np.ndarray:
    image = np.full((240, 240, 3), 40, dtype=np.uint8)
    cv2.circle(image, (120, 120), 100, (115, 110, 105), -1)
    # A broad oxide patch with mottled texture, plus a few darker pits.
    cv2.ellipse(image, (92, 100), (55, 38), 12, 0, 360, (18, 64, 176), -1)
    rng = np.random.default_rng(7)
    region = image[70:130, 45:140].astype(np.int16)
    region += rng.integers(-18, 19, region.shape, dtype=np.int16)
    image[70:130, 45:140] = np.clip(region, 0, 255).astype(np.uint8)
    for x, y in [(70, 95), (104, 112), (122, 88)]:
        cv2.circle(image, (x, y), 3, (8, 25, 70), -1)
    return image


def test_rust_pixels_are_masked_and_clean_surface_stays_transparent():
    image = _synthetic_rust_image()
    result = generate_mask_from_bgr(image, ["rust"])

    assert result["width"] == 240
    assert result["height"] == 240
    assert result["stats"]["maskedPixels"] > 500
    assert result["stats"]["severity"] in {"moderate", "severe"}
    assert "rust" in result["stats"]["types"]

    alpha = _alpha_from_data_url(result["dataUrl"])
    assert alpha.shape == (240, 240)
    assert int(alpha[95, 80]) > 0          # rust patch centre
    assert int(alpha[120, 195]) == 0      # clean grey gear surface
    assert int(alpha[10, 10]) == 0        # background


def test_clean_component_produces_no_damage_mask():
    image = np.full((200, 200, 3), 35, dtype=np.uint8)
    cv2.circle(image, (100, 100), 75, (115, 110, 105), -1)

    result = generate_mask_from_bgr(image, [])

    assert result["stats"]["maskedPixels"] == 0
    assert result["stats"]["severity"] is None
    assert result["stats"]["types"] == []
    alpha = _alpha_from_data_url(result["dataUrl"])
    assert int(alpha.max()) == 0


def test_many_small_regions_do_not_imply_widespread_damage():
    assert _extent_from_coverage(0.04, 11, 0.10) == "localized"
    assert _extent_from_coverage(0.04, 11, 0.22) == "widespread"
    assert _extent_from_coverage(0.15, 2, 0.05) == "widespread"


def test_decoder_rejects_non_image_payload():
    import pytest

    with pytest.raises(ValueError):
        decode_image("bm90LWFuLWltYWdl")
