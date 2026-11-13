"""
feature_recipe_validator.py — Validation & normalisation for advanced feature recipes.

Pure-Python layer (no CadQuery / OpenCASCADE import).  It validates a
:class:`~cad.feature_schema.FeatureRecipe` and:

* checks the schema version and units,
* enforces unique feature ids and a valid, acyclic dependency graph,
* verifies that every feature carries the geometric parameters its type needs,
* enforces finite, positive values where required,
* normalises all length parameters to millimetres,
* records a per-feature validation status and diagnostics.

The result is a :class:`FeatureRecipeValidation` carrying a normalised recipe
plus diagnostics.  The geometry engine (``feature_modeller.py``) only ever runs
on a recipe that passed this stage.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

try:  # support package and flat imports
    from cad.feature_schema import (
        ALL_FEATURE_TYPES,
        FEATURE_RECIPE_FORMAT,
        FEATURE_RECIPE_VERSION,
        Feature,
        FeatureRecipe,
        is_feature_recipe_dict,
        operation_for_type,
    )
except ImportError:  # pragma: no cover - fallback import styles
    try:
        from feature_schema import (  # type: ignore
            ALL_FEATURE_TYPES,
            FEATURE_RECIPE_FORMAT,
            FEATURE_RECIPE_VERSION,
            Feature,
            FeatureRecipe,
            is_feature_recipe_dict,
            operation_for_type,
        )
    except ImportError:
        from python_engine.cad.feature_schema import (  # type: ignore
            ALL_FEATURE_TYPES,
            FEATURE_RECIPE_FORMAT,
            FEATURE_RECIPE_VERSION,
            Feature,
            FeatureRecipe,
            is_feature_recipe_dict,
            operation_for_type,
        )


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------

UNIT_CONVERSION_TO_MM: Dict[str, float] = {
    "mm": 1.0, "millimeter": 1.0, "millimeters": 1.0,
    "cm": 10.0, "centimeter": 10.0, "centimeters": 10.0,
    "m": 1000.0, "meter": 1000.0, "meters": 1000.0,
    "in": 25.4, "inch": 25.4, "inches": 25.4,
}

# ---------------------------------------------------------------------------
# Per-type parameter contract
# ---------------------------------------------------------------------------
# required : keys that must be present and finite
# positive : subset of required that must additionally be > 0
# lengths  : keys scaled to mm during normalisation
# angles   : keys expressed in degrees (NEVER scaled)
# counts   : integer-valued keys

_PARAM_SPEC: Dict[str, Dict[str, Tuple[str, ...]]] = {
    "base_cylinder": {
        "required": ("radius",),
        "positive": ("radius", "height"),
        "lengths": ("radius", "zStart", "zEnd", "height"),
    },
    "base_box": {
        "required": ("length", "width", "height"),
        "positive": ("length", "width", "height"),
        "lengths": ("length", "width", "height"),
    },
    "revolve_profile": {
        "required": ("profile",),
        "positive": (),
        "lengths": (),
        "angles": ("angleDeg",),
    },
    "extrude_profile": {
        "required": ("outline", "depth"),
        "positive": ("depth",),
        "lengths": ("depth", "zStart"),
    },
    "flange": {
        "required": ("shape", "thickness"),
        "positive": ("thickness",),
        "lengths": ("thickness", "zStart", "outerRadius", "length", "width"),
    },
    "boss_cylindrical": {
        "required": ("radius", "angleDeg", "z", "startRadius", "height"),
        "positive": ("radius", "height"),
        "lengths": ("radius", "z", "startRadius", "height"),
        "angles": ("angleDeg",),
    },
    "boss_rectangular": {
        "required": ("length", "width", "height", "angleDeg", "startRadius", "z"),
        "positive": ("length", "width", "height"),
        "lengths": ("length", "width", "height", "startRadius", "z"),
        "angles": ("angleDeg",),
    },
    "rib": {
        "required": ("length", "thickness", "height", "angleDeg", "startRadius", "z"),
        "positive": ("length", "thickness", "height"),
        "lengths": ("length", "thickness", "height", "startRadius", "z"),
        "angles": ("angleDeg",),
    },
    "connector": {
        "required": ("radius", "length", "angleDeg", "startRadius", "z"),
        "positive": ("radius", "length"),
        "lengths": ("radius", "length", "startRadius", "z"),
        "angles": ("angleDeg",),
    },
    "through_bore": {
        "required": ("diameter", "zStart", "zEnd"),
        "positive": ("diameter",),
        "lengths": ("diameter", "zStart", "zEnd"),
    },
    "blind_bore": {
        "required": ("diameter", "zStart", "depth"),
        "positive": ("diameter", "depth"),
        "lengths": ("diameter", "zStart", "depth"),
    },
    "stepped_bore": {
        "required": ("segments",),
        "positive": (),
        "lengths": (),
    },
    "counterbore": {
        "required": ("diameter", "counterboreDiameter", "counterboreDepth", "zStart", "zEnd"),
        "positive": ("diameter", "counterboreDiameter", "counterboreDepth"),
        "lengths": ("diameter", "counterboreDiameter", "counterboreDepth", "zStart", "zEnd"),
    },
    "countersink": {
        "required": ("diameter", "countersinkDiameter", "angleDeg", "zStart", "depth"),
        "positive": ("diameter", "countersinkDiameter", "depth"),
        "lengths": ("diameter", "countersinkDiameter", "zStart", "depth"),
        "angles": ("angleDeg",),
    },
    "pocket_circular": {
        "required": ("diameter", "depth", "zStart"),
        "positive": ("diameter", "depth"),
        "lengths": ("diameter", "depth", "zStart"),
    },
    "pocket_rectangular": {
        "required": ("length", "width", "depth", "zStart"),
        "positive": ("length", "width", "depth"),
        "lengths": ("length", "width", "depth", "zStart", "cornerRadius"),
    },
    "radial_port": {
        "required": ("diameter", "angleDeg", "z", "startRadius", "depth"),
        "positive": ("diameter", "depth"),
        "lengths": ("diameter", "z", "startRadius", "depth"),
        "angles": ("angleDeg",),
    },
    "axial_port": {
        "required": ("diameter", "zStart", "zEnd"),
        "positive": ("diameter",),
        "lengths": ("diameter", "zStart", "zEnd"),
    },
    "internal_passage": {
        "required": ("diameter", "start", "end"),
        "positive": ("diameter",),
        "lengths": ("diameter",),
    },
    "cavity": {
        "required": ("diameter", "zStart", "zEnd"),
        "positive": ("diameter",),
        "lengths": ("diameter", "zStart", "zEnd"),
    },
    "bolt_circle": {
        "required": ("count", "boltCircleRadius", "holeDiameter", "zStart", "zEnd"),
        "positive": ("boltCircleRadius", "holeDiameter"),
        "lengths": ("boltCircleRadius", "holeDiameter", "zStart", "zEnd"),
        "angles": ("startAngleDeg",),
        "counts": ("count",),
    },
    "hole_pattern": {
        "required": ("pattern", "holeDiameter"),
        "positive": ("holeDiameter",),
        "lengths": ("holeDiameter", "spacing", "zStart", "zEnd"),
        "counts": ("countX", "countY"),
    },
    "fillet": {
        "required": ("radius", "edges"),
        "positive": ("radius",),
        "lengths": ("radius",),
    },
    "chamfer": {
        "required": ("distance", "edges"),
        "positive": ("distance",),
        "lengths": ("distance",),
    },
}

#: Coordinate-bearing nested keys that must be scaled to mm.
_COORD_LIST_KEYS = ("profile", "outline", "segments", "holes", "points")

#: Public alias for the per-type parameter contract (used by the interface
#: layer for semantic unit validation).
PARAM_SPEC = _PARAM_SPEC

#: Semantic unit classes for feature parameters.
SEMANTIC_LENGTH = "length"
SEMANTIC_ANGLE = "angle"
SEMANTIC_COUNT = "count"
SEMANTIC_DIMENSIONLESS = "dimensionless"


def parameter_semantic(feature_type: str, key: str) -> str:
    """Return the semantic unit class of ``feature_type``'s parameter ``key``.

    One of ``"length"`` (metric), ``"angle"`` (degrees), ``"count"`` (integer)
    or ``"dimensionless"`` (enums / structured data).  Unknown types/keys fall
    back to a name-based heuristic and finally to ``"dimensionless"``.
    """
    spec = _PARAM_SPEC.get(feature_type, {})
    if key in spec.get("counts", ()) or key in spec.get("count", ()):
        return SEMANTIC_COUNT
    if key in spec.get("angles", ()):
        return SEMANTIC_ANGLE
    if key in spec.get("lengths", ()):
        return SEMANTIC_LENGTH
    # Name-based fallback for parameters not enumerated per type.
    if key.endswith("AngleDeg") or key.endswith("_angle") or key == "angleDeg":
        return SEMANTIC_ANGLE
    if key in ("count", "countX", "countY", "teeth", "numTeeth"):
        return SEMANTIC_COUNT
    return SEMANTIC_DIMENSIONLESS



# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------

@dataclass
class FeatureRecipeValidation:
    """Outcome of validating / normalising a feature recipe."""

    recipe: FeatureRecipe
    status: str = "rejected"  # ok | needs_input | rejected
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    missing: List[str] = field(default_factory=list)
    feature_status: Dict[str, str] = field(default_factory=dict)
    feature_diagnostics: Dict[str, List[str]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "missing": list(self.missing),
            "feature_status": dict(self.feature_status),
            "feature_diagnostics": {k: list(v) for k, v in self.feature_diagnostics.items()},
            "recipe_summary": self.recipe.summary(),
        }


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------

def _clean_number(val: Any) -> Optional[float]:
    if val is None or isinstance(val, bool):
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _scale_point(point: Dict[str, Any], factor: float, keys: Tuple[str, ...]) -> Dict[str, Any]:
    out = dict(point)
    for k in keys:
        if k in out:
            v = _clean_number(out[k])
            if v is not None:
                out[k] = v * factor
    return out


def _normalise_lengths(feature: Feature, factor: float) -> None:
    """Scale all length-valued parameters of a feature to millimetres in place."""
    if factor == 1.0:
        return
    spec = _PARAM_SPEC.get(feature.type, {})
    for key in spec.get("lengths", ()):
        if key in feature.parameters:
            v = _clean_number(feature.parameters[key])
            if v is not None:
                feature.parameters[key] = v * factor
    # Nested coordinate structures
    if feature.type == "revolve_profile":
        feature.parameters["profile"] = [
            _scale_point(p, factor, ("radius", "z"))
            for p in feature.parameters.get("profile", [])
            if isinstance(p, dict)
        ]
    elif feature.type == "extrude_profile":
        feature.parameters["outline"] = [
            _scale_point(p, factor, ("x", "y"))
            for p in feature.parameters.get("outline", [])
            if isinstance(p, dict)
        ]
    elif feature.type == "stepped_bore":
        feature.parameters["segments"] = [
            _scale_point(s, factor, ("diameter", "zStart", "zEnd"))
            for s in feature.parameters.get("segments", [])
            if isinstance(s, dict)
        ]
    elif feature.type in ("through_bore", "blind_bore", "axial_port", "cavity",
                          "counterbore", "countersink", "pocket_circular",
                          "pocket_rectangular", "bolt_circle"):
        center = feature.parameters.get("center")
        if isinstance(center, dict):
            feature.parameters["center"] = _scale_point(center, factor, ("x", "y", "z"))
    elif feature.type == "internal_passage":
        for key in ("start", "end"):
            pt = feature.parameters.get(key)
            if isinstance(pt, dict):
                feature.parameters[key] = _scale_point(pt, factor, ("x", "y", "z"))
    elif feature.type == "base_box":
        center = feature.parameters.get("center")
        if isinstance(center, dict):
            feature.parameters["center"] = _scale_point(center, factor, ("x", "y", "z"))
    feature.units = "mm"


# ---------------------------------------------------------------------------
# Dependency graph helpers
# ---------------------------------------------------------------------------

def _find_cycles(ids: List[str], deps: Dict[str, List[str]]) -> List[List[str]]:
    """Return a list of dependency cycles (each as a node list)."""
    WHITE, GREY, BLACK = 0, 1, 2
    color: Dict[str, int] = {i: WHITE for i in ids}
    cycles: List[List[str]] = []
    stack: List[str] = []

    def visit(node: str) -> None:
        color[node] = GREY
        stack.append(node)
        for dep in deps.get(node, []):
            if dep not in color:
                continue
            if color[dep] == GREY:
                idx = stack.index(dep)
                cycles.append(stack[idx:] + [dep])
            elif color[dep] == WHITE:
                visit(dep)
        stack.pop()
        color[node] = BLACK

    for node in ids:
        if color[node] == WHITE:
            visit(node)
    return cycles


def _topological_order(ids: List[str], deps: Dict[str, List[str]]) -> List[str]:
    """Stable topological order (dependencies first)."""
    order: List[str] = []
    visited: Set[str] = set()

    def visit(node: str) -> None:
        if node in visited:
            return
        visited.add(node)
        for dep in deps.get(node, []):
            if dep in deps:
                visit(dep)
        order.append(node)

    for node in ids:
        visit(node)
    return order


# ---------------------------------------------------------------------------
# Per-feature validation
# ---------------------------------------------------------------------------

def _validate_feature_params(feature: Feature) -> Tuple[List[str], List[str]]:
    """Return (errors, missing) for a single feature's parameters."""
    errors: List[str] = []
    missing: List[str] = []
    spec = _PARAM_SPEC.get(feature.type)
    if spec is None:
        return [f"Feature '{feature.id}': unknown feature type '{feature.type}'."], []

    params = feature.parameters
    for key in spec.get("required", ()):
        if key not in params or params[key] is None:
            missing.append(f"{feature.id}.{key}")

    for key in spec.get("positive", ()):
        if key in params:
            v = _clean_number(params[key])
            if v is None:
                errors.append(f"Feature '{feature.id}': parameter '{key}' is not a finite number.")
            elif v <= 0:
                errors.append(f"Feature '{feature.id}': parameter '{key}' must be > 0 (got {v}).")

    for key in spec.get("count", ()):
        if key in params:
            v = _clean_number(params[key])
            if v is None:
                errors.append(f"Feature '{feature.id}': count '{key}' is not a finite number.")
            elif v < 1 or abs(v - round(v)) > 1e-9:
                errors.append(f"Feature '{feature.id}': count '{key}' must be a positive integer (got {v}).")
    for key in spec.get("counts", ()):
        if key in params:
            v = _clean_number(params[key])
            if v is None:
                errors.append(f"Feature '{feature.id}': count '{key}' is not a finite number.")
            elif v < 1 or abs(v - round(v)) > 1e-9:
                errors.append(f"Feature '{feature.id}': count '{key}' must be a positive integer (got {v}).")
    for key in spec.get("angles", ()):
        if key in params:
            v = _clean_number(params[key])
            if v is None:
                errors.append(f"Feature '{feature.id}': angle '{key}' must be a finite number of degrees.")

    # Type-specific structural checks
    ftype = feature.type
    if ftype == "base_cylinder":
        has_span = params.get("zStart") is not None and params.get("zEnd") is not None
        has_height = params.get("height") is not None
        if not has_span and not has_height:
            missing.append(f"{feature.id}.zStart")
            missing.append(f"{feature.id}.zEnd")
        if has_span:
            z0, z1 = _clean_number(params.get("zStart")), _clean_number(params.get("zEnd"))
            if z0 is None or z1 is None:
                errors.append(f"Feature '{feature.id}': zStart/zEnd must be finite.")
            elif z1 <= z0:
                errors.append(f"Feature '{feature.id}': zEnd must be > zStart ({z0} -> {z1}).")
    elif ftype == "revolve_profile":
        profile = params.get("profile")
        if not isinstance(profile, list) or len(profile) < 2:
            errors.append(f"Feature '{feature.id}': 'profile' needs >= 2 points.")
        else:
            for i, pt in enumerate(profile):
                if not isinstance(pt, dict) or _clean_number(pt.get("radius")) is None \
                        or _clean_number(pt.get("z")) is None:
                    errors.append(f"Feature '{feature.id}': profile point {i} needs finite radius & z.")
                    break
    elif ftype == "extrude_profile":
        outline = params.get("outline")
        if not isinstance(outline, list) or len(outline) < 3:
            errors.append(f"Feature '{feature.id}': 'outline' needs >= 3 points.")
        else:
            for i, pt in enumerate(outline):
                if not isinstance(pt, dict) or _clean_number(pt.get("x")) is None \
                        or _clean_number(pt.get("y")) is None:
                    errors.append(f"Feature '{feature.id}': outline point {i} needs finite x & y.")
                    break
    elif ftype == "stepped_bore":
        segs = params.get("segments")
        if not isinstance(segs, list) or not segs:
            errors.append(f"Feature '{feature.id}': 'segments' must be a non-empty list.")
        else:
            for i, s in enumerate(segs):
                if not isinstance(s, dict):
                    errors.append(f"Feature '{feature.id}': segment {i} must be an object.")
                    break
                d = _clean_number(s.get("diameter"))
                if d is None or d <= 0:
                    errors.append(f"Feature '{feature.id}': segment {i} needs diameter > 0.")
                    break
                if _clean_number(s.get("zStart")) is None or _clean_number(s.get("zEnd")) is None:
                    errors.append(f"Feature '{feature.id}': segment {i} needs finite zStart & zEnd.")
                    break
    elif ftype == "internal_passage":
        for key in ("start", "end"):
            pt = params.get(key)
            if not isinstance(pt, dict) or any(_clean_number(pt.get(k)) is None for k in ("x", "y", "z")):
                errors.append(f"Feature '{feature.id}': '{key}' must provide finite x, y, z.")
    elif ftype == "flange":
        shape = params.get("shape")
        if shape not in ("circular", "rectangular"):
            errors.append(f"Feature '{feature.id}': flange shape must be 'circular' or 'rectangular'.")
        elif shape == "circular":
            r = _clean_number(params.get("outerRadius"))
            if r is None or r <= 0:
                errors.append(f"Feature '{feature.id}': circular flange needs outerRadius > 0.")
        else:
            for k in ("length", "width"):
                v = _clean_number(params.get(k))
                if v is None or v <= 0:
                    errors.append(f"Feature '{feature.id}': rectangular flange needs {k} > 0.")
    elif ftype == "hole_pattern":
        pattern = params.get("pattern")
        if pattern not in ("linear", "grid", "bolt_circle"):
            errors.append(f"Feature '{feature.id}': hole_pattern 'pattern' must be linear|grid|bolt_circle.")
    elif ftype in ("fillet", "chamfer"):
        edges = params.get("edges")
        if not isinstance(edges, list) or not edges:
            errors.append(f"Feature '{feature.id}': 'edges' must be a non-empty selector list.")

    return errors, missing


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def validate_feature_recipe(recipe: Any) -> FeatureRecipeValidation:
    """Validate and normalise an advanced feature recipe.

    Accepts a :class:`FeatureRecipe` or a raw recipe ``dict``.  Returns a
    :class:`FeatureRecipeValidation` whose ``recipe`` is a normalised
    (millimetre) :class:`FeatureRecipe` with per-feature statuses populated.
    """
    errors: List[str] = []
    warnings: List[str] = []
    missing: List[str] = []
    feature_status: Dict[str, str] = {}
    feature_diagnostics: Dict[str, List[str]] = {}

    # --- Coerce to FeatureRecipe -----------------------------------------
    if isinstance(recipe, FeatureRecipe):
        fr = recipe
    elif isinstance(recipe, dict):
        if not is_feature_recipe_dict(recipe):
            # Allow a bare {"features": [...]} mapping for convenience.
            if not isinstance(recipe.get("features"), list):
                return FeatureRecipeValidation(
                    recipe=FeatureRecipe(),
                    status="rejected",
                    errors=["Input is not a recognised feature recipe (missing 'features')."],
                    feature_status=feature_status,
                    feature_diagnostics=feature_diagnostics,
                )
        fr = FeatureRecipe.from_dict(recipe)
    else:
        return FeatureRecipeValidation(
            recipe=FeatureRecipe(),
            status="rejected",
            errors=[f"Expected FeatureRecipe or dict, received {type(recipe).__name__}."],
            feature_status=feature_status,
            feature_diagnostics=feature_diagnostics,
        )

    # --- Recipe-level checks ---------------------------------------------
    if fr.version != FEATURE_RECIPE_VERSION:
        warnings.append(
            f"Recipe version '{fr.version}' differs from supported '{FEATURE_RECIPE_VERSION}'."
        )
    if fr.format != FEATURE_RECIPE_FORMAT:
        warnings.append(f"Recipe format '{fr.format}' is not the canonical '{FEATURE_RECIPE_FORMAT}'.")

    unit = str(fr.units or "mm").lower()
    if unit not in UNIT_CONVERSION_TO_MM:
        errors.append(f"Unsupported recipe units '{fr.units}'. Supported: {sorted(set(UNIT_CONVERSION_TO_MM))}.")
        factor = 1.0
    else:
        factor = UNIT_CONVERSION_TO_MM[unit]

    if not fr.features:
        errors.append("Feature recipe contains no features.")

    # --- Id uniqueness ----------------------------------------------------
    ids = [f.id for f in fr.features]
    seen: Set[str] = set()
    for fid in ids:
        if not fid:
            errors.append("A feature has an empty id.")
        elif fid in seen:
            errors.append(f"Duplicate feature id '{fid}'.")
        seen.add(fid)

    # --- Per-feature type & parameter checks -----------------------------
    for f in fr.features:
        f.diagnostics = []
        if f.type not in ALL_FEATURE_TYPES:
            msg = f"Unknown feature type '{f.type}'."
            errors.append(f"Feature '{f.id}': {msg}")
            f.validation_status = "invalid"
            f.diagnostics.append(msg)
            feature_status[f.id] = "invalid"
            feature_diagnostics[f.id] = list(f.diagnostics)
            continue

        derived = operation_for_type(f.type)
        if f.operation and f.operation != derived:
            warnings.append(
                f"Feature '{f.id}': operation '{f.operation}' overridden to '{derived}' for type '{f.type}'."
            )
        f.operation = derived or f.operation

        # Unit normalisation (before numeric checks so tolerances are consistent)
        _normalise_lengths(f, factor)

        f_errors, f_missing = _validate_feature_params(f)
        errors.extend(f_errors)
        missing.extend(f_missing)

        if f_errors:
            f.validation_status = "invalid"
            f.diagnostics.extend(f_errors)
            feature_status[f.id] = "invalid"
        elif f_missing:
            f.validation_status = "invalid"
            f.diagnostics.append("Missing required parameters: " + ", ".join(f_missing))
            feature_status[f.id] = "invalid"
        else:
            f.validation_status = "valid"
            feature_status[f.id] = "valid"
        feature_diagnostics[f.id] = list(f.diagnostics)

    # --- Dependency graph -------------------------------------------------
    id_set = set(ids)
    deps: Dict[str, List[str]] = {}
    for f in fr.features:
        deps[f.id] = []
        for dep in f.depends_on:
            if dep not in id_set:
                errors.append(f"Feature '{f.id}': depends on unknown feature '{dep}'.")
                f.validation_status = "invalid"
                f.diagnostics.append(f"Unknown dependency '{dep}'.")
            elif dep == f.id:
                errors.append(f"Feature '{f.id}': cannot depend on itself.")
                f.validation_status = "invalid"
            else:
                deps[f.id].append(dep)

    cycles = _find_cycles(ids, deps)
    for cyc in cycles:
        errors.append("Dependency cycle detected: " + " -> ".join(cyc) + ".")
        for node in cyc:
            f = fr.get_feature(node)
            if f:
                f.validation_status = "invalid"
                f.diagnostics.append("Part of a dependency cycle.")

    # Re-order features topologically if the original order violates deps.
    if not cycles and any(f.depends_on for f in fr.features):
        ordered_ids = _topological_order(ids, deps)
        if ordered_ids != ids:
            by_id = {f.id: f for f in fr.features}
            fr.features = [by_id[i] for i in ordered_ids]
            warnings.append("Feature order normalised to satisfy dependencies.")

    # --- Status determination --------------------------------------------
    if errors:
        status = "rejected"
    elif missing:
        status = "needs_input"
    else:
        status = "ok"

    return FeatureRecipeValidation(
        recipe=fr,
        status=status,
        errors=errors,
        warnings=warnings,
        missing=missing,
        feature_status=feature_status,
        feature_diagnostics=feature_diagnostics,
    )
