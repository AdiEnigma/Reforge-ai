"""
conftest.py — Fixtures and Synthetic Ground Truth Generators for Reconstruction Engine.
"""

import math
import tempfile
from pathlib import Path
from typing import Dict, List, Tuple
import pytest
import numpy as np
import cv2


@pytest.fixture
def synthetic_cylinder_points():
    """
    Generates deterministic 3D points on the surface of a cylinder:
    Ground Truth:
    - radius = 25.0 mm (outer_diameter = 50.0 mm)
    - height = 100.0 mm (z from -50 to +50)
    - center_x = 0.0, center_y = 0.0
    """
    np.random.seed(42)
    n_points = 200
    r = 25.0
    h = 100.0
    theta = np.linspace(0, 2 * np.pi, n_points, endpoint=False)
    z = np.linspace(-50.0, 50.0, n_points)

    x = r * np.cos(theta)
    y = r * np.sin(theta)
    pts = np.column_stack([x, y, z]).tolist()
    return {
        "points": pts,
        "true_radius": r,
        "true_diameter": 2 * r,
        "true_height": h,
        "true_center": (0.0, 0.0),
    }


@pytest.fixture
def noisy_cylinder_points(synthetic_cylinder_points):
    """Adds Gaussian noise (sigma=0.2 mm) to synthetic cylinder points."""
    np.random.seed(42)
    clean = np.array(synthetic_cylinder_points["points"])
    noise = np.random.normal(0, 0.2, clean.shape)
    noisy = (clean + noise).tolist()
    return {
        "points": noisy,
        "true_radius": synthetic_cylinder_points["true_radius"],
        "true_height": synthetic_cylinder_points["true_height"],
        "noise_sigma": 0.2,
    }


@pytest.fixture
def outlier_cylinder_points(synthetic_cylinder_points):
    """Injects 10% severe outliers into cylinder points."""
    np.random.seed(42)
    clean = np.array(synthetic_cylinder_points["points"])
    n_outliers = int(len(clean) * 0.10)
    clean[:n_outliers] += np.random.uniform(50.0, 100.0, (n_outliers, 3))
    return {
        "points": clean.tolist(),
        "true_radius": synthetic_cylinder_points["true_radius"],
        "true_height": synthetic_cylinder_points["true_height"],
    }


@pytest.fixture
def synthetic_concentric_circles():
    """
    Ground truth concentric circles:
    - Center: (150.0, 150.0)
    - Inner radius = 20.0 mm
    - Outer radius = 60.0 mm
    """
    return [
        {"cx": 150.0, "cy": 150.0, "r": 20.0},
        {"cx": 150.2, "cy": 149.9, "r": 19.9},
        {"cx": 149.8, "cy": 150.1, "r": 60.1},
        {"cx": 150.0, "cy": 150.0, "r": 59.9},
    ]


@pytest.fixture
def temp_image_files():
    """Generates a set of temporary synthetic valid PNG images."""
    with tempfile.TemporaryDirectory(prefix="reforge_test_imgs_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        paths = []
        for i in range(4):
            img_path = tmp_path / f"test_view_{i}.png"
            img = np.zeros((100, 100, 3), dtype=np.uint8)
            # Add distinct patterns so they aren't identical
            cv2.circle(img, (50 + i * 5, 50), 20 + i, (255, 255, 255), -1)
            cv2.imwrite(str(img_path), img)
            paths.append(img_path)
        yield paths


@pytest.fixture
def mock_colmap_env():
    """Mocks COLMAP executable presence and successful text model generation."""
    import os
    from unittest.mock import MagicMock
    with tempfile.TemporaryDirectory(prefix="mock_colmap_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        mock_exe = tmp_path / "mock_colmap.bat" if os.name == "nt" else tmp_path / "mock_colmap"
        mock_exe.write_text("@echo COLMAP 3.9" if os.name == "nt" else "#!/bin/sh\necho 'COLMAP 3.9'")
        if os.name != "nt":
            mock_exe.chmod(0o755)

        def mock_subprocess_run(cmd, *args, **kwargs):
            action = cmd[1] if len(cmd) > 1 else ""
            if action == "mapper":
                out_path = Path(cmd[cmd.index("--output_path") + 1])
                model_0 = out_path / "0"
                model_0.mkdir(parents=True, exist_ok=True)

                (model_0 / "cameras.txt").write_text(
                    "# Camera list\n"
                    "1 SIMPLE_RADIAL 1000 1000 800 500 500 0.01\n"
                )
                (model_0 / "images.txt").write_text(
                    "# Image list\n"
                    "1 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 image_0000.png\n"
                    "100.0 200.0 1\n"
                    "2 0.965 0.0 0.258 0.0 1.5 0.0 0.2 1 image_0001.png\n"
                    "120.0 210.0 1\n"
                    "3 0.866 0.0 0.500 0.0 3.0 0.0 0.5 1 image_0002.png\n"
                    "140.0 220.0 1\n"
                )
                pts_lines = ["# 3D points\n"]
                for pid in range(1, 25):
                    ang = pid * 0.25
                    px = 10.0 * math.cos(ang)
                    py = 10.0 * math.sin(ang)
                    pz = float(pid * 2.0)
                    pts_lines.append(f"{pid} {px:.3f} {py:.3f} {pz:.3f} 200 200 200 0.45 1 0 2 0\n")
                (model_0 / "points3D.txt").write_text("".join(pts_lines))

            mock_res = MagicMock()
            mock_res.returncode = 0
            mock_res.stdout = "COLMAP 3.9"
            mock_res.stderr = ""
            return mock_res

        yield str(mock_exe), mock_subprocess_run
