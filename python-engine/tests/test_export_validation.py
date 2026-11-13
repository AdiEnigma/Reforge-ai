"""
test_export_validation.py — Tests for Stage 4 export validation.

Verifies that STEP and STL exports are validated by re-import (solid count,
validity, volume, bounding box, mesh watertightness, degenerate triangles,
normals) and that drawings are validated for views / dimensions / units /
tolerances.  Also checks that missing or broken exports fail loudly.
"""

from __future__ import annotations

import os

import numpy as np
import pytest
import cadquery as cq

from cad import export_validation as ev


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _part():
    return (cq.Workplane("XY").box(30, 20, 10)
            .faces(">Z").workplane().hole(6))


def _export_all(tmp_path):
    wp = _part()
    step = str(tmp_path / "part.step")
    stl = str(tmp_path / "part.stl")
    cq.exporters.export(wp, step, cq.exporters.ExportTypes.STEP)
    cq.exporters.export(wp, stl, cq.exporters.ExportTypes.STL)
    return wp, step, stl


def _ascii_stl(tris, path):
    lines = ["solid test"]
    for tri in tris:
        lines.append("  facet normal 0 0 1")
        lines.append("    outer loop")
        for v in tri:
            lines.append(f"      vertex {v[0]} {v[1]} {v[2]}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid test")
    with open(path, "w", encoding="ascii") as fh:
        fh.write("\n".join(lines))
    return path


# ---------------------------------------------------------------------------
# STEP
# ---------------------------------------------------------------------------

def test_step_reimport_valid(tmp_path):
    wp, step, _ = _export_all(tmp_path)
    res = ev.validate_step_export(step, wp)
    assert res["valid"]
    checks = res["checks"]
    assert checks["solid_count"]["ok"]
    assert checks["reimported_valid"]
    assert checks["volume"]["relative_error"] < 1e-6
    assert checks["bbox"]["ok"]


def test_step_missing_file_fails(tmp_path):
    res = ev.validate_step_export(str(tmp_path / "nope.step"), _part())
    assert not res["valid"]
    assert res["issues"]


# ---------------------------------------------------------------------------
# STL
# ---------------------------------------------------------------------------

def test_stl_reimport_valid_and_watertight(tmp_path):
    wp, _, stl = _export_all(tmp_path)
    res = ev.validate_stl_export(stl, wp)
    assert res["valid"], res["issues"]
    checks = res["checks"]
    assert checks["finite_vertices"]["ok"]
    assert checks["degenerate_triangles"]["count"] == 0
    assert checks["normals"]["ok"]
    assert checks["watertight"]["ok"]
    assert checks["volume"]["relative_error"] < 0.05


def test_stl_truncated_fails(tmp_path):
    _, _, stl = _export_all(tmp_path)
    with open(stl, "rb") as fh:
        data = fh.read()
    broken = str(tmp_path / "broken.stl")
    with open(broken, "wb") as fh:
        fh.write(data[: len(data) // 2])
    res = ev.validate_stl_export(broken, _part())
    assert not res["valid"]
    assert res["issues"]


def test_stl_degenerate_triangle_detected(tmp_path):
    # One zero-area triangle.
    path = _ascii_stl([[(0, 0, 0), (0, 0, 0), (1, 1, 1)]], str(tmp_path / "deg.stl"))
    res = ev.validate_stl_export(path, _part())
    assert res["checks"]["degenerate_triangles"]["count"] >= 1
    assert not res["valid"]


def test_stl_non_watertight_detected(tmp_path):
    # A single (non-degenerate) triangle is an open, non-watertight surface.
    path = _ascii_stl([[(0, 0, 0), (10, 0, 0), (0, 10, 0)]], str(tmp_path / "open.stl"))
    res = ev.validate_stl_export(path, _part())
    assert res["checks"]["watertight"]["ok"] is False
    assert not res["valid"]


def test_parse_stl_reports_binary_and_triangle_count(tmp_path):
    _, _, stl = _export_all(tmp_path)
    parsed = ev.parse_stl(stl)
    assert parsed["num_triangles"] > 0
    assert isinstance(parsed["binary"], bool)


# ---------------------------------------------------------------------------
# Drawings
# ---------------------------------------------------------------------------

def _fake_drawing(tmp_path, views, dims, svg_extra=""):
    svg = str(tmp_path / "d.svg")
    pdf = str(tmp_path / "d.pdf")
    text = " ".join(views) + " " + " ".join(d["text"] for d in dims) + " mm " + svg_extra
    with open(svg, "w", encoding="utf-8") as fh:
        fh.write(f"<svg><text>{text}</text></svg>")
    with open(pdf, "wb") as fh:
        fh.write(b"%PDF-1.7 fake")
    manifest = {"views": views, "dimensions": dims}
    return svg, pdf, manifest


def test_drawing_validation_ok(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": None}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW", "TOP VIEW"], dims)
    res = ev.validate_drawing_export(svg, pdf, man,
                                     required_views=["FRONT VIEW", "TOP VIEW"])
    assert res["valid"], res["issues"]


def test_drawing_missing_view_fails(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": None}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW"], dims)
    res = ev.validate_drawing_export(svg, pdf, man,
                                     required_views=["FRONT VIEW", "TOP VIEW"])
    assert not res["valid"]
    assert "TOP VIEW" in res["checks"]["views"]["missing"]


def test_drawing_missing_dimension_fails(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": None}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW"], [])  # dim not in svg
    man["dimensions"] = dims
    res = ev.validate_drawing_export(svg, pdf, man)
    assert not res["valid"]
    assert res["checks"]["dimensions"]["missing_from_svg"] == ["40.00"]


def test_drawing_tolerance_preserved(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": "0.1"}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW"], dims,
                                  svg_extra="40.00 \u00b10.1")
    res = ev.validate_drawing_export(svg, pdf, man)
    assert res["checks"]["tolerances"]["ok"]


def test_drawing_empty_svg_fails(tmp_path):
    svg = str(tmp_path / "empty.svg")
    open(svg, "w").close()
    pdf = str(tmp_path / "d.pdf")
    with open(pdf, "wb") as fh:
        fh.write(b"%PDF-1.7")
    res = ev.validate_drawing_export(svg, pdf, {"views": [], "dimensions": []})
    assert not res["valid"]


# ---------------------------------------------------------------------------
# Combined + manifest
# ---------------------------------------------------------------------------

def test_validate_exports_combined(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    res = ev.validate_exports(step, stl, wp)
    assert res["valid"]
    assert res["step"]["valid"] and res["stl"]["valid"]


def test_build_export_manifest_records_files(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    validation = ev.validate_exports(step, stl, wp)
    man = ev.build_export_manifest({"step": step, "stl": stl, "missing": None}, validation)
    assert man["files"]["step"]["exists"]
    assert len(man["files"]["step"]["sha256"]) == 64
    assert man["files"]["missing"]["exists"] is False
    assert man["validation_summary"]["valid"] is True


# ---------------------------------------------------------------------------
# Drawing layout geometry / collision checks (Priority 4)
# ---------------------------------------------------------------------------

def _good_layout():
    return {
        "sheet_size": [420.0, 297.0],
        "inner_border": [10.0, 10.0, 410.0, 287.0],
        "title_block": [280.0, 6.0, 410.0, 68.0],
        "projection_method": "FIRST ANGLE",
        "views": {
            "FRONT": {"projection": "front", "center": [205.0, 225.0],
                      "extent": [155.0, 185.0, 255.0, 265.0], "line_count": 120},
            "RIGHT": {"projection": "right", "center": [95.0, 225.0],
                      "extent": [55.0, 185.0, 135.0, 265.0], "line_count": 90},
            "TOP": {"projection": "top", "center": [205.0, 118.0],
                    "extent": [155.0, 80.0, 255.0, 156.0], "line_count": 80},
            "DETAIL B": {"projection": "front", "center": [330.0, 118.0],
                         "extent": [305.0, 93.0, 355.0, 143.0], "line_count": 42},
        },
        "text_boxes": [
            {"text": "FRONT VIEW", "kind": "view_label",
             "box": [195.0, 178.0, 215.0, 183.0]},
            {"text": "RIGHT SIDE VIEW", "kind": "view_label",
             "box": [75.0, 178.0, 115.0, 183.0]},
        ],
    }


def test_layout_valid_passes():
    res = ev.validate_drawing_layout(_good_layout())
    assert res["valid"], res["issues"]
    assert res["checks"]["view_geometry"]["ok"]
    assert res["checks"]["projection_consistency"]["ok"]


def test_layout_empty_view_fails():
    layout = _good_layout()
    layout["views"]["DETAIL B"]["line_count"] = 0
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert "DETAIL B" in res["checks"]["view_geometry"]["empty_views"]
    assert any("no geometry" in i for i in res["issues"])


def test_layout_text_collision_detected():
    layout = _good_layout()
    layout["text_boxes"].append(
        {"text": "OVERLAP", "kind": "dimension",
         "box": [195.0, 179.0, 215.0, 183.0]})
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert res["checks"]["text_collisions"]["count"] >= 1


def test_layout_view_overlap_detected():
    layout = _good_layout()
    layout["views"]["RIGHT"]["extent"] = [150.0, 185.0, 230.0, 265.0]
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert res["checks"]["view_overlaps"]["count"] >= 1


def test_layout_page_overflow_detected():
    layout = _good_layout()
    layout["views"]["FRONT"]["extent"] = [400.0, 185.0, 470.0, 265.0]
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert "FRONT" in res["checks"]["page_overflow"]["views"]


def test_layout_title_block_intersection_detected():
    layout = _good_layout()
    layout["views"]["TOP"]["extent"] = [290.0, 40.0, 360.0, 90.0]
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert "TOP" in res["checks"]["title_block_intersection"]["views"]


def test_layout_first_angle_projection_inconsistency_detected():
    layout = _good_layout()
    # Move the right-side view to the *right* of the front view (third angle).
    layout["views"]["RIGHT"]["center"] = [340.0, 225.0]
    res = ev.validate_drawing_layout(layout)
    assert not res["valid"]
    assert res["checks"]["projection_consistency"]["ok"] is False
    assert any("FIRST ANGLE" in n
               for n in res["checks"]["projection_consistency"]["notes"])


def test_drawing_export_reports_layout_when_present(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": None}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW"], dims)
    man["layout"] = _good_layout()
    res = ev.validate_drawing_export(svg, pdf, man,
                                     required_views=["FRONT VIEW"])
    assert "layout" in res["checks"]
    assert res["checks"]["layout"]["view_geometry"]["ok"]


def test_drawing_export_preview_missing_fails(tmp_path):
    dims = [{"kind": "linear", "text": "40.00", "tolerance": None}]
    svg, pdf, man = _fake_drawing(tmp_path, ["FRONT VIEW"], dims)
    res = ev.validate_drawing_export(svg, pdf, man, required_views=["FRONT VIEW"],
                                     preview_path=str(tmp_path / "nope.png"))
    assert not res["valid"]
    assert res["checks"]["preview"]["ok"] is False


# ---------------------------------------------------------------------------
# Manifest relative paths + verification (Priority 6)
# ---------------------------------------------------------------------------

def test_manifest_relative_paths_and_verification(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    man = ev.build_export_manifest({"step": step, "stl": stl}, base_dir=str(tmp_path))
    # No absolute / backslash paths in the recorded manifest.
    for entry in man["files"].values():
        assert ":" not in entry["path"]
        assert "\\" not in entry["path"]
    assert man["files"]["step"]["path"] == "part.step"
    res = ev.verify_export_manifest(man, base_dir=str(tmp_path))
    assert res["valid"], res["issues"]
    assert res["metrics"]["verified"] == 2


def test_manifest_verification_detects_tampering(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    man = ev.build_export_manifest({"stl": stl}, base_dir=str(tmp_path))
    with open(stl, "ab") as fh:
        fh.write(b"# tampered")
    res = ev.verify_export_manifest(man, base_dir=str(tmp_path))
    assert not res["valid"]
    assert any("mismatch" in i for i in res["issues"])


def test_manifest_verification_detects_missing_file(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    man = ev.build_export_manifest({"stl": stl}, base_dir=str(tmp_path))
    os.remove(stl)
    res = ev.verify_export_manifest(man, base_dir=str(tmp_path))
    assert not res["valid"]
    assert any("missing" in i for i in res["issues"])


# ---------------------------------------------------------------------------
# Portable paths + package manifest (drawing-correction review)
# ---------------------------------------------------------------------------

def test_to_portable_paths_rewrites_absolute_paths(tmp_path):
    base = str(tmp_path)
    obj = {
        "svg": os.path.join(base, "housing_drawing.svg"),
        "nested": [os.path.join(base, "sub", "part.stl")],
        "count": 3,
        "note": "no path here",
        "none": None,
    }
    out = ev.to_portable_paths(obj, base)
    assert out["svg"] == "housing_drawing.svg"
    assert out["nested"][0] == "sub/part.stl"
    # Non-path values are untouched.
    assert out["count"] == 3
    assert out["note"] == "no path here"
    assert out["none"] is None
    # No absolute Windows path (drive letter or backslash) survives.
    for value in (out["svg"], out["nested"][0]):
        assert ":" not in value and "\\" not in value


def test_to_portable_paths_leaves_outside_paths_alone(tmp_path):
    base = str(tmp_path)
    outside = os.path.abspath(os.sep)          # e.g. C:\
    out = ev.to_portable_paths({"p": outside}, base)
    # A path that does not live under base_dir is not silently mangled.
    assert out["p"] == outside


def test_build_package_manifest_lists_files_with_hash(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    man = ev.build_package_manifest([step, stl], str(tmp_path),
                                    package_name="pkg.zip",
                                    extra={"container": "pkg.zip"})
    assert man["format"] == "reforge-package-manifest"
    assert man["file_count"] == 2
    assert man["package"] == "pkg.zip"
    assert man["container"] == "pkg.zip"
    assert set(man["files"]) == {"part.step", "part.stl"}
    for rel, entry in man["files"].items():
        assert ":" not in rel and "\\" not in rel
        assert entry["path"] == rel
        assert entry["exists"]
        assert entry["size_bytes"] > 0
        assert len(entry["sha256"]) == 64
    res = ev.verify_export_manifest(man, base_dir=str(tmp_path))
    assert res["valid"], res["issues"]
    assert res["metrics"]["verified"] == 2


def test_package_manifest_records_missing_file(tmp_path):
    wp, step, stl = _export_all(tmp_path)
    missing = str(tmp_path / "gone.stl")
    man = ev.build_package_manifest([step, missing], str(tmp_path))
    assert man["files"]["gone.stl"]["exists"] is False
    assert "sha256" not in man["files"]["gone.stl"]
