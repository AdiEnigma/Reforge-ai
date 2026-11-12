"""
test_recipe_validator.py — Automated Test Suite for Recipe Validator (Step 1).

Covers:
- Basic API and CadSpec return structure
- Parameter precedence and provenance (user_dims > solver_result > recipe)
- Unit normalization (inch -> mm, etc.)
- Missing parameter handling (status='needs_input')
- Invalid radius and numeric input rejection (status='rejected')
- Outline validation (vertex count, self-intersection, valid outlines)
- Hole validation (inside vs outside, boundary overlap, radius validity)
- Profile validation (minimum points, z-axis sorting, negative radius)
- Gear validation (teeth, module, faceWidth, boreRadius)
- Limits and dimension-ratio clamp (RECIPE_LIMITS, 1000x ratio)
- Status consistency across validation scenarios
"""

import math
import pytest

from recipe_validator import (
    CadSpec,
    COMPONENT_STYLES,
    PRIMITIVE_KINDS,
    PROV_DEFAULT,
    PROV_RECIPE,
    PROV_SOLVER_RESULT,
    PROV_USER_DIMS,
    RECIPE_LIMITS,
    validate_recipe,
)


# ---------------------------------------------------------------------------
# A. Basic API and Return Structure
# ---------------------------------------------------------------------------

def test_api_import_and_cadspec_structure():
    """Verify CadSpec exposes all required fields with proper types."""
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
    spec = validate_recipe(recipe)

    assert isinstance(spec, CadSpec)
    assert isinstance(spec.spec, dict)
    assert isinstance(spec.merged_parameters, dict)
    assert isinstance(spec.provenance, dict)
    assert isinstance(spec.status, str)
    assert isinstance(spec.missing, list)
    assert isinstance(spec.warnings, list)
    assert isinstance(spec.errors, list)
    assert spec.status == "ok"


def test_api_invalid_non_dict_recipe():
    """Non-dict recipe inputs must immediately return rejected status."""
    for invalid in [None, "invalid_string", 12345, [1, 2, 3]]:
        spec = validate_recipe(invalid)
        assert isinstance(spec, CadSpec)
        assert spec.status == "rejected"
        assert len(spec.errors) > 0


# ---------------------------------------------------------------------------
# B. Parameter Precedence and Provenance
# ---------------------------------------------------------------------------

def test_parameter_precedence_user_over_solver_and_recipe():
    """Verify user_dims > solver_result > recipe precedence."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 20,
            "module": 2.0,
            "faceWidth": 15.0,
        },
    }
    solver = {
        "parameters": {
            "teeth": {"value": 22},
            "module": {"value": 2.5},
            "faceWidth": {"value": 18.0},
        },
        "units": "mm",
    }
    user = {
        "teeth": 24,
    }

    # user overrides teeth; solver overrides module and faceWidth; recipe provides baseline
    spec = validate_recipe(recipe, solver_result=solver, user_dims=user)

    assert spec.status == "ok"
    assert spec.spec["gear"]["teeth"] == 24
    assert spec.provenance["teeth"] == PROV_USER_DIMS

    assert spec.spec["gear"]["module"] == 2.5
    assert spec.provenance["module"] == PROV_SOLVER_RESULT

    assert spec.spec["gear"]["faceWidth"] == 18.0
    assert spec.provenance["faceWidth"] == PROV_SOLVER_RESULT


def test_parameter_precedence_recipe_fallback():
    """Verify recipe values are used when solver and user_dims omit them."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 30,
            "module": 3.0,
            "faceWidth": 25.0,
        },
    }
    spec = validate_recipe(recipe, solver_result=None, user_dims=None)
    assert spec.status == "ok"
    assert spec.spec["gear"]["teeth"] == 30
    assert spec.provenance["teeth"] == PROV_RECIPE
    assert spec.spec["gear"]["module"] == 3.0
    assert spec.provenance["module"] == PROV_RECIPE
    assert spec.spec["gear"]["faceWidth"] == 25.0
    assert spec.provenance["faceWidth"] == PROV_RECIPE


def test_unit_normalization_from_inches_to_mm():
    """Verify solver parameters with inch units are normalized to mm."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 100.0, "y": 0.0},
            {"x": 100.0, "y": 100.0},
            {"x": 0.0, "y": 100.0},
        ],
    }
    # thickness 1.0 inch -> 25.4 mm
    solver = {
        "parameters": {
            "thickness": {"value": 1.0},
        },
        "units": "inch",
    }
    spec = validate_recipe(recipe, solver_result=solver)
    assert spec.status == "ok"
    assert pytest.approx(spec.spec["depth"], rel=1e-3) == 25.4
    assert spec.provenance["thickness"] == PROV_SOLVER_RESULT


# ---------------------------------------------------------------------------
# C. Missing Parameter Handling
# ---------------------------------------------------------------------------

def test_missing_required_parameters_extruded_outline():
    """Missing outline in extruded style leads to needs_input."""
    recipe = {
        "style": "extruded",
        "depth": 10.0,
    }
    spec = validate_recipe(recipe)
    assert spec.status == "needs_input"
    assert "outline" in spec.missing


def test_missing_required_parameters_extruded_depth():
    """Missing depth in extruded style leads to needs_input."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "needs_input"
    assert "depth" in spec.missing


def test_missing_required_parameters_gear():
    """Missing gear parameters (teeth/module/faceWidth) lead to needs_input."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 20,
            # module and faceWidth missing
        },
    }
    spec = validate_recipe(recipe)
    assert spec.status == "needs_input"
    assert "gear.module" in spec.missing
    assert "gear.faceWidth" in spec.missing


def test_missing_required_parameters_revolved_profile():
    """Missing revolvedProfile in revolved style leads to needs_input."""
    recipe = {
        "style": "revolved",
    }
    spec = validate_recipe(recipe)
    assert spec.status == "needs_input"
    assert "revolvedProfile" in spec.missing


# ---------------------------------------------------------------------------
# D. Invalid Radius and Numeric Inputs
# ---------------------------------------------------------------------------

def test_invalid_radius_zero_negative_nan_in_holes():
    """Holes with radius <= 0 or NaN must be rejected."""
    base_outline = [
        {"x": 0.0, "y": 0.0},
        {"x": 50.0, "y": 0.0},
        {"x": 50.0, "y": 50.0},
        {"x": 0.0, "y": 50.0},
    ]
    # Zero radius
    r_zero = {
        "style": "extruded",
        "outline": base_outline,
        "depth": 5.0,
        "holes": [{"cx": 25.0, "cy": 25.0, "radius": 0.0}],
    }
    spec = validate_recipe(r_zero)
    assert spec.status == "rejected"
    assert any("radius" in e for e in spec.errors)

    # Negative radius
    r_neg = {
        "style": "extruded",
        "outline": base_outline,
        "depth": 5.0,
        "holes": [{"cx": 25.0, "cy": 25.0, "radius": -5.0}],
    }
    spec = validate_recipe(r_neg)
    assert spec.status == "rejected"
    assert any("radius" in e for e in spec.errors)

    # NaN radius
    r_nan = {
        "style": "extruded",
        "outline": base_outline,
        "depth": 5.0,
        "holes": [{"cx": 25.0, "cy": 25.0, "radius": float("nan")}],
    }
    spec = validate_recipe(r_nan)
    assert spec.status == "rejected"
    assert any("radius" in e or "non-finite" in e for e in spec.errors)


def test_invalid_numeric_infinity_in_profile():
    """Infinite coordinates in revolvedProfile must be rejected."""
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 0.0, "radius": 10.0},
            {"z": float("inf"), "radius": 15.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("non-finite" in e for e in spec.errors)


# ---------------------------------------------------------------------------
# E. Outline Validation
# ---------------------------------------------------------------------------

def test_outline_fewer_than_three_points_rejected():
    """Outline with fewer than 3 vertices must be rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
        ],
        "depth": 5.0,
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("outline" in e for e in spec.errors)


def test_outline_self_intersecting_rejected():
    """Self-intersecting polygon (figure-8 / bowtie) must be rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 0.0, "y": 20.0},
            {"x": 20.0, "y": 0.0},
        ],
        "depth": 5.0,
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("self-intersecting" in e for e in spec.errors)


def test_outline_valid_polygon_accepted():
    """Convex or simple non-self-intersecting concave polygons must be accepted."""
    # L-shaped polygon
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 30.0, "y": 0.0},
            {"x": 30.0, "y": 10.0},
            {"x": 10.0, "y": 10.0},
            {"x": 10.0, "y": 30.0},
            {"x": 0.0, "y": 30.0},
        ],
        "depth": 5.0,
    }
    spec = validate_recipe(recipe)
    assert spec.status == "ok"
    assert len(spec.spec["outline"]) == 6


# ---------------------------------------------------------------------------
# F. Hole Validation
# ---------------------------------------------------------------------------

def test_hole_inside_outline_accepted():
    """Hole completely inside outline is valid."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 40.0, "y": 0.0},
            {"x": 40.0, "y": 40.0},
            {"x": 0.0, "y": 40.0},
        ],
        "depth": 5.0,
        "holes": [
            {"cx": 20.0, "cy": 20.0, "radius": 5.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "ok"
    assert len(spec.spec["holes"]) == 1


def test_hole_center_outside_outline_rejected():
    """Hole whose center lies outside outline polygon must be rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 40.0, "y": 0.0},
            {"x": 40.0, "y": 40.0},
            {"x": 0.0, "y": 40.0},
        ],
        "depth": 5.0,
        "holes": [
            {"cx": 50.0, "cy": 50.0, "radius": 2.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("outside outline" in e for e in spec.errors)


def test_hole_boundary_crossing_outline_rejected():
    """Hole whose center is inside, but radius extends past boundary must be rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 40.0, "y": 0.0},
            {"x": 40.0, "y": 40.0},
            {"x": 0.0, "y": 40.0},
        ],
        "depth": 5.0,
        "holes": [
            {"cx": 5.0, "cy": 5.0, "radius": 10.0},  # Left/bottom boundary crossed
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("outside outline" in e for e in spec.errors)


# ---------------------------------------------------------------------------
# G. Profile Validation
# ---------------------------------------------------------------------------

def test_revolved_profile_fewer_than_two_points_rejected():
    """revolvedProfile with fewer than 2 points must be rejected."""
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 0.0, "radius": 10.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("at least 2 valid points" in e for e in spec.errors)


def test_revolved_profile_sorting_and_validation():
    """Unsorted profile points should be sorted along the z-axis."""
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 20.0, "radius": 15.0},
            {"z": 0.0, "radius": 25.0},
            {"z": 10.0, "radius": 20.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "ok"
    pts = spec.spec["revolvedProfile"]
    assert pts[0]["z"] == 0.0 and pts[0]["radius"] == 25.0
    assert pts[1]["z"] == 10.0 and pts[1]["radius"] == 20.0
    assert pts[2]["z"] == 20.0 and pts[2]["radius"] == 15.0


def test_revolved_profile_negative_radius_rejected():
    """Negative radius in revolvedProfile must be rejected."""
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 0.0, "radius": 10.0},
            {"z": 10.0, "radius": -5.0},
        ],
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("radius" in e for e in spec.errors)


# ---------------------------------------------------------------------------
# H. Gear Validation
# ---------------------------------------------------------------------------

def test_gear_valid_constraints():
    """Valid gear parameters produce ok status."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 24,
            "module": 2.5,
            "faceWidth": 20.0,
            "pressureAngle": 20.0,
            "helixAngle": 15.0,
            "boreRadius": 8.0,
        },
    }
    spec = validate_recipe(recipe)
    assert spec.status == "ok"
    g = spec.spec["gear"]
    assert g["teeth"] == 24
    assert g["module"] == 2.5
    assert g["faceWidth"] == 20.0
    assert g["pressureAngle"] == 20.0
    assert g["helixAngle"] == 15.0
    assert g["boreRadius"] == 8.0


def test_gear_fewer_than_three_teeth():
    """Teeth count < 3 is invalid and counted as missing."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 2,
            "module": 2.0,
            "faceWidth": 10.0,
        },
    }
    spec = validate_recipe(recipe)
    assert spec.status == "needs_input"
    assert "gear.teeth" in spec.missing


def test_gear_negative_bore_radius_rejected():
    """Negative bore radius in gear must produce an error."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 20,
            "module": 2.0,
            "faceWidth": 10.0,
            "boreRadius": -4.0,
        },
    }
    spec = validate_recipe(recipe)
    assert spec.status == "rejected"
    assert any("boreRadius" in e for e in spec.errors)


# ---------------------------------------------------------------------------
# I. Limits and Dimension-Ratio Clamp
# ---------------------------------------------------------------------------

def test_recipe_limits_exceeded_rejected():
    """Exceeding RECIPE_LIMITS must be rejected."""
    # Outline points limit (max 200)
    huge_outline = [{"x": float(i), "y": float(i)} for i in range(201)]
    r_outline = {
        "style": "extruded",
        "outline": huge_outline,
        "depth": 5.0,
    }
    spec = validate_recipe(r_outline)
    assert spec.status == "rejected"
    assert any("outline exceeds limit" in e for e in spec.errors)

    # Holes limit (max 50)
    huge_holes = [{"cx": float(i), "cy": 5.0, "radius": 0.5} for i in range(51)]
    r_holes = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 100.0, "y": 0.0},
            {"x": 100.0, "y": 100.0},
            {"x": 0.0, "y": 100.0},
        ],
        "depth": 5.0,
        "holes": huge_holes,
    }
    spec2 = validate_recipe(r_holes)
    assert spec2.status == "rejected"
    assert any("holes exceeds limit" in e for e in spec2.errors)


def test_dimension_ratio_clamp_1000x():
    """1000x dimension-ratio clamp clips extreme dimensions and logs warning."""
    # Polygon 2x2 mm with depth 5000 mm -> median = 2.0, cap = max(2*1000, 1000) = 2000.0
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 2.0, "y": 0.0},
            {"x": 2.0, "y": 2.0},
            {"x": 0.0, "y": 2.0},
        ],
        "depth": 5000.0,
    }
    spec = validate_recipe(recipe)
    assert spec.status == "ok"
    assert spec.spec["depth"] == 2000.0
    assert len(spec.warnings) > 0
    assert any("1000x dimension-ratio clamp" in w for w in spec.warnings)


# ---------------------------------------------------------------------------
# J. Status Consistency
# ---------------------------------------------------------------------------

def test_status_consistency():
    """Test consistent status transition across ok, needs_input, and rejected."""
    # 1. OK
    spec_ok = validate_recipe({
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ],
        "depth": 5.0,
    })
    assert spec_ok.status == "ok"
    assert len(spec_ok.errors) == 0
    assert len(spec_ok.missing) == 0

    # 2. Needs input
    spec_input = validate_recipe({
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ],
    })
    assert spec_input.status == "needs_input"
    assert "depth" in spec_input.missing
    assert len(spec_input.errors) == 0

    # 3. Rejected
    spec_rej = validate_recipe({
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
            {"x": 10.0, "y": 0.0},
        ],
        "depth": 5.0,
    })
    assert spec_rej.status == "rejected"
    assert len(spec_rej.errors) > 0

