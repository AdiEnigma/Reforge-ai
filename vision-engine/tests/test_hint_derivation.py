"""Unit tests for the cheap SAM2 prompt hint derived from Otsu thresholding."""

from __future__ import annotations

import numpy as np

from vision.pipeline import _derive_segmentation_hint


def _part_on_background(part_value: int, background_value: int) -> np.ndarray:
    rgb = np.full((200, 200, 3), background_value, dtype=np.uint8)
    rgb[50:150, 60:160] = part_value
    return rgb


def test_hint_finds_dark_part_on_light_background():
    hint = _derive_segmentation_hint(_part_on_background(40, 235))
    assert hint is not None
    x1, y1, x2, y2 = hint["box"]
    assert 55 <= x1 <= 65 and 45 <= y1 <= 55
    assert 155 <= x2 <= 165 and 145 <= y2 <= 155
    assert 105 <= hint["point"][0] <= 115


def test_hint_finds_light_part_on_dark_background():
    hint = _derive_segmentation_hint(_part_on_background(225, 20))
    assert hint is not None
    x1, y1, x2, y2 = hint["box"]
    assert x2 - x1 < 150 and y2 - y1 < 150


def test_hint_rejects_uniform_image():
    rgb = np.full((200, 200, 3), 128, dtype=np.uint8)
    assert _derive_segmentation_hint(rgb) is None
