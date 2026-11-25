"""
tooth_count.py — automatic gear tooth counting from one component image.

The detector does not use a preset tooth-count list. It derives candidate
periodicity from the image itself and requires independent methods to agree
before it reports a count. Shadows, rust and uneven lighting are handled by
using a segmentation mask when available, CLAHE + Canny otherwise, radial
band limitation, ellipse normalisation and high-pass filtering.

All coordinates and radii are in pixels. No millimetre values are produced.
"""
from __future__ import annotations

import logging
import math
from typing import List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_ANGLE_SAMPLES = 720
_RADIAL_BINS = 256
_MIN_RADIUS_PX = 16.0
_MIN_CONTOUR_AREA = 220.0
_MIN_METHODS_FOR_COUNT = 2


def _circular_convolve(values: np.ndarray, sigma_bins: float) -> np.ndarray:
    size = int(max(5, round(sigma_bins * 6)) | 1)
    offsets = np.arange(-size // 2, size // 2 + 1)
    kernel = np.exp(-0.5 * (offsets / max(sigma_bins, 1e-6)) ** 2)
    kernel /= kernel.sum()
    spectrum = np.fft.rfft(values)
    kernel_spectrum = np.fft.rfft(kernel, n=len(values))
    return np.fft.irfft(spectrum * kernel_spectrum, n=len(values)).real


def _circular_moving_average(values: np.ndarray, window: int) -> np.ndarray:
    window = max(3, int(window) | 1)
    kernel = np.ones(window, dtype=float) / window
    spectrum = np.fft.rfft(values)
    kernel_spectrum = np.fft.rfft(kernel, n=len(values))
    return np.fft.irfft(spectrum * kernel_spectrum, n=len(values)).real


def _blank_result(image_index: int, reason: str) -> dict:
    return {
        "image_index": image_index,
        "status": "unavailable",
        "count": None,
        "confidence": 0.0,
        "center_px": None,
        "outer_radius_px": None,
        "methods": [],
        "teeth": [],
        "warnings": [reason],
    }


def _foreground_mask(rgb: np.ndarray, supplied_mask: Optional[np.ndarray]) -> np.ndarray:
    if supplied_mask is not None:
        mask = np.asarray(supplied_mask) > 0
        if mask.shape[:2] == rgb.shape[:2] and int(np.count_nonzero(mask)) > _MIN_CONTOUR_AREA:
            return mask.astype(np.uint8) * 255

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(clahe, (7, 7), 0)
    candidates = []
    for mode in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
        _, raw = cv2.threshold(blurred, 0, 255, mode + cv2.THRESH_OTSU)
        cleaned = cv2.morphologyEx(
            cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)),
            cv2.MORPH_OPEN,
            np.ones((3, 3), np.uint8),
        )
        contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        area = float(cv2.contourArea(contour))
        perimeter = float(cv2.arcLength(contour, True))
        circularity = 4 * math.pi * area / (perimeter ** 2) if perimeter > 1e-6 else 0.0
        # A threshold that selected the whole frame is background, not the part.
        y_max, x_max = cleaned.shape
        x, y, w, h = cv2.boundingRect(contour)
        if w >= x_max * 0.97 and h >= y_max * 0.97:
            continue
        score = area * (0.25 + min(circularity, 1.0))
        candidates.append((score, cleaned, contour))

    if not candidates:
        return np.zeros(rgb.shape[:2], dtype=np.uint8)
    best = max(candidates, key=lambda item: item[0])
    mask = np.zeros(rgb.shape[:2], dtype=np.uint8)
    cv2.drawContours(mask, [best[2]], -1, 255, thickness=cv2.FILLED)
    return np.where(mask > 0, 255, 0).astype(np.uint8)


def _outer_contour(mask: np.ndarray) -> Optional[np.ndarray]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    usable = [c for c in contours if cv2.contourArea(c) >= _MIN_CONTOUR_AREA]
    if not usable:
        contours_sorted = sorted(contours, key=cv2.contourArea, reverse=True)
        usable = contours_sorted[:1]
    if not usable:
        return None
    return max(usable, key=cv2.contourArea)


def _ellipse_radius_scale(contour: np.ndarray, center: np.ndarray, angles: np.ndarray) -> Optional[np.ndarray]:
    """Radius of the fitted outer ellipse at each angle; removes perspective stretch."""
    if len(contour) < 6:
        return None
    try:
        (ex, ey), (major, minor), angle_deg = cv2.fitEllipse(contour)
    except cv2.error:
        return None
    a = float(major) / 2.0
    b = float(minor) / 2.0
    if a < _MIN_RADIUS_PX or b < _MIN_RADIUS_PX or min(a, b) / max(a, b) < 0.28:
        return None
    phi = math.radians(float(angle_deg))
    delta = angles - phi
    denominator = np.sqrt((np.cos(delta) / a) ** 2 + (np.sin(delta) / b) ** 2)
    scale = 1.0 / np.maximum(denominator, 1e-6)
    scale *= float(np.median(scale) > 0)
    if float(np.median(scale)) <= 0:
        return None
    # Keep the overall envelope while normalising the elliptical trend.
    return scale / float(np.median(scale)) * float(np.median(np.hypot(contour[:, 0, 0] - ex, contour[:, 0, 1] - ey)))


def _affine_to_circle(contour: np.ndarray, output_shape: tuple[int, int]) -> Optional[tuple[np.ndarray, np.ndarray, float]]:
    """Affine matrix that maps the fitted outer ellipse to a centred circle."""
    if len(contour) < 6:
        return None
    try:
        (ex, ey), (major, minor), angle_deg = cv2.fitEllipse(contour)
    except cv2.error:
        return None
    a, b = float(major) / 2.0, float(minor) / 2.0
    if a < _MIN_RADIUS_PX or b < _MIN_RADIUS_PX or min(a, b) / max(a, b) < 0.28:
        return None
    target = min(a, b)
    phi = math.radians(float(angle_deg))
    c, s = math.cos(phi), math.sin(phi)
    rotate = np.array([[c, -s], [s, c]], dtype=float)
    unrotate = np.array([[c, s], [-s, c]], dtype=float)
    scale = np.array([[target / a, 0.0], [0.0, target / b]], dtype=float)
    linear = rotate @ scale @ unrotate
    out_center = np.array([output_shape[1] / 2.0, output_shape[0] / 2.0], dtype=float)
    translation = out_center - linear @ np.array([float(ex), float(ey)])
    matrix = np.column_stack([linear, translation]).astype(np.float32)
    return matrix, out_center, float(target)


def _polar_radial_signal(source: np.ndarray, center: np.ndarray, max_radius: float) -> np.ndarray:
    polar = cv2.warpPolar(
        source,
        (_RADIAL_BINS, _ANGLE_SAMPLES),
        (float(center[0]), float(center[1])),
        max_radius,
        cv2.WARP_POLAR_LINEAR + cv2.WARP_FILL_OUTLIERS,
    )
    if polar is None or polar.shape[0] != _ANGLE_SAMPLES:
        return np.full(_ANGLE_SAMPLES, np.nan)
    radial_step = max_radius / _RADIAL_BINS
    low = int(max(1, round(_RADIAL_BINS * 0.42)))
    high = int(min(_RADIAL_BINS - 1, round(_RADIAL_BINS * 1.02)))
    row = polar[:, low:high]
    signal = np.full(_ANGLE_SAMPLES, np.nan)
    for i in range(_ANGLE_SAMPLES):
        hits = np.flatnonzero(row[i] > 96)
        if hits.size:
            signal[i] = (low + float(hits[-1]) + 0.5) * radial_step
    return signal


def _prepare_signal(signal: np.ndarray, ellipse_scale: Optional[np.ndarray]) -> tuple[np.ndarray, float]:
    values = np.asarray(signal, dtype=float).copy()
    bad = ~np.isfinite(values)
    if bad.any():
        if bad.mean() > 0.2:
            return values, 0.0
        values[bad] = np.nanmedian(values)
    if ellipse_scale is not None and ellipse_scale.shape == values.shape:
        values = values / np.maximum(ellipse_scale, 1e-6)

    # Remove circle/ellipse/trend harmonics (k < 3) without imposing a tooth count.
    spectrum = np.fft.rfft(values)
    spectrum[:3] = 0.0
    detrended = np.fft.irfft(spectrum, n=len(values)).real
    detrended = _circular_convolve(detrended, 1.4)
    spread = float(np.median(np.abs(detrended - np.median(detrended))))
    noise = 1.4826 * spread
    return detrended, noise


def _circular_local_maxima(values: np.ndarray, threshold: float, order: int = 1) -> List[int]:
    n = len(values)
    result = []
    for i in range(n):
        if values[i] < threshold:
            continue
        if all(values[i] >= values[(i - step) % n] for step in range(1, order + 1)):
            if all(values[i] > values[(i + step) % n] for step in range(1, order + 1)):
                result.append(i)
    return result


def _merge_circular_peaks(peaks: List[int], min_separation: int, n: int) -> List[int]:
    if not peaks:
        return []
    ordered = sorted(peaks)
    # Unwrap at the largest circular gap before enforcing minimum separation,
    # otherwise a peak near 0° is incorrectly discarded.
    gaps = [(ordered[(i + 1) % len(ordered)] - ordered[i]) % n for i in range(len(ordered))]
    split_index = int(np.argmax(gaps)) + 1
    rotated = [int(p) for p in ordered[split_index:]]
    rotated.extend(int(p) + n for p in ordered[:split_index])
    merged = [rotated[0]]
    for peak in rotated[1:]:
        if peak - merged[-1] >= min_separation:
            merged.append(peak)
    return sorted(int(p % n) for p in merged)


def _radial_peak_method(detrended: np.ndarray, noise: float) -> tuple[Optional[int], float, List[int]]:
    n = len(detrended)
    peak_range = float(np.max(detrended) - np.min(detrended))
    # The detrended signal is itself the periodic component, so a MAD estimate
    # of it overstates noise. Use the signal range for the peak floor and keep
    # a small high-frequency term for noisy photographs.
    threshold = max(noise * 0.25, peak_range * 0.18)
    if threshold <= 0:
        return None, 0.0, []
    peaks = _circular_local_maxima(detrended, threshold, order=2)
    min_separation = max(4, int(round(n / 180.0)))
    peaks = _merge_circular_peaks(peaks, min_separation, n)
    if len(peaks) < 3:
        return None, 0.0, []
    prominences = np.array([detrended[p] - np.median(detrended) for p in peaks])
    confidence = float(np.clip(np.median(prominences) / (noise * 5.0 + 1e-6), 0.0, 1.0))
    return len(peaks), confidence, peaks


def _spectral_method(detrended: np.ndarray) -> tuple[Optional[int], float]:
    n = len(detrended)
    power = np.abs(np.fft.rfft(detrended)) ** 2
    floor = float(np.median(power[3:n // 2 + 1])) + 1e-9
    candidates = []
    for k in range(3, n // 2):
        if power[k] > power[k - 1] and power[k] >= power[k + 1]:
            candidates.append(k)
    candidates.sort(key=lambda k: power[k], reverse=True)
    candidates = candidates[:12]
    chosen = None
    for k in candidates:
        is_harmonic = any(
            j < k and k % j == 0 and power[j] > 0.42 * power[k]
            for j in candidates
        )
        if not is_harmonic and power[k] > floor * 2.0:
            chosen = k
            break
    if chosen is None:
        return None, 0.0
    confidence = float(np.clip(power[chosen] / (floor * 10.0), 0.0, 1.0))
    return chosen, confidence


def _autocorrelation_method(detrended: np.ndarray) -> tuple[Optional[int], float]:
    n = len(detrended)
    centered = detrended - np.mean(detrended)
    spectrum = np.fft.rfft(centered, n=2 * n)
    autocorr = np.fft.irfft(np.abs(spectrum) ** 2, n=2 * n)[:n]
    if autocorr[0] <= 1e-9:
        return None, 0.0
    autocorr /= autocorr[0]
    best_lag = None
    min_lag = max(4, int(round(n / 360.0)))
    # The first strong local maximum is the fundamental period. Later maxima
    # are its multiples and would report a small harmonic count.
    for lag in range(min_lag, n // 2):
        value = float(autocorr[lag])
        if value < 0.18:
            continue
        if value >= float(autocorr[lag - 1]) and value >= float(autocorr[lag + 1]):
            best_lag = lag
            break
    if best_lag is None:
        return None, 0.0
    # The tooth period is rarely an integer number of angular samples. Using
    # the integer lag directly biases 44 teeth to 45 (720 / 16 -> 45), so
    # estimate the true peak position with a three-point parabolic fit.
    refined_lag = float(best_lag)
    left, center, right = float(autocorr[best_lag - 1]), float(autocorr[best_lag]), float(autocorr[best_lag + 1])
    denominator = left - 2.0 * center + right
    if abs(denominator) > 1e-12:
        offset = 0.5 * (left - right) / denominator
        if -0.5 <= offset <= 0.5:
            refined_lag += offset
    count = int(round(n / refined_lag))
    if count < 3 or count > n // 2:
        return None, 0.0
    return count, float(np.clip(center, 0.0, 1.0))


def _tooth_markers(
    peaks: List[int],
    boundary_signal: np.ndarray,
    sample_center: np.ndarray,
    original_center: np.ndarray,
    inverse_matrix: Optional[np.ndarray],
    confidence: float,
) -> List[dict]:
    n = len(boundary_signal)
    markers = []
    for peak in peaks:
        radius = float(boundary_signal[peak])
        angle_deg = float(peak * 360.0 / n)
        radians = math.radians(angle_deg)
        x = float(sample_center[0] + radius * math.cos(radians))
        y = float(sample_center[1] + radius * math.sin(radians))
        original_radius = float(np.hypot(x - sample_center[0], y - sample_center[1]))
        if inverse_matrix is not None:
            mapped_x = float(inverse_matrix[0, 0] * x + inverse_matrix[0, 1] * y + inverse_matrix[0, 2])
            mapped_y = float(inverse_matrix[1, 0] * x + inverse_matrix[1, 1] * y + inverse_matrix[1, 2])
            x, y = mapped_x, mapped_y
            original_radius = float(np.hypot(x - original_center[0], y - original_center[1]))
        markers.append({
            "angle_deg": round(angle_deg, 2),
            "x_px": round(x, 2),
            "y_px": round(y, 2),
            "radius_px": round(original_radius, 2),
            "confidence": round(confidence, 3),
        })
    return markers


def detect_tooth_count(
    rgb: np.ndarray,
    mask: Optional[np.ndarray] = None,
    image_index: int = 0,
) -> dict:
    """Detect gear tooth tips and return an agreed count or an explicit uncertain result."""
    try:
        if rgb is None or getattr(rgb, "ndim", 0) != 3 or rgb.shape[2] < 3:
            return _blank_result(image_index, "No RGB image available for tooth counting.")

        foreground = _foreground_mask(rgb, mask)
        contour = _outer_contour(foreground)
        if contour is None:
            return _blank_result(image_index, "No closed outer contour available for tooth counting.")

        moments = cv2.moments(contour)
        if moments["m00"] <= 0:
            return _blank_result(image_index, "Outer contour has no usable centre.")
        original_center = np.array([moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]], dtype=float)
        try:
            (ex, ey), axes = cv2.minEnclosingCircle(contour)
            if _MIN_RADIUS_PX <= float(axes) <= max(rgb.shape[:2]) * 0.75:
                original_center = np.array([float(ex), float(ey)], dtype=float)
        except cv2.error:
            pass

        distances = np.hypot(contour[:, 0, 0] - original_center[0], contour[:, 0, 1] - original_center[1])
        original_max_radius = float(np.percentile(distances, 98))
        if original_max_radius < _MIN_RADIUS_PX:
            return _blank_result(image_index, "Gear envelope is too small for reliable tooth counting.")

        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        affine = _affine_to_circle(contour, rgb.shape[:2])
        warnings = []
        if affine is not None:
            matrix, sample_center, target_radius = affine
            sample_mask = cv2.warpAffine(
                foreground,
                matrix,
                (rgb.shape[1], rgb.shape[0]),
                flags=cv2.INTER_NEAREST,
                borderValue=0,
            )
            sample_gray = cv2.warpAffine(
                gray,
                matrix,
                (rgb.shape[1], rgb.shape[0]),
                flags=cv2.INTER_LINEAR,
                borderValue=float(np.median(gray)),
            )
            inverse_matrix = cv2.invertAffineTransform(matrix)
            sample_max_radius = target_radius * 1.08
            ellipse_scale = None
        else:
            sample_mask = foreground
            sample_gray = gray
            sample_center = original_center
            sample_max_radius = original_max_radius
            inverse_matrix = None
            angles = np.arange(_ANGLE_SAMPLES, dtype=float) * 2.0 * math.pi / _ANGLE_SAMPLES
            ellipse_scale = _ellipse_radius_scale(contour, original_center, angles)
            warnings.append("Perspective ellipse fit was rejected; radial-trend filtering was used instead.")

        boundary = _polar_radial_signal(sample_mask, sample_center, sample_max_radius)
        valid_fraction = float(np.mean(np.isfinite(boundary)))
        if valid_fraction < 0.55:
            return _blank_result(image_index, "Outer circumference is occluded or not closed.")

        detrended, noise = _prepare_signal(boundary, ellipse_scale)
        peak_count, peak_confidence, peaks = _radial_peak_method(detrended, noise)
        spectral_count, spectral_confidence = _spectral_method(detrended)
        autocorr_count, autocorr_confidence = _autocorrelation_method(detrended)

        # Independent edge-based polar signal: CLAHE + Canny after ellipse normalisation.
        enhanced = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(sample_gray)
        edges = cv2.Canny(cv2.GaussianBlur(enhanced, (5, 5), 0), 45, 130)
        edge_signal = _polar_radial_signal(edges, sample_center, sample_max_radius)
        edge_detrended, edge_noise = _prepare_signal(edge_signal, ellipse_scale)
        edge_count, edge_confidence, _ = _radial_peak_method(edge_detrended, edge_noise)

        methods = []
        if peak_count is not None:
            methods.append({"method": "radial_peak", "count": peak_count, "confidence": round(peak_confidence, 3)})
        if spectral_count is not None:
            methods.append({"method": "polar_fft", "count": spectral_count, "confidence": round(spectral_confidence, 3)})
        if autocorr_count is not None:
            methods.append({"method": "autocorrelation", "count": autocorr_count, "confidence": round(autocorr_confidence, 3)})
        if edge_count is not None:
            methods.append({"method": "edge_radial_peak", "count": edge_count, "confidence": round(edge_confidence, 3)})

        if valid_fraction < 0.9:
            warnings.append("Outer boundary partially occluded; tooth count flagged for review.")

        groups: dict[int, list[dict]] = {}
        for item in methods:
            groups.setdefault(int(item["count"]), []).append(item)
        voted_count, supporters = max(
            groups.items(),
            key=lambda pair: (len(pair[1]), sum(m["confidence"] for m in pair[1])),
        ) if groups else (None, [])
        support_ratio = len(supporters) / len(methods) if methods else 0.0
        strong_support = any(
            m["method"] in {"polar_fft", "autocorrelation"} for m in supporters
        )
        reliable = (
            len(methods) >= _MIN_METHODS_FOR_COUNT
            and len(supporters) >= _MIN_METHODS_FOR_COUNT
            and support_ratio >= 0.6
            and strong_support
        )
        if reliable:
            agreed = int(voted_count)
            best_confidence = max(float(m["confidence"]) for m in supporters)
            mean_confidence = float(np.mean([float(m["confidence"]) for m in supporters]))
            confidence = float(np.clip(
                0.35 * support_ratio + 0.45 * best_confidence + 0.20 * mean_confidence,
                0.0,
                1.0,
            ))
            status = "ok"
            if len(supporters) < len(methods):
                warnings.append(
                    "One tooth-count method disagreed; count accepted by "
                    f"{len(supporters)}/{len(methods)} cross-checks."
                )
        else:
            agreed = None
            confidence = float(np.clip(max([item["confidence"] for item in methods], default=0.0) * 0.5, 0.0, 0.5))
            status = "uncertain" if methods else "unavailable"
            warnings.append(
                "Tooth-count methods disagree or too few methods were reliable; no count is reported."
            )

        markers = []
        if status == "ok" and peak_count == agreed:
            markers = _tooth_markers(
                peaks,
                boundary,
                sample_center,
                original_center,
                inverse_matrix,
                confidence,
            )

        return {
            "image_index": image_index,
            "status": status,
            "count": agreed,
            "confidence": round(confidence, 3),
            "center_px": [round(float(original_center[0]), 2), round(float(original_center[1]), 2)],
            "outer_radius_px": round(original_max_radius, 2),
            "methods": methods,
            "teeth": markers,
            "warnings": warnings,
        }
    except Exception as exc:  # fail soft: vision evidence is optional
        logger.warning("Tooth counting failed for image %s: %s", image_index, exc)
        return _blank_result(image_index, f"Tooth counting failed: {exc}")
