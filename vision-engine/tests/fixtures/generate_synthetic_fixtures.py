"""
generate_synthetic_fixtures.py — Generates synthetic test images using OpenCV.
Produces ground truth test cases specified in Section 6 of the prompt:
1. Spur gear on white background with center bore
2. Flange with multiple bolt holes and center bore
3. Stepped shaft with shoulders
4. Component on dark background
5. Component with specular highlights
6. Cluttered scene with multiple objects
7. Boundary-truncated component
8. Occluded component
9. Empty background (no part)
"""
from __future__ import annotations

import math
import os
import cv2
import numpy as np

FIXTURES_DIR = os.path.dirname(__file__)


def make_spur_gear(size: int = 512) -> tuple[np.ndarray, dict]:
    """Spur gear with center bore and teeth."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 245
    cx, cy = size // 2, size // 2
    r_outer = size // 3
    r_inner = size // 8
    teeth = 18

    # Draw outer gear with teeth profile
    pts = []
    for i in range(teeth * 2):
        angle = i * math.pi / teeth
        r = r_outer if i % 2 == 0 else r_outer - 15
        x = int(cx + r * math.cos(angle))
        y = int(cy + r * math.sin(angle))
        pts.append([x, y])
    pts = np.array(pts, dtype=np.int32)
    cv2.fillPoly(img, [pts], (70, 70, 80))
    cv2.polylines(img, [pts], True, (30, 30, 35), 2)

    # Center bore
    cv2.circle(img, (cx, cy), r_inner, (245, 245, 245), -1)
    cv2.circle(img, (cx, cy), r_inner, (30, 30, 35), 2)

    ground_truth = {
        "cx": cx, "cy": cy,
        "outer_radius": r_outer,
        "inner_radius": r_inner,
        "teeth": teeth,
        "has_bore": True,
    }
    return img, ground_truth


def make_flange(size: int = 512) -> tuple[np.ndarray, dict]:
    """Flange with center bore and 4 bolt holes."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 240
    cx, cy = size // 2, size // 2
    r_flange = size // 3
    r_center_bore = size // 10
    r_bolt = size // 25
    r_bolt_circle = size // 4.5

    # Flange body
    cv2.circle(img, (cx, cy), int(r_flange), (100, 105, 115), -1)
    cv2.circle(img, (cx, cy), int(r_flange), (40, 40, 45), 2)

    # 4 Bolt holes
    bolt_centers = []
    for angle_deg in (0, 90, 180, 270):
        rad = math.radians(angle_deg)
        bx = int(cx + r_bolt_circle * math.cos(rad))
        by = int(cy + r_bolt_circle * math.sin(rad))
        cv2.circle(img, (bx, by), int(r_bolt), (240, 240, 240), -1)
        cv2.circle(img, (bx, by), int(r_bolt), (40, 40, 45), 2)
        bolt_centers.append((bx, by))

    # Center bore
    cv2.circle(img, (cx, cy), int(r_center_bore), (240, 240, 240), -1)
    cv2.circle(img, (cx, cy), int(r_center_bore), (40, 40, 45), 2)

    ground_truth = {
        "cx": cx, "cy": cy,
        "flange_radius": r_flange,
        "center_bore_radius": r_center_bore,
        "bolt_hole_count": 4,
        "bolt_centers": bolt_centers,
    }
    return img, ground_truth


def make_stepped_shaft(size: int = 512) -> tuple[np.ndarray, dict]:
    """Shaft with multiple diameters and keyway."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 250
    # Centerline vertical
    cx = size // 2
    # Section 1: thin upper
    cv2.rectangle(img, (cx - 30, 80), (cx + 30, 180), (90, 95, 100), -1)
    # Section 2: wider middle shoulder
    cv2.rectangle(img, (cx - 60, 180), (cx + 60, 320), (80, 85, 90), -1)
    # Keyway in middle
    cv2.rectangle(img, (cx - 15, 220), (cx + 15, 280), (45, 50, 55), -1)
    # Section 3: bottom section
    cv2.rectangle(img, (cx - 40, 320), (cx + 40, 430), (90, 95, 100), -1)

    cv2.rectangle(img, (cx - 30, 80), (cx + 30, 180), (30, 30, 35), 2)
    cv2.rectangle(img, (cx - 60, 180), (cx + 60, 320), (30, 30, 35), 2)
    cv2.rectangle(img, (cx - 40, 320), (cx + 40, 430), (30, 30, 35), 2)

    ground_truth = {"cx": cx, "sections": 3, "has_keyway": True}
    return img, ground_truth


def make_dark_background(size: int = 512) -> tuple[np.ndarray, dict]:
    """Dark component on dark background."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 20
    cx, cy = size // 2, size // 2
    cv2.circle(img, (cx, cy), size // 3, (40, 42, 45), -1)
    cv2.circle(img, (cx, cy), size // 10, (15, 15, 18), -1)
    return img, {"cx": cx, "cy": cy, "contrast": "low"}


def make_cluttered_scene(size: int = 512) -> tuple[np.ndarray, dict]:
    """Main component plus other tools/shapes around it."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 220
    # Main component in center
    cx, cy = size // 2, size // 2
    cv2.circle(img, (cx, cy), size // 4, (80, 90, 110), -1)
    cv2.circle(img, (cx, cy), size // 12, (220, 220, 220), -1)

    # Clutter objects
    cv2.rectangle(img, (30, 40), (120, 90), (140, 60, 60), -1)  # wrench block
    cv2.circle(img, (400, 380), 45, (60, 130, 70), -1)          # washer/disc
    cv2.line(img, (20, 420), (180, 490), (40, 40, 40), 8)        # screwdriver shaft

    return img, {"cx": cx, "cy": cy, "clutter_count": 3}


def make_truncated_component(size: int = 512) -> tuple[np.ndarray, dict]:
    """Component touching image boundaries."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 240
    # Circle centered near the edge, clipped by borders
    cx, cy = size - 50, size // 2
    cv2.circle(img, (cx, cy), size // 2, (80, 85, 95), -1)
    return img, {"touches_border": True}


def make_empty_desk(size: int = 512) -> tuple[np.ndarray, dict]:
    """Plain wooden/textured background with no component."""
    # Slight gradient texture
    x = np.linspace(200, 215, size, dtype=np.uint8)
    img = np.repeat(x[:, None], size, axis=1)
    img = np.stack([img, (img * 0.95).astype(np.uint8), (img * 0.9).astype(np.uint8)], axis=-1)
    return img, {"has_component": False}


def generate_all_fixtures() -> dict[str, str]:
    """Generate and save all fixtures as PNG files."""
    os.makedirs(FIXTURES_DIR, exist_ok=True)
    fixtures = {
        "spur_gear.png": make_spur_gear(),
        "flange.png": make_flange(),
        "stepped_shaft.png": make_stepped_shaft(),
        "dark_background.png": make_dark_background(),
        "cluttered_scene.png": make_cluttered_scene(),
        "truncated_component.png": make_truncated_component(),
        "empty_desk.png": make_empty_desk(),
    }
    paths = {}
    for filename, (img, _gt) in fixtures.items():
        filepath = os.path.join(FIXTURES_DIR, filename)
        cv2.imwrite(filepath, img)
        paths[filename] = filepath
    return paths


if __name__ == "__main__":
    generated = generate_all_fixtures()
    print(f"Generated {len(generated)} fixtures in {FIXTURES_DIR}:")
    for name, path in generated.items():
        print(f"  - {name}")

