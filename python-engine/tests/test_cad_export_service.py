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

from exports.reconstruction_export import export_model  # noqa: E402

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
    "bearing": {
        "componentType": "deep groove ball bearing",
        "ballCount": 9,
        "dimensions": {"outerDiameter": 80, "innerDiameter": 30, "height": 18, "thickness": 18},
        "geometryRecipe": {
            "style": "bearing",
            "bearing": {
                "outerDiameter": 80,
                "innerDiameter": 30,
                "width": 18,
                "outerRaceInnerDiameter": 63,
                "innerRaceOuterDiameter": 47,
                "pitchDiameter": 55,
                "ballDiameter": 10,
                "ballCount": 9,
                "grooveDepth": 3,
                "grooveRadius": 2.5,
                "rows": 1,
                "shieldType": "open",
            },
        },
    },
    "fallback_bearing": {
        "componentType": "ball bearing",
        "ballCount": 7,
        "dimensions": {"outerDiameter": 70, "innerDiameter": 25, "height": 16, "thickness": 16},
    },
    "fallback_cylinder": {
        "componentType": "cylinder/shaft",
        "dimensions": {"outerDiameter": 40, "innerDiameter": 16, "height": 90},
    },
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


def test_iges_export_reimports_as_valid_shape(tmp_path):
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.IGESControl import IGESControl_Reader

    result = export_model(
        {
            "analysis": SAMPLES["flange"],
            "format": "iges",
            "outDir": str(tmp_path),
            "baseName": "flange",
        }
    )
    assert result["valid"] is True

    reader = IGESControl_Reader()
    reader.ReadFile(result["path"])
    reader.TransferRoots()
    shape = reader.OneShape()
    assert not shape.IsNull()
    assert BRepCheck_Analyzer(shape).IsValid() is True


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
