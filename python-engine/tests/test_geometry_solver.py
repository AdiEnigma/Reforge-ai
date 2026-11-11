"""
test_geometry_solver.py — Verification of SciPy Geometric Parameter Optimisation (GS-01 to GS-22).
"""

import math
import numpy as np
import pytest

from reconstruction.geometry_solver import (
    CLASSIFICATION_ESTIMATED,
    CLASSIFICATION_MEASURED,
    CLASSIFICATION_UNKNOWN,
    compute_identifiability_diagnostics,
    fit_concentric_circles_scipy,
    fit_cylinder_scipy,
    solve_gear_parameters,
    solve_geometry,
)


# GS-01: Exact synthetic cylinder
def test_gs01_exact_synthetic_cylinder(synthetic_cylinder_points):
    res = solve_geometry(
        job_id="gs01",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]]},
    )
    assert res.status in ["success", "partial"]
    od = res.parameters["outer_diameter"]
    assert od["value"] is not None
    assert abs(od["value"] - synthetic_cylinder_points["true_diameter"]) < 1e-3
    assert od["classification"] == CLASSIFICATION_ESTIMATED
    assert res.identifiability["identifiable"] is True


# GS-02: Noisy measurements
def test_gs02_noisy_measurements(noisy_cylinder_points):
    res = solve_geometry(
        job_id="gs02",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in noisy_cylinder_points["points"]]},
    )
    assert res.status in ["success", "partial"]
    od = res.parameters["outer_diameter"]
    # With sigma=0.2 on 200 points, diameter error should be < 0.2 mm
    assert abs(od["value"] - (2 * noisy_cylinder_points["true_radius"])) < 0.3
    assert res.residual_statistics["mean_residual"] > 0.0


# GS-03: Outlier measurements
def test_gs03_outlier_measurements(outlier_cylinder_points):
    res = solve_geometry(
        job_id="gs03",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in outlier_cylinder_points["points"]]},
        options={"loss": "soft_l1"},
    )
    assert res.status in ["success", "partial"]
    od = res.parameters["outer_diameter"]
    # Soft L1 should reject 10% severe outliers and recover diameter within 1.0 mm
    assert abs(od["value"] - (2 * outlier_cylinder_points["true_radius"])) < 1.0


# GS-04: Contradictory dimensions
def test_gs04_contradictory_dimensions():
    res = solve_geometry(
        job_id="gs04",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 40.0, "inner_diameter": 60.0},  # ID > OD impossible
    )
    assert res.status == "failed"
    assert any("inner diameter" in e and "outer diameter" in e for e in res.errors)


# GS-05: Missing critical dimension
def test_gs05_missing_critical_dimension(synthetic_cylinder_points):
    res = solve_geometry(
        job_id="gs05",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]]},
    )
    assert "inner_diameter" in res.missing_critical_dimensions
    assert res.parameters["inner_diameter"]["value"] is None
    assert res.parameters["inner_diameter"]["classification"] == CLASSIFICATION_UNKNOWN


# GS-06: Parallel/perpendicular constraints
def test_gs06_parallel_perpendicular_constraints(synthetic_cylinder_points):
    constraints = [
        {"type": "coaxial", "axis": [0, 0, 1]},
        {"type": "perpendicular", "plane_normal": [0, 0, 1]},
    ]
    res = solve_geometry(
        job_id="gs06",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]]},
        constraints=constraints,
    )
    assert res.status in ["success", "partial"]
    assert res.identifiability["identifiable"] is True


# GS-07: Concentric holes
def test_gs07_concentric_holes(synthetic_concentric_circles):
    res = solve_geometry(
        job_id="gs07",
        component_type="flange",
        opencv_observations={"circles": synthetic_concentric_circles},
    )
    assert res.status in ["success", "partial"]
    assert abs(res.parameters["inner_diameter"]["value"] - 40.0) < 0.5  # 2 * 20.0
    assert abs(res.parameters["outer_diameter"]["value"] - 120.0) < 0.5  # 2 * 60.0


# GS-08: Symmetrical geometry
def test_gs08_symmetrical_geometry(synthetic_concentric_circles):
    res = solve_geometry(
        job_id="gs08",
        component_type="bearing",
        opencv_observations={"circles": synthetic_concentric_circles},
        user_dimensions={"thickness": 25.0},
    )
    assert res.status in ["success", "partial"]
    assert res.parameters["thickness"]["classification"] == CLASSIFICATION_MEASURED
    assert res.parameters["thickness"]["value"] == 25.0


# GS-09: Negative radius / impossible thickness
def test_gs09_negative_radius_impossible_thickness():
    res = solve_geometry(
        job_id="gs09",
        component_type="cylinder",
        user_dimensions={"outer_diameter": -50.0, "thickness": -10.0},
    )
    assert res.status == "failed"
    assert any("negative" in e for e in res.errors)


# GS-10: Underdetermined geometry
def test_gs10_underdetermined_geometry():
    # Only 1 point provided for 3D cylinder -> rank deficient
    res = solve_geometry(
        job_id="gs10",
        component_type="cylinder",
        multiview_evidence={"points3D": [{"xyz": [0.0, 0.0, 0.0]}]},
    )
    assert res.identifiability["underdetermined"] is True
    assert res.identifiability["identifiable"] is False


# GS-11: Multiple initial guesses
def test_gs11_multiple_initial_guesses(synthetic_cylinder_points):
    fit1, _, _ = fit_cylinder_scipy(synthetic_cylinder_points["points"], initial_radius=10.0)
    fit2, _, _ = fit_cylinder_scipy(synthetic_cylinder_points["points"], initial_radius=80.0)
    assert abs(fit1["radius"] - fit2["radius"]) < 1e-4


# GS-12: Parameters with different magnitudes
def test_gs12_parameters_different_magnitudes():
    # Diameter = 800.0 mm, helix_angle = 0.25 rad
    res = solve_geometry(
        job_id="gs12",
        component_type="gear",
        user_dimensions={"outer_diameter": 800.0, "teeth": 78, "helix_angle": 0.25},
    )
    assert res.status in ["success", "partial"]
    assert res.parameters["outer_diameter"]["value"] == 800.0
    assert res.parameters["helix_angle"]["value"] == 0.25


# GS-13: Zero observations
def test_gs13_zero_observations():
    res = solve_geometry(job_id="gs13", component_type="cylinder")
    assert res.status == "failed"
    assert any("Zero observations" in e for e in res.errors)


# GS-14: NaN and infinity inputs
def test_gs14_nan_infinity_inputs():
    res = solve_geometry(
        job_id="gs14",
        component_type="cylinder",
        user_dimensions={"outer_diameter": float("nan"), "height": float("inf")},
    )
    assert res.status == "failed"
    assert any("Non-finite" in e for e in res.errors)


# GS-15: Rank-deficient constraints/Jacobian
def test_gs15_rank_deficient_jacobian():
    # Empty jacobian or zero columns
    J = np.zeros((5, 3))
    report = compute_identifiability_diagnostics(J, ["p1", "p2", "p3"], cost=1.0)
    assert report.identifiable is False
    assert report.underdetermined is True
    assert report.rank == 0


# GS-16: Gear-related geometric relationships
def test_gs16_gear_geometric_relationships():
    # teeth = 20, module = 3.0 -> pitch diameter = 60.0, outer diameter = (20+2)*3 = 66.0
    res = solve_geometry(
        job_id="gs16",
        component_type="gear",
        user_dimensions={"teeth": 20, "module": 3.0},
    )
    assert res.status in ["success", "partial"]
    assert res.parameters["pitch_diameter"]["value"] == 60.0
    assert res.parameters["outer_diameter"]["value"] == 66.0
    assert res.parameters["teeth"]["classification"] == CLASSIFICATION_MEASURED


# GS-17: Unit conversion (mm/inch)
def test_gs17_unit_conversion():
    res = solve_geometry(
        job_id="gs17",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 2.5},
        options={"units": "inch"},
    )
    assert res.units == "inch"
    assert res.parameters["outer_diameter"]["unit"] == "inch"
    assert res.parameters["outer_diameter"]["value"] == 2.5


# GS-18: Calibrated vs uncalibrated observations
def test_gs18_calibrated_vs_uncalibrated():
    # Calibrated user dimension -> MEASURED, Gemini proposal -> ESTIMATED
    res = solve_geometry(
        job_id="gs18",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 100.0},
        gemini_proposal={"dimensions": {"height": 50.0}},
    )
    assert res.parameters["outer_diameter"]["classification"] == CLASSIFICATION_MEASURED
    assert res.parameters["height"]["classification"] == CLASSIFICATION_ESTIMATED
    assert "GEMINI_PROPOSAL" in res.parameters["height"]["provenance"]


# GS-19: Gemini-proposed impossible parameters
def test_gs19_gemini_proposed_impossible_parameters():
    # Gemini proposes negative dimension -> sanitized and ignored
    res = solve_geometry(
        job_id="gs19",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 50.0},
        gemini_proposal={"dimensions": {"height": -999.0}},
    )
    assert res.status in ["success", "partial"]
    # Negative proposal was ignored
    assert "height" not in res.parameters or res.parameters["height"]["value"] is None


# GS-20: Parameter at active bound
def test_gs20_parameter_at_active_bound():
    # Very small circle radius hitting lower bound
    res = solve_geometry(
        job_id="gs20",
        component_type="flange",
        opencv_observations={"circles": [{"cx": 0.0, "cy": 0.0, "r": 0.001}]},
    )
    assert res.status in ["success", "partial"]


# GS-21: Duplicate/redundant observations
def test_gs21_duplicate_observations():
    # Exact duplicate circles
    circles = [{"cx": 100.0, "cy": 100.0, "r": 25.0} for _ in range(10)]
    res = solve_geometry(
        job_id="gs21",
        component_type="flange",
        opencv_observations={"circles": circles},
    )
    assert res.status in ["success", "partial"]
    assert abs(res.parameters["inner_diameter"]["value"] - 50.0) < 0.1


# GS-22: Coordinate-frame transformations
def test_gs22_coordinate_frame_transformations(synthetic_cylinder_points):
    # Metric scale -> component_local frame
    res_metric = solve_geometry(
        job_id="gs22_metric",
        component_type="cylinder",
        user_dimensions={"outer_diameter": 50.0},
        multiview_evidence={
            "scale": {"classification": "metric"},
            "points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]],
        },
    )
    assert res_metric.coordinate_frame == "component_local"
    assert res_metric.scale_classification == "metric"

    # Relative scale without user dims -> relative_world frame
    res_rel = solve_geometry(
        job_id="gs22_rel",
        component_type="cylinder",
        multiview_evidence={
            "scale": {"classification": "relative"},
            "points3D": [{"xyz": pt} for pt in synthetic_cylinder_points["points"]],
        },
    )
    assert res_rel.coordinate_frame == "relative_world"
    assert res_rel.scale_classification == "relative"
    assert res_rel.units == "relative"
