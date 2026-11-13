"""
test_advanced_cad.py — Tests for the advanced feature-based CAD layer.

Covers Phase 1 (Stages 1 & 2) of the ReForge AI advanced CAD upgrade:

* feature schema round-tripping and operation derivation,
* recipe validation / normalisation (units, dependencies, cycles, missing data),
* additive operations (base bodies, flanges, bosses),
* subtractive operations (bores, pockets, multi-axis passages),
* repeated features (bolt circles, hole patterns),
* invalid / non-intersecting cuts and Boolean failures,
* feature dependency handling,
* the reference housing specimen (validity, dimensions, counts),
* the legacy -> feature adapter (backward compatibility),
* section / cutaway and preview evidence generation.
"""

from __future__ import annotations

import json
import os

import pytest
import cadquery as cq

from cad.feature_schema import (
    FEATURE_RECIPE_FORMAT,
    FEATURE_RECIPE_VERSION,
    Feature,
    FeatureRecipe,
    is_feature_recipe_dict,
    make_feature,
    operation_for_type,
)
from cad.feature_recipe_validator import validate_feature_recipe
from cad.feature_modeller import (
    FeatureModellingError,
    model_feature_recipe,
    build_feature_tool,
    shapes_intersect,
)
from cad.advanced_cad_validator import validate_feature_geometry
from cad.advanced_recipe_adapter import (
    generate_cad_from_recipe,
    is_advanced_recipe,
    legacy_recipe_to_feature_recipe,
)
from cad import advanced_preview
from cad.specimens.advanced_housing import (
    EXPECTED_BBOX,
    HOUSING_DIMENSIONS,
    build_advanced_housing_recipe,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _recipe(features, name="test", units="mm", expected=None):
    return {
        "format": FEATURE_RECIPE_FORMAT,
        "version": FEATURE_RECIPE_VERSION,
        "name": name,
        "units": units,
        "features": features,
        "expected": expected or {},
    }


def _base_cylinder(radius=10.0, z0=0.0, z1=20.0, fid="base"):
    return {"id": fid, "type": "base_cylinder",
            "parameters": {"radius": radius, "zStart": z0, "zEnd": z1}}


def _volume(wp):
    return float(wp.val().Volume())


def _cylindrical_face_count(wp):
    return sum(1 for f in wp.val().Faces() if f.geomType() == "CYLINDER")


def _step_status(history, feature_id):
    for s in history["steps"]:
        if s["id"] == feature_id:
            return s["status"]
    raise KeyError(feature_id)


# ===========================================================================
# 1. Schema
# ===========================================================================

def test_schema_operation_derivation():
    assert operation_for_type("base_cylinder") == "additive"
    assert operation_for_type("flange") == "additive"
    assert operation_for_type("through_bore") == "subtractive"
    assert operation_for_type("internal_passage") == "subtractive"
    assert operation_for_type("fillet") == "finish"
    assert operation_for_type("chamfer") == "finish"
    assert operation_for_type("not_a_type") is None


def test_feature_dataclass_derives_operation():
    f = make_feature("b1", "boss_cylindrical", {"radius": 5.0})
    assert f.operation == "additive"
    g = make_feature("h1", "through_bore", {"diameter": 4.0})
    assert g.operation == "subtractive"


def test_recipe_round_trip_json():
    recipe = _recipe([
        _base_cylinder(),
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 6.0, "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ], name="roundtrip")
    fr = FeatureRecipe.from_dict(recipe)
    assert fr.name == "roundtrip"
    assert fr.feature_ids() == ["base", "bore"]
    text = fr.to_json()
    fr2 = FeatureRecipe.from_json(text)
    assert fr2.to_dict() == fr.to_dict()
    assert fr2.get_feature("bore").depends_on == ["base"]


def test_is_feature_recipe_dict():
    assert is_feature_recipe_dict({"format": FEATURE_RECIPE_FORMAT, "features": []})
    assert is_feature_recipe_dict({"style": "feature", "features": []})
    assert is_feature_recipe_dict({"version": "1.0", "features": [{}]})
    assert not is_feature_recipe_dict({"style": "revolved", "revolvedProfile": []})
    assert not is_feature_recipe_dict("nope")
    assert not is_feature_recipe_dict(None)


# ===========================================================================
# 2. Recipe validation / normalisation
# ===========================================================================

def test_validate_ok_recipe():
    res = validate_feature_recipe(_recipe([_base_cylinder()]))
    assert res.status == "ok"
    assert res.errors == []
    assert res.feature_status["base"] == "valid"


def test_validate_unknown_type_rejected():
    res = validate_feature_recipe(_recipe([
        {"id": "x", "type": "teleporter", "parameters": {}}]))
    assert res.status == "rejected"
    assert res.feature_status["x"] == "invalid"
    assert any("teleporter" in e for e in res.errors)


def test_validate_duplicate_ids_rejected():
    res = validate_feature_recipe(_recipe([_base_cylinder(), _base_cylinder()]))
    assert res.status == "rejected"
    assert any("Duplicate" in e for e in res.errors)


def test_validate_missing_required_param_needs_input():
    res = validate_feature_recipe(_recipe([
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 5.0}}]))
    assert res.status == "needs_input"
    assert any("zStart" in m for m in res.missing)


def test_validate_non_positive_radius_rejected():
    res = validate_feature_recipe(_recipe([
        {"id": "b", "type": "base_cylinder",
         "parameters": {"radius": -3.0, "zStart": 0.0, "zEnd": 10.0}}]))
    assert res.status == "rejected"


def test_validate_unknown_dependency_rejected():
    res = validate_feature_recipe(_recipe([
        _base_cylinder(),
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 5.0, "zStart": 0.0, "zEnd": 10.0},
         "depends_on": ["ghost"]},
    ]))
    assert res.status == "rejected"
    assert any("ghost" in e for e in res.errors)


def test_validate_dependency_cycle_rejected():
    res = validate_feature_recipe(_recipe([
        {"id": "a", "type": "through_bore",
         "parameters": {"diameter": 5.0, "zStart": 0.0, "zEnd": 10.0},
         "depends_on": ["b"]},
        {"id": "b", "type": "through_bore",
         "parameters": {"diameter": 5.0, "zStart": 0.0, "zEnd": 10.0},
         "depends_on": ["a"]},
    ]))
    assert res.status == "rejected"
    assert any("cycle" in e.lower() for e in res.errors)


def test_validate_normalises_units_to_mm():
    recipe = _recipe([
        {"id": "b", "type": "base_cylinder",
         "parameters": {"radius": 1.0, "zStart": 0.0, "zEnd": 2.0}},
    ], units="cm")
    res = validate_feature_recipe(recipe)
    assert res.status == "ok"
    p = res.recipe.get_feature("b").parameters
    assert p["radius"] == pytest.approx(10.0)
    assert p["zEnd"] == pytest.approx(20.0)
    assert res.recipe.get_feature("b").units == "mm"


def test_validate_orders_features_by_dependency():
    recipe = _recipe([
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 5.0, "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
        _base_cylinder(),
    ])
    res = validate_feature_recipe(recipe)
    assert res.status == "ok"
    assert res.recipe.feature_ids() == ["base", "bore"]


# ===========================================================================
# 3. Additive operations
# ===========================================================================

def test_additive_base_cylinder_volume_and_shape():
    wp, hist = model_feature_recipe(_recipe([_base_cylinder(radius=10, z0=0, z1=20)]))
    assert _step_status(hist, "base") == "applied"
    assert len(wp.solids().vals()) == 1
    assert _volume(wp) == pytest.approx(3.14159265 * 100 * 20, rel=1e-3)


def test_additive_flange_and_boss_union():
    recipe = _recipe([
        {"id": "flange", "type": "flange",
         "parameters": {"shape": "circular", "outerRadius": 30.0,
                        "thickness": 8.0, "zStart": 0.0}},
        {"id": "boss", "type": "boss_cylindrical",
         "parameters": {"radius": 10.0, "angleDeg": 0.0, "z": 4.0,
                        "startRadius": 25.0, "height": 20.0},
         "depends_on": ["flange"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "flange") == "applied"
    assert _step_status(hist, "boss") == "applied"
    assert len(wp.solids().vals()) == 1
    # Union must add material over the flange alone.
    flange_only = float(cq.Workplane("XY").cylinder(8.0, 30.0).val().Volume())
    assert _volume(wp) > flange_only


def test_additive_rectangular_boss_and_rib():
    recipe = _recipe([
        _base_cylinder(radius=20, z0=0, z1=40),
        {"id": "rib", "type": "rib",
         "parameters": {"length": 10.0, "thickness": 6.0, "height": 20.0,
                        "angleDeg": 0.0, "startRadius": 18.0, "z": 5.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "rib") == "applied"
    assert len(wp.solids().vals()) == 1


def test_additive_disconnected_feature_fails():
    """An additive feature that misses the body must NOT silently fuse."""
    recipe = _recipe([
        {"id": "base", "type": "base_box",
         "parameters": {"length": 10.0, "width": 10.0, "height": 10.0}},
        {"id": "floating", "type": "base_box",
         "parameters": {"length": 5.0, "width": 5.0, "height": 5.0,
                        "center": {"x": 100.0, "y": 0.0, "z": 0.0}},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "floating") == "failed"
    assert any("disconnected" in d.lower() or "intersect" in d.lower()
               for d in hist["steps"][1]["diagnostics"])
    # The body must be unchanged (no fallback primitive added).
    assert len(wp.solids().vals()) == 1
    assert _volume(wp) == pytest.approx(1000.0, rel=1e-6)


def test_strict_mode_raises_on_failed_feature():
    recipe = _recipe([
        {"id": "base", "type": "base_box",
         "parameters": {"length": 10.0, "width": 10.0, "height": 10.0}},
        {"id": "floating", "type": "base_box",
         "parameters": {"length": 5.0, "width": 5.0, "height": 5.0,
                        "center": {"x": 100.0, "y": 0.0, "z": 0.0}}},
    ])
    with pytest.raises(FeatureModellingError):
        model_feature_recipe(recipe, strict=True)


# ===========================================================================
# 4. Subtractive operations
# ===========================================================================

def test_subtractive_through_bore_reduces_volume():
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 6.0, "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "bore") == "applied"
    expected = 3.14159265 * (100 - 9) * 20
    assert _volume(wp) == pytest.approx(expected, rel=1e-2)
    assert _cylindrical_face_count(wp) == 2  # outer wall + bore wall


def test_subtractive_blind_bore():
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "blind", "type": "blind_bore",
         "parameters": {"diameter": 6.0, "zStart": 20.0, "depth": 8.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "blind") == "applied"
    assert _volume(wp) < 3.14159265 * 100 * 20


def test_subtractive_non_intersecting_cut_fails():
    """A cut that misses the body must be reported as failed, not successful."""
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "miss", "type": "through_bore",
         "parameters": {"diameter": 4.0, "center": {"x": 100.0, "y": 0.0},
                        "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "miss") == "failed"
    assert any("miss" in d.lower() or "zero intersection" in d.lower()
               for d in hist["steps"][1]["diagnostics"])
    # Body unchanged.
    assert _volume(wp) == pytest.approx(3.14159265 * 100 * 20, rel=1e-3)


def test_subtractive_cut_removing_everything_fails():
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "wipe", "type": "through_bore",
         "parameters": {"diameter": 40.0, "zStart": -5.0, "zEnd": 25.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "wipe") == "failed"


def test_subtractive_stepped_bore_and_counterbore():
    recipe = _recipe([
        _base_cylinder(radius=15, z0=0, z1=30),
        {"id": "step", "type": "stepped_bore",
         "parameters": {"segments": [
             {"diameter": 6.0, "zStart": -1.0, "zEnd": 12.0},
             {"diameter": 12.0, "zStart": 12.0, "zEnd": 31.0},
         ]},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "step") == "applied"
    assert len(wp.solids().vals()) == 1


def test_subtractive_circular_and_rectangular_pockets():
    recipe = _recipe([
        {"id": "base", "type": "base_box",
         "parameters": {"length": 40.0, "width": 40.0, "height": 20.0}},
        {"id": "pc", "type": "pocket_circular",
         "parameters": {"diameter": 10.0, "depth": 6.0, "zStart": 10.0,
                        "center": {"x": -10.0, "y": 0.0}},
         "depends_on": ["base"]},
        {"id": "pr", "type": "pocket_rectangular",
         "parameters": {"length": 10.0, "width": 8.0, "depth": 5.0, "zStart": 10.0,
                        "center": {"x": 10.0, "y": 0.0}},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "pc") == "applied"
    assert _step_status(hist, "pr") == "applied"
    assert _volume(wp) < 40 * 40 * 20


# ===========================================================================
# 5. Repeated features
# ===========================================================================

def test_bolt_circle_creates_expected_holes():
    recipe = _recipe([
        {"id": "flange", "type": "flange",
         "parameters": {"shape": "circular", "outerRadius": 40.0,
                        "thickness": 10.0, "zStart": 0.0}},
        {"id": "holes", "type": "bolt_circle",
         "parameters": {"count": 6, "boltCircleRadius": 30.0, "holeDiameter": 6.0,
                        "zStart": -1.0, "zEnd": 11.0, "startAngleDeg": 0.0},
         "depends_on": ["flange"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "holes") == "applied"
    assert len(wp.solids().vals()) == 1
    # 6 hole walls + 1 outer cylindrical wall.
    assert _cylindrical_face_count(wp) == 7


def test_hole_pattern_linear_and_grid():
    # The linear/grid pattern anchors at the feature centre and steps in +x/+y,
    # so the plate must be large enough for every hole to land inside it.
    linear = _recipe([
        {"id": "base", "type": "base_box",
         "parameters": {"length": 100.0, "width": 100.0, "height": 10.0}},
        {"id": "lin", "type": "hole_pattern",
         "parameters": {"pattern": "linear", "holeDiameter": 4.0, "countX": 4,
                        "spacing": 12.0, "zStart": -1.0, "zEnd": 11.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(linear)
    assert _step_status(hist, "lin") == "applied"
    assert _cylindrical_face_count(wp) == 4

    grid = _recipe([
        {"id": "base", "type": "base_box",
         "parameters": {"length": 100.0, "width": 100.0, "height": 10.0}},
        {"id": "grid", "type": "hole_pattern",
         "parameters": {"pattern": "grid", "holeDiameter": 4.0,
                        "countX": 3, "countY": 3, "spacing": 12.0,
                        "zStart": -1.0, "zEnd": 11.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(grid)
    assert _step_status(hist, "grid") == "applied"
    assert _cylindrical_face_count(wp) == 9


# ===========================================================================
# 6. Multi-axis holes / passages
# ===========================================================================

def test_internal_passages_along_two_axes_intersect():
    recipe = _recipe([
        _base_cylinder(radius=20, z0=0, z1=40),
        {"id": "px", "type": "internal_passage",
         "parameters": {"diameter": 6.0,
                        "start": {"x": -20.0, "y": 5.0, "z": 20.0},
                        "end": {"x": 20.0, "y": 5.0, "z": 20.0}},
         "depends_on": ["base"]},
        {"id": "py", "type": "internal_passage",
         "parameters": {"diameter": 6.0,
                        "start": {"x": 5.0, "y": -20.0, "z": 20.0},
                        "end": {"x": 5.0, "y": 20.0, "z": 20.0}},
         "depends_on": ["base"]},
    ], expected={"intersecting_passages": [["px", "py"]]})
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "px") == "applied"
    assert _step_status(hist, "py") == "applied"
    result = validate_feature_geometry(wp, recipe, hist)
    assert result["metrics"]["feature_checks"]["intersecting_passages_ok"] is True


def test_radial_port_on_cylinder():
    recipe = _recipe([
        _base_cylinder(radius=20, z0=0, z1=40),
        {"id": "port", "type": "radial_port",
         "parameters": {"diameter": 6.0, "angleDeg": 0.0, "z": 20.0,
                        "startRadius": 20.0, "depth": 25.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "port") == "applied"
    assert _volume(wp) < 3.14159265 * 400 * 40


def test_radial_port_missing_body_fails():
    recipe = _recipe([
        _base_cylinder(radius=20, z0=0, z1=40),
        {"id": "port", "type": "radial_port",
         "parameters": {"diameter": 6.0, "angleDeg": 0.0, "z": 100.0,
                        "startRadius": 20.0, "depth": 25.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    assert _step_status(hist, "port") == "failed"


# ===========================================================================
# 7. Boolean failures / geometry validity reporting
# ===========================================================================

def test_shapes_intersect_helpers():
    a = cq.Workplane("XY").box(10, 10, 10).val()
    b = cq.Workplane("XY").box(10, 10, 10).translate((5, 0, 0)).val()
    c = cq.Workplane("XY").box(10, 10, 10).translate((100, 0, 0)).val()
    overlap, vol = shapes_intersect(a, b)
    assert overlap is True and vol > 0
    overlap2, vol2 = shapes_intersect(a, c)
    assert overlap2 is False and vol2 == 0.0


def test_validate_reports_failed_feature_as_invalid():
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "miss", "type": "through_bore",
         "parameters": {"diameter": 4.0, "center": {"x": 100.0, "y": 0.0},
                        "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ])
    wp, hist = model_feature_recipe(recipe)
    result = validate_feature_geometry(wp, recipe, hist)
    assert result["valid"] is False
    assert "miss" in result["feature_diagnostics"]
    assert result["metrics"]["feature_checks"]["num_failed_features"] == 1


def test_validate_bbox_mismatch_invalidates():
    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
    ], expected={"bbox": {"xlen": 999.0, "ylen": 999.0, "zlen": 999.0}})
    wp, hist = model_feature_recipe(recipe)
    result = validate_feature_geometry(wp, recipe, hist)
    assert result["valid"] is False
    assert result["metrics"]["bbox_valid"] is False


def test_validate_detects_history_inconsistency():
    recipe = _recipe([_base_cylinder()])
    wp, hist = model_feature_recipe(recipe)
    tampered = json.loads(json.dumps(hist))
    tampered["steps"][0]["id"] = "renamed"
    result = validate_feature_geometry(wp, recipe, tampered)
    assert result["metrics"]["history_consistent"] is False
    assert result["valid"] is False


# ===========================================================================
# 8. Reference housing specimen
# ===========================================================================

@pytest.fixture(scope="module")
def housing_model():
    recipe = build_advanced_housing_recipe()
    wp, hist = model_feature_recipe(recipe)
    return recipe, wp, hist


def test_housing_all_features_applied(housing_model):
    recipe, wp, hist = housing_model
    assert hist["summary"]["num_features"] == 22
    assert hist["summary"]["failed"] == 0
    assert hist["summary"]["all_applied"] is True


def test_housing_geometry_valid(housing_model):
    recipe, wp, hist = housing_model
    result = validate_feature_geometry(wp, recipe, hist)
    assert result["valid"] is True
    assert result["fit_score"] == pytest.approx(1.0)
    assert result["metrics"]["solid_count"] == 1


def test_housing_dimensions_and_bbox(housing_model):
    recipe, wp, hist = housing_model
    bb = wp.val().BoundingBox()
    assert bb.xlen == pytest.approx(EXPECTED_BBOX["xlen"], abs=0.1)
    assert bb.ylen == pytest.approx(EXPECTED_BBOX["ylen"], abs=0.1)
    assert bb.zlen == pytest.approx(EXPECTED_BBOX["zlen"], abs=0.1)


def test_housing_volume_in_expected_range(housing_model):
    recipe, wp, hist = housing_model
    vol = _volume(wp)
    assert 550_000.0 <= vol <= 900_000.0


def test_housing_feature_counts(housing_model):
    recipe, wp, hist = housing_model
    result = validate_feature_geometry(wp, recipe, hist)
    fc = result["metrics"]["feature_checks"]
    assert fc["bore_feature_count"] == 3
    assert fc["pattern_hole_count"] == 6
    assert fc["port_count"] == 3
    assert fc["passage_count"] == 2
    assert fc["intersecting_passages_ok"] is True


def test_housing_dimensions_documented():
    # The specimen must ship explicit, finite dimensions (zStart offsets may be
    # negative to guarantee a clean cut-through).
    import math
    assert HOUSING_DIMENSIONS["flange_outer_radius"] == 80.0
    assert HOUSING_DIMENSIONS["mounting_hole_count"] == 6
    assert all(isinstance(v, (int, float)) and math.isfinite(v)
               for v in HOUSING_DIMENSIONS.values())
    # Every physically-sized dimension must be positive.
    positive_keys = [k for k in HOUSING_DIMENSIONS if not k.endswith("_z_start")]
    assert all(HOUSING_DIMENSIONS[k] > 0 for k in positive_keys)


# ===========================================================================
# 9. Legacy -> feature adapter (backward compatibility)
# ===========================================================================

def test_is_advanced_recipe_detection():
    assert is_advanced_recipe({"format": FEATURE_RECIPE_FORMAT, "features": []})
    assert not is_advanced_recipe({"style": "revolved", "revolvedProfile": []})


def test_adapter_converts_legacy_revolved():
    legacy = {
        "style": "revolved",
        "revolvedProfile": [
            {"radius": 0.0, "z": 0.0},
            {"radius": 10.0, "z": 0.0},
            {"radius": 10.0, "z": 30.0},
            {"radius": 0.0, "z": 30.0},
        ],
    }
    feat = legacy_recipe_to_feature_recipe(legacy)
    assert feat["format"] == FEATURE_RECIPE_FORMAT
    assert feat["features"][0]["type"] == "revolve_profile"
    wp, hist = model_feature_recipe(feat)
    assert len(wp.solids().vals()) == 1
    assert _volume(wp) == pytest.approx(3.14159265 * 100 * 30, rel=1e-2)


def test_adapter_converts_legacy_extruded_with_holes():
    legacy = {
        "style": "extruded",
        "outline": [{"x": 0, "y": 0}, {"x": 20, "y": 0},
                    {"x": 20, "y": 20}, {"x": 0, "y": 20}],
        "depth": 5.0,
        "holes": [{"cx": 10, "cy": 10, "radius": 3.0}],
    }
    feat = legacy_recipe_to_feature_recipe(legacy)
    types = [f["type"] for f in feat["features"]]
    assert types == ["extrude_profile", "through_bore"]
    wp, hist = model_feature_recipe(feat)
    assert len(wp.solids().vals()) == 1
    assert _volume(wp) == pytest.approx((400 - 3.14159265 * 9) * 5, rel=1e-2)


def test_adapter_routes_legacy_to_legacy_generator():
    """Non-feature recipes must still be handled by the existing generator."""
    legacy = {
        "style": "extruded",
        "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0},
                    {"x": 10, "y": 10}, {"x": 0, "y": 10}],
        "depth": 4.0,
    }
    wp, tree = generate_cad_from_recipe(legacy)
    assert wp is not None
    assert len(wp.solids().vals()) == 1


def test_adapter_routes_feature_recipe_to_modeller():
    recipe = _recipe([_base_cylinder(radius=5, z0=0, z1=10)])
    wp, info = generate_cad_from_recipe(recipe)
    assert info["format"] == FEATURE_RECIPE_FORMAT
    assert "steps" in info
    assert len(wp.solids().vals()) == 1


# ===========================================================================
# 10. Section / cutaway + previews
# ===========================================================================

def test_make_half_section_reduces_volume(housing_model):
    recipe, wp, hist = housing_model
    full = _volume(wp)
    sectioned = advanced_preview.make_half_section(wp, axis="y", keep="positive")
    assert _volume(sectioned) < full
    assert len(sectioned.solids().vals()) >= 1


def test_preview_svg_generation(tmp_path, housing_model):
    recipe, wp, hist = housing_model
    svg = advanced_preview.export_view_svg(
        wp, str(tmp_path / "iso.svg"), "isometric")
    assert os.path.isfile(svg)
    assert os.path.getsize(svg) > 500


def test_preview_section_svg(tmp_path, housing_model):
    recipe, wp, hist = housing_model
    svg = advanced_preview.export_section_svg(
        wp, str(tmp_path / "sec.svg"), axis="y", keep="positive")
    assert os.path.isfile(svg)
    assert os.path.getsize(svg) > 500


def test_preview_bundle_manifest(tmp_path, housing_model):
    recipe, wp, hist = housing_model
    manifest = advanced_preview.generate_preview_bundle(
        wp, str(tmp_path), "housing", include_section=True)
    assert set(manifest["svg"]) == {"isometric", "front", "side", "top"}
    for path in manifest["svg"].values():
        assert os.path.isfile(path)
    assert manifest["section"]["svg"]
    assert os.path.isfile(manifest["section"]["svg"])


# ===========================================================================
# 11. Exports (STEP / STL) with temporary directories
# ===========================================================================

def test_housing_step_and_stl_export(tmp_path, housing_model):
    recipe, wp, hist = housing_model
    step = str(tmp_path / "housing.step")
    stl = str(tmp_path / "housing.stl")
    cq.exporters.export(wp, step, cq.exporters.ExportTypes.STEP)
    cq.exporters.export(wp, stl, cq.exporters.ExportTypes.STL)
    assert os.path.getsize(step) > 1000
    assert os.path.getsize(stl) > 1000

    # STEP round-trip preserves validity and volume.
    imported = cq.importers.importStep(step)
    solids = imported.solids().vals()
    assert len(solids) == 1
    assert float(solids[0].Volume()) == pytest.approx(_volume(wp), rel=1e-3)


# ===========================================================================
# 12. Advanced API endpoint
# ===========================================================================

def test_advanced_endpoint_success(tmp_path):
    from app import generate_advanced_cad_endpoint, AdvancedCadGenerateRequest

    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "bore", "type": "through_bore",
         "parameters": {"diameter": 6.0, "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ], expected={"bbox": {"xlen": 20.0, "ylen": 20.0, "zlen": 20.0}})
    payload = AdvancedCadGenerateRequest(
        job_id="adv_api_01", recipe=recipe, output_dir=str(tmp_path))
    res = generate_advanced_cad_endpoint(payload)
    assert isinstance(res, dict)
    assert res["status"] == "success"
    assert res["mode"] == "feature"
    assert res["validation_report"]["valid"] is True
    assert os.path.isfile(res["step_path"])
    assert os.path.isfile(res["stl_path"])


def test_advanced_endpoint_converts_legacy_recipe(tmp_path):
    from app import generate_advanced_cad_endpoint, AdvancedCadGenerateRequest

    legacy = {
        "style": "revolved",
        "revolvedProfile": [
            {"radius": 0.0, "z": 0.0},
            {"radius": 8.0, "z": 0.0},
            {"radius": 8.0, "z": 25.0},
            {"radius": 0.0, "z": 25.0},
        ],
    }
    payload = AdvancedCadGenerateRequest(
        job_id="adv_api_legacy", recipe=legacy, output_dir=str(tmp_path))
    res = generate_advanced_cad_endpoint(payload)
    assert res["status"] == "success"
    assert res["feature_history"]["summary"]["all_applied"] is True


def test_advanced_endpoint_rejects_unsupported_legacy_style():
    from app import generate_advanced_cad_endpoint, AdvancedCadGenerateRequest
    from fastapi.responses import JSONResponse

    payload = AdvancedCadGenerateRequest(
        job_id="adv_api_bad", recipe={"style": "gear", "gear": {}})
    res = generate_advanced_cad_endpoint(payload)
    assert isinstance(res, JSONResponse)
    assert res.status_code == 400


def test_advanced_endpoint_reports_failed_feature(tmp_path):
    from app import generate_advanced_cad_endpoint, AdvancedCadGenerateRequest
    from fastapi.responses import JSONResponse

    recipe = _recipe([
        _base_cylinder(radius=10, z0=0, z1=20),
        {"id": "miss", "type": "through_bore",
         "parameters": {"diameter": 4.0, "center": {"x": 100.0, "y": 0.0},
                        "zStart": -1.0, "zEnd": 21.0},
         "depends_on": ["base"]},
    ])
    payload = AdvancedCadGenerateRequest(
        job_id="adv_api_fail", recipe=recipe, output_dir=str(tmp_path))
    res = generate_advanced_cad_endpoint(payload)
    assert isinstance(res, JSONResponse)
    assert res.status_code == 422
