"""
reconstruction_export.py — real B-Rep CAD export for ReForge AI.

The Export Center previously fabricated STEP/IGES text in the browser, which no
CAD kernel could read. This module builds the *same* component the interface
reconstructs (same recipe semantics as ``frontend/src/lib/recipe.js`` and the
same dimension fallbacks as ``frontend/src/lib/reconstruct.js``) as genuine
solids with CadQuery/OpenCASCADE, then exports interchange formats that
FreeCAD (also OpenCASCADE) imports as valid geometry.

CLI contract
------------
``python reconstruction_export.py`` reads one JSON object from stdin::

    {"analysis": {...}, "format": "step|iges|stl|obj", "outDir": "/tmp/...",
     "baseName": "spur-gear"}

and prints a single JSON line on stdout::

    {"ok": true, "format": "step", "path": "...", "bytes": 1234,
     "solids": 1, "valid": true, "warnings": []}

Failures print ``{"ok": false, "stage": "...", "error": "..."}`` and exit 1.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cadquery as cq

FORMATS = ("step", "iges", "stl", "obj")
STYLES = ("revolved", "extruded", "gear", "flange", "combination")
PRIMITIVE_KINDS = ("box", "cylinder", "sphere", "cone", "torus")
LIMITS = {
    "maxProfilePoints": 200,
    "maxOutlinePoints": 200,
    "maxHoles": 50,
    "maxPrimitives": 30,
}


class ExportError(Exception):
    """Raised when geometry or export fails; carries a stage for diagnostics."""

    def __init__(self, message: str, stage: str = "geometry"):
        super().__init__(message)
        self.message = message
        self.stage = stage


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _positive(value: Any) -> Optional[float]:
    f = _num(value)
    return f if f is not None and f > 0 else None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# Recipe sanitising (mirrors frontend/src/lib/recipe.js)
# ---------------------------------------------------------------------------


def _clean_recipe(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    recipe: Dict[str, Any] = {}
    recipe["style"] = raw.get("style") if raw.get("style") in STYLES else None

    profile = raw.get("revolvedProfile")
    if isinstance(profile, list):
        clean = []
        for pt in profile[: LIMITS["maxProfilePoints"]]:
            if not isinstance(pt, dict):
                continue
            z = _num(pt.get("z"))
            r = _num(pt.get("radius"))
            if z is None or r is None:
                continue
            clean.append({"z": z, "radius": max(0.0, r)})
        if len(clean) >= 2:
            clean.sort(key=lambda p: p["z"])
            recipe["revolvedProfile"] = clean

    outline = raw.get("outline")
    if isinstance(outline, list):
        clean_outline = []
        for pt in outline[: LIMITS["maxOutlinePoints"]]:
            if not isinstance(pt, dict):
                continue
            x = _num(pt.get("x"))
            y = _num(pt.get("y"))
            if x is None or y is None:
                continue
            clean_outline.append({"x": x, "y": y})
        if len(clean_outline) >= 3:
            recipe["outline"] = clean_outline

    holes = raw.get("holes")
    if isinstance(holes, list):
        clean_holes = []
        for h in holes[: LIMITS["maxHoles"]]:
            if not isinstance(h, dict):
                continue
            cx, cy, r = _num(h.get("cx")), _num(h.get("cy")), _num(h.get("radius"))
            if cx is None or cy is None or r is None or r <= 0:
                continue
            clean_holes.append({"cx": cx, "cy": cy, "radius": r})
        if clean_holes:
            recipe["holes"] = clean_holes

    depth = _positive(raw.get("depth"))
    if depth:
        recipe["depth"] = depth

    gear = raw.get("gear")
    if isinstance(gear, dict):
        clean_gear = {}
        for key in (
            "teeth",
            "module",
            "outerDiameter",
            "pressureAngle",
            "helixAngle",
            "faceWidth",
            "boreRadius",
            "coneAngle",
            "hubDiameter",
            "hubLength",
        ):
            value = _num(gear.get(key))
            if value is not None:
                clean_gear[key] = value
        if "teeth" in clean_gear:
            clean_gear["teeth"] = int(round(max(6.0, min(200.0, clean_gear["teeth"]))))
        if isinstance(gear.get("gearType"), str):
            clean_gear["gearType"] = gear["gearType"]
        if "spokes" in gear:
            spokes = _num(gear.get("spokes"))
            if spokes is not None:
                clean_gear["spokes"] = int(round(spokes))
        if clean_gear:
            recipe["gear"] = clean_gear

    flange = raw.get("flange")
    if isinstance(flange, dict):
        clean_flange = {}
        for key in (
            "outerDiameter",
            "innerDiameter",
            "thickness",
            "height",
            "boltCount",
            "boltCircleDiameter",
            "boltHoleDiameter",
            "bossDiameter",
            "bossHeight",
        ):
            value = _num(flange.get(key))
            if value is not None:
                clean_flange[key] = value
        if clean_flange:
            recipe["flange"] = clean_flange

    primitives = raw.get("primitives")
    if isinstance(primitives, list):
        clean_prims = []
        for p in primitives[: LIMITS["maxPrimitives"]]:
            if not isinstance(p, dict) or p.get("kind") not in PRIMITIVE_KINDS:
                continue
            item: Dict[str, Any] = {"kind": p["kind"]}
            for key in (
                "width",
                "height",
                "depth",
                "radius",
                "radiusTop",
                "radiusBottom",
                "tube",
            ):
                value = _num(p.get(key))
                if value is not None and value > 0:
                    item[key] = value
            pos = p.get("position") if isinstance(p.get("position"), dict) else {}
            rot = p.get("rotation") if isinstance(p.get("rotation"), dict) else {}
            item["position"] = {
                "x": _num(pos.get("x")) or 0.0,
                "y": _num(pos.get("y")) or 0.0,
                "z": _num(pos.get("z")) or 0.0,
            }
            item["rotation"] = {
                "x": _num(rot.get("x")) or 0.0,
                "y": _num(rot.get("y")) or 0.0,
                "z": _num(rot.get("z")) or 0.0,
            }
            clean_prims.append(item)
        if clean_prims:
            recipe["primitives"] = clean_prims

    if not recipe["style"]:
        if recipe.get("flange"):
            recipe["style"] = "flange"
        elif recipe.get("gear"):
            recipe["style"] = "gear"
        elif recipe.get("revolvedProfile"):
            recipe["style"] = "revolved"
        elif recipe.get("outline"):
            recipe["style"] = "extruded"
        elif recipe.get("primitives"):
            recipe["style"] = "combination"

    if not recipe["style"]:
        return None
    if not (
        recipe.get("revolvedProfile")
        or recipe.get("outline")
        or recipe.get("gear")
        or recipe.get("flange")
        or recipe.get("primitives")
    ):
        return None
    return recipe


def _dims(analysis: Dict[str, Any]) -> Dict[str, Optional[float]]:
    dims = analysis.get("dimensions") if isinstance(analysis.get("dimensions"), dict) else {}
    od = _positive(dims.get("outerDiameter"))
    idia = _positive(dims.get("innerDiameter"))
    height = _positive(dims.get("height"))
    thickness = _positive(dims.get("thickness"))
    length = _positive(dims.get("length"))
    width = _positive(dims.get("width"))
    return {
        "od": od,
        "id": idia,
        "h": height or thickness,
        "height": height,
        "thickness": thickness,
        "length": length,
        "width": width,
    }


# ---------------------------------------------------------------------------
# Shape helpers
# ---------------------------------------------------------------------------


def _union_all(shapes: Sequence[cq.Workplane]) -> cq.Workplane:
    """Union every body; keep disconnected bodies together as a compound."""
    bodies = [s for s in shapes if s is not None]
    if not bodies:
        raise ExportError("No geometry was produced.")
    merged = bodies[0]
    leftovers: List[Any] = []
    for shape in bodies[1:]:
        try:
            merged = merged.union(shape)
        except Exception:  # non-touching bodies cannot be unioned
            leftovers.append(shape.val())
    if leftovers:
        return cq.Workplane("XY").newObject(list(merged.solids().vals()) + leftovers)
    return merged


def _dedupe(points: Sequence[Tuple[float, float]], tol: float = 1e-9) -> List[Tuple[float, float]]:
    """Drop consecutive duplicate vertices — zero-length edges break extrusions."""
    clean: List[Tuple[float, float]] = []
    for x, y in points:
        if not clean or abs(x - clean[-1][0]) > tol or abs(y - clean[-1][1]) > tol:
            clean.append((x, y))
    while len(clean) > 1 and abs(clean[0][0] - clean[-1][0]) <= tol and abs(clean[0][1] - clean[-1][1]) <= tol:
        clean.pop()
    return clean


def _cut_cylinder(body: cq.Workplane, radius: float, z_min: float, z_max: float) -> cq.Workplane:
    cutter = (
        cq.Workplane("XY")
        .workplane(offset=z_min)
        .circle(radius)
        .extrude(max(1e-3, z_max - z_min))
    )
    return body.cut(cutter)


# ---------------------------------------------------------------------------
# Gear geometry
# ---------------------------------------------------------------------------


def _gear_profile(
    teeth: int, outer_r: float, tooth_height: float, pressure_angle_deg: float = 20.0
) -> List[Tuple[float, float]]:
    """Involute tooth profile — same construction as geo.js::gearShape."""
    z = max(4, int(round(teeth)))
    alpha = math.radians(pressure_angle_deg)
    ra = max(0.1, outer_r)
    m = (2 * ra) / (z + 2)
    rp = (z * m) / 2
    rb = rp * math.cos(alpha)
    th = tooth_height if tooth_height and tooth_height > 0 else 2.25 * m
    rf = max(0.01, min(ra - 0.01, ra - th))

    def involute_theta(r: float) -> float:
        if r <= rb:
            return 0.0
        cos_phi = max(-1.0, min(1.0, rb / r))
        phi = math.acos(cos_phi)
        return math.tan(phi) - phi

    inv_alpha = math.tan(alpha) - alpha
    inv_alpha_a = involute_theta(ra)
    half_pitch = math.pi / (2 * z)
    half_base = max(0.0, half_pitch + inv_alpha)

    points: List[Tuple[float, float]] = []
    samples = 3
    for i in range(z):
        center = (2 * math.pi * i) / z
        root_angle1 = center - math.pi / z
        points.append((rf * math.cos(root_angle1), rf * math.sin(root_angle1)))
        if rf < rb:
            theta_base1 = center - half_base
            points.append((rb * math.cos(theta_base1), rb * math.sin(theta_base1)))

        for s in range(1, samples + 1):
            frac = s / samples
            r = rb + (ra - rb) * frac
            theta = involute_theta(r)
            a = center - (half_base - theta)
            points.append((r * math.cos(a), r * math.sin(a)))

        a_tip_rising = center - (half_base - inv_alpha_a)
        a_tip_falling = center + (half_base - inv_alpha_a)
        points.append((ra * math.cos(a_tip_rising), ra * math.sin(a_tip_rising)))
        points.append((ra * math.cos(a_tip_falling), ra * math.sin(a_tip_falling)))

        for s in range(samples - 1, -1, -1):
            frac = s / samples
            r = rb + (ra - rb) * frac
            theta = involute_theta(r)
            a = center + (half_base - theta)
            points.append((r * math.cos(a), r * math.sin(a)))

        if rf < rb:
            root_angle2 = center + half_base
            points.append((rf * math.cos(root_angle2), rf * math.sin(root_angle2)))
    return _dedupe(points)


def _tooth_extrusion(points: List[Tuple[float, float]], height: float) -> cq.Workplane:
    clean = _dedupe(points)
    if len(clean) < 3:
        raise ExportError("The gear profile is degenerate.", stage="geometry")
    return cq.Workplane("XY").polyline(clean).close().extrude(height)


def _twisted_tooth_extrusion(
    points: List[Tuple[float, float]], height: float, twist_rad: float, sections: int = 16
) -> cq.Workplane:
    wires = []
    for i in range(sections):
        z = height * i / (sections - 1)
        angle = twist_rad * i / (sections - 1)
        ca, sa = math.cos(angle), math.sin(angle)
        rotated = [(x * ca - y * sa, x * sa + y * ca) for (x, y) in points]
        wires.append(cq.Wire.makePolygon([cq.Vector(x, y, z) for (x, y) in rotated], close=True))
    solid = cq.Solid.makeLoft(wires, False)
    return cq.Workplane("XY").newObject([solid])


def _gear_solid(gear: Dict[str, Any], analysis: Dict[str, Any]) -> cq.Workplane:
    dims = _dims(analysis)
    teeth = int(round(_num(gear.get("teeth")) or _num(analysis.get("teeth")) or 16))
    teeth = max(6, min(200, teeth))

    module = _positive(gear.get("module"))
    outer_diameter = _positive(gear.get("outerDiameter"))
    if module is None and dims["od"]:
        module = dims["od"] / (teeth + 2)
    if module is None and outer_diameter:
        module = outer_diameter / (teeth + 2)
    if module is None:
        module = 2.0

    if outer_diameter:
        outer_r = outer_diameter / 2
    else:
        outer_r = (teeth * module) / 2 + module
    face_width = _positive(gear.get("faceWidth")) or dims["h"] or outer_r * 0.45
    bore = _positive(gear.get("boreRadius"))
    if bore is None:
        bore = (dims["id"] / 2) if dims["id"] else 0.0
    bore = min(bore or 0.0, outer_r * 0.9)

    tooth_h = 2.25 * module
    pressure = _num(gear.get("pressureAngle")) or 20.0
    helix = _clamp(_num(gear.get("helixAngle")) or 0.0, -60.0, 60.0)
    gear_type = str(
        gear.get("gearType")
        or analysis.get("gearType")
        or ("bevel" if (gear.get("coneAngle") or analysis.get("coneAngle")) else "spur")
    ).lower()

    if gear_type == "bevel":
        return _bevel_gear_solid(
            teeth=teeth,
            outer_r=outer_r,
            module=module,
            face_width=face_width,
            bore=bore,
            cone_angle=_num(gear.get("coneAngle")) or _num(analysis.get("coneAngle")) or 45.0,
        )
    if gear_type == "worm":
        return _worm_solid(
            module=module,
            face_width=face_width,
            bore=bore,
            outer_r=outer_r,
        )

    points = _gear_profile(teeth, outer_r, tooth_h, pressure)
    if abs(helix) > 0.01:
        pitch_r = max(1e-6, outer_r * 0.9)
        twist = (face_width * math.tan(math.radians(helix))) / pitch_r
        body = _twisted_tooth_extrusion(points, face_width, twist)
    else:
        body = _tooth_extrusion(points, face_width)

    hub_r = _positive(gear.get("hubDiameter"))
    hub_r = (hub_r / 2) if hub_r else bore * 1.65
    hub_h = _positive(gear.get("hubLength")) or face_width * 0.28
    total_h = face_width

    if hub_r > bore + 1e-6 and hub_h > 1e-6:
        hubs = [
            cq.Workplane("XY").workplane(offset=z0).circle(hub_r).extrude(hub_h)
            for z0 in (-hub_h, face_width)
        ]
        body = _union_all([body] + hubs)  # type: ignore[list-item]
        total_h = face_width + 2 * hub_h

    if bore > 1e-6:
        body = _cut_cylinder(body, bore, -hub_h - 1.0, total_h + 1.0)
    return body.translate((0, 0, -total_h / 2))


def _bevel_gear_solid(
    teeth: int,
    outer_r: float,
    module: float,
    face_width: float,
    bore: float,
    cone_angle: float,
) -> cq.Workplane:
    gamma = math.radians(_clamp(cone_angle, 5.0, 85.0))
    height = max(1e-3, face_width * math.cos(gamma))
    delta_r = face_width * math.sin(gamma)
    front_r = max(bore * 1.12, outer_r - delta_r)
    front_r = min(front_r, outer_r - 1e-3)

    blank = cq.Workplane("XY").add(
        cq.Solid.makeCone(front_r, outer_r, height, cq.Vector(0, 0, 0), cq.Vector(0, 0, 1))
    )

    tooth_h_back = 2.25 * module
    tooth_h_front = tooth_h_back * (front_r / outer_r)
    half_back = ((math.pi * outer_r) / teeth) * 0.28
    half_front = half_back * (front_r / outer_r)

    bodies: List[cq.Workplane] = [blank]
    for i in range(teeth):
        a = (i / teeth) * math.pi * 2
        ca, sa = math.cos(a), math.sin(a)
        px, py = -sa, ca

        def quad(radius_base: float, radius_top: float, half: float, z: float) -> List[cq.Vector]:
            return [
                cq.Vector(ca * radius_base - px * half, sa * radius_base - py * half, z),
                cq.Vector(ca * radius_base + px * half, sa * radius_base + py * half, z),
                cq.Vector(ca * radius_top + px * half * 0.5, sa * radius_top + py * half * 0.5, z),
                cq.Vector(ca * radius_top - px * half * 0.5, sa * radius_top - py * half * 0.5, z),
            ]

        back = cq.Wire.makePolygon(
            quad(outer_r - tooth_h_back * 0.3, outer_r + tooth_h_back * 0.7, half_back, 0.0),
            close=True,
        )
        front = cq.Wire.makePolygon(
            quad(
                front_r - tooth_h_front * 0.3,
                front_r + tooth_h_front * 0.7,
                half_front,
                height,
            ),
            close=True,
        )
        try:
            bodies.append(cq.Workplane("XY").newObject([cq.Solid.makeLoft([back, front], False)]))
        except Exception:
            continue

    hub_r = outer_r * 0.6
    hub_h = height * 0.9
    if hub_r > bore:
        bodies.append(
            cq.Workplane("XY")
            .workplane(offset=-hub_h)
            .circle(hub_r)
            .extrude(hub_h)
        )

    body = _union_all(bodies)
    total_h = height + hub_h
    if bore > 1e-6:
        body = _cut_cylinder(body, bore, -hub_h - 1.0, height + 1.0)
    return body.translate((0, 0, -total_h / 2 + hub_h / 2))


def _worm_solid(module: float, face_width: float, bore: float, outer_r: float) -> cq.Workplane:
    shaft_r = max(module, outer_r * 0.35)
    length = _positive(face_width) or outer_r * 1.2
    body = cq.Workplane("XY").circle(shaft_r).extrude(length)
    starts = 1

    pitch = max(1e-3, math.pi * module)
    thread_r = max(1e-3, module * 0.35)
    helix_r = shaft_r + thread_r * 0.3
    for _ in range(starts):
        try:
            helix = cq.Wire.makeHelix(pitch, length, helix_r)
            profile = cq.Workplane("XZ").center(helix_r, 0).circle(thread_r).wire().val()
            thread_solid = cq.Solid.sweep(profile, [], helix, True, False)
            body = body.union(cq.Workplane("XY").newObject([thread_solid]))
        except Exception:
            continue

    if bore > 1e-6:
        body = _cut_cylinder(body, bore, -1.0, length + 1.0)
    return body.translate((0, 0, -length / 2))


# ---------------------------------------------------------------------------
# Flange / revolved / extruded / combination
# ---------------------------------------------------------------------------


def _flange_solid(recipe: Dict[str, Any], analysis: Dict[str, Any]) -> cq.Workplane:
    fl = recipe.get("flange") or {}
    dims = _dims(analysis)

    od = _positive(fl.get("outerDiameter")) or dims["od"] or 120.0
    inner_d = _positive(fl.get("innerDiameter")) or dims["id"] or 35.0
    thickness = (
        _positive(fl.get("thickness"))
        or _positive(recipe.get("depth"))
        or dims["thickness"]
        or 18.0
    )
    height = _positive(fl.get("height")) or dims["h"] or thickness * 1.5

    outer_r = od / 2
    bore_r = min(inner_d / 2, outer_r * 0.95)

    bolts: List[Tuple[float, float, float]] = []
    holes = recipe.get("holes") or []
    off_axis = [
        h for h in holes if abs(h.get("cx", 0)) > 1e-6 or abs(h.get("cy", 0)) > 1e-6
    ]
    if off_axis:
        bolts = [(h["cx"], h["cy"], h["radius"]) for h in off_axis]
    else:
        count = int(round(_num(fl.get("boltCount")) or _num(analysis.get("boltCount")) or 4))
        count = int(_clamp(count, 3, 64))
        bcd = _positive(fl.get("boltCircleDiameter")) or od * 0.76
        hole_d = _positive(fl.get("boltHoleDiameter")) or max(4.0, od * 0.11)
        for i in range(count):
            a = (i / count) * math.pi * 2
            bolts.append((math.cos(a) * bcd / 2, math.sin(a) * bcd / 2, hole_d / 2))

    base = cq.Workplane("XY").circle(outer_r)
    if bore_r > 1e-6:
        base = base.circle(bore_r)
    base = base.extrude(thickness)
    for (x, y, r) in bolts:
        if r <= 0:
            continue
        base = base.faces(">Z").workplane().pushPoints([(x, y)]).circle(r).cutThruAll()

    boss_r = (_positive(fl.get("bossDiameter")) or od * 0.60) / 2
    boss_h = _positive(fl.get("bossHeight")) or max(2.0, height - thickness)
    if boss_r > bore_r + 1e-6 and boss_h > 1e-6:
        boss_wp = cq.Workplane("XY").circle(boss_r)
        if bore_r > 1e-6:
            boss_wp = boss_wp.circle(bore_r)
        boss = boss_wp.extrude(boss_h).translate((0, 0, thickness))
        try:
            base = base.union(boss)
        except Exception:
            base = _union_all([base, boss])
    return base.translate((0, 0, -(thickness / 2)))


def _revolved_solid(recipe: Dict[str, Any]) -> cq.Workplane:
    profile = recipe.get("revolvedProfile") or []
    if len(profile) < 2:
        raise ExportError("A revolved profile needs at least two points.", stage="geometry")

    z_min = profile[0]["z"]
    z_max = profile[-1]["z"]
    pts: List[Tuple[float, float]] = [(0.0, z_min)]
    for pt in profile:
        r = float(pt["radius"])
        z = float(pt["z"])
        if abs(r) < 1e-9 and (abs(z - z_min) < 1e-9 or abs(z - z_max) < 1e-9):
            continue
        pts.append((r, z))
    if abs(pts[-1][0]) > 1e-9:
        pts.append((0.0, z_max))
    if len({(round(x, 9), round(y, 9)) for (x, y) in pts}) < 3:
        raise ExportError(
            "The revolved profile is degenerate (no usable area).", stage="geometry"
        )

    return (
        cq.Workplane("XZ")
        .polyline(pts)
        .close()
        .revolve(360, (0.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    )


def _extruded_solid(recipe: Dict[str, Any], analysis: Dict[str, Any]) -> cq.Workplane:
    outline = recipe.get("outline") or []
    if len(outline) < 3:
        raise ExportError("An extruded outline needs at least three points.", stage="geometry")
    dims = _dims(analysis)
    depth = _positive(recipe.get("depth")) or dims["thickness"] or dims["h"]
    if not depth:
        raise ExportError("An extruded solid needs a positive depth.", stage="geometry")

    pts = _dedupe([(float(pt["x"]), float(pt["y"])) for pt in outline])
    if len(pts) < 3:
        raise ExportError("The extruded outline is degenerate.", stage="geometry")
    body = cq.Workplane("XY").polyline(pts).close().extrude(depth)
    for hole in recipe.get("holes") or []:
        try:
            body = (
                body.faces(">Z")
                .workplane()
                .pushPoints([(hole["cx"], hole["cy"])])
                .circle(hole["radius"])
                .cutThruAll()
            )
        except Exception as exc:  # pragma: no cover - defensive
            raise ExportError(f"Hole could not be cut: {exc}", stage="geometry") from exc
    return body.translate((0, 0, -depth / 2))


def _combination_solid(recipe: Dict[str, Any]) -> cq.Workplane:
    bodies: List[cq.Workplane] = []
    for prim in recipe.get("primitives") or []:
        kind = prim["kind"]
        pos = prim.get("position") or {}
        rot = prim.get("rotation") or {}
        if kind == "box":
            shape = cq.Workplane("XY").box(
                prim.get("width", 10.0), prim.get("height", 10.0), prim.get("depth", 10.0)
            )
        elif kind == "cylinder":
            shape = cq.Workplane("XY").cylinder(
                prim.get("height", 10.0), prim.get("radius", 5.0)
            )
        elif kind == "sphere":
            shape = cq.Workplane("XY").sphere(prim.get("radius", 5.0))
        elif kind == "cone":
            shape = cq.Workplane("XY").add(
                cq.Solid.makeCone(
                    prim.get("radiusBottom", prim.get("radius", 10.0)),
                    prim.get("radiusTop", 0.0),
                    prim.get("height", 20.0),
                )
            )
        elif kind == "torus":
            shape = cq.Workplane("XY").add(
                cq.Solid.makeTorus(prim.get("radius", 20.0), prim.get("tube", 5.0))
            )
        else:
            continue

        if rot.get("x"):
            shape = shape.rotate((0, 0, 0), (1, 0, 0), rot["x"])
        if rot.get("y"):
            shape = shape.rotate((0, 0, 0), (0, 1, 0), rot["y"])
        if rot.get("z"):
            shape = shape.rotate((0, 0, 0), (0, 0, 1), rot["z"])
        shape = shape.translate((pos.get("x", 0.0), pos.get("y", 0.0), pos.get("z", 0.0)))
        bodies.append(shape)

    if not bodies:
        raise ExportError("No usable primitives were provided.", stage="geometry")
    return _union_all(bodies)


# ---------------------------------------------------------------------------
# Dimension fallback (mirrors the reconstruct.js builders when no recipe exists)
# ---------------------------------------------------------------------------


def _component_type(analysis: Dict[str, Any]) -> str:
    raw = str(analysis.get("componentType") or "other").lower()
    features = " ".join(str(f) for f in (analysis.get("features") or [])).lower()
    gear_type = str(
        analysis.get("gearType")
        or (analysis.get("geometryRecipe") or {}).get("gear", {}).get("gearType")
        or ""
    ).lower()
    if "bevel" in raw or gear_type == "bevel" or "bevel" in features:
        return "bevel gear"
    if "worm" in raw or gear_type == "worm":
        return "worm gear"
    if "helical" in raw or gear_type == "helical":
        return "helical gear"
    if "gear" in raw or _positive(analysis.get("teeth")) or "gear" in features:
        return "spur gear"
    if "flange" in raw or "flange" in features:
        return "flange"
    if "bearing" in raw:
        return "bearing"
    if "bracket" in raw:
        return "bracket"
    if "shaft" in raw or "cylinder" in raw:
        return "cylinder"
    return "other"


def _fallback_solid(analysis: Dict[str, Any]) -> cq.Workplane:
    dims = _dims(analysis)
    kind = _component_type(analysis)

    if kind in ("bevel gear", "spur gear", "helical gear", "worm gear"):
        gear = {
            "teeth": analysis.get("teeth") or 20,
            "module": analysis.get("module"),
            "helixAngle": analysis.get("helixAngle") or (20 if kind == "helical gear" else 0),
            "gearType": "bevel" if kind == "bevel gear" else ("worm" if kind == "worm gear" else "spur"),
            "coneAngle": analysis.get("coneAngle") or 45,
            "faceWidth": dims["h"],
            "boreRadius": (dims["id"] / 2) if dims["id"] else None,
        }
        return _gear_solid({k: v for k, v in gear.items() if v is not None}, analysis)

    if kind == "flange":
        return _flange_solid({}, analysis)

    if kind == "bearing":
        outer_r = (dims["od"] or 80.0) / 2
        bore_r = (dims["id"] / 2) if dims["id"] else outer_r * 0.55
        width = dims["thickness"] or dims["h"] or outer_r * 0.7
        mid_r = (outer_r + bore_r) / 2
        ball_r = max(0.5, (outer_r - bore_r) / 4)
        outer_ring = cq.Workplane("XY").circle(outer_r).circle(mid_r + ball_r).extrude(width)
        inner_ring = cq.Workplane("XY").circle(mid_r - ball_r).circle(bore_r).extrude(width)
        bodies: List[cq.Workplane] = [outer_ring, inner_ring]
        balls = 10
        for i in range(balls):
            a = (i / balls) * math.pi * 2
            bodies.append(
                cq.Workplane("XY")
                .sphere(ball_r)
                .translate((math.cos(a) * mid_r, math.sin(a) * mid_r, width / 2))
            )
        return _union_all(bodies).translate((0, 0, -width / 2))

    if kind == "bracket":
        width = dims["width"] or 60.0
        height = dims["height"] or 60.0
        length = dims["length"] or dims["thickness"] or 20.0
        t = min(dims["thickness"] or 6.0, min(width, height) / 2)
        vertical = cq.Workplane("XY").box(t, height, length).translate((0, height / 2, 0))
        horizontal = cq.Workplane("XY").box(width, t, length).translate((0, t / 2, 0))
        return _union_all([vertical, horizontal])

    if kind == "cylinder":
        outer_r = (dims["od"] or 40.0) / 2
        bore_r = (dims["id"] / 2) if dims["id"] else 0.0
        height = dims["height"] or dims["length"] or dims["h"] or outer_r * 3
        body = cq.Workplane("XY").circle(outer_r)
        if bore_r > 0:
            body = body.circle(bore_r)
        return body.extrude(height).translate((0, 0, -height / 2))

    # Generic fallback: a plate with the measured envelope.
    width = dims["width"] or dims["od"] or 60.0
    height = dims["height"] or dims["h"] or 60.0
    depth = dims["thickness"] or dims["length"] or 20.0
    return cq.Workplane("XY").box(width, height, depth)


def build_shape(analysis: Dict[str, Any]) -> Tuple[cq.Workplane, str]:
    """Build the reconstructed component as a solid; returns (workplane, style)."""
    if not isinstance(analysis, dict):
        raise ExportError("analysis must be an object.", stage="input")

    recipe = _clean_recipe((analysis or {}).get("geometryRecipe"))
    if recipe:
        style = recipe["style"]
        try:
            if style == "gear" or recipe.get("gear"):
                return _gear_solid(recipe.get("gear") or {}, analysis), "gear"
            if style == "flange" or recipe.get("flange"):
                return _flange_solid(recipe, analysis), "flange"
            if style == "revolved":
                return _revolved_solid(recipe), "revolved"
            if style == "extruded":
                return _extruded_solid(recipe, analysis), "extruded"
            if style == "combination":
                return _combination_solid(recipe), "combination"
        except ExportError:
            raise
        except Exception as exc:
            # Fall through to the dimension fallback rather than failing outright.
            fallback_reason = f"recipe geometry failed ({exc}); used dimension fallback"
            shape = _fallback_solid(analysis)
            return shape, f"fallback:{fallback_reason}"

    return _fallback_solid(analysis), "fallback"


# ---------------------------------------------------------------------------
# Exporters
# ---------------------------------------------------------------------------


def _write_iges(shape: cq.Workplane, path: str) -> None:
    from OCP.IGESControl import IGESControl_Writer

    writer = IGESControl_Writer("MM", 0)
    writer.AddShape(shape.val().wrapped)
    writer.ComputeModel()
    if not writer.Write(path):
        raise ExportError("OpenCASCADE IGES writer failed.", stage="export")


def _write_obj(shape: cq.Workplane, path: str) -> None:
    vertices, triangles = shape.val().tessellate(0.2, 0.25)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("# ReForge AI reconstructed component — Wavefront OBJ\n")
        handle.write("# units: millimetres\n")
        handle.write("o reforge_component\n")
        for v in vertices:
            handle.write(f"v {v.x:.6f} {v.y:.6f} {v.z:.6f}\n")
        for (a, b, c) in triangles:
            handle.write(f"f {a + 1} {b + 1} {c + 1}\n")


def export_model(payload: Dict[str, Any]) -> Dict[str, Any]:
    analysis = payload.get("analysis")
    fmt = str(payload.get("format") or "step").lower()
    if fmt not in FORMATS:
        raise ExportError(f"Unsupported format '{fmt}'.", stage="input")

    out_dir = payload.get("outDir")
    if not out_dir:
        raise ExportError("outDir is required.", stage="input")
    os.makedirs(out_dir, exist_ok=True)

    base_name = str(payload.get("baseName") or "reforge-component")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in base_name).strip("-")
    safe = safe or "reforge-component"

    shape, style = build_shape(analysis if isinstance(analysis, dict) else {})

    solid = shape.val()
    if solid is None:
        raise ExportError("Geometry build produced no shape.", stage="geometry")
    if not solid.isValid():
        raise ExportError(
            "The generated solid failed the OpenCASCADE validity check.", stage="geometry"
        )

    path = os.path.join(out_dir, f"{safe}.{fmt}")
    if fmt == "step":
        cq.exporters.export(shape, path)
    elif fmt == "stl":
        cq.exporters.export(shape, path, tolerance=0.1, angularTolerance=0.2)
    elif fmt == "iges":
        _write_iges(shape, path)
    elif fmt == "obj":
        _write_obj(shape, path)

    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise ExportError("Export produced a missing or empty file.", stage="export")

    return {
        "ok": True,
        "format": fmt,
        "path": os.path.abspath(path),
        "bytes": os.path.getsize(path),
        "solids": len(shape.solids().vals()),
        "valid": True,
        "style": style,
        "baseName": safe,
    }


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        result = export_model(payload)
    except ExportError as exc:
        print(json.dumps({"ok": False, "stage": exc.stage, "error": exc.message}))
        return 1
    except Exception as exc:  # pragma: no cover - unexpected failure path
        print(json.dumps({"ok": False, "stage": "unexpected", "error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
