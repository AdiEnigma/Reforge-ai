"""
Reconstruction → CAD export tests.

Each generated artifact is re-imported with OpenCASCADE — the same kernel FreeCAD
uses for STEP/IGES — and must come back as a valid solid. "Exported" therefore
means "opens as real geometry", not "a file was written".
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from exports.reconstruction_export import ExportError, export_model  # noqa: E402

SAMPLES = {
    "spur_gear": {
        "componentType": "spur gear",
        "dimensions": {"outerDiameter": 120, "innerDiameter": 30, "height": 25},
        "geometryRecipe": {
            "style": "gear",
            "gear": {"teeth": 24, "module": 5, "faceWidth": 25, "boreRadius": 15},
        },
    },
    "helical_gear": {
        "componentType": "helical gear",
        "dimensions": {"outerDiameter": 120, "innerDiameter": 30, "height": 25},
        "geometryRecipe": {
            "style": "gear",
            "gear": {
                "teeth": 20,
                "module": 4,
                "faceWidth": 22,
                "boreRadius": 12,
                "helixAngle": 20,
            },
        },
    },
    "bevel_gear": {
        "componentType": "bevel gear",
        "dimensions": {"outerDiameter": 80, "innerDiameter": 20, "height": 30},
        "geometryRecipe": {
            "style": "gear",
            "gear": {
                "teeth": 18,
                "module": 3,
                "faceWidth": 20,
                "boreRadius": 8,
                "gearType": "bevel",
                "coneAngle": 45,
            },
        },
    },
    "flange": {
        "componentType": "flange",
        "dimensions": {"outerDiameter": 150, "innerDiameter": 50, "height": 40, "thickness": 20},
        "geometryRecipe": {
            "style": "flange",
            "flange": {
                "outerDiameter": 150,
                "innerDiameter": 50,
                "thickness": 20,
                "height": 40,
                "boltCount": 6,
                "boltCircleDiameter": 114,
                "boltHoleDiameter": 16,
                "bossDiameter": 90,
                "bossHeight": 20,
            },
        },
    },
    "shaft": {
        "componentType": "cylinder/shaft",
        "dimensions": {"outerDiameter": 50, "height": 200},
        "geometryRecipe": {
            "style": "revolved",
            "revolvedProfile": [
                {"z": 0, "radius": 10},
                {"z": 20, "radius": 25},
                {"z": 120, "radius": 25},
                {"z": 140, "radius": 15},
                {"z": 200, "radius": 15},
            ],
        },
    },
    "plate": {
        "componentType": "plate",
        "dimensions": {"thickness": 10},
        "geometryRecipe": {
            "style": "extruded",
            "depth": 10,
            "outline": [
                {"x": -50, "y": -30},
                {"x": 50, "y": -30},
                {"x": 50, "y": 30},
                {"x": -50, "y": 30},
            ],
            "holes": [
                {"cx": 0, "cy": 0, "radius": 12},
                {"cx": 35, "cy": 0, "radius": 6},
                {"cx": -35, "cy": 0, "radius": 6},
            ],
        },
    },
    "fallback_cylinder": {
        "componentType": "cylinder/shaft",
        "dimensions": {"outerDiameter": 40, "innerDiameter": 16, "height": 90},
    },
}


# Each confirmed tooth form has a distinct fixture: different tooth counts,
# diameters, face widths and type-specific parameters. The analysis-level type
# is intentional: CAD must honour the single confirmed analysis even when a
# partial recipe does not repeat it.
CONFIRMED_GEAR_SAMPLES = {
    "spur": {
        "componentType": "spur gear",
        "gearType": "spur",
        "gear": {"teeth": 13, "module": 3.5, "faceWidth": 13, "boreRadius": 5},
    },
    "helical": {
        "componentType": "helical gear",
        "gearType": "helical",
        "gear": {"teeth": 14, "module": 3.5, "faceWidth": 14, "boreRadius": 5.5, "helixAngle": 22},
    },
    "bevel": {
        "componentType": "bevel gear",
        "gearType": "bevel",
        "gear": {"teeth": 15, "module": 3.6, "faceWidth": 15, "boreRadius": 5.5, "coneAngle": 38},
    },
    "worm": {
        "componentType": "worm gear",
        "gearType": "worm",
        "gear": {
            "module": 3.8, "faceWidth": 28, "outerDiameter": 44,
            "pitch": 7, "starts": 1, "rootRadius": 15,
        },
    },
    "rack": {
        "componentType": "rack gear",
        "gearType": "rack",
        "gear": {"teeth": 16, "module": 3.0, "faceWidth": 11, "rackLength": 165},
    },
    "internal": {
        "componentType": "internal gear",
        "gearType": "internal",
        "gear": {
            "teeth": 18, "module": 3.5, "faceWidth": 13,
            "outerDiameter": 76, "boreRadius": 20, "innerRing": True,
        },
    },
    "compound": {
        "componentType": "compound gear",
        "gearType": "compound",
        "gear": {
            "teeth": 17, "module": 3.0, "faceWidth": 21, "boreRadius": 5,
            "stages": [
                {"teeth": 17, "module": 3.0, "faceWidth": 12, "outerDiameter": 68},
                {"teeth": 10, "module": 3.0, "faceWidth": 9, "outerDiameter": 44},
            ],
        },
    },
    "pinion": {
        "componentType": "pinion shaft",
        "gearType": "pinion",
        "gear": {"teeth": 11, "module": 3.2, "faceWidth": 13, "boreRadius": 4},
    },
    "stepped": {
        "componentType": "stepped gear",
        "gearType": "stepped",
        "gear": {
            "teeth": 19, "module": 3.0, "faceWidth": 23, "boreRadius": 5,
            "stages": [
                {"teeth": 19, "module": 3.0, "faceWidth": 13, "outerDiameter": 74},
                {"teeth": 13, "module": 3.0, "faceWidth": 10, "outerDiameter": 54},
            ],
        },
    },
    "flanged": {
        "componentType": "flanged gear",
        "gearType": "flanged",
        "gear": {"teeth": 12, "module": 3.4, "faceWidth": 12, "boreRadius": 5},
    },
}


def _confirmed_analysis(gear_type):
    spec = CONFIRMED_GEAR_SAMPLES[gear_type]
    gear = spec["gear"]
    outer_diameter = gear.get("outerDiameter", (gear.get("teeth", 12) + 2) * gear.get("module", 3))
    face_width = gear["faceWidth"]
    return {
        "componentType": spec["componentType"],
        "gearType": spec["gearType"],
        "dimensions": {
            "outerDiameter": outer_diameter,
            "innerDiameter": gear.get("boreRadius", 0) * 2,
            "height": face_width,
            "thickness": face_width,
            "width": gear.get("rackLength", outer_diameter),
            "length": gear.get("rackLength", outer_diameter),
        },
        "geometryRecipe": {"style": "gear", "gear": dict(gear)},
    }


def _reimport_step(path):
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.STEPControl import STEPControl_Reader

    reader = STEPControl_Reader()
    reader.ReadFile(path)
    reader.TransferRoots()
    shape = reader.OneShape()
    return shape, BRepCheck_Analyzer(shape).IsValid()


@pytest.mark.parametrize("name", sorted(SAMPLES))
def test_step_export_reimports_as_valid_solid(tmp_path, name):
    result = export_model(
        {
            "analysis": SAMPLES[name],
            "format": "step",
            "outDir": str(tmp_path),
            "baseName": name,
        }
    )

    assert result["ok"] is True
    assert result["valid"] is True
    assert result["solids"] >= 1
    assert os.path.getsize(result["path"]) > 1024

    shape, valid = _reimport_step(result["path"])
    assert not shape.IsNull(), f"{name}: STEP re-import produced no shape"
    assert valid is True, f"{name}: STEP re-import failed the OpenCASCADE validity check"


@pytest.mark.parametrize("gear_type", sorted(CONFIRMED_GEAR_SAMPLES))
def test_confirmed_gear_type_exports_type_specific_valid_solid(tmp_path, gear_type):
    result = export_model(
        {
            "analysis": _confirmed_analysis(gear_type),
            "format": "step",
            "outDir": str(tmp_path),
            "baseName": f"confirmed_{gear_type}",
        }
    )

    assert result["ok"] is True
    assert result["valid"] is True
    assert result["style"] == "gear", f"{gear_type} did not use the gear geometry path"
    assert result["solids"] >= 1
    assert os.path.getsize(result["path"]) > 1024

    shape, valid = _reimport_step(result["path"])
    assert not shape.IsNull(), f"{gear_type}: STEP re-import produced no shape"
    assert valid is True, f"{gear_type}: STEP re-import failed the OpenCASCADE validity check"

    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bounds = Bnd_Box()
    BRepBndLib.Add_s(shape, bounds)
    xmin, ymin, zmin, xmax, ymax, zmax = bounds.Get()
    x_length, y_length, z_length = xmax - xmin, ymax - ymin, zmax - zmin
    assert min(x_length, y_length, z_length) > 0.1, (
        f"{gear_type}: degenerate reconstructed geometry"
    )
    if gear_type == "rack":
        assert x_length > y_length * 2, (
            f"{gear_type}: rack must stay linear, got {x_length} x {y_length}"
        )
    if gear_type == "worm":
        assert result["solids"] >= 2, "worm should keep its helical flight as separate solids"


def _reimport_iges(path):
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.IGESControl import IGESControl_Reader

    reader = IGESControl_Reader()
    reader.ReadFile(path)
    reader.TransferRoots()
    shape = reader.OneShape()
    return shape, BRepCheck_Analyzer(shape).IsValid()


def test_iges_export_reimports_as_valid_shape(tmp_path):
    result = export_model(
        {
            "analysis": SAMPLES["flange"],
            "format": "iges",
            "outDir": str(tmp_path),
            "baseName": "flange",
        }
    )
    assert result["valid"] is True

    shape, valid = _reimport_iges(result["path"])
    assert not shape.IsNull()
    assert valid is True


@pytest.mark.parametrize("gear_type", sorted(CONFIRMED_GEAR_SAMPLES))
def test_confirmed_gear_iges_reimports_as_valid_shape(tmp_path, gear_type):
    result = export_model(
        {
            "analysis": _confirmed_analysis(gear_type),
            "format": "iges",
            "outDir": str(tmp_path),
            "baseName": f"confirmed_{gear_type}",
        }
    )
    assert result["ok"] is True
    assert result["valid"] is True

    shape, valid = _reimport_iges(result["path"])
    assert not shape.IsNull(), f"{gear_type}: IGES re-import produced no shape"
    assert valid is True, f"{gear_type}: IGES re-import failed the OpenCASCADE validity check"


def test_stl_and_obj_exports_are_non_empty(tmp_path):
    for fmt in ("stl", "obj"):
        result = export_model(
            {
                "analysis": SAMPLES["spur_gear"],
                "format": fmt,
                "outDir": str(tmp_path),
                "baseName": f"gear_{fmt}",
            }
        )
        assert result["format"] == fmt
        assert os.path.getsize(result["path"]) > 512


def test_cli_contract_used_by_the_backend(tmp_path):
    payload = json.dumps(
        {
            "analysis": SAMPLES["spur_gear"],
            "format": "step",
            "outDir": str(tmp_path),
            "baseName": "cli_gear",
        }
    )
    completed = subprocess.run(
        [sys.executable, os.path.join(ENGINE_ROOT, "exports", "reconstruction_export.py")],
        input=payload,
        capture_output=True,
        text=True,
        cwd=ENGINE_ROOT,
        timeout=180,
    )

    assert completed.returncode == 0, completed.stderr
    manifest = json.loads(completed.stdout.strip().splitlines()[-1])
    assert manifest["ok"] is True
    assert manifest["valid"] is True
    assert manifest["baseName"] == "cli_gear"


@pytest.mark.parametrize(
    "analysis",
    [
        {
            "componentType": "gear",
            "gearType": "unknown",
            "teeth": 20,
            "dimensions": {"outerDiameter": 80},
            "geometryRecipe": {
                "style": "gear",
                "gear": {"gearType": "unknown", "teeth": 20, "module": 3},
            },
        },
        {
            "componentType": "gear",
            "teeth": 20,
            "dimensions": {"outerDiameter": 80},
            "geometryRecipe": {"style": "gear", "gear": {"teeth": 20, "module": 3}},
        },
        {
            "componentType": "gear",
            "gearType": "spur",
            "requiresGearTypeConfirmation": True,
            "teeth": 20,
            "dimensions": {"outerDiameter": 80},
        },
    ],
    ids=["explicit_unknown", "tooth_count_only", "confirmation_flag"],
)
def test_unconfirmed_gear_type_is_rejected(tmp_path, analysis):
    with pytest.raises(ExportError) as excinfo:
        export_model(
            {
                "analysis": analysis,
                "format": "step",
                "outDir": str(tmp_path),
                "baseName": "unconfirmed",
            }
        )
    assert str(excinfo.value) == (
        "Gear type is unconfirmed. Confirm spur, helical, bevel, worm, rack, "
        "internal, compound, pinion, stepped or flanged before exporting CAD."
    )
    assert excinfo.value.stage == "input"


def test_unsupported_format_is_rejected(tmp_path):
    with pytest.raises(Exception) as excinfo:
        export_model(
            {
                "analysis": SAMPLES["spur_gear"],
                "format": "parasolid",
                "outDir": str(tmp_path),
                "baseName": "bad",
            }
        )
    assert "Unsupported format" in str(excinfo.value)
