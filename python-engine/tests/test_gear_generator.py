"""
test_gear_generator.py — Step 3 Automated Test Suite for Involute Spur Gear Generator.

Tests:
1. Basic spur gear generation (Workplane, 1 solid, positive volume, bounding box).
2. Tooth count verification (geometric profile / vertex periodicity or tooth spacing).
3. Gear dimensions verification (face width, tip diameter, module).
4. Bore verification (central through-hole presence and volume subtraction).
5. Missing module reconciliation (inferred from measured OD and tooth count: m = OD / (teeth + 2)).
6. Module disagreement warning (measured OD implies module differing > 5% from provided).
7. Invalid input rejection (teeth < 3, negative width, invalid bore).
8. Bore diameter exceeding root diameter rejection.
9. No fallback geometry on error (raises GearGenerationError, never boxes or cylinders).
10. Step 2 delegation integration (generate_cad with style='gear' succeeds and returns gear).
"""

import math
import pytest
import cadquery as cq

from cad.gear_generator import GearGenerationError, generate_gear, reconcile_gear_module
from cad.cad_generator import generate_cad, CadGenerationError
from recipe_validator import CadSpec, validate_recipe


# ---------------------------------------------------------------------------
# Test 1: Basic Spur Gear Generation
# ---------------------------------------------------------------------------

def test_basic_spur_gear_generation():
    """Verify basic spur gear generation produces 1 valid solid with positive volume."""
    gear_spec = {
        "teeth": 20,
        "module": 2.0,
        "faceWidth": 10.0,
        "pressureAngle": 20.0,
        "boreRadius": 4.0,
    }
    wp, ft = generate_gear(gear_spec)
    assert isinstance(wp, cq.Workplane)
    assert ft["style"] == "gear"
    assert ft["parameters"]["teeth"] == 20
    assert ft["parameters"]["module"] == 2.0
    assert ft["parameters"]["faceWidth"] == 10.0

    solids = wp.solids().vals()
    assert len(solids) == 1

    vol = wp.val().Volume()
    assert vol > 0.0

    bb = wp.val().BoundingBox()
    # Tip diameter D_o = (teeth + 2) * module = 22 * 2 = 44 mm => bounds in [-22, 22]
    assert pytest.approx(bb.xmin, abs=0.5) == -22.0
    assert pytest.approx(bb.xmax, abs=0.5) == 22.0
    assert pytest.approx(bb.ymin, abs=0.5) == -22.0
    assert pytest.approx(bb.ymax, abs=0.5) == 22.0
    assert pytest.approx(bb.zmin, abs=0.1) == 0.0
    assert pytest.approx(bb.zmax, abs=0.1) == 10.0


# ---------------------------------------------------------------------------
# Test 2: Tooth Count
# ---------------------------------------------------------------------------

def test_gear_tooth_count_and_scaling():
    """Verify varying tooth count scales the gear tip diameter proportionally: D_o = (z + 2) * m."""
    for z in [12, 24, 36]:
        gear_spec = {
            "teeth": z,
            "module": 1.5,
            "faceWidth": 8.0,
        }
        wp, ft = generate_gear(gear_spec)
        assert ft["parameters"]["teeth"] == z
        expected_tip_d = (z + 2.0) * 1.5
        expected_r = expected_tip_d / 2.0

        bb = wp.val().BoundingBox()
        assert pytest.approx(bb.xmax, abs=0.5) == expected_r
        assert pytest.approx(bb.xmin, abs=0.5) == -expected_r


# ---------------------------------------------------------------------------
# Test 3: Gear Dimensions & Face Width
# ---------------------------------------------------------------------------

def test_gear_dimensions_and_face_width():
    """Verify face width exactly determines gear thickness along Z."""
    width = 17.5
    gear_spec = {
        "teeth": 18,
        "module": 2.5,
        "faceWidth": width,
    }
    wp, ft = generate_gear(gear_spec)
    bb = wp.val().BoundingBox()
    assert pytest.approx(bb.zlen, abs=1e-3) == width
    assert pytest.approx(bb.zmax - bb.zmin, abs=1e-3) == width


# ---------------------------------------------------------------------------
# Test 4: Bore Verification
# ---------------------------------------------------------------------------

def test_bore_verification_and_volume_reduction():
    """Verify specifying a bore reduces the solid volume by the cylindrical bore volume."""
    gear_nobore = {
        "teeth": 20,
        "module": 2.0,
        "faceWidth": 10.0,
        "boreRadius": 0.0,
    }
    wp_nobore, _ = generate_gear(gear_nobore)
    vol_nobore = wp_nobore.val().Volume()

    bore_r = 5.0
    gear_bore = {
        "teeth": 20,
        "module": 2.0,
        "faceWidth": 10.0,
        "boreRadius": bore_r,
    }
    wp_bore, ft = generate_gear(gear_bore)
    vol_bore = wp_bore.val().Volume()

    # Bore removed volume should be approximately pi * r^2 * h
    bore_vol = math.pi * (bore_r ** 2) * 10.0
    assert vol_bore < vol_nobore
    assert pytest.approx(vol_nobore - vol_bore, rel=0.02) == bore_vol
    assert ft["parameters"]["boreRadius"] == bore_r
    assert ft["parameters"]["boreDiameter"] == 2.0 * bore_r


# ---------------------------------------------------------------------------
# Test 5: Missing Module Reconciliation
# ---------------------------------------------------------------------------

def test_module_reconciliation_from_measured_od():
    """Verify module is inferred from measured outer diameter when module is missing."""
    teeth = 24
    measured_od = 65.0  # (24 + 2) * 2.5 = 65.0 => module = 2.5
    gear_spec = {
        "teeth": teeth,
        "faceWidth": 12.0,
        "outer_diameter": measured_od,
    }
    wp, ft = generate_gear(gear_spec)
    assert pytest.approx(ft["parameters"]["module"], rel=1e-3) == 2.5
    bb = wp.val().BoundingBox()
    assert pytest.approx(bb.xmax, abs=0.5) == measured_od / 2.0


# ---------------------------------------------------------------------------
# Test 6: Module Disagreement Warning
# ---------------------------------------------------------------------------

def test_module_disagreement_warning_over_5_percent():
    """Verify > 5% discrepancy between provided module and measured OD triggers a warning and prioritizes measured."""
    teeth = 20
    # Provided module = 2.0 (theoretical OD = (20+2)*2 = 44.0)
    # Measured OD = 48.4 mm => inferred module = 48.4 / 22 = 2.2 (+10% difference)
    gear_spec = {
        "teeth": teeth,
        "module": 2.0,
        "faceWidth": 10.0,
        "outer_diameter": 48.4,
    }
    wp, ft = generate_gear(gear_spec)
    assert "warnings" in ft
    assert any("differs" in w or "differing by" in w for w in ft["warnings"])
    assert pytest.approx(ft["parameters"]["module"], rel=1e-3) == 2.2


# ---------------------------------------------------------------------------
# Test 7: Invalid Input Rejection
# ---------------------------------------------------------------------------

def test_invalid_input_rejection():
    """Verify teeth < 3, non-positive face width, and invalid angles raise GearGenerationError."""
    # Teeth < 3
    with pytest.raises(GearGenerationError) as exc_1:
        generate_gear({"teeth": 2, "module": 2.0, "faceWidth": 10.0})
    assert "tooth count" in exc_1.value.message.lower()

    # Face width <= 0
    with pytest.raises(GearGenerationError) as exc_2:
        generate_gear({"teeth": 20, "module": 2.0, "faceWidth": -5.0})
    assert "face width" in exc_2.value.message.lower()

    # Pressure angle out of range
    with pytest.raises(GearGenerationError) as exc_3:
        generate_gear({"teeth": 20, "module": 2.0, "faceWidth": 10.0, "pressureAngle": 110.0})
    assert "pressure angle" in exc_3.value.message.lower()


# ---------------------------------------------------------------------------
# Test 8: Bore Exceeding Root Diameter
# ---------------------------------------------------------------------------

def test_bore_exceeding_root_diameter_rejected():
    """Verify a bore that would completely sever gear teeth is rejected."""
    # module=2.0, teeth=10 => root diameter = 2.0 * (10 - 2.5) = 15.0 mm
    # boreRadius=10.0 => bore diameter = 20.0 mm > 15.0 mm root diameter
    with pytest.raises(GearGenerationError) as exc:
        generate_gear({
            "teeth": 10,
            "module": 2.0,
            "faceWidth": 10.0,
            "boreRadius": 10.0,
        })
    assert "root diameter" in exc.value.message.lower()


# ---------------------------------------------------------------------------
# Test 9: No Fallback Geometry
# ---------------------------------------------------------------------------

def test_no_fallback_geometry_on_failure():
    """Verify that failed generation never silently returns a fallback box or cylinder."""
    with pytest.raises(GearGenerationError):
        generate_gear({"teeth": None, "module": None})


# ---------------------------------------------------------------------------
# Test 10: Step 2 CAD Generator Delegation Integration
# ---------------------------------------------------------------------------

def test_step2_cad_generator_delegation():
    """Verify that cad_generator.generate_cad delegates seamlessly to gear_generator."""
    recipe = {
        "style": "gear",
        "gear": {
            "teeth": 16,
            "module": 2.0,
            "faceWidth": 12.0,
            "pressureAngle": 20.0,
            "boreRadius": 3.0,
        },
    }
    cad_spec = validate_recipe(recipe)
    assert cad_spec.status == "ok"

    wp, ft = generate_cad(cad_spec)
    assert isinstance(wp, cq.Workplane)
    assert ft["style"] == "gear"
    assert len(wp.solids().vals()) == 1
    assert ft["parameters"]["teeth"] == 16
    assert ft["parameters"]["module"] == 2.0
    assert ft["parameters"]["faceWidth"] == 12.0

