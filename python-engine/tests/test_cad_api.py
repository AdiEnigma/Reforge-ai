"""
test_cad_api.py — Integration Tests for POST /cad/generate API Endpoint.
"""

from __future__ import annotations

import json
import os
import pytest
from unittest.mock import patch

from app import generate_cad_endpoint, CadGenerateRequest
from exports.step_export import StepExportError
from exports.mesh_export import MeshExportError


def test_cad_generate_endpoint_success(tmp_path):
    """End-to-end: Recipe -> Solid -> Validation -> STEP & STL Export."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 25.0, "y": 0.0},
            {"x": 25.0, "y": 25.0},
            {"x": 0.0, "y": 25.0},
        ],
        "depth": 10.0,
        "holes": [{"cx": 12.5, "cy": 12.5, "radius": 3.0}],
    }
    payload = CadGenerateRequest(
        job_id="api_test_01",
        recipe=recipe,
        output_dir=str(tmp_path),
    )
    res = generate_cad_endpoint(payload)

    # If dict returned directly (FastAPI default when not returning JSONResponse)
    assert isinstance(res, dict)
    assert res["status"] == "success"
    assert res["job_id"] == "api_test_01"
    assert res["cad_spec"]["status"] == "ok"
    assert res["feature_tree"]["style"] == "extruded"
    assert res["validation_report"]["valid"] is True
    assert res["validation_report"]["fit_score"] > 0.9

    step_path = res["step_path"]
    stl_path = res["stl_path"]

    assert os.path.exists(step_path)
    assert os.path.getsize(step_path) > 0
    assert os.path.exists(stl_path)
    assert os.path.getsize(stl_path) > 0

    # Ensure JSON serializability
    serialized = json.dumps(res)
    assert len(serialized) > 0


def test_cad_generate_endpoint_rejected_recipe():
    """Rejected recipe produces status 400 and does not export files."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
        ],  # Outline with < 3 points rejected
        "depth": 5.0,
    }
    payload = CadGenerateRequest(job_id="reject_01", recipe=recipe)
    res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    assert res.status_code == 400
    body = json.loads(res.body.decode("utf-8"))
    assert body["status"] == "error"
    assert body["stage"] == "recipe_validation"
    assert "rejected" in body["error"]


def test_cad_generate_endpoint_needs_input():
    """Incomplete recipe missing depth produces needs_input status 400."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 0.0, "y": 20.0},
        ],
        # depth missing
    }
    payload = CadGenerateRequest(job_id="needs_01", recipe=recipe)
    res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    assert res.status_code == 400
    body = json.loads(res.body.decode("utf-8"))
    assert body["status"] == "needs_input"
    assert body["stage"] == "recipe_validation"
    assert "depth" in body["missing"]


def test_cad_generate_endpoint_cad_generation_failure():
    """Unresolvable CAD generation error returns 422."""
    recipe = {
        "style": "unsupported_unknown_style",
    }
    payload = CadGenerateRequest(job_id="unsupp_01", recipe=recipe)
    res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    # Rejected by validator or generator
    assert res.status_code in (400, 422)


def test_cad_generate_endpoint_validation_failure():
    """If geometry validation returns valid=False, endpoint returns 422 and skips export."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 0.0, "y": 20.0},
        ],
        "depth": 10.0,
    }
    payload = CadGenerateRequest(job_id="val_fail_01", recipe=recipe)

    # Mock validate_cad_geometry to simulate geometry validation failure
    with patch("app.validate_cad_geometry", return_value={"valid": False, "fit_score": 0.0, "issues": ["Mocked bounding box failure"]}):
        res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    assert res.status_code == 422
    body = json.loads(res.body.decode("utf-8"))
    assert body["status"] == "error"
    assert body["stage"] == "cad_validation"
    assert "validation_report" in body
    assert body["validation_report"]["valid"] is False


def test_cad_generate_endpoint_step_export_failure():
    """STEP export exception produces structured 500 error."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 0.0, "y": 20.0},
        ],
        "depth": 10.0,
    }
    payload = CadGenerateRequest(job_id="step_fail_01", recipe=recipe)

    with patch("app.export_step", side_effect=StepExportError("STEP write permission denied")):
        res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    assert res.status_code == 500
    body = json.loads(res.body.decode("utf-8"))
    assert body["status"] == "error"
    assert body["stage"] == "step_export"
    assert "STEP write permission denied" in body["error"]


def test_cad_generate_endpoint_stl_export_failure():
    """STL export exception produces structured 500 error."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 0.0, "y": 20.0},
        ],
        "depth": 10.0,
    }
    payload = CadGenerateRequest(job_id="stl_fail_01", recipe=recipe)

    with patch("app.export_stl", side_effect=MeshExportError("Mesh generation failed")):
        res = generate_cad_endpoint(payload)

    assert hasattr(res, "status_code")
    assert res.status_code == 500
    body = json.loads(res.body.decode("utf-8"))
    assert body["status"] == "error"
    assert body["stage"] == "stl_export"
    assert "Mesh generation failed" in body["error"]

