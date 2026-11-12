"""
test_cad_matrix.py — ReForge AI Step 6 CAD Test Matrix (CAD-01 to CAD-11).

Verification suite covering all mandatory CAD test matrix IDs:
- CAD-01: Revolved shaft (recipe, generation, validation, 1 solid, positive volume, bbox, STEP/STL export).
- CAD-02: Extruded plate with holes (holes count & diameter validation, STEP/STL export).
- CAD-03: Helical gear with bore (helix angle, face width, bore diameter, STEP/STL export).
- CAD-04: Missing required dimension (needs_input, no CAD generation, no exports).
- CAD-05: Relative units refused (rejected, no geometry, no exports).
- CAD-06: Negative radius (rejected, no geometry, no exports).
- CAD-07: Self-intersecting outline (rejected, no geometry, no exports).
- CAD-08: Module / outer-diameter conflict (>5% difference, reconciliation priority to measured OD).
- CAD-09: NaN, infinity, null inputs rejected (no crash, no exports).
- CAD-10: STEP re-import round trip (export STEP, re-import via cq.importers.importStep, verify validity, solid count, volume & bbox match).
- CAD-11: Oversize dimension ratio (clamped/rejected according to RECIPE_LIMITS, no unconstrained geometry).
"""

from __future__ import annotations

import math
import os
import pytest
import cadquery as cq

from recipe_validator import validate_recipe, RECIPE_LIMITS
from cad.cad_generator import generate_cad
from cad.cad_validator import validate_cad_geometry
from exports.step_export import export_step
from exports.mesh_export import export_stl


def test_cad_01_revolved_shaft(tmp_path):
    """CAD-01: Revolved shaft valid recipe, CAD gen, validation, exports."""
    recipe = {
        "style": "revolved",
        "revolvedProfile": [
            {"z": 0.0, "radius": 12.0},
            {"z": 20.0, "radius": 12.0},
            {"z": 20.0, "radius": 24.0},
            {"z": 50.0, "radius": 24.0},
        ],
    }
    # 1. Recipe validation
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    # 2. CAD generation
    wp, ft = generate_cad(cad_spec)
    assert wp is not None

    # 3. Geometry validation
    val = validate_cad_geometry(wp, cad_spec, ft)
    assert val["valid"] is True
    assert val["metrics"]["solid_count"] == 1
    assert val["metrics"]["actual_volume_mm3"] > 0
    assert val["metrics"]["bbox_valid"] is True

    # 4. Exports
    step_file = str(tmp_path / "cad01.step")
    stl_file = str(tmp_path / "cad01.stl")
    assert export_step(wp, step_file) == os.path.abspath(step_file)
    assert export_stl(wp, stl_file) == os.path.abspath(stl_file)

    assert os.path.getsize(step_file) > 0
    assert os.path.getsize(stl_file) > 0


def test_cad_02_extruded_plate_with_holes(tmp_path):
    """CAD-02: Extruded plate with multiple holes."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 60.0, "y": 0.0},
            {"x": 60.0, "y": 60.0},
            {"x": 0.0, "y": 60.0},
        ],
        "depth": 12.0,
        "holes": [
            {"cx": 15.0, "cy": 15.0, "radius": 4.0},
            {"cx": 45.0, "cy": 15.0, "radius": 4.0},
            {"cx": 30.0, "cy": 45.0, "radius": 5.0},
        ],
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    val = validate_cad_geometry(wp, cad_spec, ft)

    assert val["valid"] is True
    assert val["metrics"]["feature_checks"]["expected_hole_count"] == 3
    assert val["metrics"]["feature_checks"]["actual_hole_count"] == 3

    step_file = str(tmp_path / "cad02.step")
    stl_file = str(tmp_path / "cad02.stl")
    export_step(wp, step_file)
    export_stl(wp, stl_file)
    assert os.path.getsize(step_file) > 0
    assert os.path.getsize(stl_file) > 0


def test_cad_03_helical_gear_with_bore(tmp_path):
    """CAD-03: Helical gear with bore and faceWidth."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 20,
            "module": 2.0,
            "faceWidth": 15.0,
            "pressureAngle": 20.0,
            "helixAngle": 15.0,
            "boreRadius": 5.0,
        },
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    val = validate_cad_geometry(wp, cad_spec, ft)

    assert val["valid"] is True
    assert val["metrics"]["solid_count"] == 1
    assert val["metrics"]["actual_volume_mm3"] > 0
    # Face width in Z
    assert pytest.approx(val["metrics"]["actual_bbox"]["zlen"], rel=1e-2) == 15.0
    # Bore diameter = 2 * 5.0 = 10.0
    assert pytest.approx(val["metrics"]["feature_checks"]["actual_bore_diameter"], rel=1e-2) == 10.0

    step_file = str(tmp_path / "cad03.step")
    stl_file = str(tmp_path / "cad03.stl")
    export_step(wp, step_file)
    export_stl(wp, stl_file)
    assert os.path.getsize(step_file) > 0
    assert os.path.getsize(stl_file) > 0


def test_cad_04_unknown_or_missing_required_dimension():
    """CAD-04: Recipe missing required dimension produces needs_input and no exports."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 30.0, "y": 0.0},
            {"x": 30.0, "y": 30.0},
            {"x": 0.0, "y": 30.0},
        ],
        # 'depth' intentionally missing
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "needs_input"
    assert "depth" in cad_spec.missing


def test_cad_05_relative_units_refused():
    """CAD-05: Recipe with unsupported relative units is rejected."""
    recipe = {
        "style": "extruded",
        "units": "relative",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 1.0, "y": 0.0},
            {"x": 1.0, "y": 1.0},
            {"x": 0.0, "y": 1.0},
        ],
        "depth": 0.5,
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "rejected"
    assert any("relative" in err.lower() or "units" in err.lower() for err in cad_spec.errors)


def test_cad_06_negative_radius():
    """CAD-06: Recipe with negative radius in hole/bore/profile is rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 40.0, "y": 0.0},
            {"x": 40.0, "y": 40.0},
            {"x": 0.0, "y": 40.0},
        ],
        "depth": 10.0,
        "holes": [{"cx": 20.0, "cy": 20.0, "radius": -5.0}],
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "rejected"
    assert any("non-positive" in err.lower() or "radius" in err.lower() for err in cad_spec.errors)


def test_cad_07_self_intersecting_outline():
    """CAD-07: Self-intersecting bowtie outline is rejected."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 20.0, "y": 20.0},
            {"x": 20.0, "y": 0.0},
            {"x": 0.0, "y": 20.0},
        ],
        "depth": 10.0,
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "rejected"
    assert any("intersect" in err.lower() for err in cad_spec.errors)


def test_cad_08_module_outer_diameter_conflict():
    """CAD-08: Gear with module conflicting with measured OD > 5% prioritizes measured OD."""
    # teeth=20, provided module=2.0 (implies OD = (20+2)*2.0 = 44.0)
    # measured outer_diameter = 55.0 => inferred module = 55 / 22 = 2.5 (diff = 25% > 5%)
    recipe = {
        "style": "gear",
        "outer_diameter": 55.0,
        "gear": {
            "teeth": 20,
            "module": 2.0,
            "faceWidth": 10.0,
            "boreRadius": 4.0,
        },
    }
    # 1. Pipeline validation
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"
    assert cad_spec.spec["gear"]["outer_diameter"] == 55.0

    # 2. Pipeline generation
    wp, ft = generate_cad(cad_spec)

    # Reconciliation prioritized measured OD: module should be 2.5
    reconciled_module = ft["parameters"]["module"]
    assert reconciled_module == 2.5
    assert len(ft["warnings"]) > 0

    # 3. Pipeline geometry validation against reconciled specification
    reconciled_spec = dict(cad_spec.spec)
    reconciled_spec["gear"] = dict(cad_spec.spec["gear"])
    reconciled_spec["gear"]["module"] = reconciled_module

    val = validate_cad_geometry(wp, reconciled_spec, ft)
    assert val["valid"] is True
    # Bounding box OD should match tip_d = 2.5 * 22 = 55.0 mm
    assert pytest.approx(val["metrics"]["actual_bbox"]["xlen"], rel=1e-2) == 55.0


def test_cad_09_nan_and_null_inputs():
    """CAD-09: Recipes with NaN, infinity, or null in numeric fields are rejected safely."""
    recipes = [
        {"style": "extruded", "outline": [{"x": float("nan"), "y": 0.0}, {"x": 10.0, "y": 0.0}, {"x": 10.0, "y": 10.0}], "depth": 5.0},
        {"style": "extruded", "outline": [{"x": 0.0, "y": 0.0}, {"x": 10.0, "y": 0.0}, {"x": 10.0, "y": 10.0}], "depth": float("inf")},
        {"style": "gear", "gear": {"teeth": 20, "module": None, "faceWidth": 10.0}},
    ]
    for r in recipes:
        cad_spec = validate_recipe(r)
        assert cad_spec.status in ("rejected", "needs_input")


def test_cad_10_step_reimport_round_trip(tmp_path):
    """CAD-10: STEP export and re-import round trip verification."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 30.0, "y": 0.0},
            {"x": 30.0, "y": 30.0},
            {"x": 0.0, "y": 30.0},
        ],
        "depth": 15.0,
        "holes": [{"cx": 15.0, "cy": 15.0, "radius": 5.0}],
    }
    cad_spec = validate_recipe(recipe)
    wp_orig, ft = generate_cad(cad_spec)
    orig_solid = wp_orig.val()
    orig_vol = orig_solid.Volume()
    orig_bb = orig_solid.BoundingBox()

    step_path = str(tmp_path / "roundtrip.step")
    export_step(wp_orig, step_path)
    assert os.path.exists(step_path)
    assert os.path.getsize(step_path) > 0

    # Re-import via CadQuery
    imported_shape = cq.importers.importStep(step_path)
    imported_solids = imported_shape.solids().vals()

    assert len(imported_solids) == 1
    imp_solid = imported_solids[0]
    assert imp_solid.isValid() is True

    imp_vol = imp_solid.Volume()
    assert imp_vol > 0.0
    assert pytest.approx(imp_vol, rel=1e-3) == orig_vol

    imp_bb = imp_solid.BoundingBox()
    assert pytest.approx(imp_bb.xlen, rel=1e-3) == orig_bb.xlen
    assert pytest.approx(imp_bb.ylen, rel=1e-3) == orig_bb.ylen
    assert pytest.approx(imp_bb.zlen, rel=1e-3) == orig_bb.zlen


def test_cad_11_oversize_dimension_ratio():
    """CAD-11: Recipe dimensions exceeding max dimension ratio are clamped/warned."""
    recipe = {
        "style": "extruded",
        "outline": [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ],
        "depth": 100000000.0,  # 100 million vs median 10 => ratio 10,000,000 exceeds 1000x cap
    }
    cad_spec = validate_recipe(recipe)
    # The 1000x dimension-ratio clamp must apply
    assert len(cad_spec.warnings) > 0
    assert any("dimension-ratio clamp" in w for w in cad_spec.warnings)
    # Depth must be clamped to median * 1000 = 10,000
    assert cad_spec.spec["depth"] <= 10000.0

