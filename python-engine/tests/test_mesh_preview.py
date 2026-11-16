"""Tests for the JSON mesh preview exporter (no cadquery required)."""

import json
import math

import pytest

from exports.mesh_preview import (
    MeshPreviewError,
    export_mesh_preview,
    _bbox_from_vertices,
)


class _Vector:
    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z


class _Box:
    xmin, ymin, zmin = -1.0, -2.0, -3.0
    xmax, ymax, zmax = 1.0, 2.0, 3.0
    xlen, ylen, zlen = 2.0, 4.0, 6.0


class _Edge:
    def __init__(self, length=10.0):
        self._length = length

    def Length(self):
        return self._length

    def positionAt(self, t):
        return _Vector(t * 10.0, 0.0, 0.0)


class _Solid:
    def __init__(self):
        self.calls = []

    def tessellate(self, tolerance, angular_tolerance):
        self.calls.append((tolerance, angular_tolerance))
        vertices = [
            _Vector(0.0, 0.0, 0.0),
            _Vector(1.0, 0.0, 0.0),
            _Vector(0.0, 1.0, 0.0),
        ]
        return vertices, [(0, 1, 2)]

    def Edges(self):
        return [_Edge(10.0)]

    def BoundingBox(self):
        return _Box()

    def Volume(self):
        return 12.5


class _Workplane:
    def __init__(self, solid):
        self._solid = solid

    def solids(self):
        return self

    def vals(self):
        return [self._solid]


def test_export_mesh_preview_writes_expected_json(tmp_path):
    solid = _Solid()
    path = tmp_path / "part.mesh.json"
    result = export_mesh_preview(_Workplane(solid), str(path))

    assert result == str(path.resolve())
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["units"] == "mm"
    assert payload["vertices"] == [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    assert payload["triangles"] == [0, 1, 2]
    assert payload["edges"]
    assert payload["edges"][0][:3] == [0.0, 0.0, 0.0]
    assert payload["bbox"]["xlen"] == 2.0
    assert payload["volume"] == 12.5
    assert payload["solidCount"] == 1


def test_export_mesh_preview_rejects_none(tmp_path):
    with pytest.raises(MeshPreviewError):
        export_mesh_preview(None, str(tmp_path / "x.mesh.json"))


def test_bbox_from_vertices():
    bbox = _bbox_from_vertices([-2, -4, -6, 2, 4, 6])
    assert bbox == {
        "xmin": -2.0,
        "xmax": 2.0,
        "ymin": -4.0,
        "ymax": 4.0,
        "zmin": -6.0,
        "zmax": 6.0,
        "xlen": 4.0,
        "ylen": 8.0,
        "zlen": 12.0,
    }


def test_export_mesh_preview_coarsens_when_triangle_budget_exceeded(tmp_path, monkeypatch):
    import exports.mesh_preview as mesh_preview

    monkeypatch.setattr(mesh_preview, "MAX_TRIANGLES", 0)
    solid = _Solid()
    with pytest.raises(MeshPreviewError):
        export_mesh_preview(_Workplane(solid), str(tmp_path / "x.mesh.json"))
    assert len(solid.calls) == 3
    assert solid.calls[0][0] < solid.calls[-1][0]
    assert math.isclose(solid.calls[-1][0], solid.calls[0][0] * 4)
