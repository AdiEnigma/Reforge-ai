"""
test_cad_generator.py — Step 2 Automated Test Suite for CAD Geometry Generator.

Tests:
1. Revolved geometry generation (valid solid around global Z axis, dimensions)
2. Extruded geometry generation (valid solid, depth check)
3. Extruded geometry with circular holes (through-hole diameter = 2 * radius)
4. Combination geometry (CSG primitives combined via Boolean union into 1 solid)
5. Disconnected combination primitives (failure: multiple solids detected)
6. Unsupported style handling (CadGenerationError)
7. Missing geometry fields (CadGenerationError)
8. Invalid or rejected geometry from CadSpec
9. Gear delegation boundary (structured error reporting gear_generator unimplemented)
10. Feature tree structure and parameter accuracy
"""

import math
import pytest
import cadquery as cq

from cad.cad_generator import CadGenerationError, generate_cad
from recipe_validator import CadSpec, validate_recipe


# ---------------------------------------------------------------------------
# 1. Revolved Geometry Tests
# ---------------------------------------------------------------------------

def test_revolved_geometry_generation_and_axis():
    """Verify revolved cylinder/stepped-shaft generation produces 1 solid around Z."""
    # Stepped shaft: r=10 from z=0 to z=15, r=20 from z=15 to z=30
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 0.0, "radius": 10.0},
            {"z": 15.0, "radius": 10.0},
            {"z": 15.0, "radius": 20.0},
            {"z": 30.0, "radius": 20.0},
        ],
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    assert isinstance(wp, cq.Workplane)
    assert ft["style"] == "revolved"
    assert len(ft["operations"]) == 1

    solids = wp.solids().vals()
    assert len(solids) == 1

    bb = wp.val().BoundingBox()
    # Check Z bounds: [0, 30]
    assert pytest.approx(bb.zmin, abs=1e-2) == 0.0
    assert pytest.approx(bb.zmax, abs=1e-2) == 30.0
    # Check max radius = 20 -> bounding box X/Y in [-20, 20]
    assert pytest.approx(bb.xmin, abs=1e-2) == -20.0
    assert pytest.approx(bb.xmax, abs=1e-2) == 20.0
    assert pytest.approx(bb.ymin, abs=1e-2) == -20.0
    assert pytest.approx(bb.ymax, abs=1e-2) == 20.0


# ---------------------------------------------------------------------------
# 2. Extruded Geometry Tests
# ---------------------------------------------------------------------------

def test_extruded_geometry_generation():
    """Verify 2D polygon outline extrudes into a 3D solid with exact depth."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 50.0, "y": 0.0},
            {"x": 50.0, "y": 30.0},
            {"x": 0.0, "y": 30.0},
        ],
        "depth": 15.0,
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    assert isinstance(wp, cq.Workplane)
    assert ft["style"] == "extruded"
    assert ft["parameters"]["depth"] == 15.0

    solids = wp.solids().vals()
    assert len(solids) == 1

    bb = wp.val().BoundingBox()
    assert pytest.approx(bb.xmin, abs=1e-2) == 0.0
    assert pytest.approx(bb.xmax, abs=1e-2) == 50.0
    assert pytest.approx(bb.ymin, abs=1e-2) == 0.0
    assert pytest.approx(bb.ymax, abs=1e-2) == 30.0
    assert pytest.approx(bb.zmin, abs=1e-2) == 0.0
    assert pytest.approx(bb.zmax, abs=1e-2) == 15.0


def test_extruded_geometry_with_holes():
    """Verify extruded geometry applies circular through-holes with diameter = 2 * radius."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 40.0, "y": 0.0},
            {"x": 40.0, "y": 40.0},
            {"x": 0.0, "y": 40.0},
        ],
        "depth": 10.0,
        "holes": [
            {"cx": 20.0, "cy": 20.0, "radius": 5.0},  # diameter = 10.0
        ],
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    solids = wp.solids().vals()
    assert len(solids) == 1

    # Feature tree should record extrude + 1 hole operation
    assert len(ft["operations"]) == 2
    hole_op = ft["operations"][1]
    assert hole_op["type"] == "hole"
    assert hole_op["position"] == (20.0, 20.0)
    assert hole_op["radius"] == 5.0
    assert hole_op["diameter"] == 10.0

    # Volume check: Solid volume should equal box volume minus cylindrical hole volume
    # Box: 40 * 40 * 10 = 16000
    # Hole: pi * 5^2 * 10 = 250 * pi ≈ 785.398
    # Expected net volume ≈ 15214.6
    solid_val = wp.val()
    vol = solid_val.Volume()
    expected_vol = (40.0 * 40.0 * 10.0) - (math.pi * (5.0 ** 2) * 10.0)
    assert pytest.approx(vol, rel=1e-2) == expected_vol


# ---------------------------------------------------------------------------
# 3. Combination Geometry Tests
# ---------------------------------------------------------------------------

def test_combination_geometry_success():
    """Verify overlapping CSG primitives combine via Boolean union into 1 solid."""
    recipe = {
        "style": "combination",
        "primitives": [
            {
                "kind": "box",
                "width": 20.0,
                "height": 20.0,
                "depth": 10.0,
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            },
            {
                "kind": "cylinder",
                "radius": 5.0,
                "height": 20.0,
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            },
        ],
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    assert ft["style"] == "combination"
    assert len(wp.solids().vals()) == 1


def test_combination_geometry_disconnected_solids_rejected():
    """Verify combination geometry that produces multiple disconnected solids is rejected."""
    # Two boxes spaced 100 mm apart (no overlap)
    spec_dict = {
        "style": "combination",
        "primitives": [
            {
                "kind": "box",
                "width": 10.0,
                "height": 10.0,
                "depth": 10.0,
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            },
            {
                "kind": "box",
                "width": 10.0,
                "height": 10.0,
                "depth": 10.0,
                "position": {"x": 100.0, "y": 100.0, "z": 100.0},
            },
        ],
    }
    cad_spec = CadSpec(spec=spec_dict, status="ok")

    with pytest.raises(CadGenerationError) as exc_info:
        generate_cad(cad_spec)

    assert "expected 1 solid" in exc_info.value.message.lower()


# ---------------------------------------------------------------------------
# 4. Gear Delegation & Unsupported Styles
# ---------------------------------------------------------------------------

def test_gear_delegation_success():
    """Verify gear generation delegates to gear_generator and returns valid gear geometry."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 20,
            "module": 2.0,
            "faceWidth": 10.0,
            "pressureAngle": 20.0,
            "boreRadius": 5.0,
        },
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    assert isinstance(wp, cq.Workplane)
    assert ft["style"] == "gear"
    assert len(wp.solids().vals()) == 1
    assert ft["parameters"]["teeth"] == 20
    assert ft["parameters"]["module"] == 2.0
    assert ft["parameters"]["faceWidth"] == 10.0
    assert ft["parameters"]["boreRadius"] == 5.0


def test_unsupported_style_error():
    """Verify unsupported style raises structured CadGenerationError."""
    cad_spec = CadSpec(spec={"style": "origami_fold"}, status="ok")

    with pytest.raises(CadGenerationError) as exc_info:
        generate_cad(cad_spec)

    err = exc_info.value
    assert "unsupported component style" in err.message.lower()
    assert err.style == "origami_fold"


# ---------------------------------------------------------------------------
# 5. Missing Fields & Rejected Specs
# ---------------------------------------------------------------------------

def test_rejected_cadspec_cannot_generate():
    """Verify rejected CadSpec raises CadGenerationError immediately."""
    rejected_spec = CadSpec(
        spec={},
        status="rejected",
        errors=["Self-intersecting outline."],
    )
    with pytest.raises(CadGenerationError) as exc_info:
        generate_cad(rejected_spec)

    assert "cannot generate cad from rejected cadspec" in exc_info.value.message.lower()


def test_needs_input_cadspec_cannot_generate():
    """Verify incomplete CadSpec with status needs_input raises CadGenerationError."""
    incomplete_spec = CadSpec(
        spec={"style": "extruded"},
        status="needs_input",
        missing=["depth", "outline"],
    )
    with pytest.raises(CadGenerationError) as exc_info:
        generate_cad(incomplete_spec)

    assert "missing" in exc_info.value.message.lower()


def test_direct_raw_recipe_dict_input():
    """Verify generate_cad also seamlessly accepts a raw valid recipe dict."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ],
        "depth": 5.0,
    }
    wp, ft = generate_cad(recipe)
    assert isinstance(wp, cq.Workplane)
    assert len(wp.solids().vals()) == 1

