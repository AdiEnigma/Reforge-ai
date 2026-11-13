"""
test_engineering_drawing.py — Tests for Stage 3 engineering drawing generation.

Covers real hidden-line-removal projection, section cut polygons, drawing-spec
assembly from the validated housing recipe, and SVG/PDF sheet rendering with
views, dimensions, title block and units.
"""

from __future__ import annotations

import os

import pytest
import cadquery as cq

from cad import engineering_drawing as ed
from cad import advanced_preview
from cad.feature_modeller import model_feature_recipe
from cad.advanced_cad_validator import validate_feature_geometry
from cad.specimens.advanced_housing import build_advanced_housing_recipe


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

def _box():
    return cq.Workplane("XY").box(40, 30, 20)


def test_project_front_bounds_match_model():
    pv = ed.project(_box(), "front")
    minx, miny, maxx, maxy = pv.bounds
    assert minx == pytest.approx(-20.0, abs=0.5)
    assert maxx == pytest.approx(20.0, abs=0.5)
    assert miny == pytest.approx(-10.0, abs=0.5)   # model Z maps to 2D Y
    assert maxy == pytest.approx(10.0, abs=0.5)
    assert pv.visible, "front projection produced no visible edges"


def test_project_top_bounds_match_model():
    pv = ed.project(_box(), "top")
    minx, miny, maxx, maxy = pv.bounds
    assert minx == pytest.approx(-20.0, abs=0.5)
    assert maxx == pytest.approx(20.0, abs=0.5)
    assert miny == pytest.approx(-15.0, abs=0.5)
    assert maxy == pytest.approx(15.0, abs=0.5)


def test_project_isometric_nonempty():
    pv = ed.project(_box(), "isometric")
    assert pv.visible
    assert len(pv.all_polylines()) > 0


# ---------------------------------------------------------------------------
# Section polygons
# ---------------------------------------------------------------------------

def test_section_cut_polygons_on_cut_face():
    body = cq.Workplane("XY").box(20, 20, 20)
    half = body.cut(cq.Workplane("XY").box(20, 10, 20).translate((0, -5, 0)))
    polys = ed.section_cut_polygons(half.val(), axis="y", at=0.0)
    assert polys, "no cut-face polygons found on the y=0 section"
    assert all(len(p) >= 3 for p in polys)


def test_section_cut_polygons_empty_when_no_face():
    # A solid box has no planar face on the y=0 plane.
    polys = ed.section_cut_polygons(_box().val(), axis="y", at=0.0)
    assert polys == []


# ---------------------------------------------------------------------------
# Scale helper
# ---------------------------------------------------------------------------

def test_nice_scale_is_standard_and_fits():
    for size, target in [(50, 150), (160, 150), (600, 150)]:
        s = ed._nice_scale(size, target)
        assert s in (5.0, 2.0, 1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01)
        # The chosen scale must not overflow the target by more than 2 %.
        assert size * s <= target * 1.02


# ---------------------------------------------------------------------------
# Spec assembly from real recipe data
# ---------------------------------------------------------------------------

def test_build_housing_drawing_spec_uses_real_dimensions():
    recipe = build_advanced_housing_recipe()
    metrics = {
        "actual_bbox": {"xlen": 160.0, "ylen": 160.0, "zlen": 90.0,
                        "xmin": -80.0, "xmax": 80.0, "ymin": -80.0, "ymax": 80.0,
                        "zmin": 0.0, "zmax": 90.0},
        "actual_volume_mm3": 701034.0,
    }
    spec = ed.build_housing_drawing_spec(recipe, metrics)
    names = {v.name for v in spec.views}
    assert {"FRONT", "TOP", "RIGHT", "ISO", "SECTION A-A", "DETAIL B"} <= names
    assert spec.title_block.units == "mm"
    assert spec.title_block.drawing_number == "RF-ADV-HOUSING-001"
    assert spec.title_block.component == "ADVANCED MECHANICAL HOUSING"
    assert len(spec.dimensions) >= 10
    texts = " ".join(d.text for d in spec.dimensions)
    assert "\u00d8160" in texts          # flange diameter from real data
    assert "\u00d890" in texts           # body diameter
    # Unspecified information must be explicitly marked, never invented.
    assert spec.title_block.material == "NOT SPECIFIED"
    assert spec.title_block.general_tolerance == "NOT SPECIFIED"
    assert any(not f.get("specified", False) for f in spec.gdt_frames)


def _housing_metrics():
    return {
        "actual_bbox": {"xlen": 160.0, "ylen": 160.0, "zlen": 90.0,
                        "xmin": -80.0, "xmax": 80.0, "ymin": -80.0, "ymax": 80.0,
                        "zmin": 0.0, "zmax": 90.0},
        "actual_volume_mm3": 701034.0,
    }


def test_first_angle_layout_places_right_left_of_front_and_top_below():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    by_name = {v.name: v for v in spec.views}
    assert spec.title_block.projection_method == "FIRST ANGLE"
    front, right, top = by_name["FRONT"], by_name["RIGHT"], by_name["TOP"]
    # First angle: right-side view sits to the LEFT of the front view.
    assert right.center[0] < front.center[0]
    assert right.projection == "right"
    # First angle: top view sits BELOW the front view.
    assert top.center[1] < front.center[1]
    assert top.projection == "top"


def test_detail_view_is_real_magnified_clip_of_front():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    by_name = {v.name: v for v in spec.views}
    detail = by_name["DETAIL B"]
    assert detail.is_detail
    assert detail.detail_id == "B"
    assert detail.detail_source == "FRONT"
    assert detail.clip is not None
    x0, y0, x1, y1 = detail.clip
    assert x1 > x0 and y1 > y0
    # Magnified relative to its parent view.
    assert detail.scale > by_name["FRONT"].scale
    # Detail / isometric views carry no centre lines.
    assert detail.show_centrelines is False
    assert by_name["ISO"].show_centrelines is False


def test_feature_dimensions_are_drawn():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    texts = " ".join(d.text for d in spec.dimensions)
    # Boss / port / rib / bore / fillet / chamfer / passage callouts.
    assert "BOSS" in texts
    assert "B.C." in texts
    assert "45\u00b0" in texts and "120\u00b0" in texts
    assert "RIB" in texts
    assert "CAVITY DEEP" in texts
    assert "STEP DEEP" in texts
    assert "FILLET" in texts
    assert "CHAMFER" in texts
    views_used = {d.view for d in spec.dimensions}
    assert {"FRONT", "TOP", "RIGHT"} <= views_used


# ---------------------------------------------------------------------------
# Clipping primitives (used for real detail views + centre-line clipping)
# ---------------------------------------------------------------------------

def test_clip_segment_liang_barsky():
    rect = (0.0, 0.0, 10.0, 10.0)
    assert ed._clip_segment((-5.0, 5.0), (15.0, 5.0), rect) == ((0.0, 5.0), (10.0, 5.0))
    assert ed._clip_segment((2.0, 2.0), (8.0, 8.0), rect) == ((2.0, 2.0), (8.0, 8.0))
    assert ed._clip_segment((20.0, 20.0), (30.0, 30.0), rect) is None


def test_clip_polyline_returns_clipped_points():
    rect = (0.0, 0.0, 10.0, 10.0)
    out = ed._clip_polyline([(-5.0, 5.0), (5.0, 5.0), (15.0, 5.0)], rect)
    assert out is not None
    assert out[0] == (0.0, 5.0)
    assert out[-1] == (10.0, 5.0)
    assert ed._clip_polyline([(20.0, 20.0), (30.0, 30.0)], rect) is None


# ---------------------------------------------------------------------------
# Sheet rendering (SVG + PDF)
# ---------------------------------------------------------------------------

def test_render_sheet_writes_svg_and_pdf(tmp_path):
    box = _box()
    spec = ed.DrawingSpec(
        title_block=ed.TitleBlock(component="TEST PART",
                                  drawing_number="RF-TEST-001", units="mm"),
        views=[
            ed.ViewPlacement("FRONT", "front", (70.0, 90.0), 1.0, label="FRONT VIEW"),
            ed.ViewPlacement("TOP", "top", (70.0, 180.0), 1.0, label="TOP VIEW"),
        ],
        dimensions=[
            ed.Dimension("linear", "FRONT", 40.0, "40.00",
                         (-20.0, -10.0), (20.0, -10.0), offset=-8.0),
        ],
    )
    projected = {v.name: ed.project(box, v.projection, name=v.name) for v in spec.views}
    svg = str(tmp_path / "sheet.svg")
    pdf = str(tmp_path / "sheet.pdf")
    png = str(tmp_path / "sheet.png")
    written = ed.render_sheet(spec, projected=projected, out_svg=svg, out_pdf=pdf,
                              out_png=png)

    assert os.path.getsize(written["svg"]) > 1000
    assert os.path.getsize(written["pdf"]) > 1000
    assert os.path.getsize(written["png"]) > 1000
    with open(svg, encoding="utf-8") as fh:
        text = fh.read()
    assert "FRONT VIEW" in text
    assert "TOP VIEW" in text
    assert "40.00" in text
    assert "TEST PART" in text
    assert "mm" in text
    with open(pdf, "rb") as fh:
        assert fh.read(5) == b"%PDF-"

    # The renderer returns a structured layout map with real geometry counts.
    layout = written["layout"]
    assert layout["views"]["FRONT"]["line_count"] > 0
    assert layout["views"]["TOP"]["line_count"] > 0
    assert layout["inner_border"] and layout["title_block"]
    assert isinstance(layout["text_boxes"], list)


# ---------------------------------------------------------------------------
# End-to-end drawing from the real validated housing model
# ---------------------------------------------------------------------------

def test_generate_housing_drawings_from_real_model(tmp_path):
    recipe = build_advanced_housing_recipe()
    workplane, history = model_feature_recipe(recipe)
    validation = validate_feature_geometry(workplane, recipe, history)
    assert validation["valid"]

    section = advanced_preview.make_half_section(workplane, axis="y", keep="positive")
    manifest = ed.generate_engineering_drawings(
        workplane, recipe, validation["metrics"], str(tmp_path), "housing",
        section_shape=section.val())

    assert manifest["svg"] and os.path.getsize(manifest["svg"]) > 5000
    assert manifest["pdf"] and os.path.getsize(manifest["pdf"]) > 3000
    assert manifest["preview_png"] and os.path.getsize(manifest["preview_png"]) > 3000
    assert manifest["dimension_count"] >= 10
    assert {"FRONT", "TOP", "RIGHT", "ISO", "SECTION A-A", "DETAIL B"} <= set(manifest["views"])

    with open(manifest["svg"], encoding="utf-8") as fh:
        svg = fh.read()
    for token in ["FRONT VIEW", "TOP VIEW", "RIGHT SIDE VIEW", "ISOMETRIC",
                  "SECTION A-A", "DETAIL B", "\u00d8160", "\u00d890", "mm",
                  "ADVANCED MECHANICAL HOUSING"]:
        assert token in svg, f"missing drawing token: {token!r}"

    # Every declared view must render real geometry — including DETAIL B, which
    # previously passed on its label alone.
    layout = manifest["layout"]
    for name, vinfo in layout["views"].items():
        assert vinfo["line_count"] > 0, f"view {name} rendered no geometry"
    assert layout["views"]["DETAIL B"]["line_count"] > 0
    assert manifest["detail_markers"], "detail source marker not drawn"
    assert manifest["detail_markers"][0]["source_view"] == "FRONT"

    # FIRST ANGLE consistency in the rendered layout.
    centers = {n: v["center"] for n, v in layout["views"].items()}
    assert centers["RIGHT"][0] < centers["FRONT"][0]
    assert centers["TOP"][1] < centers["FRONT"][1]
    assert layout["projection_method"] == "FIRST ANGLE"


# ---------------------------------------------------------------------------
# Dimension semantics + leader routing (drawing-correction review)
# ---------------------------------------------------------------------------

def _segments_cross(p1, p2, p3, p4) -> bool:
    """True when open segments p1p2 and p3p4 properly intersect.

    Endpoints are *not* counted as crossings (no two leaders share a point).
    """
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1 = orient(p3, p4, p1)
    d2 = orient(p3, p4, p2)
    d3 = orient(p1, p2, p3)
    d4 = orient(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def test_rib_and_chamfer_dimension_kinds_are_truthful():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    rib = [d for d in spec.dimensions if d.text.startswith("RIB")]
    assert rib, "no rib callout found"
    # A rib length is a linear size, never a diameter.
    assert all(d.kind == "linear" for d in rib)

    cham = [d for d in spec.dimensions if "CHAMFER" in d.text]
    assert cham, "no chamfer callout found"
    # A chamfer callout is its own semantic kind, never a diameter.
    assert all(d.kind == "chamfer" for d in cham)


def test_front_view_feature_leaders_do_not_cross():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    front = [d for d in spec.dimensions
             if d.view == "FRONT" and d.leader_to is not None]
    assert len(front) >= 8, "expected the full front-view feature fan"

    # Every front leader is routed to the right of the geometry.
    for d in front:
        assert d.leader_to[0] > d.a[0]
        assert d.leader_side == "right"

    segs = [(d.a, d.leader_to) for d in front]
    for i in range(len(segs)):
        for j in range(i + 1, len(segs)):
            assert not _segments_cross(segs[i][0], segs[i][1],
                                       segs[j][0], segs[j][1]), \
                f"front leaders cross: {segs[i]} vs {segs[j]}"

    # Monotonic fan: the label vertical order matches the anchor vertical order.
    ordered = sorted(front, key=lambda d: d.a[1])
    label_ys = [d.leader_to[1] for d in ordered]
    assert label_ys == sorted(label_ys)


def test_front_overall_vertical_dimension_placed_left():
    spec = ed.build_housing_drawing_spec(build_advanced_housing_recipe(),
                                         _housing_metrics())
    front_linear = [d for d in spec.dimensions
                    if d.view == "FRONT" and d.kind == "linear" and d.b is not None]
    vertical = [d for d in front_linear if d.a[0] == d.b[0]]
    horizontal = [d for d in front_linear if d.a[1] == d.b[1]]
    assert vertical and horizontal
    # Positive offset for a vertical linear dim places the dimension line on the
    # LEFT; the horizontal overall stays below (negative offset).
    assert vertical[0].offset > 0
    assert horizontal[0].offset < 0


def test_section_cutting_plane_marker_is_on_edge_on_view(tmp_path):
    recipe = build_advanced_housing_recipe()
    workplane, history = model_feature_recipe(recipe)
    validation = validate_feature_geometry(workplane, recipe, history)
    section = advanced_preview.make_half_section(workplane, axis="y", keep="positive")
    manifest = ed.generate_engineering_drawings(
        workplane, recipe, validation["metrics"], str(tmp_path), "housing",
        section_shape=section.val())

    assert manifest["section_markers"], "cutting-plane marker not recorded"
    marker = manifest["section_markers"][0]
    # The Y=0 cutting plane is edge-on in the plan (top) view, so the marker is
    # drawn there rather than floating on the section view itself.
    assert marker["source_view"] == "TOP"
    assert marker["section_view"] == "SECTION A-A"
    (x0, y0), (x1, y1) = marker["line"]
    assert x1 > x0
    assert y0 == pytest.approx(y1), "edge-on plane should project to a line"
    # Direction of sight is perpendicular to the cutting line in this view.
    sx, sy = marker["sight_2d"]
    assert sy != 0.0

    # DETAIL B carries a circled callout with its stated magnification, and its
    # magnified clip is centred on the flange/body junction, not empty space.
    assert manifest["detail_markers"]
    dmarker = manifest["detail_markers"][0]
    bx, by, radius = dmarker["callout"]
    assert radius > 0.0
    assert dmarker["scale_text"], "detail callout must state its magnification"
    assert dmarker["scale_text"].endswith("x")
    dx0, dy0, dx1, dy1 = dmarker["clip"]
    assert dx1 > dx0 and dy1 > dy0
