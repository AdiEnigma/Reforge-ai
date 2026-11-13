"""
generate_advanced_cad_demo_phase2.py — Reproducible demonstration for the
ReForge AI advanced CAD layer, Phase 2 (Stages 3 & 4).

This script reuses the *exact* Phase 1 reference housing model and feature
recipe — no separate simplified model is created.  It then:

1. Models + validates the housing (same recipe as Phase 1).
2. Generates professional engineering drawings (Stage 3): front / top / right /
   isometric / section / detail views with real hidden-line-removal geometry,
   dimensions, centre lines, title block, units and section labels — as vector
   **SVG** and **PDF**.
3. Generates high-resolution isometric and section/cutaway previews (PNG).
4. Exports STEP + STL and validates them by re-import (Stage 4).
5. Validates the drawings (required views / dimensions / units / tolerances).
6. Emits the source recipe, feature history, validation report and export
   manifest.
7. Emits the Reconstruction→CAD integration contract example + JSON Schema.
8. Packages everything into a single ZIP deliverable.

All outputs land in ``python-engine/cad/artifacts/advanced-cad/phase2/``.

Run from the ``python-engine`` directory:

    python cad/scripts/generate_advanced_cad_demo_phase2.py

or from the repository root:

    python python-engine/cad/scripts/generate_advanced_cad_demo_phase2.py

The script is location-independent: it derives every path from its own
``__file__`` and never relies on the current working directory.
"""

from __future__ import annotations

import json
import os
import sys
import time
import zipfile
from typing import Any, Dict, List

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
    build_advanced_housing_recipe,
)
from cad.feature_modeller import model_feature_recipe  # noqa: E402
from cad.advanced_cad_validator import validate_feature_geometry  # noqa: E402
from cad import advanced_preview  # noqa: E402
from cad import engineering_drawing  # noqa: E402
from cad import export_validation  # noqa: E402
from cad import integration_contract  # noqa: E402

ARTIFACT_DIR = os.path.join(_CAD_ROOT, "artifacts", "advanced-cad", "phase2")


def _write_json(path: str, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)


def _synthetic_cylinder_points():
    """Reproduce the deterministic Reconstruction test cylinder (r=25, h=100)."""
    import numpy as np

    np.random.seed(42)
    n_points = 200
    r = 25.0
    theta = np.linspace(0, 2 * np.pi, n_points, endpoint=False)
    z = np.linspace(-50.0, 50.0, n_points)
    pts = np.column_stack([r * np.cos(theta), r * np.sin(theta), z]).tolist()
    return {"points": pts, "true_radius": r, "true_diameter": 2 * r,
            "true_height": 100.0}


def _generate_recon_evidence(artifact_dir: str) -> Dict[str, Any]:
    """Run a real Reconstruction -> CAD round trip and capture the JSON.

    Uses the *actual* Reconstruction Engine public interface
    (``solve_geometry``) and the *actual* ``POST /cad/from-reconstruction``
    endpoint, then writes the exact request/response documents as evidence.
    """
    import numpy as np  # noqa: F401  (used via the helper above)
    from reconstruction.geometry_solver import solve_geometry
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest
    from fastapi.responses import JSONResponse

    cyl = _synthetic_cylinder_points()
    solver_result = solve_geometry(
        job_id="recon_to_cad",
        component_type="cylinder",
        user_dimensions={"inner_diameter": 20.0},
        multiview_evidence={
            "points3D": [{"xyz": pt} for pt in cyl["points"]],
            "scale": {"classification": "metric"},
        },
    )
    # These points are synthesised in-process; COLMAP is NOT run.  The solver's
    # cylinder branch stamps the fit ``COLMAP_RECONSTRUCTION`` by default, so
    # record the true source so no evidence document claims a reconstruction
    # that did not happen.
    integration_contract.record_fixture_source(
        solver_result,
        source="synthetic-cylinder-fixture",
        colmap_executed=False,
        note=("Deterministic synthetic cylinder point cloud (r=25 mm, h=100 mm, "
              "bore d=20 mm); COLMAP was NOT run."))

    out_subdir = os.path.join(artifact_dir, "reconstruction_to_cad")
    os.makedirs(out_subdir, exist_ok=True)

    interface_doc = integration_contract.interface_from_solver_result(
        solver_result, component_id="cyl_001", component_type="shaft",
        geometry_style="revolved", name="reconstructed_sleeve")
    interface_check = integration_contract.validate_interface(interface_doc)

    request = {
        "job_id": "recon_to_cad",
        "interface": interface_doc,
        "model": True,
        "output_dir": out_subdir,
    }
    payload = ReconstructionCadRequest(
        job_id="recon_to_cad", interface=interface_doc, model=True,
        output_dir=out_subdir)
    response = cad_from_reconstruction_endpoint(payload)
    if isinstance(response, JSONResponse):
        response_doc = {"http_status": response.status_code,
                        "body": json.loads(bytes(response.body).decode("utf-8"))}
        status = "error"
    else:
        response_doc = {k: v for k, v in response.items()
                        if k not in ("feature_history",)}
        status = response.get("status")

    _write_json(os.path.join(artifact_dir, "reconstruction_solver_result.json"),
                solver_result.to_dict())
    _write_json(os.path.join(artifact_dir, "reconstruction_to_cad_request.json"),
                request)
    _write_json(os.path.join(artifact_dir, "reconstruction_to_cad_response.json"),
                response_doc)

    # Re-import the *actual* exported STEP / STL and compare with the modelled
    # solid, so the integration evidence includes real export validation.
    export_check: Dict[str, Any] = {}
    if status == "success":
        from cad.feature_modeller import model_feature_recipe
        wp, _hist = model_feature_recipe(interface_check["recipe_dict"],
                                         strict=False)
        export_check = {
            "step": export_validation.validate_step_export(
                response_doc.get("step_path"), wp),
            "stl": export_validation.validate_stl_export(
                response_doc.get("stl_path"), wp),
        }
        export_check["valid"] = bool(export_check["step"]["valid"]
                                     and export_check["stl"]["valid"])
        _write_json(
            os.path.join(artifact_dir,
                         "reconstruction_to_cad_export_validation.json"),
            export_validation.to_portable_paths(export_check, artifact_dir))

    return {
        "solver_status": solver_result.status,
        "scale_classification": solver_result.scale_classification,
        "units": solver_result.units,
        "missing_critical_dimensions": solver_result.missing_critical_dimensions,
        "interface_valid": interface_check["valid"],
        "endpoint_status": status,
        "export_valid": export_check.get("valid"),
        "step_volume_error": (export_check.get("step", {}).get("checks", {})
                              .get("volume", {}).get("relative_error")),
        "stl_volume_error": (export_check.get("stl", {}).get("checks", {})
                             .get("volume", {}).get("relative_error")),
        "request_path": os.path.join(artifact_dir, "reconstruction_to_cad_request.json"),
        "response_path": os.path.join(artifact_dir, "reconstruction_to_cad_response.json"),
        "solver_result_path": os.path.join(artifact_dir, "reconstruction_solver_result.json"),
        "export_validation_path": os.path.join(
            artifact_dir, "reconstruction_to_cad_export_validation.json"),
        "export_dir": out_subdir,
        "step_path": response_doc.get("step_path") if isinstance(response_doc, dict) else None,
        "stl_path": response_doc.get("stl_path") if isinstance(response_doc, dict) else None,
    }


def main() -> int:
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    t0 = time.time()

    print("=" * 78)
    print("ReForge AI — Advanced CAD Phase 2 demonstration (Stages 3 & 4)")
    print("=" * 78)
    print(f"Artifact directory: {ARTIFACT_DIR}")

    # ------------------------------------------------------------------
    # 1. Same Phase 1 recipe + model
    # ------------------------------------------------------------------
    recipe = build_advanced_housing_recipe()
    _write_json(os.path.join(ARTIFACT_DIR, "housing_recipe.json"), recipe)
    workplane, history = model_feature_recipe(recipe)
    _write_json(os.path.join(ARTIFACT_DIR, "housing_feature_history.json"), history)
    summary = history["summary"]
    print(f"[1/9] Modelled {summary['applied']}/{summary['num_features']} features "
          f"(all_applied={summary['all_applied']}).")

    validation = validate_feature_geometry(workplane, recipe, history)
    _write_json(os.path.join(ARTIFACT_DIR, "housing_validation_report.json"), validation)
    print(f"[2/9] Geometry validation: valid={validation['valid']} "
          f"fit={validation['fit_score']} issues={len(validation['issues'])}.")

    # ------------------------------------------------------------------
    # 2. Engineering drawings (Stage 3)
    # ------------------------------------------------------------------
    section_wp = advanced_preview.make_half_section(workplane, axis="y", keep="positive")
    drawing_manifest = engineering_drawing.generate_engineering_drawings(
        workplane, recipe, validation["metrics"], ARTIFACT_DIR, "housing",
        section_shape=section_wp.val())
    # Write a *portable* copy (relative POSIX paths) as the packaged manifest;
    # the in-memory manifest keeps absolute paths for the validation logic below.
    _write_json(os.path.join(ARTIFACT_DIR, "housing_drawing_manifest.json"),
                export_validation.to_portable_paths(drawing_manifest, ARTIFACT_DIR))
    print(f"[3/9] Drawings: {len(drawing_manifest['views'])} views, "
          f"{drawing_manifest['dimension_count']} dimensions; "
          f"SVG {os.path.getsize(drawing_manifest['svg']) // 1024} KB, "
          f"PDF {os.path.getsize(drawing_manifest['pdf']) // 1024} KB.")

    # ------------------------------------------------------------------
    # 3. High-resolution previews (Stage 4 evidence)
    # ------------------------------------------------------------------
    step_path = os.path.join(ARTIFACT_DIR, "housing.step")
    stl_path = os.path.join(ARTIFACT_DIR, "housing.stl")
    cq.exporters.export(workplane, step_path, cq.exporters.ExportTypes.STEP)
    cq.exporters.export(workplane, stl_path, cq.exporters.ExportTypes.STL)

    hi_iso = advanced_preview.render_png_from_stl(
        stl_path, os.path.join(ARTIFACT_DIR, "housing_isometric_hires.png"),
        "isometric", size=(1800, 1400))
    sec_stl = os.path.join(ARTIFACT_DIR, "housing_section.stl")
    cq.exporters.export(section_wp, sec_stl, cq.exporters.ExportTypes.STL)
    hi_sec = advanced_preview.render_png_from_stl(
        sec_stl, os.path.join(ARTIFACT_DIR, "housing_section_hires.png"),
        "isometric", size=(1800, 1400))
    print(f"[4/9] High-res previews: isometric={'ok' if hi_iso else 'skip'}, "
          f"section={'ok' if hi_sec else 'skip'}.")

    # ------------------------------------------------------------------
    # 4. Export validation (Stage 4)
    # ------------------------------------------------------------------
    required_texts = [
        drawing_manifest["title_block"]["component"],
        drawing_manifest["title_block"]["drawing_number"],
        drawing_manifest["title_block"]["units"],
    ]
    export_report = export_validation.validate_exports(
        step_path, stl_path, workplane,
        svg_path=drawing_manifest["svg"], pdf_path=drawing_manifest["pdf"],
        drawing_manifest=drawing_manifest,
        required_views=drawing_manifest["views"], required_texts=required_texts,
        preview_path=drawing_manifest.get("preview_png"))
    _write_json(os.path.join(ARTIFACT_DIR, "housing_export_validation.json"),
                export_validation.to_portable_paths(export_report, ARTIFACT_DIR))
    print(f"[5/9] Export validation: overall={export_report['valid']} "
          f"(STEP={export_report['step']['valid']}, "
          f"STL={export_report['stl']['valid']}, "
          f"drawing={export_report['drawing']['valid']}).")
    for issue in export_report["issues"]:
        print(f"        - {issue}")

    # ------------------------------------------------------------------
    # 5. Integration contract example + schema
    # ------------------------------------------------------------------
    interface_doc = integration_contract.example_housing_interface()
    _write_json(os.path.join(ARTIFACT_DIR, "integration_example_recipe.json"),
                interface_doc)
    _write_json(os.path.join(ARTIFACT_DIR, "integration_interface_schema.json"),
                integration_contract.interface_json_schema())
    interface_check = integration_contract.validate_interface(interface_doc)
    print(f"[6/9] Integration contract: example valid={interface_check['valid']} "
          f"(status={interface_check['status']}).")

    # ------------------------------------------------------------------
    # 5b. Real Reconstruction -> CAD round trip (evidence)
    # ------------------------------------------------------------------
    recon = _generate_recon_evidence(ARTIFACT_DIR)
    print(f"[7/9] Reconstruction -> CAD: solver={recon['solver_status']} "
          f"({recon['scale_classification']}), endpoint={recon['endpoint_status']}, "
          f"interface_valid={recon['interface_valid']}.")

    # ------------------------------------------------------------------
    # 6. Export manifest (relative paths + SHA-256) and verification
    # ------------------------------------------------------------------
    entries = {
        "step_solid": step_path,
        "stl_mesh": stl_path,
        "section_stl": sec_stl,
        "drawing_svg": drawing_manifest["svg"],
        "drawing_pdf": drawing_manifest["pdf"],
        "drawing_preview_png": drawing_manifest.get("preview_png"),
        "isometric_hires_png": hi_iso,
        "section_hires_png": hi_sec,
        "source_recipe_json": os.path.join(ARTIFACT_DIR, "housing_recipe.json"),
        "feature_history_json": os.path.join(ARTIFACT_DIR, "housing_feature_history.json"),
        "validation_report_json": os.path.join(ARTIFACT_DIR, "housing_validation_report.json"),
        "drawing_manifest_json": os.path.join(ARTIFACT_DIR, "housing_drawing_manifest.json"),
        "export_validation_json": os.path.join(ARTIFACT_DIR, "housing_export_validation.json"),
        "integration_example_json": os.path.join(ARTIFACT_DIR, "integration_example_recipe.json"),
        "integration_schema_json": os.path.join(ARTIFACT_DIR, "integration_interface_schema.json"),
        "reconstruction_solver_result_json": recon["solver_result_path"],
        "reconstruction_to_cad_request_json": recon["request_path"],
        "reconstruction_to_cad_response_json": recon["response_path"],
        "reconstruction_to_cad_export_validation_json": recon["export_validation_path"],
        # The *current* Reconstruction→CAD STEP/STL pair.  Only this pair is
        # packaged; stale runs left in reconstruction_to_cad/ are excluded.
        "reconstruction_to_cad_step": recon["step_path"],
        "reconstruction_to_cad_stl": recon["stl_path"],
    }
    manifest = export_validation.build_export_manifest(
        entries, export_report, base_dir=ARTIFACT_DIR)
    manifest_check = export_validation.verify_export_manifest(
        manifest, base_dir=ARTIFACT_DIR)
    manifest["verification"] = {
        "valid": manifest_check["valid"],
        "verified": manifest_check["metrics"].get("verified"),
        "file_count": manifest_check["metrics"].get("file_count"),
    }
    _write_json(os.path.join(ARTIFACT_DIR, "housing_export_manifest.json"), manifest)
    print(f"[8/9] Export manifest: {len(manifest['files'])} files recorded, "
          f"verified={manifest_check['valid']} "
          f"({manifest_check['metrics'].get('verified')} checked).")
    for issue in manifest_check["issues"]:
        print(f"        - {issue}")

    # ------------------------------------------------------------------
    # 7. Human-readable report
    # ------------------------------------------------------------------
    metrics = validation["metrics"]
    bbox = metrics.get("actual_bbox", {})
    step_checks = export_report["step"]["checks"]
    stl_checks = export_report["stl"]["checks"]
    report_lines: List[str] = [
        "# ReForge AI — Advanced CAD Phase 2 Evidence (Stages 3 & 4)",
        "",
        "Engineering drawings and export validation generated from the **same** "
        "validated Phase 1 housing model and feature recipe "
        "(`python-engine/cad/scripts/generate_advanced_cad_demo_phase2.py`).",
        "",
        "## Source model (unchanged from Phase 1)",
        "",
        f"- Features: **{summary['num_features']}** ({summary['applied']} applied, "
        f"{summary['failed']} failed, {summary['skipped']} skipped)",
        f"- Geometry valid: **{validation['valid']}**, fit score **{validation['fit_score']}**",
        f"- Volume: **{metrics.get('actual_volume_mm3', 0):,.1f} mm³**",
        f"- Bounding box: **{bbox.get('xlen', 0):.2f} × {bbox.get('ylen', 0):.2f} × "
        f"{bbox.get('zlen', 0):.2f} mm** (expected "
        f"{EXPECTED_BBOX['xlen']:.0f} × {EXPECTED_BBOX['ylen']:.0f} × "
        f"{EXPECTED_BBOX['zlen']:.0f} mm)",
        "",
        "## Stage 3 — Engineering drawings",
        "",
        f"- Views: **{', '.join(drawing_manifest['views'])}**",
        f"- Dimensions: **{drawing_manifest['dimension_count']}**",
        f"- Title block: {drawing_manifest['title_block']['component']} / "
        f"{drawing_manifest['title_block']['drawing_number']} / "
        f"rev {drawing_manifest['title_block']['revision']} / "
        f"scale {drawing_manifest['title_block']['scale']} / "
        f"units {drawing_manifest['title_block']['units']}",
        f"- Section labels: {[s['id'] for s in drawing_manifest['section_labels']]}",
        f"- Projection: {drawing_manifest['title_block']['projection_method']} "
        f"(right-side view left of front, top view below front)",
        f"- Rendered geometry per view (line counts): "
        f"{export_report['drawing']['checks'].get('layout', {}).get('view_geometry', {}).get('line_counts')}",
        f"- Layout checks: text collisions="
        f"{export_report['drawing']['checks'].get('layout', {}).get('text_collisions', {}).get('count')}, "
        f"view overlaps="
        f"{export_report['drawing']['checks'].get('layout', {}).get('view_overlaps', {}).get('count')}, "
        f"page overflow="
        f"{export_report['drawing']['checks'].get('layout', {}).get('page_overflow', {}).get('views')}, "
        f"title-block intersections="
        f"{export_report['drawing']['checks'].get('layout', {}).get('title_block_intersection', {}).get('views')}",
        f"- Unspecified GD&T / tolerances are explicitly marked as such.",
        f"- Dimension kinds are truthful: `RIB L=…` is a **linear** callout and "
        f"`… CHAMFER` is a **chamfer** callout (neither is mislabelled a diameter).",
        f"- Front-view feature leaders are routed as a single non-crossing fan on "
        f"the right; the overall vertical dimension sits on the left.",
        f"- The SECTION A-A cutting-plane line + endpoint arrows/labels are drawn "
        f"on the plan (top) view where the Y=0 plane is edge-on.",
        f"- DETAIL B carries a circled callout with its magnification and a "
        f"magnified clip centred on the flange/body junction.",
        f"- Vector SVG: `{os.path.basename(drawing_manifest['svg'])}` "
        f"({os.path.getsize(drawing_manifest['svg']) // 1024} KB)",
        f"- PDF: `{os.path.basename(drawing_manifest['pdf'])}` "
        f"({os.path.getsize(drawing_manifest['pdf']) // 1024} KB)",
        f"- Raster preview: `{os.path.basename(drawing_manifest['preview_png'])}`",
        "",
        "## Stage 4 — Export validation (re-imported, not assumed)",
        "",
        f"- STEP re-import: valid=**{export_report['step']['valid']}**, "
        f"solid count {step_checks['solid_count']['source']} → "
        f"{step_checks['solid_count']['reimported']}, "
        f"volume Δ {step_checks['volume'].get('relative_error', 0) * 100:.5f}%",
        f"- STL mesh: valid=**{export_report['stl']['valid']}**, "
        f"{stl_checks['watertight']['welded_vertices']} verts, "
        f"{stl_checks['watertight']['unique_edges']} edges, "
        f"watertight={stl_checks['watertight']['ok']}, "
        f"degenerate={stl_checks['degenerate_triangles']['count']}, "
        f"volume Δ {stl_checks['volume'].get('relative_error', 0) * 100:.4f}%",
        f"- Drawing validation: valid=**{export_report['drawing']['valid']}** "
        f"({len(drawing_manifest['views'])} views, "
        f"{drawing_manifest['dimension_count']} dimensions, units mm)",
        f"- Export manifest: **{len(manifest['files'])}** files with relative paths, "
        f"sizes and SHA-256; re-verified=**{manifest_check['valid']}** "
        f"({manifest_check['metrics'].get('verified')}/{manifest_check['metrics'].get('file_count')}).",
        "",
        "## Integration contract",
        "",
        "`integration_example_recipe.json` is a complete "
        "`reforge-cad-interface` v1.0 document that the Reconstruction Engine "
        "could emit. It carries a named dimension table with semantic units and "
        "truthful (`user_specified` / demo-fixture) provenance, plus the ordered "
        "feature list with an explicit `operation` on every feature. The "
        "validator rejects missing / unreliable dimensions with explicit "
        "diagnostics (see `tests/test_integration_contract.py`).",
        f"- Example validates: **{interface_check['valid']}** "
        f"({len(interface_doc['dimensions'])} dimensions, "
        f"{len(interface_doc['features'])} features)",
        "",
        "## Real Reconstruction → CAD round trip",
        "",
        "`reconstruction_to_cad_request.json` / `..._response.json` are the "
        "**actual** JSON documents produced by driving the real Reconstruction "
        "Engine (`solve_geometry` on a known cylinder r=25 / h=100 / bore 20) "
        "through `interface_from_solver_result` and "
        "`POST /cad/from-reconstruction`.",
        "",
        "The cylinder point cloud is a **deterministic synthetic fixture "
        "synthesised in-process; COLMAP was NOT run**. The solver's cylinder "
        "branch labels a point-cloud fit `COLMAP_RECONSTRUCTION` by default, so "
        "`record_fixture_source` re-labels it `SYNTHETIC_FIXTURE` and records "
        "`colmap_executed=false` in the solver result, the adapted interface "
        "document and the evidence below. The user-supplied bore keeps "
        "`USER_PROVIDED` provenance and the ESTIMATED (outer diameter / height) "
        "vs MEASURED (inner diameter) classification distinction is preserved.",
        "",
        f"- Solver status: **{recon['solver_status']}** "
        f"(scale `{recon['scale_classification']}`, units `{recon['units']}`)",
        f"- Input source: **synthetic fixture** (`colmap_executed=false`)",
        f"- Missing critical dimensions: {recon['missing_critical_dimensions']}",
        f"- Adapted interface valid: **{recon['interface_valid']}**",
        f"- Endpoint status: **{recon['endpoint_status']}**",
        f"- Re-imported STEP/STL exports valid: **{recon['export_valid']}** "
        f"(STEP volume Δ {(recon['step_volume_error'] or 0) * 100:.5f}%, "
        f"STL volume Δ {(recon['stl_volume_error'] or 0) * 100:.4f}%)",
        "",
        "## Files",
        "",
        "| File | Description |",
        "| --- | --- |",
        "| `housing_drawing.svg` / `.pdf` | Engineering drawing (Stage 3). |",
        "| `housing_drawing_preview.png` | Raster preview of the A3 sheet. |",
        "| `housing_isometric_hires.png` | High-resolution isometric preview. |",
        "| `housing_section_hires.png` | High-resolution section/cutaway preview. |",
        "| `housing.step` / `housing.stl` | STEP solid / STL mesh. |",
        "| `housing_recipe.json` | Source feature recipe (Phase 1). |",
        "| `housing_feature_history.json` | Full modelling history. |",
        "| `housing_validation_report.json` | Geometry validation report. |",
        "| `housing_drawing_manifest.json` | Drawing manifest (views/dims/title block). |",
        "| `housing_export_validation.json` | STEP/STL/drawing re-import validation. |",
        "| `housing_export_manifest.json` | Export manifest with relative paths + SHA-256. |",
        "| `housing_package_manifest.json` | Every packaged file (relative path + SHA-256). |",
        "| `integration_example_recipe.json` | Example Reconstruction→CAD interface. |",
        "| `integration_interface_schema.json` | JSON Schema for the contract. |",
        "| `reconstruction_solver_result.json` | Real `SolverResult` from `solve_geometry`. |",
        "| `reconstruction_to_cad_request.json` | Actual endpoint request (contract document). |",
        "| `reconstruction_to_cad_response.json` | Actual endpoint response (model + exports). |",
        "| `reconstruction_to_cad_export_validation.json` | STEP/STL re-import of the recon exports. |",
        "| `advanced-cad-phase2.zip` | ZIP deliverable (current run + current recon pair only). |",
        "",
        "All JSON manifests record **relative POSIX paths** (no absolute Windows "
        "paths); sizes and SHA-256 are read from the exact files on disk.",
        "",
        "## Reproduction",
        "",
        "```",
        "cd python-engine",
        "python cad/scripts/generate_advanced_cad_demo_phase2.py",
        "```",
        "",
    ]
    with open(os.path.join(ARTIFACT_DIR, "EVIDENCE.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report_lines))

    # ------------------------------------------------------------------
    # 8. ZIP deliverable — current run only (no stale Reconstruction runs)
    # ------------------------------------------------------------------
    zip_path = os.path.join(ARTIFACT_DIR, "advanced-cad-phase2.zip")
    zip_base = os.path.basename(zip_path)
    package_manifest_path = os.path.join(ARTIFACT_DIR,
                                         "housing_package_manifest.json")
    package_manifest_name = os.path.basename(package_manifest_path)

    # Package every *top-level* artefact of this run plus the *current*
    # Reconstruction→CAD STEP/STL pair.  Older runs left under
    # reconstruction_to_cad/ are deliberately not walked, so they never enter
    # the package (they are not deleted from disk either).
    packaged: List[str] = []
    for name in sorted(os.listdir(ARTIFACT_DIR)):
        full = os.path.join(ARTIFACT_DIR, name)
        if not os.path.isfile(full):
            continue
        if name in (zip_base, package_manifest_name):
            continue
        packaged.append(full)
    for extra_path in (recon.get("step_path"), recon.get("stl_path")):
        if extra_path and os.path.exists(extra_path) and extra_path not in packaged:
            packaged.append(extra_path)

    package_manifest = export_validation.build_package_manifest(
        packaged, ARTIFACT_DIR, package_name=zip_base,
        extra={
            "note": ("Lists every file in the ZIP except the package manifest "
                     "itself and the ZIP container. Contains only the current "
                     "run plus the current Reconstruction->CAD STEP/STL pair; "
                     "stale runs under reconstruction_to_cad/ are excluded."),
            "container": zip_base,
            "self": package_manifest_name,
        })
    package_check = export_validation.verify_export_manifest(
        package_manifest, base_dir=ARTIFACT_DIR)
    package_manifest["verification"] = {
        "valid": package_check["valid"],
        "verified": package_check["metrics"].get("verified"),
        "file_count": package_check["metrics"].get("file_count"),
    }
    _write_json(package_manifest_path, package_manifest)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for full in packaged:
            rel = os.path.relpath(full, ARTIFACT_DIR).replace("\\", "/")
            zf.write(full, arcname=rel)
        zf.write(package_manifest_path, arcname=package_manifest_name)
    print(f"[9/9] ZIP deliverable: {zip_base} "
          f"({os.path.getsize(zip_path) // 1024} KB); package manifest lists "
          f"{package_manifest['file_count']} files "
          f"(verified={package_check['valid']}) in {time.time() - t0:.1f}s.")

    ok = bool(validation["valid"] and export_report["valid"]
              and interface_check["valid"] and manifest_check["valid"]
              and package_check["valid"]
              and recon["endpoint_status"] == "success")
    print("\nDone." if ok else "\nCompleted WITH failures — see report.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
