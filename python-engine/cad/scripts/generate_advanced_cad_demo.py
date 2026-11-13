"""
generate_advanced_cad_demo.py — Reproducible demonstration for the ReForge AI
advanced (feature-based) CAD layer, Phase 1 (Stages 1 & 2).

This script is fully deterministic.  It:

1. Builds the reference mechanical-housing feature recipe
   (``cad/specimens/advanced_housing.py``).
2. Models it with the feature modeller (``cad/feature_modeller.py``).
3. Validates the resulting geometry (``cad/advanced_cad_validator.py``).
4. Generates visual evidence: isometric / front / side / top previews plus a
   half-section cutaway that exposes the internal cavity, bores and passages.
5. Writes the demonstration recipe, the full feature (modelling) history,
   the validation report, and STEP / STL exports.

All outputs land in ``python-engine/cad/artifacts/advanced-cad/phase1/``.

Run from the ``python-engine`` directory:

    python cad/scripts/generate_advanced_cad_demo.py

or from the repository root:

    python python-engine/cad/scripts/generate_advanced_cad_demo.py

The script is location-independent: it derives every path from its own
``__file__`` and never relies on the current working directory.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict

# Make ``python-engine`` importable regardless of the current working
# directory (the script may be launched from the repo root or python-engine).
_HERE = os.path.dirname(os.path.abspath(__file__))   # python-engine/cad/scripts
_CAD_ROOT = os.path.dirname(_HERE)                   # python-engine/cad
_ENGINE_ROOT = os.path.dirname(_CAD_ROOT)            # python-engine
if _ENGINE_ROOT not in sys.path:
    sys.path.insert(0, _ENGINE_ROOT)

import cadquery as cq  # noqa: E402

from cad.specimens.advanced_housing import (  # noqa: E402
    EXPECTED_BBOX,
    HOUSING_DIMENSIONS,
    build_advanced_housing_recipe,
)
from cad.feature_modeller import model_feature_recipe  # noqa: E402
from cad.advanced_cad_validator import validate_feature_geometry  # noqa: E402
from cad import advanced_preview  # noqa: E402

ARTIFACT_DIR = os.path.join(_CAD_ROOT, "artifacts", "advanced-cad", "phase1")


def _write_json(path: str, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)


def main() -> int:
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    t0 = time.time()

    print("=" * 78)
    print("ReForge AI — Advanced CAD Phase 1 demonstration (Stages 1 & 2)")
    print("=" * 78)
    print(f"Artifact directory: {ARTIFACT_DIR}")

    # ------------------------------------------------------------------
    # 1. Recipe
    # ------------------------------------------------------------------
    recipe = build_advanced_housing_recipe()
    _write_json(os.path.join(ARTIFACT_DIR, "housing_recipe.json"), recipe)
    print(f"\n[1/6] Recipe '{recipe['name']}' with {len(recipe['features'])} features.")

    # ------------------------------------------------------------------
    # 2. Model
    # ------------------------------------------------------------------
    workplane, history = model_feature_recipe(recipe)
    _write_json(os.path.join(ARTIFACT_DIR, "housing_feature_history.json"), history)
    summary = history["summary"]
    print(f"[2/6] Modelled: {summary['applied']}/{summary['num_features']} features applied, "
          f"all_applied={summary['all_applied']}.")

    # ------------------------------------------------------------------
    # 3. Validate
    # ------------------------------------------------------------------
    validation = validate_feature_geometry(workplane, recipe, history)
    _write_json(os.path.join(ARTIFACT_DIR, "housing_validation_report.json"), validation)
    print(f"[3/6] Validation: valid={validation['valid']} fit={validation['fit_score']} "
          f"issues={len(validation['issues'])}.")
    for issue in validation["issues"]:
        print(f"        - {issue}")

    # ------------------------------------------------------------------
    # 4. Visual evidence
    # ------------------------------------------------------------------
    manifest = advanced_preview.generate_preview_bundle(
        workplane, ARTIFACT_DIR, "housing")
    _write_json(os.path.join(ARTIFACT_DIR, "housing_preview_manifest.json"), manifest)
    produced = [v for v in manifest["png"].values() if v]
    print(f"[4/6] Previews: {len(manifest['svg'])} SVG, {len(produced)} PNG, "
          f"section={'yes' if manifest['section'] else 'no'}.")

    # ------------------------------------------------------------------
    # 5. STEP / STL exports
    # ------------------------------------------------------------------
    step_path = os.path.join(ARTIFACT_DIR, "housing.step")
    stl_path = os.path.join(ARTIFACT_DIR, "housing.stl")
    cq.exporters.export(workplane, step_path, cq.exporters.ExportTypes.STEP)
    cq.exporters.export(workplane, stl_path, cq.exporters.ExportTypes.STL)
    print(f"[5/6] Exports: {os.path.basename(step_path)} "
          f"({os.path.getsize(step_path) // 1024} KB), "
          f"{os.path.basename(stl_path)} ({os.path.getsize(stl_path) // 1024} KB).")

    # ------------------------------------------------------------------
    # 6. Human-readable report
    # ------------------------------------------------------------------
    metrics = validation["metrics"]
    bbox = metrics.get("actual_bbox", {})
    report_lines = [
        "# ReForge AI — Advanced CAD Phase 1 Evidence",
        "",
        "Deterministic demonstration of the feature-based 3D modelling layer "
        "(Stages 1 & 2). Generated by `python-engine/cad/scripts/generate_advanced_cad_demo.py`.",
        "",
        "## Reference component",
        "",
        "`advanced_mechanical_housing` — a mechanical housing with a central "
        "cylindrical body, a bolted mounting flange, an upper internal cavity with a "
        "stepped bore, three radial side ports on external bosses, four structural "
        "ribs, an intersecting internal cross-passage network, and machined edges.",
        "",
        "## Result",
        "",
        f"- Features: **{summary['num_features']}** "
        f"({summary['applied']} applied, {summary['failed']} failed, {summary['skipped']} skipped)",
        f"- Valid: **{validation['valid']}**",
        f"- Fit score: **{validation['fit_score']}**",
        f"- Volume: **{metrics.get('actual_volume_mm3', 0):,.1f} mm³**",
        f"- Bounding box: **{bbox.get('xlen', 0):.2f} × {bbox.get('ylen', 0):.2f} × "
        f"{bbox.get('zlen', 0):.2f} mm** (expected "
        f"{EXPECTED_BBOX['xlen']:.0f} × {EXPECTED_BBOX['ylen']:.0f} × {EXPECTED_BBOX['zlen']:.0f} mm)",
        f"- Solid count: **{metrics.get('solid_count')}**",
        f"- Bore features: **{metrics['feature_checks'].get('bore_feature_count')}**, "
        f"mounting holes: **{metrics['feature_checks'].get('pattern_hole_count')}**, "
        f"ports: **{metrics['feature_checks'].get('port_count')}**, "
        f"internal passages: **{metrics['feature_checks'].get('passage_count')}**",
        f"- Intersecting passages verified: "
        f"**{metrics['feature_checks'].get('intersecting_passages_ok')}**",
        "",
        "## Files",
        "",
        "| File | Description |",
        "| --- | --- |",
        "| `housing_recipe.json` | Versioned feature recipe (input). |",
        "| `housing_feature_history.json` | Full modelling history with per-feature diagnostics. |",
        "| `housing_validation_report.json` | Geometry validation report. |",
        "| `housing_preview_manifest.json` | Preview file manifest. |",
        "| `housing_isometric.{svg,png}` | Isometric preview. |",
        "| `housing_front.{svg,png}` | Front preview. |",
        "| `housing_side.{svg,png}` | Side preview. |",
        "| `housing_top.{svg,png}` | Top preview. |",
        "| `housing_section*.{svg,png}` | Half-section cutaway exposing internal geometry. |",
        "| `housing.step` / `housing.stl` | CAD exchange exports. |",
        "",
        "## Reproduction",
        "",
        "```",
        "cd python-engine",
        "python cad/scripts/generate_advanced_cad_demo.py",
        "```",
        "",
    ]
    report_path = os.path.join(ARTIFACT_DIR, "EVIDENCE.md")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(report_lines))
    print(f"[6/6] Wrote EVIDENCE.md and all artifacts in {time.time() - t0:.1f}s.")

    print("\nDone.")
    return 0 if validation["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
