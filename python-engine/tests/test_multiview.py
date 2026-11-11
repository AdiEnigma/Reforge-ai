"""
test_multiview.py — Verification of COLMAP Multi-View Reconstruction Subsystem (MV-01 to MV-25).
"""

import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
import cv2
import numpy as np
import pytest

from reconstruction.multiview import (
    apply_metric_scale,
    find_colmap_executable,
    parse_colmap_text_model,
    quick_image_check,
    run_multiview_reconstruction,
    validate_image_set,
    ImagePose,
    Point3D,
)


@pytest.fixture
def mock_colmap_env():
    """Mocks COLMAP executable presence and successful text model generation."""
    with tempfile.TemporaryDirectory(prefix="mock_colmap_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        mock_exe = tmp_path / "mock_colmap.bat" if os.name == "nt" else tmp_path / "mock_colmap"
        mock_exe.write_text("@echo COLMAP 3.9" if os.name == "nt" else "#!/bin/sh\necho 'COLMAP 3.9'")
        if os.name != "nt":
            mock_exe.chmod(0o755)

        def mock_subprocess_run(cmd, *args, **kwargs):
            # Check what stage is being called
            action = cmd[1] if len(cmd) > 1 else ""
            if action == "mapper":
                # Create sparse/0/ directory with mock text model
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
                # Generate points in cylinder shape
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


# MV-01: Three overlapping photographs of a textured cylinder
def test_mv01_three_overlapping_views(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    three_imgs = temp_image_files[:3]
    with patch("subprocess.run", side_effect=mock_runner):
        res = run_multiview_reconstruction(
            image_paths=three_imgs,
            job_id="mv01",
            colmap_custom_path=exe_path,
        )
    assert res.status == "success"
    assert res.registered_images == 3
    assert len(res.points3D) >= 20
    assert res.coordinate_frame == "relative_world"
    assert res.scale["classification"] == "relative"


# MV-02: Eight to twelve views of a textured mechanical component
def test_mv02_eight_views_reporting(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    # Generate 8 temp images
    imgs = list(temp_image_files)
    with tempfile.TemporaryDirectory() as tmp_d:
        for i in range(4):
            extra = Path(tmp_d) / f"extra_{i}.png"
            shutil.copy2(imgs[0], extra)
            imgs.append(extra)

        with patch("subprocess.run", side_effect=mock_runner):
            res = run_multiview_reconstruction(
                image_paths=imgs[:8],
                job_id="mv02",
                colmap_custom_path=exe_path,
            )
        assert res.total_images == 8
        assert "mean_reprojection_error" in res.diagnostics


# MV-03: Shuffled image input order
def test_mv03_shuffled_input_order(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    order_a = temp_image_files[:3]
    order_b = [order_a[2], order_a[0], order_a[1]]

    with patch("subprocess.run", side_effect=mock_runner):
        res_a = run_multiview_reconstruction(order_a, job_id="mv03_a", colmap_custom_path=exe_path)
        res_b = run_multiview_reconstruction(order_b, job_id="mv03_b", colmap_custom_path=exe_path)

    assert res_a.status == res_b.status
    assert res_a.registered_images == res_b.registered_images
    assert len(res_a.points3D) == len(res_b.points3D)


# MV-04: Exact and near-duplicate photographs
def test_mv04_exact_duplicate_detection(temp_image_files):
    # Two identical copies
    dup_set = [temp_image_files[0], temp_image_files[0]]
    valid, diag = validate_image_set(dup_set)
    assert len(valid) == 1
    assert len(diag["duplicates_detected"]) == 1
    assert any("Duplicate image ignored" in w for w in diag["warnings"])


# MV-05: One corrupted photograph among valid images
def test_mv05_corrupted_image_isolation(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as corrupt_f:
        corrupt_f.write(b"not an image at all garbage bytes")
        corrupt_path = Path(corrupt_f.name)

    try:
        mixed_set = [temp_image_files[0], temp_image_files[1], corrupt_path]
        with patch("subprocess.run", side_effect=mock_runner):
            res = run_multiview_reconstruction(mixed_set, job_id="mv05", colmap_custom_path=exe_path)

        assert res.total_images == 3
        assert len(res.diagnostics["validation"]["corrupt_images"]) == 1
        assert res.status in ["success", "partial"]
    finally:
        if corrupt_path.exists():
            corrupt_path.unlink()


# MV-06: Blurred photographs
def test_mv06_blurred_photo_detection():
    # Create severely blurred image (uniform color)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        blur_p = Path(f.name)
        img = np.full((100, 100, 3), 128, dtype=np.uint8)
        cv2.imwrite(str(blur_p), img)

    try:
        ok, dims, sharpness, warns = quick_image_check(blur_p)
        assert ok is True
        assert sharpness is not None and sharpness < 10.0
        assert any("blurred" in w.lower() for w in warns)
    finally:
        if blur_p.exists():
            blur_p.unlink()


# MV-07: Textureless metallic component
def test_mv07_textureless_component(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    # Subprocess fails mapper due to no features
    def failing_matcher_run(cmd, *args, **kwargs):
        mock_res = MagicMock()
        action = cmd[1] if len(cmd) > 1 else ""
        if action == "mapper":
            mock_res.returncode = 1
            mock_res.stderr = "No good initial pair found. Insufficient matches."
            return mock_res
        mock_res.returncode = 0
        return mock_res

    with patch("subprocess.run", side_effect=failing_matcher_run):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv07", colmap_custom_path=exe_path)

    assert res.status == "failed"
    assert any("mapper failed" in e for e in res.diagnostics["errors"])


# MV-08: Highly reflective component
def test_mv08_highly_reflective_component(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    # Feature matching fails
    def failing_match(cmd, *args, **kwargs):
        mock_res = MagicMock()
        action = cmd[1] if len(cmd) > 1 else ""
        if action == "exhaustive_matcher":
            mock_res.returncode = 1
            mock_res.stderr = "Matching error: inconsistent epipolar geometry"
            return mock_res
        mock_res.returncode = 0
        return mock_res

    with patch("subprocess.run", side_effect=failing_match):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv08", colmap_custom_path=exe_path)

    assert res.status == "failed"


# MV-09: Turntable object with static background
def test_mv09_turntable_without_masks(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with patch("subprocess.run", side_effect=mock_runner):
        res = run_multiview_reconstruction(
            temp_image_files[:3],
            job_id="mv09",
            colmap_custom_path=exe_path,
            options={"capture_mode": "turntable"},
        )
    assert any("Turntable capture without background segmentation masks" in w for w in res.diagnostics.get("warnings", []))


# MV-10: Different image resolutions
def test_mv10_different_image_resolutions():
    with tempfile.TemporaryDirectory() as tmp_d:
        p1 = Path(tmp_d) / "img1.png"
        p2 = Path(tmp_d) / "img2.png"
        cv2.imwrite(str(p1), np.zeros((100, 200, 3), dtype=np.uint8))
        cv2.imwrite(str(p2), np.zeros((300, 400, 3), dtype=np.uint8))
        valid, diag = validate_image_set([p1, p2])
        assert len(valid) == 2
        assert diag["image_metadata"]["img1.png"]["dimensions"] == (200, 100)
        assert diag["image_metadata"]["img2.png"]["dimensions"] == (400, 300)


# MV-11: Missing EXIF metadata
def test_mv11_missing_exif_metadata(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    # Synthetic images have no EXIF metadata; pipeline proceeds smoothly
    with patch("subprocess.run", side_effect=mock_runner):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv11", colmap_custom_path=exe_path)
    assert res.status == "success"


# MV-12: Single-image input
def test_mv12_single_image_input(temp_image_files):
    # Does not invoke COLMAP; returns unavailable/insufficient views
    res = run_multiview_reconstruction([temp_image_files[0]], job_id="mv12")
    assert res.status == "unavailable"
    assert any("requires at least 2 images" in w for w in res.diagnostics["warnings"])


# MV-13: Two views with insufficient baseline
def test_mv13_insufficient_baseline(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    # Return camera poses with zero baseline (coincident cameras)
    def zero_baseline_runner(cmd, *args, **kwargs):
        action = cmd[1] if len(cmd) > 1 else ""
        if action == "mapper":
            out_path = Path(cmd[cmd.index("--output_path") + 1])
            model_0 = out_path / "0"
            model_0.mkdir(parents=True, exist_ok=True)
            (model_0 / "cameras.txt").write_text("1 SIMPLE_RADIAL 1000 1000 800 500 500 0.01\n")
            (model_0 / "images.txt").write_text(
                "1 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 image_0000.png\n100 100 1\n"
                "2 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 image_0001.png\n100 100 1\n"
            )
            (model_0 / "points3D.txt").write_text("1 0 0 10 200 200 200 0.2 1 0 2 0\n")
        res = MagicMock()
        res.returncode = 0
        return res

    with patch("subprocess.run", side_effect=zero_baseline_runner):
        res = run_multiview_reconstruction(temp_image_files[:2], job_id="mv13", colmap_custom_path=exe_path)
    assert res.diagnostics.get("baseline_sufficient") is False
    assert any("Insufficient camera baseline" in w for w in res.diagnostics.get("warnings", []))


# MV-14: Reconstruction without known physical dimension
def test_mv14_reconstruction_without_known_dimension(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with patch("subprocess.run", side_effect=mock_runner):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv14", colmap_custom_path=exe_path)
    assert res.scale["classification"] == "relative"
    assert res.scale["units"] == "relative"
    assert res.coordinate_frame == "relative_world"


# MV-15: Reconstruction with valid known reference distance
def test_mv15_reconstruction_with_known_dimension(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    reference = {"type": "known_distance", "distance_mm": 100.0}
    with patch("subprocess.run", side_effect=mock_runner):
        res = run_multiview_reconstruction(
            temp_image_files[:3],
            job_id="mv15",
            reference=reference,
            colmap_custom_path=exe_path,
        )
    assert res.scale["classification"] == "metric"
    assert res.scale["units"] == "mm"
    assert res.coordinate_frame == "component_local"
    assert res.scale["source"] == "KNOWN_DISTANCE"


# MV-16: Missing COLMAP executable
def test_mv16_missing_colmap_executable(temp_image_files):
    with patch("reconstruction.multiview.find_colmap_executable", return_value=None):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv16")
    assert res.status == "unavailable"
    assert any("COLMAP executable was not found" in w for w in res.diagnostics["warnings"])


# MV-17: Insufficient overlap
def test_mv17_insufficient_overlap(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    # Mapper outputs 0 sub-models due to no overlap
    def no_models_runner(cmd, *args, **kwargs):
        action = cmd[1] if len(cmd) > 1 else ""
        if action == "mapper":
            out_path = Path(cmd[cmd.index("--output_path") + 1])
            # Sparse folder is created but no subdirs inside
            out_path.mkdir(parents=True, exist_ok=True)
        res = MagicMock()
        res.returncode = 0
        return res

    with patch("subprocess.run", side_effect=no_models_runner):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv17", colmap_custom_path=exe_path)
    assert res.status == "failed"
    assert any("0 sub-models" in e for e in res.diagnostics["errors"])


# MV-18: Unsupported format / impossible dimensions
def test_mv18_unsupported_format():
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        f.write(b"plain text file")
        txt_path = Path(f.name)

    try:
        ok, dims, _, warns = quick_image_check(txt_path)
        assert ok is False
        assert any("Unsupported extension" in w for w in warns)
    finally:
        if txt_path.exists():
            txt_path.unlink()


# MV-19: Paths containing spaces and non-ASCII characters
def test_mv19_paths_with_spaces_and_non_ascii(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with tempfile.TemporaryDirectory(prefix="path with spaces and üñîçødè_") as unicode_dir:
        dest = Path(unicode_dir) / "image with space.png"
        shutil.copy2(temp_image_files[0], dest)

        ok, dims, _, _ = quick_image_check(dest)
        assert ok is True
        assert dims is not None


# MV-20: Concurrent jobs with identical image filenames
def test_mv20_concurrent_jobs_isolation(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with patch("subprocess.run", side_effect=mock_runner):
        res1 = run_multiview_reconstruction(temp_image_files[:3], job_id="job_alpha", colmap_custom_path=exe_path)
        res2 = run_multiview_reconstruction(temp_image_files[:3], job_id="job_beta", colmap_custom_path=exe_path)

    assert res1.job_id == "job_alpha"
    assert res2.job_id == "job_beta"
    assert res1.status == "success"
    assert res2.status == "success"


# MV-21: Timeout, process termination and cancellation
def test_mv21_timeout_handling(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    def timeout_runner(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=["colmap"], timeout=1)

    with patch("subprocess.run", side_effect=timeout_runner):
        res = run_multiview_reconstruction(
            temp_image_files[:3],
            job_id="mv21",
            colmap_custom_path=exe_path,
            options={"timeout_seconds": 1},
        )
    assert res.status == "failed"
    assert any("timed out" in e for e in res.diagnostics["errors"])


# MV-22: Corrupt intermediate database/model
def test_mv22_corrupt_intermediate_model(temp_image_files, mock_colmap_env):
    exe_path, _ = mock_colmap_env
    def corrupt_model_runner(cmd, *args, **kwargs):
        action = cmd[1] if len(cmd) > 1 else ""
        if action == "mapper":
            out_path = Path(cmd[cmd.index("--output_path") + 1])
            model_0 = out_path / "0"
            model_0.mkdir(parents=True, exist_ok=True)
            # Write corrupt text files
            (model_0 / "cameras.txt").write_text("corrupt data invalid line\n")
            (model_0 / "images.txt").write_text("corrupt\n")
            (model_0 / "points3D.txt").write_text("corrupt\n")
        res = MagicMock()
        res.returncode = 0
        return res

    with patch("subprocess.run", side_effect=corrupt_model_runner):
        res = run_multiview_reconstruction(temp_image_files[:3], job_id="mv22", colmap_custom_path=exe_path)
    assert res.status == "failed"
    assert res.registered_images == 0


# MV-23: Missing or mismatched segmentation masks
def test_mv23_missing_or_mismatched_masks(temp_image_files):
    masks = {"nonexistent.png": "missing_mask_file.png"}
    valid, diag = validate_image_set(temp_image_files[:3], masks=masks)
    assert len(valid) == 3


# MV-24: Moving camera vs rotating object capture modes
def test_mv24_capture_mode_explicit(temp_image_files, mock_colmap_env):
    exe_path, mock_runner = mock_colmap_env
    with patch("subprocess.run", side_effect=mock_runner):
        res_moving = run_multiview_reconstruction(
            temp_image_files[:3],
            job_id="mv24_m",
            options={"capture_mode": "moving_camera"},
            colmap_custom_path=exe_path,
        )
    assert res_moving.status == "success"


# MV-25: Metric references conflict
def test_mv25_metric_references_conflict(temp_image_files):
    # Expected ratio is 2.0, but provided target=100 and secondary=10 -> ratio 10.0 (conflict)
    ref = {
        "type": "known_distance",
        "distance_mm": 100.0,
        "secondary_distance_mm": 10.0,
        "expected_ratio": 2.0,
    }
    pts = [Point3D(point_id=1, xyz=[0, 0, 0], rgb=[0, 0, 0], error=0.1), Point3D(point_id=2, xyz=[1, 1, 1], rgb=[0, 0, 0], error=0.1)]
    imgs = [ImagePose(image_id=1, name="img1", camera_id=1, qvec=[1, 0, 0, 0], tvec=[0, 0, 0], registered=True)]
    scaled_pts, scaled_imgs, scale_info, errs = apply_metric_scale(pts, imgs, ref)
    assert scale_info.classification == "unknown"
    assert any("Contradictory metric scale references" in e for e in errs)

