"""
test_reconstruction_to_cad.py — Real Reconstruction → CAD integration test.

Unlike ``test_integration_contract.py`` (which drives the contract with the
static, documented housing fixture), this module exercises the **actual**
Reconstruction Engine public interface:

    solve_geometry(...)  ->  SolverResult  ->  interface_from_solver_result
                         ->  validate_interface  ->  POST /cad/from-reconstruction

It starts from a known synthetic cylinder (r = 25 mm, h = 100 mm, bore
d = 20 mm) whose dimensions the SciPy solver recovers.  The points are
**synthesised in-process** — COLMAP is never run — so the result is explicitly
re-labelled from the solver's default ``COLMAP_RECONSTRUCTION`` provenance to
the true synthetic-fixture source (see :func:`cad.integration_contract.record_fixture_source`).
The test then checks:

* units and scale status are preserved truthfully (metric -> absolute),
* provenance is mapped from the solver's own classification/provenance,
* no confidence/uncertainty is fabricated,
* the feature mapping produces a valid, exportable CAD solid,
* STEP and STL exports re-import and match the model,
* a missing critical dimension produces a clear ``needs_input`` rejection,
* a relative/unknown scale is rejected rather than silently assumed metric.

The real request/response JSON captured by these flows is written as evidence
by ``cad/scripts/generate_advanced_cad_demo_phase2.py``.
"""

from __future__ import annotations

import json
import os

import pytest

from reconstruction.geometry_solver import solve_geometry
from cad import integration_contract as ic
from cad import export_validation as ev


#: Truthful label for the deterministic point cloud used by these tests.  The
#: points are synthesised in-process; COLMAP is never run, so the solver's
#: default ``COLMAP_RECONSTRUCTION`` provenance must be corrected.
FIXTURE_SOURCE = "synthetic-cylinder-fixture"
FIXTURE_NOTE = ("Deterministic synthetic cylinder point cloud (r=25 mm, "
                "h=100 mm, bore d=20 mm); COLMAP was NOT run.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _multiview_metric(points):
    return {
        "points3D": [{"xyz": pt} for pt in points],
        "scale": {"classification": "metric"},
    }


def _solve_cylinder(synthetic_cylinder_points, *, with_bore: bool = True,
                    metric: bool = True):
    user_dims = {"inner_diameter": 20.0} if with_bore else None
    if metric:
        evidence = _multiview_metric(synthetic_cylinder_points["points"])
    else:
        # No scale block -> solver classifies the scale as 'relative'.
        evidence = {"points3D": [{"xyz": pt}
                                 for pt in synthetic_cylinder_points["points"]]}
    res = solve_geometry(
        job_id="recon_to_cad",
        component_type="cylinder",
        user_dimensions=user_dims,
        multiview_evidence=evidence,
    )
    # The cylinder point-cloud branch stamps the fit ``COLMAP_RECONSTRUCTION``
    # by default, but these points are a synthetic fixture and COLMAP was never
    # run.  Record the true source so the solver result, the adapted interface
    # and the written evidence never claim a reconstruction that did not happen.
    ic.record_fixture_source(res, source=FIXTURE_SOURCE,
                             colmap_executed=False, note=FIXTURE_NOTE)
    return res


# ---------------------------------------------------------------------------
# SolverResult -> contract mapping
# ---------------------------------------------------------------------------

def test_solver_result_recovers_known_cylinder(synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points)
    assert res.status in ("success", "partial")
    assert res.scale_classification == "metric"
    assert res.units == "mm"
    od = res.parameters["outer_diameter"]
    assert od["value"] is not None
    assert abs(od["value"] - synthetic_cylinder_points["true_diameter"]) < 1e-2
    height = res.parameters["height"]
    assert abs(height["value"] - synthetic_cylinder_points["true_height"]) < 1e-2
    assert res.parameters["inner_diameter"]["value"] == pytest.approx(20.0)


def test_solver_result_records_true_fixture_source(synthetic_cylinder_points):
    """Synthetic fixture data must never be labelled as a COLMAP run."""
    res = _solve_cylinder(synthetic_cylinder_points)

    # The true source is recorded explicitly on the solver result.
    assert res.metadata["fixture_source"] == FIXTURE_SOURCE
    assert res.metadata["colmap_executed"] is False

    # The point-cloud fit is re-labelled to the true fixture source...
    assert res.parameters["outer_diameter"]["provenance"] == ["SYNTHETIC_FIXTURE"]
    assert res.parameters["height"]["provenance"] == ["SYNTHETIC_FIXTURE"]
    assert all("COLMAP_RECONSTRUCTION" not in p["provenance"]
               for p in res.parameters.values())

    # ...while the user-supplied bore keeps USER_PROVIDED provenance and the
    # classification distinction is preserved (ESTIMATED vs MEASURED).
    assert res.parameters["inner_diameter"]["provenance"] == ["USER_PROVIDED"]
    assert res.parameters["outer_diameter"]["classification"] == "ESTIMATED"
    assert res.parameters["height"]["classification"] == "ESTIMATED"
    assert res.parameters["inner_diameter"]["classification"] == "MEASURED"


def test_interface_from_solver_result_preserves_units_and_scale(
        synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points)
    doc = ic.interface_from_solver_result(
        res, component_id="cyl_001", component_type="shaft",
        geometry_style="revolved", name="reconstructed_sleeve")

    assert doc["format"] == ic.INTERFACE_FORMAT
    assert doc["version"] == ic.INTERFACE_VERSION
    assert doc["units"]["length"] == "mm"
    assert doc["units"]["scale_status"] == "absolute"
    # Every length dimension is metric.
    for name in ("outer_diameter", "height", "inner_diameter", "outer_radius"):
        assert doc["dimensions"][name]["unit"] == "mm"


def test_interface_from_solver_result_maps_provenance_truthfully(
        synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points)
    doc = ic.interface_from_solver_result(res, component_id="cyl_001")

    # outer_diameter / height come from the point-cloud fit (ESTIMATED).
    assert doc["dimensions"]["outer_diameter"]["provenance"] in ("derived", "measured")
    # inner_diameter was supplied by the user (MEASURED / USER_PROVIDED).
    assert doc["dimensions"]["inner_diameter"]["provenance"] == "user_specified"
    # The derived radius is explicitly marked as derived.
    assert doc["dimensions"]["outer_radius"]["provenance"] == "derived"
    # No fabricated confidence.
    assert all("confidence" not in d for d in doc["dimensions"].values()
               if isinstance(d, dict))
    # Provenance records the solver metadata *and* the true fixture source, so
    # the adapted document never implies a COLMAP run.
    assert doc["provenance"]["method"] == "solver-result-adapter"
    assert doc["provenance"]["solver"]["scale_classification"] == "metric"
    assert doc["provenance"]["source"] == FIXTURE_SOURCE
    assert doc["provenance"]["fixture_source"] == FIXTURE_SOURCE
    assert doc["provenance"]["colmap_executed"] is False
    assert doc["provenance"]["dimension_meta"]["outer_diameter"]["solver_provenance"] \
        == ["SYNTHETIC_FIXTURE"]


def test_solver_result_interface_validates_and_maps_features(
        synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points)
    doc = ic.interface_from_solver_result(res, component_id="cyl_001",
                                          component_type="shaft")
    val = ic.validate_interface(doc)
    assert val["valid"], val["issues"]
    assert val["status"] == "ok"

    types = [f["type"] for f in val["recipe_dict"]["features"]]
    assert "base_cylinder" in types
    assert "through_bore" in types
    # Every feature carries an explicit operation agreeing with the registry.
    from cad.feature_schema import operation_for_type
    for f in val["recipe_dict"]["features"]:
        assert f["operation"] == operation_for_type(f["type"])


def test_dimension_semantics_reported(synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points)
    doc = ic.interface_from_solver_result(res, component_id="cyl_001")
    val = ic.validate_interface(doc)
    sems = val["dimension_semantics"]
    assert sems["outer_radius"] == ["length"]
    assert sems["inner_diameter"] == ["length"]


# ---------------------------------------------------------------------------
# Missing critical dimension -> needs_input rejection
# ---------------------------------------------------------------------------

def test_missing_inner_diameter_needs_input(synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points, with_bore=False)
    assert "inner_diameter" in res.missing_critical_dimensions

    doc = ic.interface_from_solver_result(res, component_id="cyl_nobore",
                                          component_type="shaft")
    assert "inner_diameter" in doc["missing_dimensions"]

    val = ic.validate_interface(doc)
    assert not val["valid"]
    assert val["status"] == "needs_input"
    assert "inner_diameter" in val["missing_dimensions"]


def test_endpoint_rejects_missing_critical_dimension(
        synthetic_cylinder_points, tmp_path):
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest
    from fastapi.responses import JSONResponse

    res = _solve_cylinder(synthetic_cylinder_points, with_bore=False)
    doc = ic.interface_from_solver_result(res, component_id="cyl_nobore",
                                          component_type="shaft")
    payload = ReconstructionCadRequest(
        job_id="recon_missing", interface=doc, model=True,
        output_dir=str(tmp_path))
    out = cad_from_reconstruction_endpoint(payload)
    assert isinstance(out, JSONResponse)
    assert out.status_code == 422
    body = json.loads(bytes(out.body).decode("utf-8"))
    assert body["stage"] == "integration_contract"
    assert "inner_diameter" in body["missing_dimensions"]


# ---------------------------------------------------------------------------
# Relative / unknown scale -> rejection
# ---------------------------------------------------------------------------

def test_relative_scale_is_rejected(synthetic_cylinder_points):
    res = _solve_cylinder(synthetic_cylinder_points, metric=False)
    assert res.scale_classification == "relative"
    doc = ic.interface_from_solver_result(res, component_id="cyl_rel")
    assert doc["units"]["scale_status"] == "unknown"
    val = ic.validate_interface(doc)
    assert not val["valid"]
    assert any("scale" in i.lower() for i in val["issues"])


def test_endpoint_rejects_relative_scale(synthetic_cylinder_points, tmp_path):
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest
    from fastapi.responses import JSONResponse

    res = _solve_cylinder(synthetic_cylinder_points, metric=False)
    doc = ic.interface_from_solver_result(res, component_id="cyl_rel")
    payload = ReconstructionCadRequest(
        job_id="recon_rel", interface=doc, model=True,
        output_dir=str(tmp_path))
    out = cad_from_reconstruction_endpoint(payload)
    assert isinstance(out, JSONResponse)
    assert out.status_code == 422


# ---------------------------------------------------------------------------
# Full end-to-end: solve -> adapt -> endpoint -> model -> export -> re-import
# ---------------------------------------------------------------------------

def test_end_to_end_reconstruction_to_cad_exports(synthetic_cylinder_points,
                                                  tmp_path):
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest

    res = _solve_cylinder(synthetic_cylinder_points)
    doc = ic.interface_from_solver_result(
        res, component_id="cyl_001", component_type="shaft",
        geometry_style="revolved", name="reconstructed_sleeve")

    request = {
        "job_id": "recon_to_cad",
        "interface": doc,
        "model": True,
        "output_dir": str(tmp_path),
    }
    payload = ReconstructionCadRequest(
        job_id="recon_to_cad", interface=doc, model=True,
        output_dir=str(tmp_path))
    response = cad_from_reconstruction_endpoint(payload)

    assert response["status"] == "success", response
    assert response["mode"] == "feature"
    report = response["validation_report"]
    assert report["valid"] is True
    assert os.path.isfile(response["step_path"])
    assert os.path.isfile(response["stl_path"])

    # Re-import the exports and compare against the modelled solid.
    from cad.feature_modeller import model_feature_recipe
    from cad.advanced_cad_validator import validate_feature_geometry
    recipe = ic.validate_interface(doc)["recipe_dict"]
    wp, history = model_feature_recipe(recipe, strict=False)

    step_val = ev.validate_step_export(response["step_path"], wp)
    assert step_val["valid"], step_val["issues"]
    stl_val = ev.validate_stl_export(response["stl_path"], wp)
    assert stl_val["valid"], stl_val["issues"]

    # The recovered bounding box matches the known cylinder (50 x 50 x 100).
    od = res.parameters["outer_diameter"]["value"]
    height = res.parameters["height"]["value"]
    bbox = report["metrics"]["actual_bbox"]
    assert bbox["xlen"] == pytest.approx(od, abs=1e-2)
    assert bbox["zlen"] == pytest.approx(height, abs=1e-2)
    # fit_score is qualified: bbox-only agreement is not accuracy.
    assert report["fit_score_basis"]["method"] in ("bbox_only", "volume_and_bbox")
    assert report["fit_score_basis"]["is_accuracy_metric"] is False
    assert report["check_categories"]["geometry_validity"] is True
    assert report["check_categories"]["bounding_box"] is True

    # Evidence: real request/response JSON round-trips.
    evidence = {"request": request,
                "response": {k: v for k, v in response.items()
                             if k not in ("feature_history",)}}
    text = json.dumps(evidence)
    assert json.loads(text)["response"]["status"] == "success"
    (tmp_path / "recon_to_cad_evidence.json").write_text(text, encoding="utf-8")
    assert (tmp_path / "recon_to_cad_evidence.json").is_file()
