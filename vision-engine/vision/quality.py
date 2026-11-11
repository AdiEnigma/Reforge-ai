"""
quality.py — Per-image quality metrics using OpenCV and NumPy.
No GUI calls; headless only.
"""
from __future__ import annotations

import numpy as np
import cv2


def compute_quality(rgb: np.ndarray) -> dict:
    """
    Compute quality metrics for a single RGB image.

    Args:
        rgb: np.ndarray of shape (H, W, 3), dtype uint8

    Returns:
        dict with keys:
            blur_score         : float — Laplacian variance (higher = sharper)
            contrast_score     : float — grayscale std dev
            clipped_fraction   : float in [0, 1] — fraction of pixels near black or white
            foreground_occupancy : float in [0, 1] — estimated foreground fraction via Otsu
    """
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Blur: Laplacian variance — higher is sharper
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # Contrast: standard deviation of grayscale
    contrast_score = float(gray.std())

    # Clipped fraction: near-black (<5) or near-white (>250)
    total_pixels = gray.size
    clipped = int(np.sum(gray < 5) + np.sum(gray > 250))
    clipped_fraction = float(clipped / total_pixels) if total_pixels > 0 else 0.0

    # Foreground occupancy via Otsu thresholding
    # Otsu separates background from foreground; we use the larger class as background
    if gray.std() < 1e-3:
        # Completely flat image — no foreground
        foreground_occupancy = 0.0
    else:
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        foreground_pixels = int(np.sum(binary > 0))
        background_pixels = total_pixels - foreground_pixels
        # Pick the smaller region as "foreground" (component of interest)
        fg = min(foreground_pixels, background_pixels)
        foreground_occupancy = float(fg / total_pixels) if total_pixels > 0 else 0.0

    return {
        "blur_score": blur_score,
        "contrast_score": contrast_score,
        "clipped_fraction": clipped_fraction,
        "foreground_occupancy": foreground_occupancy,
    }
