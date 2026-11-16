"""Stage 4: analytic feature fit, honest statuses and export gating."""
import copy
from pathlib import Path

import pytest

from cad.advanced_cad_validator import validate_feature_geometry
from cad.advanced_recipe_adapter import generate_cad_from_recipe
from cad.feature_fit import (
    assess_measurement_build,
    compare_features,
    extract_cylindrical_faces,
)
from cad.measurement_to_features import synthesize_feature_recipe


def circular_measurements():
    return {
        "schema_version": "1.0",
        "status": "ok",
        "view": {"label": "axial_face", "confidence": 0.92, "vote_agreement": 0.95},
        "outer": {"shape": "circular", "non_circular": False},
        "concentric": [{"radius_ratio": 0.30, "confidence": 0.94}],
        "radial_patterns": [{
            "count": 6,
            "pattern_radius_ratio": 0.63,
            "hole_radius_ratio": 0.0875,
            "start_angle_deg": 0.0,
            "count_confidence": 0.99,
            "confidence": 0.93,
        }],
        "holes": [],
        "side_profile": None,
        "polygon": None,
        "agreement_score": 0.88,
        "needs_input": [],
        "warnings": [],
        "images": [
            {"image_index": 0, "view": "axial_face", "view_confidence": 0.92},
        ],
    }


def build(measurements, user_dimensions):
    synthesis = synthesize_feature_recipe(measurements, user_dimensions=user_dimensions)
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assessment = assess_measurement_build(
        synthesis, report, fit, measurements,
    )
    return synthesis, workplane, report, fit, assessment


def test_exact_build_passes_all_four_statuses():
    synthesis, workplane, report, fit, assessment = build(
        circular_measurements(), {"outer_diameter": 120, "thickness": 20}
    )
    assert report["valid"] is True
    assert fit["status"] == "pass"
    assert fit["score"] == pytest.approx(1.0)
    assert fit["is_dimensional_accuracy_metric"] is True

    faces = extract_cylindrical_faces(workplane)
    # outer + bore + six pattern holes
    assert len(faces) == 8

    statuses = assessment["statuses"]
    assert statuses["geometry"]["status"] == "valid"
    assert statuses["reconstruction"]["status"] == "complete"
    assert statuses["reconstruction"]["evidence"]["image_count"] == 1
    assert statuses["dimensional_accuracy"]["status"] == "pass"
    assert statuses["manufacturing_readiness"]["status"] == "ready"
    assert assessment["export_allowed"] is True
    assert assessment["preview_only"] is False


def test_deleting_bolt_holes_lowers_score_and_blocks_export():
    synthesis, workplane, report, fit, assessment = build(
        circular_measurements(), {"outer_diameter": 120, "thickness": 20}
    )
    reduced_recipe = copy.deepcopy(synthesis["recipe"])
    reduced_recipe["features"] = [
        feature for feature in reduced_recipe["features"]
        if feature["type"] != "bolt_circle"
    ]
    reduced_wp, reduced_history = generate_cad_from_recipe(reduced_recipe, strict=True)
    reduced_report = validate_feature_geometry(reduced_wp, reduced_recipe, reduced_history)
    reduced_fit = compare_features(
        reduced_wp, synthesis["recipe"], synthesis["scale"]
    )
    reduced_assessment = assess_measurement_build(
        synthesis, reduced_report, reduced_fit, circular_measurements(),
    )

    assert reduced_fit["score"] < fit["score"]
    assert reduced_fit["status"] == "fail"
    assert any(
        item["type"] == "bolt_circle_holes"
        for item in reduced_fit["missing_features"]
    )
    readiness = reduced_assessment["statuses"]["manufacturing_readiness"]
    assert "dimensional_fit_failed" in readiness["block_reasons"]
    assert reduced_assessment["export_allowed"] is False


def test_wrong_bore_radius_is_penalised():
    synthesis, workplane, report, fit, assessment = build(
        circular_measurements(), {"outer_diameter": 120, "thickness": 20}
    )
    modified = copy.deepcopy(synthesis["recipe"])
    for feature in modified["features"]:
        if feature["type"] == "through_bore":
            feature["parameters"]["diameter"] = 50.0
    modified_wp, modified_history = generate_cad_from_recipe(modified, strict=True)
    modified_report = validate_feature_geometry(modified_wp, modified, modified_history)
    modified_fit = compare_features(
        modified_wp, synthesis["recipe"], synthesis["scale"]
    )
    assert modified_fit["score"] < fit["score"]
    assert modified_fit["components"]["bore"] < 0.5

    modified_assessment = assess_measurement_build(
        synthesis, modified_report, modified_fit, circular_measurements(),
    )
    assert modified_assessment["statuses"]["dimensional_accuracy"]["status"] != "pass"


def test_un_anchored_measurements_are_insufficient_and_not_exportable():
    measurements = circular_measurements()
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"thickness": 20}
    )
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assessment = assess_measurement_build(synthesis, report, fit, measurements)

    assert synthesis["scale"]["mode"] == "assumed"
    assert assessment["statuses"]["reconstruction"]["status"] == "insufficient"
    readiness = assessment["statuses"]["manufacturing_readiness"]
    assert readiness["status"] == "blocked"
    assert "scale_not_anchored" in readiness["block_reasons"]
    assert assessment["export_allowed"] is False


def test_assumed_thickness_blocks_manufacturing_readiness():
    measurements = circular_measurements()
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 120}
    )
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assessment = assess_measurement_build(synthesis, report, fit, measurements)

    assert synthesis["provenance"]["thickness"]["assumed"] is True
    readiness = assessment["statuses"]["manufacturing_readiness"]
    assert readiness["status"] == "blocked"
    assert "critical_dimensions_assumed" in readiness["block_reasons"]
    assumed_names = [item["parameter"] for item in assessment["assumed_dimensions"]]
    assert "thickness" in assumed_names
    assert assessment["preview_only"] is True


def test_estimated_dimensions_are_treated_as_assumed():
    measurements = circular_measurements()
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 120, "thickness": 20}
    )
    synthesis["provenance"]["hole_diameter"] = {
        "value": 10.5,
        "provenance": "vision_estimated",
        "confidence": 0.4,
        "source": "gemini_hint",
        "assumed": True,
    }
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assessment = assess_measurement_build(synthesis, report, fit, measurements)

    readiness = assessment["statuses"]["manufacturing_readiness"]
    assert readiness["status"] == "blocked"
    assert any(
        item["parameter"] == "hole_diameter"
        for item in assessment["assumed_dimensions"]
    )


def test_explicit_override_allows_assumed_export():
    measurements = circular_measurements()
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 120}
    )
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assessment = assess_measurement_build(
        synthesis, report, fit, measurements, export_override=True,
    )
    readiness = assessment["statuses"]["manufacturing_readiness"]
    assert readiness["status"] == "ready_with_assumptions"
    assert readiness["override_used"] is True
    assert assessment["export_allowed"] is True


def test_polygonal_and_revolved_profiles_are_compared():
    measurements = {
        "schema_version": "1.0",
        "status": "ok",
        "view": {"label": "oblique", "confidence": 0.7},
        "outer": {"shape": "polygonal", "non_circular": True},
        "concentric": [{"radius_ratio": 0.14, "confidence": 0.9}],
        "radial_patterns": [],
        "holes": [
            {"x_ratio": 0.5, "y_ratio": 0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": -0.5, "y_ratio": 0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": 0.5, "y_ratio": -0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": -0.5, "y_ratio": -0.36, "radius_ratio": 0.07, "confidence": 0.9},
        ],
        "polygon": {
            "points": [
                {"x_ratio": -0.5, "y_ratio": -0.31},
                {"x_ratio": 0.5, "y_ratio": -0.31},
                {"x_ratio": 0.5, "y_ratio": 0.31},
                {"x_ratio": -0.5, "y_ratio": 0.31},
            ],
        },
        "side_profile": {
            "points": [
                {"z_ratio": 0.0, "r_ratio": 0.45},
                {"z_ratio": 0.2, "r_ratio": 0.45},
                {"z_ratio": 0.2, "r_ratio": 1.0},
                {"z_ratio": 0.35, "r_ratio": 1.0},
            ],
            "thickness_ratio": 0.15,
            "height_ratio": 0.35,
            "hub_height_ratio": 0.2,
            "hub_radius_ratio": 0.45,
        },
        "agreement_score": 0.8,
        "images": [{"image_index": 0, "view": "oblique", "view_confidence": 0.7}],
    }
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"width": 160, "thickness": 8}
    )
    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    fit = compare_features(workplane, synthesis["recipe"], synthesis["scale"])
    assert report["valid"] is True
    assert fit["status"] == "pass"
    assert "holes" in fit["components"]

    revolved = copy.deepcopy(measurements)
    revolved.pop("polygon", None)
    revolved["outer"] = {"shape": "circular"}
    revolved["concentric"] = []
    revolved["holes"] = []
    revolved["side_profile"] = {
        "points": [
            {"z_ratio": 0.0, "r_ratio": 0.45},
            {"z_ratio": 0.12, "r_ratio": 0.45},
            {"z_ratio": 0.13, "r_ratio": 1.0},
            {"z_ratio": 0.30, "r_ratio": 1.0},
        ],
        "thickness_ratio": 0.17,
        "height_ratio": 0.30,
        "hub_height_ratio": 0.13,
        "hub_radius_ratio": 0.45,
    }
    revolved_synthesis = synthesize_feature_recipe(
        revolved, user_dimensions={"outer_diameter": 100}
    )
    revolved_wp, revolved_history = generate_cad_from_recipe(
        revolved_synthesis["recipe"], strict=True
    )
    revolved_fit = compare_features(
        revolved_wp, revolved_synthesis["recipe"], revolved_synthesis["scale"]
    )
    assert "profile" in revolved_fit["components"]
    assert revolved_fit["components"]["profile"] == pytest.approx(1.0)


def test_endpoint_exposes_statuses_and_gates_manufacturing_exports(tmp_path):
    from app import (
        MeasurementCadGenerateRequest,
        generate_cad_from_measurements_endpoint,
    )

    ready = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="fit_ready",
        measurements=circular_measurements(),
        user_dimensions={"outer_diameter": 120, "thickness": 20},
        output_dir=str(tmp_path),
    ))
    assert ready["export_allowed"] is True
    assert ready["manufacturing_ready"] is True
    assert ready["step_path"] and Path(ready["step_path"]).exists()
    assert ready["feature_fit"]["status"] == "pass"
    assert ready["validation_statuses"]["dimensional_accuracy"]["status"] == "pass"

    preview = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="fit_preview",
        measurements=circular_measurements(),
        user_dimensions={"outer_diameter": 120},
        output_dir=str(tmp_path),
    ))
    assert preview["preview_only"] is True
    assert preview["export_allowed"] is False
    assert preview["step_path"] is None
    assert preview["stl_path"] is None
    assert Path(preview["preview_step_path"]).exists()
    assert Path(preview["preview_stl_path"]).exists()
    assert "critical_dimensions_assumed" in preview["export_block_reasons"]
    assert preview["validation_statuses"]["manufacturing_readiness"]["status"] == "blocked"

    overridden = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="fit_override",
        measurements=circular_measurements(),
        user_dimensions={"outer_diameter": 120},
        output_dir=str(tmp_path),
        export_override=True,
    ))
    assert overridden["export_allowed"] is True
    assert overridden["preview_only"] is False
    assert overridden["export_override_used"] is True
    assert overridden["step_path"] and Path(overridden["step_path"]).exists()


def test_endpoint_env_flag_can_allow_assumed_exports(tmp_path, monkeypatch):
    from app import (
        MeasurementCadGenerateRequest,
        generate_cad_from_measurements_endpoint,
    )

    monkeypatch.setenv("ALLOW_ASSUMED_EXPORTS", "true")
    response = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="fit_env",
        measurements=circular_measurements(),
        user_dimensions={"outer_diameter": 120},
        output_dir=str(tmp_path),
    ))
    assert response["export_allowed"] is True
    assert response["preview_only"] is False
    assert response["export_override_used"] is True
