"""Tests for measurement -> generic feature-recipe synthesis and its endpoint."""
import json
from pathlib import Path

import pytest

from cad.advanced_cad_validator import validate_feature_geometry
from cad.advanced_recipe_adapter import generate_cad_from_recipe
from cad.feature_recipe_validator import validate_feature_recipe
from cad.measurement_to_features import (
    DEFAULT_OUTER_DIAMETER_UNITS,
    MeasurementSynthesisError,
    synthesize_feature_recipe,
)


def circular_measurements(**overrides):
    measurement = {
        "schema_version": "1.0",
        "status": "ok",
        "view": {"label": "axial_face", "confidence": 0.92},
        "outer": {"shape": "circular", "non_circular": False},
        "concentric": [{"radius_ratio": 0.30, "confidence": 0.94}],
        "radial_patterns": [{
            "count": 6,
            "observed_count": 6,
            "occluded_estimate": 0,
            "pattern_radius_ratio": 0.63,
            "hole_radius_ratio": 0.0875,
            "start_angle_deg": 0.0,
            "angular_residual_deg": 0.1,
            "count_confidence": 0.99,
            "confidence": 0.93,
        }],
        "holes": [],
        "side_profile": {
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
            "step_count": 1,
            "confidence": 0.90,
        },
        "polygon": None,
        "agreement_score": 0.88,
        "needs_input": [],
        "warnings": [],
    }
    measurement.update(overrides)
    return measurement


def polygonal_measurements():
    return {
        "schema_version": "1.0",
        "status": "ok",
        "view": {"label": "oblique", "confidence": 0.70},
        "outer": {"shape": "polygonal", "non_circular": True},
        "concentric": [{"radius_ratio": 0.14, "confidence": 0.94}],
        "radial_patterns": [],
        "holes": [
            {"x_ratio": 0.50, "y_ratio": 0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": -0.50, "y_ratio": 0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": 0.50, "y_ratio": -0.36, "radius_ratio": 0.07, "confidence": 0.9},
            {"x_ratio": -0.50, "y_ratio": -0.36, "radius_ratio": 0.07, "confidence": 0.9},
        ],
        "polygon": {
            "points": [
                {"x_ratio": -0.5, "y_ratio": -0.31},
                {"x_ratio": 0.5, "y_ratio": -0.31},
                {"x_ratio": 0.5, "y_ratio": 0.31},
                {"x_ratio": -0.5, "y_ratio": 0.31},
            ],
            "point_count": 4,
            "confidence": 0.75,
        },
        "side_profile": None,
        "agreement_score": 0.80,
        "needs_input": [],
        "warnings": [],
    }


def test_circular_part_builds_valid_geometry():
    synthesis = synthesize_feature_recipe(
        circular_measurements(), user_dimensions={"outer_diameter": 120}
    )
    assert synthesis["status"] == "ok"
    assert synthesis["scale"]["mode"] == "anchored"
    assert synthesis["recipe"]["metadata"]["source"] == "feature_measurements"
    assert synthesis["topology"] == {
        "outer": "circular",
        "has_side_profile": True,
        "bore": True,
        "hub": True,
        "hole_count": 6,
        "radial_pattern": True,
    }

    types = [feature["type"] for feature in synthesis["recipe"]["features"]]
    assert types[0] == "revolve_profile"
    assert "through_bore" in types
    assert "bolt_circle" in types

    validation = validate_feature_recipe(synthesis["recipe"])
    assert validation.status == "ok", validation.errors

    workplane, history = generate_cad_from_recipe(synthesis["recipe"], strict=True)
    report = validate_feature_geometry(workplane, synthesis["recipe"], history)
    assert report["valid"] is True


def test_no_anchor_is_preview_only_and_never_invents_millimetres():
    synthesis = synthesize_feature_recipe(circular_measurements())
    assert synthesis["scale"]["mode"] == "assumed"
    assert synthesis["scale"]["preview_only"] is True
    assert synthesis["scale"]["outer_diameter"] == DEFAULT_OUTER_DIAMETER_UNITS
    assert synthesis["recipe"]["units"] == "mm"
    assert synthesis["recipe"]["metadata"]["length_unit"] == "reference_unit"
    assert any(item["parameter"] == "absolute_scale" for item in synthesis["needs_input"])
    assert synthesis["recipe"]["metadata"]["preview_only"] is True


def test_user_dimensions_override_measurements():
    synthesis = synthesize_feature_recipe(
        circular_measurements(),
        user_dimensions={
            "outer_diameter": 120,
            "bore_diameter": 50,
            "thickness": 20,
            "hole_count": 8,
            "hole_diameter": 9,
            "bolt_circle_diameter": 90,
        },
    )
    features = {feature["id"]: feature for feature in synthesis["recipe"]["features"]}
    assert features["bore_1"]["parameters"]["diameter"] == 50.0
    assert features["bolt_circle_1"]["parameters"]["count"] == 8
    assert features["bolt_circle_1"]["parameters"]["holeDiameter"] == 9.0
    assert features["bolt_circle_1"]["parameters"]["boltCircleRadius"] == 45.0
    assert synthesis["provenance"]["outer_diameter"]["provenance"] == "user_provided"
    assert synthesis["provenance"]["bore_diameter"]["provenance"] == "user_provided"


def test_bore_anchor_scales_the_model():
    measurements = circular_measurements()
    measurements["side_profile"] = None
    synthesis = synthesize_feature_recipe(measurements, user_dimensions={"bore_diameter": 40})
    # Bore ratio 0.30 => outer radius 40 / (2 * 0.30) = 66.666...
    assert synthesis["scale"]["source"] == "user_bore_anchor"
    assert synthesis["scale"]["outer_diameter"] == pytest.approx(133.3333, abs=1e-3)


def test_calibration_pattern_anchor_scales_the_model():
    measurements = circular_measurements()
    measurements["side_profile"] = None
    synthesis = synthesize_feature_recipe(
        measurements,
        user_dimensions={"thickness": 10},
        calibration={"anchor_parameter": "bolt_circle_diameter", "anchor_value_mm": 100},
    )
    assert synthesis["scale"]["source"] == "calibration_anchor"
    assert synthesis["scale"]["outer_diameter"] == pytest.approx(200.0 / 1.26, abs=1e-2)


def test_polygonal_plate_keeps_outline_and_individual_holes():
    synthesis = synthesize_feature_recipe(
        polygonal_measurements(), user_dimensions={"width": 160, "thickness": 8}
    )
    assert synthesis["status"] == "ok"
    features = synthesis["recipe"]["features"]
    assert features[0]["type"] == "extrude_profile"
    outline = features[0]["parameters"]["outline"]
    assert len(outline) == 4
    assert max(point["x"] for point in outline) == 80.0
    assert max(point["y"] for point in outline) == pytest.approx(49.6, abs=0.05)

    holes = [f for f in features if f["type"] == "through_bore" and f["id"] != "bore_1"]
    assert len(holes) == 4
    assert not any(f["type"] == "bolt_circle" for f in features)

    validation = validate_feature_recipe(synthesis["recipe"])
    assert validation.status == "ok", validation.errors


def test_irregular_concentric_circles_ask_instead_of_inventing_counterbores():
    measurements = circular_measurements()
    measurements["concentric"] = [
        {"radius_ratio": 0.30, "confidence": 0.9},
        {"radius_ratio": 0.50, "confidence": 0.9},
    ]
    measurements["side_profile"] = None
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 100, "thickness": 10}
    )
    assert any(item["parameter"] == "concentric_feature" for item in synthesis["needs_input"])
    assert not any(
        feature["type"] == "counterbore"
        for feature in synthesis["recipe"]["features"]
    )
    assert synthesis["recipe"]["metadata"]["preview_only"] is True


def test_overlapping_holes_are_reported_as_sanity_errors():
    measurements = circular_measurements()
    measurements["radial_patterns"] = [{
        "count": 3,
        "pattern_radius_ratio": 0.50,
        "hole_radius_ratio": 0.45,
        "start_angle_deg": 0.0,
        "count_confidence": 0.9,
        "confidence": 0.9,
    }]
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 100, "thickness": 10}
    )
    assert synthesis["status"] == "error"
    assert any("overlap" in error.lower() for error in synthesis["sanity_errors"])


def test_oversized_bore_is_rejected():
    measurements = circular_measurements()
    measurements["concentric"] = [{"radius_ratio": 0.60, "confidence": 0.9}]
    measurements["side_profile"] = None
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 100, "thickness": 10}
    )
    assert synthesis["status"] == "error"


def test_hole_count_is_bounded():
    measurements = circular_measurements()
    measurements["radial_patterns"] = [{
        "count": 100,
        "pattern_radius_ratio": 0.8,
        "hole_radius_ratio": 0.025,
        "start_angle_deg": 0.0,
        "count_confidence": 0.9,
        "confidence": 0.9,
    }]
    synthesis = synthesize_feature_recipe(
        measurements, user_dimensions={"outer_diameter": 100, "thickness": 10}
    )
    bolt = next(f for f in synthesis["recipe"]["features"] if f["type"] == "bolt_circle")
    assert bolt["parameters"]["count"] == 64


def test_side_only_measurements_revolve_without_axial_bore():
    measurements = circular_measurements()
    measurements["concentric"] = []
    measurements["radial_patterns"] = []
    measurements["view"] = {"label": "side_profile", "confidence": 0.85}
    measurements["outer"] = {"shape": "silhouette"}
    synthesis = synthesize_feature_recipe(measurements, user_dimensions={"outer_diameter": 100})
    types = [feature["type"] for feature in synthesis["recipe"]["features"]]
    assert types == ["revolve_profile"]
    assert synthesis["topology"]["bore"] is False


def test_empty_measurements_raise():
    with pytest.raises(MeasurementSynthesisError):
        synthesize_feature_recipe({})


def test_no_part_name_branching_in_synthesis():
    source = (
        Path(__file__).resolve().parents[1] / "cad" / "measurement_to_features.py"
    ).read_text(encoding="utf-8")
    for name in ("flange", "wheel", "pulley", "washer", "gear"):
        assert f'"{name}"' not in source, f"part-name literal {name!r} found in synthesis"
    for pattern in ("part_type ==", "part ==", "part_type in", "part in ("):
        assert pattern not in source


def test_endpoint_generates_step_and_mesh(tmp_path):
    from app import (
        MeasurementCadGenerateRequest,
        generate_cad_from_measurements_endpoint,
    )

    response = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="test_measure",
        measurements=circular_measurements(),
        user_dimensions={"outer_diameter": 120},
        output_dir=str(tmp_path),
        generate_previews=False,
    ))
    assert isinstance(response, dict), response
    assert response["status"] == "success"
    assert response["mode"] == "measurement"
    assert response["measurement_status"] == "ok"
    assert response["preview_only"] is False
    assert response["scale"]["mode"] == "anchored"
    assert response["confidence"] > 0.5
    assert Path(response["step_path"]).exists()
    assert Path(response["stl_path"]).exists()
    assert response["mesh_path"] is None or Path(response["mesh_path"]).exists()
    json.dumps(response["feature_recipe"])


def test_endpoint_rejects_inconsistent_measurements(tmp_path):
    from app import (
        MeasurementCadGenerateRequest,
        generate_cad_from_measurements_endpoint,
    )

    bad = circular_measurements()
    bad["concentric"] = [{"radius_ratio": 0.70, "confidence": 0.9}]
    bad["side_profile"] = None
    response = generate_cad_from_measurements_endpoint(MeasurementCadGenerateRequest(
        job_id="test_bad",
        measurements=bad,
        user_dimensions={"outer_diameter": 100, "thickness": 10},
        output_dir=str(tmp_path),
    ))
    assert response.status_code == 422
