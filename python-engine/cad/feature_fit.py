"""Analytic feature-level fit and honest build status for the measurement pipeline.

This module compares the *modelled geometry* against the *synthesised feature
recipe* (which itself is derived from scaled measurement evidence).  It is a
dimensional-agreement metric, not a photograph/reference-model fit and not a
completion claim.  Four independent statuses are reported:

* geometry validity (OpenCASCADE / bbox / feature accounting)
* reconstruction completeness (evidence + expected feature presence)
* dimensional accuracy (analytic per-feature agreement)
* manufacturing readiness (critical unknowns / assumed values / export gate)
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder

FEATURE_FIT_VERSION = "1.0"
ASSESSMENT_VERSION = "1.0"

_CENTRAL_RATIO = 0.03
_AXIS_Z_TOLERANCE = 0.98
_CRITICAL_PARAMETERS = (
    "outer_diameter",
    "thickness",
    "bore_diameter",
    "hole_count",
    "bolt_circle_diameter",
    "hole_diameter",
)


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _distance(x0: float, y0: float, x1: float, y1: float) -> float:
    return math.hypot(x1 - x0, y1 - y0)


def _reciprocal_error(actual: float, expected: float, scale: float) -> float:
    if expected == 0:
        return 0.0 if actual == 0 else 1.0
    return min(1.0, abs(actual - expected) / max(scale, 1e-9))


def _score_from_error(error: float, tolerance: float) -> float:
    if tolerance <= 0:
        return 1.0 if error <= 0 else 0.0
    return max(0.0, min(1.0, 1.0 - error / tolerance))


def _solids(workplane: Any) -> List[Any]:
    try:
        solids = workplane.solids().vals()
    except Exception:  # noqa: BLE001 - non-workplane shapes are handled below
        solids = []
    if solids:
        return solids
    try:
        value = workplane.val()
        return [value] if value is not None else []
    except Exception:  # noqa: BLE001
        return []


def extract_cylindrical_faces(workplane: Any) -> List[Dict[str, Any]]:
    """Return axis-aligned cylindrical faces as radius / centre / z-span."""
    faces: List[Dict[str, Any]] = []
    for solid in _solids(workplane):
        try:
            solid_faces = solid.Faces()
        except Exception:  # noqa: BLE001
            continue
        for face in solid_faces:
            if face.geomType() != "CYLINDER":
                continue
            try:
                surface = BRepAdaptor_Surface(face.wrapped)
                if surface.GetType() != GeomAbs_Cylinder:
                    continue
                cylinder = surface.Cylinder()
                axis = cylinder.Axis()
                direction = axis.Direction()
                if abs(direction.Z()) < _AXIS_Z_TOLERANCE:
                    continue
                location = axis.Location()
                bbox = face.BoundingBox()
                faces.append({
                    "radius": float(cylinder.Radius()),
                    "x": float(location.X()),
                    "y": float(location.Y()),
                    "z_min": float(bbox.zmin),
                    "z_max": float(bbox.zmax),
                })
            except Exception:  # noqa: BLE001 - ignore malformed faces
                continue

    merged: Dict[Tuple[float, float, float], Dict[str, Any]] = {}
    for face in faces:
        key = (_round(face["radius"], 3), _round(face["x"], 2), _round(face["y"], 2))
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(face)
        else:
            existing["z_min"] = min(existing["z_min"], face["z_min"])
            existing["z_max"] = max(existing["z_max"], face["z_max"])
    return sorted(merged.values(), key=lambda item: item["radius"], reverse=True)


def _feature_parameters(feature: Any) -> Dict[str, Any]:
    if isinstance(feature, dict):
        return feature.get("parameters", {}) or {}
    return getattr(feature, "parameters", {}) or {}


def _feature_type(feature: Any) -> str:
    if isinstance(feature, dict):
        return str(feature.get("type", ""))
    return str(getattr(feature, "type", ""))


def _feature_id(feature: Any) -> str:
    if isinstance(feature, dict):
        return str(feature.get("id", ""))
    return str(getattr(feature, "id", ""))


def _features(recipe: Dict[str, Any]) -> List[Any]:
    return list((recipe or {}).get("features", []) or [])


def _outline_bbox(outline: Iterable[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    points = [(float(p.get("x", 0.0)), float(p.get("y", 0.0))) for p in outline]
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {
        "width": max(xs) - min(xs),
        "height": max(ys) - min(ys),
        "center_x": (max(xs) + min(xs)) / 2.0,
        "center_y": (max(ys) + min(ys)) / 2.0,
    }


def expected_features(recipe: Dict[str, Any], scale: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Derive the expected analytic features from a synthesised recipe."""
    outer_radius = None
    outer_kind = "circular"
    outer_bbox = None
    profile_radii: List[float] = []
    bore: Optional[Dict[str, Any]] = None
    pattern: Optional[Dict[str, Any]] = None
    holes: List[Dict[str, Any]] = []
    height = None

    for feature in _features(recipe):
        ftype = _feature_type(feature)
        params = _feature_parameters(feature)
        fid = _feature_id(feature)

        if ftype == "base_cylinder":
            outer_radius = float(params.get("radius", 0.0)) or outer_radius
            z0 = params.get("zStart")
            z1 = params.get("zEnd")
            if z0 is not None and z1 is not None:
                height = abs(float(z1) - float(z0))
        elif ftype == "revolve_profile":
            profile = params.get("profile") or []
            all_radii = [float(point.get("radius", 0.0)) for point in profile]
            if all_radii:
                outer_radius = max(all_radii)
                profile_radii = sorted({
                    radius for radius in all_radii
                    if radius < outer_radius * 0.999
                })
                z_values = [float(point.get("z", 0.0)) for point in profile]
                height = max(z_values) - min(z_values)
        elif ftype == "extrude_profile":
            outline_bbox = _outline_bbox(params.get("outline") or [])
            if outline_bbox:
                outer_kind = "polygonal"
                outer_bbox = outline_bbox
                outer_radius = max(outline_bbox["width"], outline_bbox["height"]) / 2.0
            height = float(params.get("depth", 0.0)) or height

        elif ftype == "bolt_circle":
            pattern = {
                "feature_id": fid,
                "count": int(params.get("count", 0)),
                "bolt_circle_radius": float(params.get("boltCircleRadius", 0.0)),
                "hole_radius": float(params.get("holeDiameter", 0.0)) / 2.0,
                "start_angle_deg": float(params.get("startAngleDeg", 0.0)),
            }
        elif ftype in ("through_bore", "blind_bore", "stepped_bore", "counterbore"):
            center = params.get("center") or {}
            cx = float(center.get("x", 0.0))
            cy = float(center.get("y", 0.0))
            if ftype in ("stepped_bore", "counterbore") and params.get("diameters"):
                diameters = params.get("diameters") or []
            else:
                diameters = [params.get("diameter", 0.0)]
            for index, diameter in enumerate(diameters):
                radius = float(diameter) / 2.0
                if radius <= 0:
                    continue
                entry = {
                    "feature_id": f"{fid}_{index}" if len(diameters) > 1 else fid,
                    "x": cx,
                    "y": cy,
                    "radius": radius,
                }
                central_norm = math.hypot(cx, cy)
                if bore is None and (
                    central_norm <= _CENTRAL_RATIO * max(outer_radius or 1.0, 1e-9)
                ):
                    bore = entry
                elif central_norm <= _CENTRAL_RATIO * max(outer_radius or 1.0, 1e-9):
                    profile_radii.append(radius)
                else:
                    holes.append(entry)

    if outer_radius is None:
        outer_radius = float((scale or {}).get("outer_radius", 0.0)) or None

    return {
        "outer_kind": outer_kind,
        "outer_radius": outer_radius,
        "outer_bbox": outer_bbox,
        "height": height,
        "profile_radii": sorted({_round(value) for value in profile_radii}),
        "bore": bore,
        "pattern": pattern,
        "holes": holes,
    }


def _expected_pattern_positions(pattern: Dict[str, Any]) -> List[Dict[str, float]]:
    count = max(int(pattern.get("count", 0)), 0)
    if count == 0:
        return []
    bcr = float(pattern.get("bolt_circle_radius", 0.0))
    start = math.radians(float(pattern.get("start_angle_deg", 0.0)))
    positions = []
    for index in range(count):
        angle = start + 2.0 * math.pi * index / count
        positions.append({
            "x": bcr * math.cos(angle),
            "y": bcr * math.sin(angle),
            "angle_deg": math.degrees(angle) % 360.0,
        })
    return positions


def _match_hole(
    target: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    center_tolerance: float,
) -> Optional[Dict[str, Any]]:
    best = None
    best_distance = None
    for candidate in candidates:
        distance = _distance(target["x"], target["y"], candidate["x"], candidate["y"])
        if distance <= center_tolerance and (best_distance is None or distance < best_distance):
            best = candidate
            best_distance = distance
    return best


def _angle_error(a: float, b: float) -> float:
    diff = abs((a - b + 180.0) % 360.0 - 180.0)
    return diff


def compare_features(
    workplane: Any,
    recipe: Dict[str, Any],
    scale: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare modelled geometry against the recipe it was built from."""
    expected = expected_features(recipe, scale)
    cylinders = extract_cylindrical_faces(workplane)
    issues: List[str] = []
    missing: List[Dict[str, Any]] = []
    unexpected: List[Dict[str, Any]] = []
    components: Dict[str, float] = {}
    details: Dict[str, Any] = {}

    outer_radius_expected = expected["outer_radius"]
    outer_radius_actual = cylinders[0]["radius"] if cylinders else None

    if expected["outer_kind"] == "polygonal":
        bbox = None
        solids = _solids(workplane)
        if solids:
            try:
                raw = solids[0].BoundingBox()
                bbox = {
                    "width": float(raw.xlen),
                    "height": float(raw.ylen),
                    "thickness": float(raw.zlen),
                }
            except Exception:  # noqa: BLE001
                bbox = None
        expected_bbox = expected["outer_bbox"] or {}
        width_error = _reciprocal_error(
            (bbox or {}).get("width", 0.0),
            expected_bbox.get("width", 0.0),
            max(expected_bbox.get("width", 0.0), 1e-9),
        )
        height_error = _reciprocal_error(
            (bbox or {}).get("height", 0.0),
            expected_bbox.get("height", 0.0),
            max(expected_bbox.get("height", 0.0), 1e-9),
        )
        thickness_error = _reciprocal_error(
            (bbox or {}).get("thickness", 0.0),
            expected.get("height") or 0.0,
            max(expected.get("height") or 1.0, 1e-9),
        )
        outer_score = max(
            0.0,
            min(
                1.0,
                1.0 - max(width_error, height_error) / 0.05 - min(thickness_error, 0.5) * 0.2,
            ),
        )
        details["outer"] = {
            "kind": "polygonal",
            "expected_bbox": expected_bbox,
            "actual_bbox": bbox,
            "relative_errors": {
                "width": _round(width_error),
                "height": _round(height_error),
                "thickness": _round(thickness_error),
            },
            "score": _round(outer_score),
        }
        if width_error > 0.05 or height_error > 0.05:
            issues.append("Extruded outline dimensions deviate from the synthesised outline.")
        outer_scale = expected_bbox.get("width", 1.0) or 1.0
    else:
        if outer_radius_expected and outer_radius_actual:
            outer_error = _reciprocal_error(
                outer_radius_actual, outer_radius_expected, outer_radius_expected
            )
        else:
            outer_error = 1.0
        outer_score = _score_from_error(outer_error, 0.05)
        details["outer"] = {
            "kind": "circular",
            "expected_radius": _round(outer_radius_expected or 0.0),
            "actual_radius": _round(outer_radius_actual or 0.0),
            "relative_error": _round(outer_error),
            "score": _round(outer_score),
        }
        if outer_error > 0.05:
            issues.append("Outer radius deviates from the synthesised profile/cylinder.")
        outer_scale = outer_radius_expected or 1.0

    components["outer"] = outer_score

    reference_outer_radius = (
        outer_radius_actual
        if expected["outer_kind"] == "circular"
        else outer_radius_expected
    )
    inner = [
        face for face in cylinders
        if reference_outer_radius is None
        or face["radius"] < max(reference_outer_radius * 0.95, 1e-9)
    ]

    bore_expected = expected["bore"]
    bore_actual = None
    if bore_expected:
        center_tolerance = max(0.02 * outer_scale, 1.5 * bore_expected["radius"])
        bore_actual = _match_hole(bore_expected, inner, center_tolerance)
        if bore_actual is None:
            bore_score = 0.0
            missing.append({"feature_id": bore_expected["feature_id"], "type": "bore"})
            issues.append("Central bore is missing or displaced.")
            details["bore"] = {"expected": bore_expected, "actual": None, "score": 0.0}
        else:
            radius_error = _reciprocal_error(
                bore_actual["radius"], bore_expected["radius"], bore_expected["radius"]
            )
            center_error = _distance(
                bore_actual["x"], bore_actual["y"], bore_expected["x"], bore_expected["y"]
            ) / max(outer_scale, 1e-9)
            bore_score = _score_from_error(radius_error, 0.08) * _score_from_error(
                center_error, 0.02
            )
            details["bore"] = {
                "expected": bore_expected,
                "actual": bore_actual,
                "radius_relative_error": _round(radius_error),
                "center_relative_error": _round(center_error),
                "score": _round(bore_score),
            }
            if radius_error > 0.08:
                issues.append("Bore radius deviates from the synthesised value.")
        components["bore"] = bore_score

    matched_actual_ids = set()
    if bore_actual is not None:
        matched_actual_ids.add(id(bore_actual))

    pattern_expected = expected["pattern"]
    if pattern_expected and pattern_expected["count"] > 0:
        positions = _expected_pattern_positions(pattern_expected)
        hole_radius = pattern_expected["hole_radius"]
        center_tolerance = max(2.0 * hole_radius, 0.02 * outer_scale)
        matched = []
        missing_positions = []
        for position in positions:
            target = {"x": position["x"], "y": position["y"]}
            actual = _match_hole(target, inner, center_tolerance)
            if actual is None:
                missing_positions.append(position)
                continue
            matched.append((position, actual))
            matched_actual_ids.add(id(actual))

        count_ratio = len(matched) / max(len(positions), 1)
        if matched:
            radius_errors = [
                _reciprocal_error(actual["radius"], hole_radius, hole_radius)
                for _, actual in matched
            ]
            center_errors = [
                _distance(actual["x"], actual["y"], position["x"], position["y"])
                / max(outer_scale, 1e-9)
                for position, actual in matched
            ]
            actual_angles = [
                math.degrees(math.atan2(actual["y"], actual["x"])) % 360.0
                for _, actual in matched
            ]
            expected_angles = [position["angle_deg"] for position, _ in matched]
            angular_errors = [
                _angle_error(a, b) for a, b in zip(actual_angles, expected_angles)
            ]
            radius_score = 1.0 - min(
                1.0, sum(radius_errors) / len(radius_errors) / 0.12
            )
            center_score = 1.0 - min(
                1.0, sum(center_errors) / len(center_errors) / 0.03
            )
            angular_score = 1.0 - min(
                1.0, sum(angular_errors) / len(angular_errors) / 10.0
            )
        else:
            radius_score = center_score = angular_score = 0.0

        pattern_score = (
            0.40 * count_ratio
            + 0.30 * radius_score
            + 0.20 * center_score
            + 0.10 * angular_score
        )
        components["pattern"] = pattern_score
        details["pattern"] = {
            "expected_count": pattern_expected["count"],
            "matched_count": len(matched),
            "bolt_circle_radius": pattern_expected["bolt_circle_radius"],
            "hole_radius": hole_radius,
            "missing_positions": missing_positions,
            "score": _round(pattern_score),
        }
        if missing_positions:
            missing.append({
                "feature_id": pattern_expected["feature_id"],
                "type": "bolt_circle_holes",
                "count": len(missing_positions),
            })
            issues.append(
                f"Radial pattern: {len(missing_positions)} of "
                f"{pattern_expected['count']} holes missing."
            )

    if expected["holes"]:
        hole_matches = []
        hole_missing = []
        for hole in expected["holes"]:
            center_tolerance = max(2.0 * hole["radius"], 0.02 * outer_scale)
            actual = _match_hole(hole, inner, center_tolerance)
            if actual is None:
                hole_missing.append(hole)
            else:
                hole_matches.append((hole, actual))
                matched_actual_ids.add(id(actual))

        count_ratio = len(hole_matches) / max(len(expected["holes"]), 1)
        if hole_matches:
            radius_errors = [
                _reciprocal_error(actual["radius"], hole["radius"], hole["radius"])
                for hole, actual in hole_matches
            ]
            center_errors = [
                _distance(actual["x"], actual["y"], hole["x"], hole["y"])
                / max(outer_scale, 1e-9)
                for hole, actual in hole_matches
            ]
            radius_score = 1.0 - min(1.0, sum(radius_errors) / len(radius_errors) / 0.12)
            center_score = 1.0 - min(1.0, sum(center_errors) / len(center_errors) / 0.03)
        else:
            radius_score = center_score = 0.0
        hole_score = 0.5 * count_ratio + 0.3 * radius_score + 0.2 * center_score
        components["holes"] = hole_score
        details["holes"] = {
            "expected_count": len(expected["holes"]),
            "matched_count": len(hole_matches),
            "missing": hole_missing,
            "score": _round(hole_score),
        }
        if hole_missing:
            missing.append({
                "type": "individual_holes",
                "count": len(hole_missing),
            })
            issues.append(f"{len(hole_missing)} measured holes are missing.")

    profile_radii = expected["profile_radii"]
    if profile_radii:
        central = [
            face for face in inner
            if _distance(face["x"], face["y"], 0.0, 0.0) <= _CENTRAL_RATIO * outer_scale
        ]
        matched_profile = []
        for radius in profile_radii:
            actual = next(
                (
                    face for face in central
                    if _reciprocal_error(face["radius"], radius, radius) <= 0.08
                ),
                None,
            )
            if actual is not None:
                matched_profile.append(radius)
                matched_actual_ids.add(id(actual))
        profile_score = len(matched_profile) / len(profile_radii)
        components["profile"] = profile_score
        details["profile_steps"] = {
            "expected_radii": profile_radii,
            "matched_radii": matched_profile,
            "score": _round(profile_score),
        }
        if profile_score < 1.0:
            issues.append("One or more revolved profile steps could not be matched.")

    for face in inner:
        if id(face) in matched_actual_ids:
            continue
        if expected["profile_radii"] and any(
            _reciprocal_error(face["radius"], radius, radius) <= 0.08
            for radius in expected["profile_radii"]
        ):
            continue
        if _distance(face["x"], face["y"], 0.0, 0.0) <= _CENTRAL_RATIO * outer_scale:
            continue
        unexpected.append(face)

    weights = {
        "outer": 0.15,
        "bore": 0.25,
        "pattern": 0.30,
        "holes": 0.20,
        "profile": 0.10,
    }
    present = [name for name in components if name in weights and weights[name] > 0]
    weight_total = sum(weights[name] for name in present)
    weighted = (
        sum(components[name] * weights[name] for name in present) / weight_total
        if weight_total > 0 else 0.0
    )
    penalty = max(0.5, 1.0 - 0.08 * len(unexpected))
    score = max(0.0, min(1.0, weighted * penalty))

    critical_missing = bool(missing)
    if critical_missing or score < 0.60:
        status = "fail"
    elif score < 0.85 or unexpected:
        status = "warn"
    else:
        status = "pass"

    return {
        "version": FEATURE_FIT_VERSION,
        "status": status,
        "score": _round(score),
        "score_percent": _round(score * 100.0, 2),
        "is_dimensional_accuracy_metric": True,
        "basis": (
            "analytic comparison of modelled features against the synthesised "
            "recipe (scaled measurement evidence); not a reference-model or "
            "photograph fit"
        ),
        "components": {name: _round(value) for name, value in components.items()},
        "details": details,
        "missing_features": missing,
        "unexpected_features": [
            {
                "radius": _round(face["radius"]),
                "center": [_round(face["x"]), _round(face["y"])],
            }
            for face in unexpected
        ],
        "issues": issues,
    }


def _measurement_evidence(measurements: Dict[str, Any]) -> Dict[str, Any]:
    fused = measurements or {}
    view = fused.get("view") or {}
    images = fused.get("images") or []
    image_count = fused.get("image_count")
    if image_count is None:
        image_count = len(images) if images else 0
    return {
        "image_count": int(image_count),
        "per_view": [
            {
                "image_index": image.get("image_index"),
                "view": image.get("view", "unknown"),
                "view_confidence": image.get("view_confidence"),
            }
            for image in images
        ],
        "view_label": view.get("label", "unknown"),
        "view_confidence": float(view.get("confidence") or 0.0),
        "view_vote_agreement": view.get("vote_agreement"),
        "agreement_score": fused.get("agreement_score"),
        "status": fused.get("status"),
    }


def assess_measurement_build(
    synthesis: Dict[str, Any],
    geometry_report: Dict[str, Any],
    feature_fit: Optional[Dict[str, Any]],
    measurements: Dict[str, Any],
    *,
    allow_assumed_exports: bool = False,
    export_override: bool = False,
) -> Dict[str, Any]:
    """Build the four honest, separately-reported statuses and the export gate."""
    provenance = synthesis.get("provenance") or {}
    scale = synthesis.get("scale") or {}
    topology = synthesis.get("topology") or {}
    needs_input = synthesis.get("needs_input") or []
    evidence = _measurement_evidence(measurements)

    assumed_dimensions: List[Dict[str, Any]] = []
    critical_unknowns: List[str] = []
    for parameter in _CRITICAL_PARAMETERS:
        entry = provenance.get(parameter)
        required = parameter in ("outer_diameter", "thickness")
        if parameter == "bore_diameter" and not topology.get("bore"):
            continue
        if parameter in ("hole_count", "bolt_circle_diameter", "hole_diameter") and not (
            topology.get("radial_pattern") or topology.get("hole_count")
        ):
            continue
        if entry is None:
            if required:
                critical_unknowns.append(parameter)
            continue
        value = entry.get("value")
        source = str(entry.get("provenance", ""))
        if value is None:
            if required:
                critical_unknowns.append(parameter)
        elif source in ("assumed", "vision_estimated"):
            assumed_dimensions.append({
                "parameter": parameter,
                "value": value,
                "provenance": source,
                "source": entry.get("source"),
            })

    for item in needs_input:
        parameter = item.get("parameter")
        if parameter in _CRITICAL_PARAMETERS and parameter not in critical_unknowns:
            critical_unknowns.append(parameter)

    geometry_valid = bool(geometry_report.get("valid", False))
    if not geometry_valid:
        geometry_issues = list(geometry_report.get("issues") or [])
        geometry_status = "invalid"
    else:
        geometry_issues = []
        geometry_status = "valid"

    missing = list((feature_fit or {}).get("missing_features") or [])
    if not geometry_valid:
        reconstruction_status = "insufficient"
    elif scale.get("mode") != "anchored":
        reconstruction_status = "insufficient"
    elif critical_unknowns or missing or needs_input:
        reconstruction_status = "partial"
    else:
        reconstruction_status = "complete"

    if feature_fit is None:
        dimensional_status = "not_assessed"
        dimensional_score = None
    else:
        dimensional_status = feature_fit.get("status", "not_assessed")
        dimensional_score = feature_fit.get("score")

    block_reasons: List[str] = []
    if not geometry_valid:
        block_reasons.append("geometry_invalid")
    if scale.get("mode") != "anchored":
        block_reasons.append("scale_not_anchored")
    if critical_unknowns:
        block_reasons.append("critical_dimensions_unknown")
    if assumed_dimensions:
        block_reasons.append("critical_dimensions_assumed")
    if needs_input:
        block_reasons.append("needs_input")
    if feature_fit and feature_fit.get("status") == "fail":
        block_reasons.append("dimensional_fit_failed")

    override_allowed = bool(export_override or allow_assumed_exports)
    override_used = False
    if not block_reasons:
        readiness_status = "ready"
    elif (
        override_allowed
        and geometry_valid
        and (feature_fit is None or feature_fit.get("status") != "fail")
    ):
        readiness_status = "ready_with_assumptions"
        override_used = True
    else:
        readiness_status = "blocked"

    export_allowed = readiness_status in ("ready", "ready_with_assumptions")

    return {
        "version": ASSESSMENT_VERSION,
        "statuses": {
            "geometry": {
                "status": geometry_status,
                "valid": geometry_valid,
                "solid_count": (geometry_report.get("metrics") or {}).get("solid_count"),
                "issues": geometry_issues,
            },
            "reconstruction": {
                "status": reconstruction_status,
                "evidence": evidence,
                "critical_unknowns": critical_unknowns,
                "missing_features": missing,
                "needs_input_count": len(needs_input),
                "topology": topology,
            },
            "dimensional_accuracy": {
                "status": dimensional_status,
                "score": dimensional_score,
                "basis": (feature_fit or {}).get("basis"),
                "note": (
                    "Dimensional agreement is computed only when geometry and a "
                    "synthesised recipe exist; it is never inferred from Gemini "
                    "confidence."
                ),
            },
            "manufacturing_readiness": {
                "status": readiness_status,
                "export_allowed": export_allowed,
                "override_used": override_used,
                "block_reasons": block_reasons,
                "assumed_dimensions": assumed_dimensions,
                "critical_unknowns": critical_unknowns,
            },
        },
        "critical_unknowns": critical_unknowns,
        "assumed_dimensions": assumed_dimensions,
        "export_allowed": export_allowed,
        "preview_only": readiness_status not in ("ready", "ready_with_assumptions"),
    }
