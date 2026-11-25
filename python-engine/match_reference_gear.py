"""Identify the measured gear by local features distributed across its face."""
import base64
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

cv2.setNumThreads(1)


def matches(view, detector, points, descriptors):
    with Image.open(io.BytesIO(base64.b64decode(view))) as photo:
        if photo.width * photo.height > 32_000_000:
            return False
        photo.thumbnail((1100, 1100))
        gray = np.asarray(photo.convert("L"))
    keys, target = detector.detectAndCompute(gray, None)
    if target is None or len(keys) < 20:
        return False
    pairs = cv2.BFMatcher().knnMatch(descriptors, target, k=2)
    good = [a for a, b in pairs if a.distance < 0.75 * b.distance]
    if len(good) < 20:
        return False
    src = np.float32([points[m.queryIdx].pt for m in good])
    dst = np.float32([keys[m.trainIdx].pt for m in good])
    transform, inliers = cv2.estimateAffinePartial2D(src, dst, ransacReprojThreshold=4)
    if transform is None:
        return False
    mask = inliers.ravel().astype(bool)
    # Repeated teeth or a small patch of rust alone cannot establish identity.
    return (mask.sum() >= 20 and mask.mean() >= 0.42
            and cv2.contourArea(cv2.convexHull(src[mask])) > 0.23 * 522**2)


def main():
    reference = cv2.imread(str(Path(__file__).resolve().parents[1] /
                               "backend/references/spur-86.jpg"), cv2.IMREAD_GRAYSCALE)
    mask = np.zeros_like(reference)
    cv2.circle(mask, (261, 261), 250, 255, -1)
    detector = cv2.SIFT_create(nfeatures=1800)
    points, descriptors = detector.detectAndCompute(reference, mask)
    for view in json.load(sys.stdin):
        try:
            if matches(view, detector, points, descriptors):
                print("match")
                return
        except (ValueError, OSError, Image.DecompressionBombError, cv2.error):
            continue


if __name__ == "__main__":
    main()
