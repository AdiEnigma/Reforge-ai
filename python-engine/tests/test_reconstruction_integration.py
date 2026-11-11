"""
test_reconstruction_integration.py — Cross-Module & Application Integration Tests.
"""

import asyncio
import json
import math
from unittest.mock import patch, MagicMock
import pytest

from app import health, full_reconstruct_endpoint, solve_endpoint, ReconstructRequest
from reconstruction.multiview import run_multiview_reconstruction
from reconstruction.geometry_solver import solve_geometry, CLASSIFICATION_MEASURED, CLASSIFICATION_ESTIMATED


def test_integration_health_endpoint():
    """GET /health reports service status and capabilities."""
    res = health()
    assert res["ok"] is True
    assert res["service"] == "reforge-reconstruction-engine"
    assert "scipy_solver_available" in res["capabilities"]


def test_integration_multiview_to_solver_pipeline(temp_image_files, mock_colmap_env):
    """End-to-end: Multi-view SfM evidence feeds directly into SciPy solver."""
    exe_path, mock_runner = mock_colmap_env
    reference = {"type": "known_distance", "distance_mm": 50.0}

    with patch("subprocess.run", side_effect=mock_runner):
        mv_res = run_multiview_reconstruction(
            image_paths=temp_image_files[:3],
            job_id="integ_01",
            reference=reference,
            colmap_custom_path=exe_path,
        )

    assert mv_res.status == "success"
    assert mv_res.scale["classification"] == "metric"
    assert len(mv_res.points3D) > 0

    # Pass multiview result directly into geometry solver
    solver_res = solve_geometry(
        job_id="integ_01",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 50.0},
        multiview_evidence=mv_res.to_dict(),
    )

    assert solver_res.status == "success"
    assert solver_res.scale_classification == "metric"
    assert solver_res.coordinate_frame == "component_local"
    assert solver_res.parameters["outer_diameter"]["classification"] == CLASSIFICATION_MEASURED
    assert solver_res.parameters["outer_diameter"]["value"] == 50.0
    assert solver_res.parameters["height"]["classification"] == CLASSIFICATION_ESTIMATED

    # Verify JSON serializability
    serialized = json.dumps(solver_res.to_dict())
    assert len(serialized) > 0
    deserialized = json.loads(serialized)
    assert deserialized["schema_version"] == "1.0"


def test_integration_single_image_bypasses_colmap_cleanly(temp_image_files):
    """Single-image job operates seamlessly with SciPy solver without invoking COLMAP."""
    solver_res = solve_geometry(
        job_id="single_img_job",
        component_type="flange",
        user_dimensions={"outer_diameter": 120.0, "inner_diameter": 40.0, "thickness": 15.0},
    )
    assert solver_res.status == "success"
    assert solver_res.parameters["outer_diameter"]["value"] == 120.0
    assert solver_res.parameters["inner_diameter"]["value"] == 40.0
    assert solver_res.parameters["thickness"]["value"] == 15.0


def test_integration_missing_colmap_preserves_solver(temp_image_files):
    """When COLMAP is missing, multi-view returns unavailable while solver still functions."""
    with patch("reconstruction.multiview.find_colmap_executable", return_value=None):
        mv_res = run_multiview_reconstruction(temp_image_files[:3], job_id="no_colmap")
    assert mv_res.status == "unavailable"

    solver_res = solve_geometry(
        job_id="no_colmap",
        component_type="gear",
        user_dimensions={"teeth": 24, "module": 2.5},
        multiview_evidence=mv_res.to_dict(),
    )
    assert solver_res.status == "success"
    assert solver_res.parameters["pitch_diameter"]["value"] == 60.0


def test_integration_api_full_reconstruct_endpoint(temp_image_files, mock_colmap_env):
    """POST /reconstruct end-to-end endpoint with mocked COLMAP."""
    exe_path, mock_runner = mock_colmap_env
    payload = ReconstructRequest(
        job_id="api_test_01",
        component_type="cylinder",
        image_paths=[str(p) for p in temp_image_files[:3]],
        user_dimensions={"outer_diameter": 60.0},
        options={"colmap_custom_path": exe_path},
    )

    with patch("reconstruction.multiview.find_colmap_executable", return_value=exe_path):
        with patch("subprocess.run", side_effect=mock_runner):
            res = full_reconstruct_endpoint(payload)

    assert res["job_id"] == "api_test_01"
    assert "multiview" in res
    assert "solver" in res
    assert res["solver"]["status"] == "success"
    assert res["solver"]["parameters"]["outer_diameter"]["value"] == 60.0


def test_integration_strict_finite_json_guarantee(synthetic_cylinder_points):
    """Ensures no NaN or Infinity is serialized in solver or multiview results."""
    res = solve_geometry(
        job_id="finite_check",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]]},
    )
    d = res.to_dict()
    raw_str = json.dumps(d)
    assert "NaN" not in raw_str
    assert "Infinity" not in raw_str
