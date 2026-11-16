"""Synthesise a generic feature recipe from ratio-based image measurements.

This module is deliberately part-type agnostic: it reacts to the *topology*
present in a ``feature_measurements`` document (circular / polygonal outline,
side profile, concentric radii, radial arrays, individual holes) and to explicit
user dimensions.  Nothing here branches on part names.

Contract
--------
``synthesize_feature_recipe(measurements, user_dimensions, calibration, hints)``
returns a dictionary with:

* ``recipe``       — a ``reforge-feature-recipe`` v1.0 dict
* ``scale``        — anchored (mm) or assumed (unitless, preview-only)
* ``provenance``   — per-parameter ``{value, provenance, confidence, source}``
* ``confidence``   — overall synthesis confidence
* ``needs_input``  — list of ``{parameter, question, reason}``
* ``warnings`` / ``sanity_errors``
* ``status``       — ``ok`` | ``needs_input`` | ``error``
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from cad.feature_schema import (
    FEATURE_RECIPE_FORMAT,
    FEATURE_RECIPE_VERSION,
)

MEASUREMENT_SCHEMA_VERSION = "1.0"
SYNTHESIS_VERSION = "1.0"
DEFAULT_OUTER_DIAMETER_UNITS = 100.0
_ASSUMED_THICKNESS_FRACTION = 0.12  # of outer diameter, preview only
_MIN_BORE_RATIO = 0.01
_MIN_HOLE_COUNT = 1
_MAX_HOLE_COUNT = 64


class MeasurementSynthesisError(ValueError):
    """Raised when measurements cannot produce even a preview model."""


# ---------------------------------------------------------------------------
# Small numeric / normalisation helpers
# ---------------------------------------------------------------------------

def _number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result):
        return None
    return result


def _positive(value: Any) -> Optional[float]:
    result = _number(value)
    return result if result is not None and result > 0 else None


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _round_up_int(value: Any, default: int = 0) -> int:
    result = _number(value)
    if result is None:
        return default
    return int(round(result))


def _keys(user: Dict[str, Any]) -> Dict[str, Any]:
    return {str(k).strip().lower(): v for k, v in (user or {}).items()}


def _first(user: Dict[str, Any], *names: str) -> Optional[float]:
    for name in names:
        value = _positive(user.get(name))
        if value is not None:
            return value
    return None


def _prov(
    value: Any,
    provenance: str,
    confidence: Optional[float],
    source: str,
    assumed: bool = False,
) -> Dict[str, Any]:
    return {
        "value": value,
        "provenance": provenance,
        "confidence": None if confidence is None else _round(_clamp01(confidence), 3),
        "source": source,
        "assumed": bool(assumed),
    }


def _feature(
    feature_id: str,
    feature_type: str,
    parameters: Dict[str, Any],
    depends_on: Optional[Iterable[str]] = None,
    provenance: str = "measured",
    confidence: Optional[float] = None,
    source: str = "",
) -> Dict[str, Any]:
    return {
        "id": feature_id,
        "type": feature_type,
        "parameters": parameters,
        "depends_on": list(depends_on or []),
        "metadata": {
            "provenance": provenance,
            "confidence": None if confidence is None else _round(_clamp01(confidence), 3),
            "source": source,
        },
    }


def _needs(parameter: str, question: str, reason: str) -> Dict[str, str]:
    return {"parameter": parameter, "question": question, "reason": reason}


# ---------------------------------------------------------------------------
# Measurement interpretation
# ---------------------------------------------------------------------------

def _concentric(measurements: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = measurements.get("concentric") or []
    return sorted(
        [item for item in items if _positive(item.get("radius_ratio"))],
        key=lambda item: float(item["radius_ratio"]),
    )


def _patterns(measurements: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = measurements.get("radial_patterns") or []
    return sorted(
        [item for item in items if _number(item.get("count"))],
        key=lambda item: float(item.get("pattern_radius_ratio") or 0.0),
    )


def _side(measurements: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    side = measurements.get("side_profile")
    if not isinstance(side, dict):
        return None
    points = side.get("points") or []
    if len(points) < 2:
        return None
    return side


def _is_polygonal(measurements: Dict[str, Any]) -> bool:
    outer = measurements.get("outer") or {}
    if outer.get("non_circular"):
        return True
    if outer.get("shape") == "polygonal":
        return True
    polygon = measurements.get("polygon")
    return bool(
        isinstance(polygon, dict)
        and len(polygon.get("points") or []) >= 3
        and outer.get("shape") not in ("circular", "silhouette")
    )


def _hub_ratio(measurements: Dict[str, Any], side: Optional[Dict[str, Any]]) -> Optional[float]:
    if not side:
        return None
    ratio = _positive(side.get("hub_radius_ratio"))
    if ratio is None or ratio >= 0.98:
        return None
    if float(side.get("hub_height_ratio") or 0.0) <= 0.005:
        return None
    return ratio


def _bore_ratio(
    measurements: Dict[str, Any],
    side: Optional[Dict[str, Any]],
) -> Optional[float]:
    """Return the smallest concentric ratio that is not the hub silhouette."""
    hub = _hub_ratio(measurements, side)
    for item in _concentric(measurements):
        ratio = float(item["radius_ratio"])
        if ratio < _MIN_BORE_RATIO:
            continue
        if hub is not None and abs(ratio - hub) <= max(0.06 * hub, 0.02):
            continue
        return ratio
    return None


# ---------------------------------------------------------------------------
# Scale / anchor resolution
# ---------------------------------------------------------------------------

def _resolve_scale(
    measurements: Dict[str, Any],
    user: Dict[str, Any],
    calibration: Optional[Dict[str, Any]],
    needs_input: List[Dict[str, str]],
) -> Dict[str, Any]:
    is_polygonal = _is_polygonal(measurements)
    bore_ratio = _bore_ratio(measurements, _side(measurements))
    patterns = _patterns(measurements)
    pattern_ratio = _positive(patterns[0].get("pattern_radius_ratio")) if patterns else None

    outer = _first(user, "outer_diameter", "diameter", "od")
    width = _first(user, "width", "length", "plate_width")

    def _anchored(radius: float, source: str, anchor: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "mode": "anchored",
            "unit": "mm",
            "preview_only": False,
            "outer_radius": _round(radius),
            "outer_diameter": _round(2.0 * radius),
            "source": source,
            "anchor": anchor,
        }

    if outer:
        return _anchored(outer / 2.0, "user_outer", {
            "parameter": "outer_diameter", "value_mm": outer, "provenance": "user_provided",
        })
    if is_polygonal and width:
        return _anchored(width / 2.0, "user_width", {
            "parameter": "width", "value_mm": width, "provenance": "user_provided",
        })

    user_bore = _first(user, "bore_diameter", "inner_diameter", "id", "bore")
    if user_bore and bore_ratio:
        radius = (user_bore / 2.0) / bore_ratio
        return _anchored(radius, "user_bore_anchor", {
            "parameter": "bore_diameter", "value_mm": user_bore,
            "provenance": "user_anchor_derived",
        })

    user_pattern = _first(user, "bolt_circle_diameter", "pattern_diameter", "bcd")
    if user_pattern and pattern_ratio:
        radius = (user_pattern / 2.0) / pattern_ratio
        return _anchored(radius, "user_pattern_anchor", {
            "parameter": "bolt_circle_diameter", "value_mm": user_pattern,
            "provenance": "user_anchor_derived",
        })

    if isinstance(calibration, dict):
        anchor_value = _positive(
            calibration.get("anchor_value_mm")
            or calibration.get("value_mm")
            or calibration.get("value")
        )
        anchor_parameter = str(
            calibration.get("anchor_parameter")
            or calibration.get("parameter")
            or ""
        ).strip().lower()
        if anchor_value:
            if anchor_parameter in ("outer_diameter", "diameter", "od", "width", "length"):
                return _anchored(anchor_value / 2.0, "calibration_anchor", {
                    "parameter": anchor_parameter, "value_mm": anchor_value,
                    "provenance": "vision_calibration",
                })
            if anchor_parameter in ("bore_diameter", "bore", "inner_diameter") and bore_ratio:
                return _anchored((anchor_value / 2.0) / bore_ratio, "calibration_anchor", {
                    "parameter": "bore_diameter", "value_mm": anchor_value,
                    "provenance": "vision_calibration",
                })
            if anchor_parameter in ("bolt_circle_diameter", "pattern_diameter") and pattern_ratio:
                return _anchored((anchor_value / 2.0) / pattern_ratio, "calibration_anchor", {
                    "parameter": "bolt_circle_diameter", "value_mm": anchor_value,
                    "provenance": "vision_calibration",
                })

    needs_input.append(_needs(
        "absolute_scale",
        "Enter one known dimension (outer diameter, bore diameter, bolt-circle "
        "diameter, or plate width) so the model can be scaled in millimetres.",
        "Photos give relative proportions only; no absolute scale anchor was supplied.",
    ))
    return {
        "mode": "assumed",
        "unit": "units",
        "preview_only": True,
        "outer_radius": DEFAULT_OUTER_DIAMETER_UNITS / 2.0,
        "outer_diameter": DEFAULT_OUTER_DIAMETER_UNITS,
        "source": "assumed_default",
        "anchor": None,
    }


# ---------------------------------------------------------------------------
# Dimension resolution (user > measured > assumed)
# ---------------------------------------------------------------------------

class _Dims:
    def __init__(self, scale: Dict[str, Any], user: Dict[str, Any], measurements: Dict[str, Any]):
        self.scale = scale
        self.user = user
        self.measurements = measurements
        self.outer_radius = float(scale["outer_radius"])
        self.is_polygonal = _is_polygonal(measurements)
        self.side = _side(measurements)
        self.patterns = _patterns(measurements)
        self.concentric = _concentric(measurements)
        self.hub_ratio = _hub_ratio(measurements, self.side)
        self.bore_ratio = _bore_ratio(measurements, self.side)
        self.provenance: Dict[str, Dict[str, Any]] = {}
        self.needs_input: List[Dict[str, str]] = []
        self.warnings: List[str] = []
        self._thickness_cache: Optional[Tuple[Optional[float], str]] = None

    # -- convenience ------------------------------------------------------
    def _measured_conf(self, items: List[Dict[str, Any]]) -> Optional[float]:
        values = [float(i.get("confidence")) for i in items if _number(i.get("confidence")) is not None]
        return (sum(values) / len(values)) if values else None

    def _record(self, key: str, value: Any, prov: str, confidence: Optional[float], source: str, assumed: bool = False):
        self.provenance[key] = _prov(value, prov, confidence, source, assumed=assumed)

    # -- individual dimensions -------------------------------------------
    def outer_diameter(self) -> float:
        value = 2.0 * self.outer_radius
        source = self.scale["source"]
        if source == "user_outer":
            prov, conf = "user_provided", 1.0
        elif source == "user_width":
            prov, conf = "user_provided", 1.0
        elif source in ("user_bore_anchor", "user_pattern_anchor"):
            prov, conf = "user_anchor_derived", self.scale.get("confidence", 0.8)
        elif source == "calibration_anchor":
            prov, conf = "vision_calibration", self.scale.get("confidence", 0.8)
        else:
            prov, conf = "assumed", 0.0
        self._record("outer_diameter", _round(value), prov, conf, source, assumed=prov == "assumed")
        return value

    def bore_diameter(self) -> Optional[float]:
        user_value = _first(self.user, "bore_diameter", "inner_diameter", "id", "bore")
        if user_value:
            self._record("bore_diameter", _round(user_value), "user_provided", 1.0, "user_dimensions.bore_diameter")
            return user_value
        if self.bore_ratio is None:
            return None
        value = 2.0 * self.bore_ratio * self.outer_radius
        conf = self._measured_conf(self.concentric)
        self._record("bore_diameter", _round(value), "measured", conf, "concentric.smallest")
        return value

    def thickness(self) -> Tuple[Optional[float], str]:
        if self._thickness_cache is not None:
            return self._thickness_cache
        user_value = _first(self.user, "thickness", "plate_thickness", "depth")
        if user_value:
            self._record("thickness", _round(user_value), "user_provided", 1.0, "user_dimensions.thickness")
            self._thickness_cache = (user_value, "user_provided")
            return self._thickness_cache

        if self.side:
            ratio = _positive(self.side.get("thickness_ratio"))
            if ratio:
                value = ratio * 2.0 * self.outer_radius
                self._record(
                    "thickness", _round(value), "measured",
                    self.side.get("confidence"), "side_profile.thickness_ratio",
                )
                self._thickness_cache = (value, "measured")
                return self._thickness_cache

        user_height = _first(self.user, "height", "total_height")
        if user_height and not (self.side and _positive(self.side.get("hub_height_ratio"))):
            self._record("height", _round(user_height), "user_provided", 1.0, "user_dimensions.height")
            self._thickness_cache = (user_height, "user_provided")
            return self._thickness_cache

        assumed = _ASSUMED_THICKNESS_FRACTION * 2.0 * self.outer_radius
        self._record("thickness", _round(assumed), "assumed", 0.0, "assumed_thickness", assumed=True)
        self.needs_input.append(_needs(
            "thickness",
            "What is the plate thickness (or overall height)?",
            "No side view and no user thickness were supplied.",
        ))
        self._thickness_cache = (assumed, "assumed")
        return self._thickness_cache

    def height(self) -> Optional[float]:
        user_value = _first(self.user, "height", "total_height")
        if user_value:
            self._record("height", _round(user_value), "user_provided", 1.0, "user_dimensions.height")
            return user_value
        if self.side:
            ratio = _positive(self.side.get("height_ratio"))
            if ratio:
                value = ratio * 2.0 * self.outer_radius
                self._record("height", _round(value), "measured", self.side.get("confidence"), "side_profile.height_ratio")
                return value
        thickness, _ = self.thickness()
        return thickness

    def hub_diameter(self) -> Optional[float]:
        user_value = _first(self.user, "hub_diameter", "hub_outer_diameter", "boss_diameter")
        if user_value:
            self._record("hub_diameter", _round(user_value), "user_provided", 1.0, "user_dimensions.hub_diameter")
            return user_value
        if self.hub_ratio is None:
            return None
        value = 2.0 * self.hub_ratio * self.outer_radius
        self._record("hub_diameter", _round(value), "measured", self.side.get("confidence") if self.side else None, "side_profile.hub_radius_ratio")
        return value

    def hub_height(self) -> Optional[float]:
        user_value = _first(self.user, "hub_height", "boss_height")
        if user_value:
            self._record("hub_height", _round(user_value), "user_provided", 1.0, "user_dimensions.hub_height")
            return user_value
        if not self.side:
            return None
        ratio = _positive(self.side.get("hub_height_ratio"))
        if not ratio:
            return None
        value = ratio * 2.0 * self.outer_radius
        self._record("hub_height", _round(value), "measured", self.side.get("confidence"), "side_profile.hub_height_ratio")
        return value

    def hole_diameter(self) -> Optional[float]:
        user_value = _first(self.user, "hole_diameter", "bolt_hole_diameter")
        pattern = self.patterns[0] if self.patterns else None
        if user_value:
            self._record("hole_diameter", _round(user_value), "user_provided", 1.0, "user_dimensions.hole_diameter")
            return user_value
        if pattern is None:
            return None
        ratio = _positive(pattern.get("hole_radius_ratio"))
        if ratio is None:
            return None
        value = 2.0 * ratio * self.outer_radius
        self._record("hole_diameter", _round(value), "measured", pattern.get("confidence"), "radial_pattern.hole_radius_ratio")
        return value

    def pattern_radius(self) -> Optional[float]:
        user_value = _first(self.user, "bolt_circle_diameter", "pattern_diameter", "bcd")
        pattern = self.patterns[0] if self.patterns else None
        if user_value:
            value = user_value / 2.0
            self._record("bolt_circle_diameter", _round(2.0 * value), "user_provided", 1.0, "user_dimensions.bolt_circle_diameter")
            return value
        if pattern is None:
            return None
        ratio = _positive(pattern.get("pattern_radius_ratio"))
        if ratio is None:
            return None
        value = ratio * self.outer_radius
        self._record("bolt_circle_diameter", _round(2.0 * value), "measured", pattern.get("confidence"), "radial_pattern.pattern_radius_ratio")
        return value

    def hole_count(self) -> Optional[int]:
        user_value = _number(self.user.get("hole_count"))
        if user_value is not None and user_value >= 1:
            self._record("hole_count", int(round(user_value)), "user_provided", 1.0, "user_dimensions.hole_count")
            return int(round(user_value))
        pattern = self.patterns[0] if self.patterns else None
        if pattern is None:
            return None
        count = _round_up_int(pattern.get("count"))
        self._record("hole_count", count, "measured", pattern.get("count_confidence"), "radial_pattern.count")
        return count

    def start_angle(self) -> float:
        pattern = self.patterns[0] if self.patterns else None
        if pattern is None:
            return 0.0
        return float(_number(pattern.get("start_angle_deg")) or 0.0)


# ---------------------------------------------------------------------------
# Geometry sanity
# ---------------------------------------------------------------------------

def _regular_pattern_holes(count: int, bcr: float, hole_r: float, start_deg: float) -> List[Tuple[float, float]]:
    return [
        (
            bcr * math.cos(math.radians(start_deg + index * 360.0 / count)),
            bcr * math.sin(math.radians(start_deg + index * 360.0 / count)),
        )
        for index in range(count)
    ]


def _polygon_outline(measurements: Dict[str, Any], outer_radius: float) -> List[Dict[str, float]]:
    polygon = measurements.get("polygon") or {}
    points = polygon.get("points") or []
    outline: List[Dict[str, float]] = []
    for point in points:
        x = _number(point.get("x_ratio"))
        y = _number(point.get("y_ratio"))
        if x is None or y is None:
            continue
        outline.append({"x": _round(2.0 * x * outer_radius), "y": _round(2.0 * y * outer_radius)})
    return outline


def _point_in_polygon(x: float, y: float, outline: List[Dict[str, float]]) -> bool:
    inside = False
    count = len(outline)
    for index in range(count):
        x1, y1 = outline[index]["x"], outline[index]["y"]
        x2, y2 = outline[(index + 1) % count]["x"], outline[(index + 1) % count]["y"]
        if (y1 > y) != (y2 > y):
            x_cross = (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
            if x < x_cross:
                inside = not inside
    return inside


def _sanity_check(
    dims: _Dims,
    outline: Optional[List[Dict[str, float]]],
    holes: List[Dict[str, Any]],
    bore_d: Optional[float],
) -> List[str]:
    errors: List[str] = []
    outer_r = dims.outer_radius
    if outer_r <= 0:
        errors.append("Outer size must be > 0.")
    bore_r = (bore_d / 2.0) if bore_d else 0.0
    if bore_d and bore_d >= 2.0 * outer_r:
        errors.append("Bore diameter must be smaller than the outer diameter.")

    for index, hole in enumerate(holes):
        hx, hy, hr = hole["x"], hole["y"], hole["r"]
        if hr <= 0:
            errors.append(f"Hole {index + 1}: diameter must be > 0.")
            continue
        if math.hypot(hx, hy) + hr > outer_r * 1.01 and outline is None:
            errors.append(f"Hole {index + 1}: lies outside the outer diameter.")
        if outline is not None and not _point_in_polygon(hx, hy, outline):
            errors.append(f"Hole {index + 1}: centre lies outside the plate outline.")
        if bore_r and math.hypot(hx, hy) < bore_r + hr:
            errors.append(f"Hole {index + 1}: overlaps the central bore.")

    for i in range(len(holes)):
        for j in range(i + 1, len(holes)):
            a, b = holes[i], holes[j]
            if math.hypot(a["x"] - b["x"], a["y"] - b["y"]) < a["r"] + b["r"] - 1e-6:
                errors.append(f"Holes {i + 1} and {j + 1} overlap.")
                break
    return errors


# ---------------------------------------------------------------------------
# Public synthesis
# ---------------------------------------------------------------------------

def synthesize_feature_recipe(
    measurements: Dict[str, Any],
    user_dimensions: Optional[Dict[str, Any]] = None,
    calibration: Optional[Dict[str, Any]] = None,
    hints: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Convert fused ``feature_measurements`` into a feature recipe + metadata."""
    if not isinstance(measurements, dict) or not measurements:
        raise MeasurementSynthesisError("No measurements were supplied.")

    schema_version = str(measurements.get("schema_version") or "")
    if schema_version and schema_version != MEASUREMENT_SCHEMA_VERSION:
        raise MeasurementSynthesisError(
            f"Unsupported measurement schema version '{schema_version}' "
            f"(expected {MEASUREMENT_SCHEMA_VERSION})."
        )

    user = _keys(user_dimensions or {})
    hints = hints or {}
    needs_input: List[Dict[str, str]] = []
    warnings: List[str] = list(measurements.get("warnings") or [])
    warnings = [str(w) for w in warnings]

    scale = _resolve_scale(measurements, user, calibration, needs_input)
    dims = _Dims(scale, user, measurements)

    outer_d = dims.outer_diameter()
    is_polygonal = dims.is_polygonal
    side = dims.side

    features: List[Dict[str, Any]] = []
    dependencies: List[str] = []
    outline: Optional[List[Dict[str, float]]] = None

    # ---- 1. Additive base -------------------------------------------------
    if is_polygonal:
        outline = _polygon_outline(measurements, dims.outer_radius)
        if len(outline) < 3:
            raise MeasurementSynthesisError(
                "Measured outline is polygonal but has fewer than 3 usable points."
            )
        depth, depth_prov = dims.thickness()
        features.append(_feature(
            "body_1", "extrude_profile",
            {"outline": outline, "depth": _round(depth), "zStart": 0.0},
            provenance=depth_prov,
            confidence=(measurements.get("polygon") or {}).get("confidence"),
            source="polygon.outline",
        ))
        dependencies = ["body_1"]
    elif side is not None:
        height = dims.height()
        thickness_user = _first(user, "thickness", "plate_thickness", "depth")
        height_ratio = _positive(side.get("height_ratio"))
        z_span = (height_ratio or 0.0) * 2.0 * dims.outer_radius
        profile_points = side.get("points") or []
        profile: List[Dict[str, float]] = []
        user_height = _first(user, "height", "total_height")
        if height and height > 0:
            z_scale = height / (z_span if z_span > 0 else height)
        elif thickness_user and _positive(side.get("thickness_ratio")):
            measured_thickness = float(side["thickness_ratio"]) * 2.0 * dims.outer_radius
            z_scale = thickness_user / max(measured_thickness, 1e-6)
        else:
            z_scale = 1.0
        for point in profile_points:
            r_ratio = _number(point.get("r_ratio"))
            z_ratio = _number(point.get("z_ratio"))
            if r_ratio is None or z_ratio is None:
                continue
            z = (float(height_ratio or 0.0) - z_ratio) * 2.0 * dims.outer_radius * z_scale
            profile.append({
                "radius": _round(max(0.0, r_ratio) * dims.outer_radius),
                "z": _round(max(0.0, z)),
            })
        profile.sort(key=lambda p: p["z"])
        if len(profile) < 2:
            raise MeasurementSynthesisError("Side profile did not yield >= 2 usable points.")
        features.append(_feature(
            "body_1", "revolve_profile",
            {"profile": profile, "angleDeg": 360.0},
            provenance="measured" if not user_height and not thickness_user else "user_provided",
            confidence=side.get("confidence"),
            source="side_profile.points",
        ))
        dependencies = ["body_1"]
    else:
        thickness, depth_prov = dims.thickness()
        features.append(_feature(
            "body_1", "base_cylinder",
            {"radius": _round(dims.outer_radius), "zStart": 0.0, "zEnd": _round(thickness)},
            provenance=depth_prov,
            confidence=(measurements.get("view") or {}).get("confidence"),
            source="outer.circular",
        ))
        dependencies = ["body_1"]

    thickness, _ = dims.thickness()
    total_height = max(thickness, dims.height() or thickness)
    margin = max(1.0, 0.02 * total_height)
    cut_z0 = -margin
    cut_z1 = total_height + margin

    # ---- 2. Central bore / concentric features ---------------------------
    bore_d = dims.bore_diameter()
    if bore_d:
        features.append(_feature(
            "bore_1", "through_bore",
            {
                "diameter": _round(bore_d),
                "center": {"x": 0.0, "y": 0.0},
                "zStart": _round(cut_z0),
                "zEnd": _round(cut_z1),
            },
            depends_on=dependencies,
            provenance=dims.provenance.get("bore_diameter", {}).get("provenance", "measured"),
            confidence=dims.provenance.get("bore_diameter", {}).get("confidence"),
            source="concentric.bore",
        ))
        dependencies.append("bore_1")

    hub_d = dims.hub_diameter()
    hub_h = dims.hub_height()
    if hub_d and hub_h and not is_polygonal and side is None:
        features.append(_feature(
            "hub_1", "boss_cylindrical",
            {
                "radius": _round(hub_d / 2.0),
                "startRadius": 0.0,
                "height": _round(hub_h),
                "angleDeg": 0.0,
                "z": _round(thickness),
            },
            depends_on=dependencies,
            provenance=dims.provenance.get("hub_diameter", {}).get("provenance", "measured"),
            confidence=dims.provenance.get("hub_diameter", {}).get("confidence"),
            source="hub",
        ))
        dependencies.append("hub_1")

    # Ambiguous extra concentric circles are surfaced, never invented into
    # counterbores without a depth measurement.
    extra_concentric = [
        item for item in dims.concentric
        if dims.hub_ratio is None or abs(float(item["radius_ratio"]) - dims.hub_ratio) > 0.06
    ]
    if bore_d:
        extra_concentric = [
            item for item in extra_concentric
            if float(item["radius_ratio"]) > dims.bore_ratio + 0.02
        ]
    for item in extra_concentric:
        needs_input.append(_needs(
            "concentric_feature",
            "A second concentric circle was detected. Is it a counterbore, a "
            "stepped bore, or a raised boss? Enter its diameter/depth.",
            f"Concentric radius ratio {item['radius_ratio']:.3f} is visible but its "
            "axial extent is not measurable from this view.",
        ))

    # ---- 3. Radial arrays and individual holes ---------------------------
    hole_entries: List[Dict[str, Any]] = []
    pattern_holes: List[Dict[str, Any]] = []
    pattern = dims.patterns[0] if dims.patterns else None
    count = dims.hole_count()
    pattern_r = dims.pattern_radius()
    hole_d = dims.hole_diameter()

    if pattern and count and pattern_r and hole_d:
        count = max(_MIN_HOLE_COUNT, min(_MAX_HOLE_COUNT, int(count)))
        features.append(_feature(
            "bolt_circle_1", "bolt_circle",
            {
                "count": count,
                "boltCircleRadius": _round(pattern_r),
                "holeDiameter": _round(hole_d),
                "startAngleDeg": _round(dims.start_angle()),
                "zStart": _round(cut_z0),
                "zEnd": _round(cut_z1),
            },
            depends_on=dependencies,
            provenance="measured",
            confidence=pattern.get("confidence"),
            source="radial_pattern",
        ))
        dependencies.append("bolt_circle_1")
        for x, y in _regular_pattern_holes(count, pattern_r, hole_d / 2.0, dims.start_angle()):
            pattern_holes.append({"x": x, "y": y, "r": hole_d / 2.0, "provenance": "measured"})

    individual_holes = measurements.get("holes") or []
    # When the user supplies a complete bolt pattern, trust it over the partial
    # hole detections from the photo (which are usually a few of the holes at
    # arbitrary positions).  Mixing the two sets made the sanity check compare
    # measured holes against generated pattern holes and falsely report overlap.
    user_provides_bolt_pattern = bool(
        _number(user.get("hole_count"))
        and _number(user.get("bolt_circle_diameter"))
        and _number(user.get("hole_diameter"))
    )
    for item in individual_holes:
        if user_provides_bolt_pattern:
            continue
        radius_ratio = _positive(item.get("radius_ratio"))
        x_ratio = _number(item.get("x_ratio"))
        y_ratio = _number(item.get("y_ratio"))
        if radius_ratio is None or x_ratio is None or y_ratio is None:
            continue
        hole_r = radius_ratio * dims.outer_radius
        x = x_ratio * dims.outer_radius
        y = y_ratio * dims.outer_radius
        if pattern:
            pattern_ratio = _positive(pattern.get("pattern_radius_ratio")) or 0.0
            pattern_hole = _positive(pattern.get("hole_radius_ratio")) or 0.0
            if (
                abs(math.hypot(x, y) / max(dims.outer_radius, 1e-9) - pattern_ratio) <= 0.05 * pattern_ratio
                and abs(radius_ratio - pattern_hole) <= 0.05 * pattern_hole
            ):
                continue
        hole_entries.append({
            "x": x, "y": y, "r": hole_r,
            "provenance": "measured",
            "confidence": item.get("confidence"),
        })

    # User-confirmed holes when no pattern was measured.
    if not pattern:
        user_hole_count = _number(user.get("hole_count"))
        user_pattern_r = dims.pattern_radius()
        user_hole_d = dims.hole_diameter()
        if user_hole_count and user_pattern_r and user_hole_d:
            count = max(_MIN_HOLE_COUNT, min(_MAX_HOLE_COUNT, int(round(user_hole_count))))
            features.append(_feature(
                "bolt_circle_1", "bolt_circle",
                {
                    "count": count,
                    "boltCircleRadius": _round(user_pattern_r),
                    "holeDiameter": _round(user_hole_d),
                    "startAngleDeg": 0.0,
                    "zStart": _round(cut_z0),
                    "zEnd": _round(cut_z1),
                },
                depends_on=dependencies,
                provenance="user_provided",
                confidence=1.0,
                source="user_dimensions.hole_pattern",
            ))
            dependencies.append("bolt_circle_1")
            for x, y in _regular_pattern_holes(count, user_pattern_r, user_hole_d / 2.0, 0.0):
                pattern_holes.append({"x": x, "y": y, "r": user_hole_d / 2.0, "provenance": "user_provided"})

    for index, entry in enumerate(hole_entries, start=1):
        features.append(_feature(
            f"hole_{index}", "through_bore",
            {
                "diameter": _round(2.0 * entry["r"]),
                "center": {"x": _round(entry["x"]), "y": _round(entry["y"])},
                "zStart": _round(cut_z0),
                "zEnd": _round(cut_z1),
            },
            depends_on=["body_1"],
            provenance=entry.get("provenance", "measured"),
            confidence=entry.get("confidence"),
            source="individual_hole",
        ))

    sanity_errors = _sanity_check(dims, outline, hole_entries + pattern_holes, bore_d)
    needs_input.extend(dims.needs_input)
    warnings.extend(dims.warnings)
    if not features:
        raise MeasurementSynthesisError("Measurements did not yield any usable features.")

    agreement = _number(measurements.get("agreement_score"))
    if agreement is not None and agreement < 0.35:
        needs_input.append(_needs(
            "measurement_review",
            "The available photos disagree. Add a clearer front and side photo, "
            "or enter the key dimensions manually.",
            f"Multi-image measurement agreement is low ({agreement:.2f}).",
        ))

    if sanity_errors:
        status = "error"
    elif needs_input:
        status = "needs_input"
    else:
        status = "ok"

    confidences = [f["metadata"]["confidence"] for f in features if f["metadata"].get("confidence") is not None]
    overall_confidence = (sum(confidences) / len(confidences)) if confidences else 0.0
    if scale["mode"] == "assumed":
        overall_confidence *= 0.75
    if agreement is not None:
        overall_confidence = min(overall_confidence, max(0.0, agreement))

    recipe = {
        "format": FEATURE_RECIPE_FORMAT,
        "version": FEATURE_RECIPE_VERSION,
        "name": str(hints.get("part_type") or "measured_part"),
        # Geometry is always modelled in millimetre coordinates.  When no scale
        # anchor exists those numbers are reference units (outer diameter = 100),
        # not claimed physical millimetres; the scale block records that.
        "units": "mm",
        "features": features,
        "expected": {"solid_count": 1},
        "metadata": {
            "source": "feature_measurements",
            "synthesis_version": SYNTHESIS_VERSION,
            "measurement_schema_version": schema_version or MEASUREMENT_SCHEMA_VERSION,
            "part_type_label": hints.get("part_type"),
            "scale": scale,
            "provenance": dims.provenance,
            "needs_input": needs_input,
            "sanity_errors": sanity_errors,
            "agreement_score": agreement,
            "length_unit": "mm" if scale["mode"] == "anchored" else "reference_unit",
            "preview_only": scale["preview_only"] or bool(needs_input) or bool(sanity_errors),
        },
    }

    return {
        "status": status,
        "recipe": recipe,
        "scale": scale,
        "provenance": dims.provenance,
        "confidence": _round(_clamp01(overall_confidence), 3),
        "needs_input": needs_input,
        "warnings": list(dict.fromkeys(warnings)),
        "sanity_errors": sanity_errors,
        "topology": {
            "outer": "polygonal" if is_polygonal else "circular",
            "has_side_profile": side is not None,
            "bore": bore_d is not None,
            "hub": hub_d is not None,
            "hole_count": len(hole_entries) + len(pattern_holes),
            "radial_pattern": bool(pattern),
        },
    }
