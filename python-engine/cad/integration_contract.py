"""
integration_contract.py — Stable JSON interface between the Reconstruction
Engine and the ReForge AI CAD subsystem.

This module does **not** implement the Vision→Reconstruction pipeline.  It
defines, validates and documents the contract that the Reconstruction Engine
must satisfy when it eventually hands a part description to CAD.

Contract summary (``reforge-cad-interface`` v1.0)
-------------------------------------------------
A single JSON document describes one component:

* ``component``      — identity, component type and geometry style,
* ``units``          — metric length unit and scale status,
* ``dimensions``     — a named dimension table.  In v1.0 **every** dimension is
                       an object carrying a numeric ``value``, a semantic
                       ``unit`` (length / angle / count / dimensionless) and a
                       ``provenance``; bare numbers are not permitted.  Optional
                       ``uncertainty`` / ``confidence`` are accepted but never
                       invented,
* ``features``       — the **ordered** additive / subtractive / finish feature
                       list.  Every feature **must** carry an explicit
                       ``operation`` that agrees with the feature-type registry,
                       plus positions, orientations and dependencies,
* ``missing_dimensions`` / ``assumptions`` — explicit, never silently invented,
* ``provenance``     — where the description came from.

Features may reference a named dimension with ``{"$dim": "<name>"}`` instead of
a literal number.  Every such reference is resolved from the dimension table;
a missing or unreliable dimension is an **error**, never a default.  The
declared semantic unit of a dimension is validated against the deterministic
feature-parameter registry (``cad/feature_recipe_validator.parameter_semantic``):
counts must be integers, angles are degrees, lengths metric, everything else
dimensionless.  The runtime validator and :func:`interface_json_schema` enforce
the same structural requirements.

Public API
----------
``validate_interface(doc, **opts) -> dict``
    Validate an interface document and (on success) build a
    :class:`~cad.feature_schema.FeatureRecipe`.  Returns a structured result
    with ``valid``, ``status``, ``issues``, ``warnings`` and ``recipe``.
``feature_recipe_from_interface(doc, **opts)``
    Alias returning the same result (kept for readability at call sites).
``interface_from_recipe(recipe, **meta) -> dict``
    Convert a feature recipe into an interface document (used to build the
    worked example and to let CAD re-emit a contract-shaped document).
``interface_from_solver_result(result, **meta) -> dict``
    Convert a Reconstruction ``SolverResult`` into an interface document,
    preserving solver units/scale/provenance truthfully.
``example_housing_interface() -> dict``
    A complete, realistic example document that Reconstruction could emit for
    the reference mechanical housing.
``interface_json_schema() -> dict``
    A JSON Schema (Draft 2020-12) for the contract.
"""

from __future__ import annotations

import copy
import math
from typing import Any, Dict, List, Optional, Tuple

try:  # package + flat import styles
    from cad.feature_schema import (
        ADDITIVE_FEATURE_TYPES,
        FINISH_FEATURE_TYPES,
        OPERATION_ADDITIVE,
        OPERATION_FINISH,
        OPERATION_SUBTRACTIVE,
        SUBTRACTIVE_FEATURE_TYPES,
        FeatureRecipe,
        operation_for_type,
    )
    from cad.feature_recipe_validator import (
        SEMANTIC_ANGLE,
        SEMANTIC_COUNT,
        SEMANTIC_DIMENSIONLESS,
        SEMANTIC_LENGTH,
        UNIT_CONVERSION_TO_MM,
        parameter_semantic,
        validate_feature_recipe,
    )
    from cad.specimens.advanced_housing import (
        HOUSING_DIMENSIONS,
        build_advanced_housing_recipe,
    )
except ImportError:  # pragma: no cover
    try:
        from feature_schema import (  # type: ignore
            ADDITIVE_FEATURE_TYPES,
            FINISH_FEATURE_TYPES,
            OPERATION_ADDITIVE,
            OPERATION_FINISH,
            OPERATION_SUBTRACTIVE,
            SUBTRACTIVE_FEATURE_TYPES,
            FeatureRecipe,
            operation_for_type,
        )
        from feature_recipe_validator import (  # type: ignore
            SEMANTIC_ANGLE,
            SEMANTIC_COUNT,
            SEMANTIC_DIMENSIONLESS,
            SEMANTIC_LENGTH,
            UNIT_CONVERSION_TO_MM,
            parameter_semantic,
            validate_feature_recipe,
        )
        from specimens.advanced_housing import (  # type: ignore
            HOUSING_DIMENSIONS,
            build_advanced_housing_recipe,
        )
    except ImportError:
        from python_engine.cad.feature_schema import (  # type: ignore
            ADDITIVE_FEATURE_TYPES,
            FINISH_FEATURE_TYPES,
            OPERATION_ADDITIVE,
            OPERATION_FINISH,
            OPERATION_SUBTRACTIVE,
            SUBTRACTIVE_FEATURE_TYPES,
            FeatureRecipe,
            operation_for_type,
        )
        from python_engine.cad.feature_recipe_validator import (  # type: ignore
            SEMANTIC_ANGLE,
            SEMANTIC_COUNT,
            SEMANTIC_DIMENSIONLESS,
            SEMANTIC_LENGTH,
            UNIT_CONVERSION_TO_MM,
            parameter_semantic,
            validate_feature_recipe,
        )
        from python_engine.cad.specimens.advanced_housing import (  # type: ignore
            HOUSING_DIMENSIONS,
            build_advanced_housing_recipe,
        )

INTERFACE_FORMAT = "reforge-cad-interface"
INTERFACE_VERSION = "1.0"

#: Known component types (the contract is open — ``custom`` is always allowed).
COMPONENT_TYPES: Tuple[str, ...] = (
    "housing", "bracket", "flange", "plate", "shaft", "gear",
    "enclosure", "cover", "bushing", "manifold", "custom",
)

#: Known geometry styles describing how the primary body is formed.
GEOMETRY_STYLES: Tuple[str, ...] = (
    "revolved", "prismatic", "revolved_with_features", "extruded_profile",
    "sheet_metal", "freeform", "custom",
)

#: Valid scale statuses.  ``unknown`` means the real-world scale cannot be
#: trusted and the document is rejected.
SCALE_STATUSES: Tuple[str, ...] = ("absolute", "scaled", "unknown")

#: Measurement provenance vocabulary.
PROVENANCE_KINDS: Tuple[str, ...] = (
    "measured", "derived", "user_specified", "assumed", "unknown",
)

_METRIC_UNITS: Tuple[str, ...] = ("mm", "millimeter", "millimeters",
                                  "cm", "centimeter", "centimeters",
                                  "m", "meter", "meters")

_DIM_REF_KEYS = ("$dim", "dimension")

#: Accepted unit spellings for each non-length semantic class.  Declared once so
#: the runtime validator and the published JSON Schema cannot drift apart.
_ANGLE_UNITS: Tuple[str, ...] = ("deg", "degree", "degrees")
_COUNT_UNITS: Tuple[str, ...] = ("count", "counts", "integer", "pcs", "pieces")
_DIMENSIONLESS_UNITS: Tuple[str, ...] = ("dimensionless", "none", "ratio", "1")

#: Canonical dimension unit token per semantic class.
_SEMANTIC_UNIT: Dict[str, str] = {
    SEMANTIC_LENGTH: "mm",
    SEMANTIC_ANGLE: "deg",
    SEMANTIC_COUNT: "count",
    SEMANTIC_DIMENSIONLESS: "dimensionless",
}

#: Accepted unit spellings per semantic class (case-insensitive).
#:
#: The empty string is deliberately **not** a member of any class: it would be
#: ambiguous (both a count and a dimensionless value), so it is rejected.
_SEMANTIC_UNIT_ALIASES: Dict[str, set] = {
    SEMANTIC_LENGTH: set(_METRIC_UNITS),
    SEMANTIC_ANGLE: set(_ANGLE_UNITS),
    SEMANTIC_COUNT: set(_COUNT_UNITS),
    SEMANTIC_DIMENSIONLESS: set(_DIMENSIONLESS_UNITS),
}

#: All valid feature operation classes.
OPERATIONS: Tuple[str, ...] = (
    OPERATION_ADDITIVE, OPERATION_SUBTRACTIVE, OPERATION_FINISH,
)

#: Solver provenance -> interface provenance vocabulary.
_SOLVER_PROVENANCE_MAP: Dict[str, str] = {
    "USER_PROVIDED": "user_specified",
    "CALIBRATED_IMAGE": "measured",
    "OPENCV_OBSERVATION": "derived",
    "COLMAP_RECONSTRUCTION": "derived",
    "DEPTH_PRIOR": "derived",
    "GEOMETRIC_CONSTRAINT": "derived",
    "GEMINI_PROPOSAL": "assumed",
}

#: Provenance marker used when the point cloud did **not** come from a real
#: COLMAP run (e.g. a deterministic synthetic test fixture).  The Reconstruction
#: cylinder branch labels a point-cloud fit ``COLMAP_RECONSTRUCTION`` by default,
#: so a caller that knows the true source records it explicitly via
#: :func:`record_fixture_source` and the adapter never claims a COLMAP run.
SYNTHETIC_FIXTURE_PROVENANCE = "SYNTHETIC_FIXTURE"


def record_fixture_source(result: Any, *, source: str, note: Optional[str] = None,
                          colmap_executed: bool = False) -> Any:
    """Record the **true** source of the input that produced a ``SolverResult``.

    The Reconstruction Engine's cylinder point-cloud branch stamps a point-cloud
    fit with provenance ``COLMAP_RECONSTRUCTION`` even when the points were not
    produced by COLMAP (for example the deterministic synthetic cylinder used by
    the integration tests).  When the caller knows the real source it should call
    this helper so the solver result, the adapted interface document and the
    written evidence never label synthetic fixture data as an actual COLMAP
    reconstruction.

    ``result`` is mutated in place (its ``metadata`` is annotated and any
    parameter that still claims ``COLMAP_RECONSTRUCTION`` while ``colmap_executed``
    is ``False`` is re-labelled :data:`SYNTHETIC_FIXTURE_PROVENANCE`); the same
    object is returned for convenience.  Parameter *classifications*
    (``ESTIMATED`` / ``MEASURED``) are never changed.
    """
    meta = getattr(result, "metadata", None)
    if meta is None and isinstance(result, dict):
        meta = result.setdefault("metadata", {})
    if isinstance(meta, dict):
        meta["fixture_source"] = source
        meta["colmap_executed"] = bool(colmap_executed)
        meta["fixture_note"] = note or (
            f"Input source: {source}; COLMAP executed: {bool(colmap_executed)}.")

    params = getattr(result, "parameters", None)
    if params is None and isinstance(result, dict):
        params = result.get("parameters")
    if not colmap_executed and isinstance(params, dict):
        for pdata in params.values():
            if not isinstance(pdata, dict):
                continue
            prov = pdata.get("provenance")
            if isinstance(prov, list) and "COLMAP_RECONSTRUCTION" in prov:
                pdata["provenance"] = [
                    SYNTHETIC_FIXTURE_PROVENANCE if str(v) == "COLMAP_RECONSTRUCTION" else v
                    for v in prov
                ]
    return result




# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _clean_number(v: Any) -> Optional[float]:
    if not _is_number(v):
        return None
    f = float(v)
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _resolve_dim_refs(value: Any, dims: Dict[str, Any],
                      missing: List[str]) -> Any:
    """Recursively resolve ``{"$dim": name}`` references inside ``value``."""
    if isinstance(value, dict):
        for key in _DIM_REF_KEYS:
            if key in value and isinstance(value[key], str):
                name = value[key]
                if name not in dims:
                    missing.append(name)
                    return value
                return dims[name]
        return {k: _resolve_dim_refs(v, dims, missing) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_dim_refs(v, dims, missing) for v in value]
    return value


def _iter_dim_refs(value: Any) -> List[str]:
    """Return every ``$dim`` name referenced inside ``value``."""
    refs: List[str] = []
    if isinstance(value, dict):
        for key in _DIM_REF_KEYS:
            if key in value and isinstance(value[key], str):
                refs.append(value[key])
                return refs
        for v in value.values():
            refs.extend(_iter_dim_refs(v))
    elif isinstance(value, list):
        for v in value:
            refs.extend(_iter_dim_refs(v))
    return refs


def _collect_param_refs(params: Any) -> List[Tuple[str, str]]:
    """Return ``(parameter_key, dimension_name)`` for every reference in ``params``."""
    pairs: List[Tuple[str, str]] = []
    if not isinstance(params, dict):
        return pairs
    for key, val in params.items():
        for name in _iter_dim_refs(val):
            pairs.append((str(key), name))
    return pairs


def _semantic_for_ref(feature_type: str, key: str) -> str:
    """Semantic unit class of a dimension referenced by ``feature_type.key``."""
    return parameter_semantic(feature_type, key)



# ---------------------------------------------------------------------------
# Dimension table validation
# ---------------------------------------------------------------------------

def _check_dimension(name: str, raw: Any, *, referenced: bool,
                     expected_semantic: Optional[str] = None,
                     min_confidence: float, max_rel_uncertainty: float,
                     allow_assumed: bool) -> Tuple[Optional[float], List[str], List[str]]:
    """Validate a single dimension entry.

    Returns ``(value, errors, warnings)``.  The value is returned in the
    *declared* unit (unit conversion happens later via the recipe validator);
    only its reliability and semantic unit are assessed here.
    """
    errors: List[str] = []
    warnings: List[str] = []
    # Structural problems (missing value / unit / provenance) are *always*
    # errors so the runtime stays consistent with the published JSON Schema.
    # Reliability / semantic-mismatch problems are errors only for dimensions a
    # feature actually references, and warnings otherwise.
    soft = errors if referenced else warnings

    def _check_semantic(value: Optional[float], unit: Any) -> None:
        if expected_semantic is None or value is None:
            return
        if unit is not None and str(unit).lower() not in _SEMANTIC_UNIT_ALIASES[expected_semantic]:
            soft.append(
                f"Dimension '{name}' declares unit '{unit}' but is used as a "
                f"{expected_semantic} (expected '{_SEMANTIC_UNIT[expected_semantic]}').")
        if expected_semantic == SEMANTIC_COUNT and abs(value - round(value)) > 1e-9:
            soft.append(f"Dimension '{name}' is used as a count and must be an "
                        f"integer (got {value}).")
        if expected_semantic == SEMANTIC_ANGLE and not (0.0 <= value <= 360.0):
            # Angles outside [0, 360] are legal (e.g. full revolutions) but
            # almost always a unit error, so surface it as a warning.
            warnings.append(
                f"Dimension '{name}' angle {value} is outside the usual 0-360 deg range.")

    if _is_number(raw):
        # v1.0 requires a semantic unit and provenance for every dimension, so a
        # bare number is never acceptable (schema and runtime agree).
        errors.append(
            f"Dimension '{name}' must be an object with 'value', 'unit' and "
            f"'provenance'; bare numbers are not permitted in v1.0.")
        value = _clean_number(raw)
        _check_semantic(value, None)
        return value, errors, warnings

    if not isinstance(raw, dict):
        errors.append(f"Dimension '{name}' must be an object.")
        return None, errors, warnings

    value = _clean_number(raw.get("value"))
    if value is None:
        errors.append(f"Dimension '{name}' is missing a finite numeric 'value'.")
        return None, errors, warnings

    # A semantic unit is mandatory.  It must be one of the recognised tokens
    # (the union of every semantic class), so unknown unit strings fail.
    all_units: set = set()
    for _aliases in _SEMANTIC_UNIT_ALIASES.values():
        all_units |= _aliases
    unit = raw.get("unit")
    if unit is None:
        errors.append(f"Dimension '{name}' does not declare a 'unit'.")
    elif str(unit).lower() not in all_units:
        errors.append(f"Dimension '{name}' declares unknown unit '{unit}'.")

    # A value that declares a count unit must be a whole number.  This mirrors
    # the JSON Schema's ``if unit in count-units then value is an integer``
    # branch and is a *structural* error (independent of whether any feature
    # references the dimension), so the runtime and the schema always agree.
    if unit is not None and str(unit).lower() in _SEMANTIC_UNIT_ALIASES[SEMANTIC_COUNT]:
        if abs(value - round(value)) > 1e-9:
            errors.append(
                f"Dimension '{name}' declares count unit '{unit}' but its value "
                f"{value} is not an integer.")

    provenance = raw.get("provenance")
    if provenance is None:
        errors.append(f"Dimension '{name}' does not declare 'provenance'.")
    elif provenance not in PROVENANCE_KINDS:
        errors.append(f"Dimension '{name}' has unknown provenance '{provenance}'.")
    elif provenance == "unknown":
        soft.append(f"Dimension '{name}' has provenance 'unknown' (unreliable).")
    elif provenance == "assumed" and not allow_assumed:
        soft.append(f"Dimension '{name}' is 'assumed'; refusing to invent it "
                    "(pass allow_assumed=True to accept).")

    confidence = raw.get("confidence")
    if confidence is not None:
        c = _clean_number(confidence)
        if c is None or not (0.0 <= c <= 1.0):
            soft.append(f"Dimension '{name}' has invalid confidence '{confidence}'.")
        elif c < min_confidence:
            soft.append(f"Dimension '{name}' confidence {c} is below the "
                        f"minimum {min_confidence}.")

    uncertainty = raw.get("uncertainty")
    if uncertainty is not None:
        u = _clean_number(uncertainty)
        if u is None or u < 0:
            soft.append(f"Dimension '{name}' has invalid uncertainty '{uncertainty}'.")
        elif value > 0 and (u / abs(value)) > max_rel_uncertainty:
            soft.append(f"Dimension '{name}' relative uncertainty "
                        f"{u / abs(value):.3f} exceeds {max_rel_uncertainty}.")

    _check_semantic(value, unit)
    return value, errors, warnings



# ---------------------------------------------------------------------------
# Primary validation
# ---------------------------------------------------------------------------

def validate_interface(doc: Any, *,
                       allow_assumed: bool = False,
                       min_confidence: float = 0.5,
                       max_rel_uncertainty: float = 0.2) -> Dict[str, Any]:
    """Validate a Reconstruction→CAD interface document.

    On success the built :class:`FeatureRecipe` is available under ``recipe``
    (and its normalised dict under ``recipe_dict``).

    Args:
        doc: The interface document (``dict``).
        allow_assumed: Accept dimensions marked ``provenance == "assumed"``.
        min_confidence: Minimum accepted per-dimension confidence.
        max_rel_uncertainty: Maximum accepted relative uncertainty.
    """
    issues: List[str] = []
    warnings: List[str] = []
    missing_dimensions: List[str] = []
    unreliable: List[str] = []
    # Issues caused solely by absent (never invented) input, as opposed to
    # structural/reliability errors.  Used to choose needs_input vs rejected.
    missing_related_issues: List[str] = []
    result: Dict[str, Any] = {
        "valid": False,
        "status": "rejected",
        "issues": issues,
        "warnings": warnings,
        "missing_dimensions": missing_dimensions,
        "unreliable_dimensions": unreliable,
        "dimension_semantics": {},
        "recipe": None,
        "recipe_dict": None,
        "component": {},
        "diagnostics": {},
    }

    if not isinstance(doc, dict):
        issues.append(f"Interface document must be an object, got {type(doc).__name__}.")
        return result

    fmt = doc.get("format")
    if fmt != INTERFACE_FORMAT:
        issues.append(f"Unsupported interface format '{fmt}' (expected '{INTERFACE_FORMAT}').")
    version = doc.get("version")
    if version is None:
        issues.append("Interface document is missing 'version'.")
    elif str(version) != INTERFACE_VERSION:
        warnings.append(f"Interface version '{version}' differs from supported '{INTERFACE_VERSION}'.")

    # ---- component ------------------------------------------------------
    comp = doc.get("component")
    if not isinstance(comp, dict):
        issues.append("'component' must be an object.")
        comp = {}
    else:
        result["component"] = {
            "id": comp.get("id"),
            "type": comp.get("type"),
            "geometry_style": comp.get("geometry_style"),
            "name": comp.get("name"),
        }
        if not comp.get("id"):
            issues.append("'component.id' is required.")
        ctype = comp.get("type")
        if not ctype:
            issues.append("'component.type' is required.")
        elif ctype not in COMPONENT_TYPES:
            warnings.append(f"Unknown component type '{ctype}' (continuing as custom).")
        style = comp.get("geometry_style")
        if not style:
            issues.append("'component.geometry_style' is required.")
        elif style not in GEOMETRY_STYLES:
            warnings.append(f"Unknown geometry style '{style}' (continuing as custom).")

    # ---- units ----------------------------------------------------------
    units = doc.get("units")
    scale_factor = 1.0
    if not isinstance(units, dict):
        issues.append("'units' must be an object.")
    else:
        length = str(units.get("length", "")).lower()
        if length not in _METRIC_UNITS:
            issues.append(
                f"Interface must use metric units; got '{units.get('length')}'.")
        scale_status = units.get("scale_status")
        if scale_status not in SCALE_STATUSES:
            issues.append(
                f"'units.scale_status' must be one of {SCALE_STATUSES}; "
                f"got '{scale_status}'.")
        elif scale_status == "unknown":
            issues.append("'units.scale_status' is 'unknown': real-world scale "
                          "cannot be trusted.")
        elif scale_status == "scaled":
            sf = _clean_number(units.get("scale_factor"))
            if sf is None or sf <= 0:
                issues.append("'units.scale_status' is 'scaled' but no positive "
                              "numeric 'scale_factor' was supplied.")
            else:
                scale_factor = sf

    # ---- dimensions -----------------------------------------------------
    dims_raw = doc.get("dimensions")
    dims: Dict[str, Any] = {}
    if not isinstance(dims_raw, dict):
        issues.append("'dimensions' must be an object keyed by dimension name.")
        dims_raw = {}

    # ---- features (collect references first) ----------------------------
    features = doc.get("features")
    if not isinstance(features, list) or not features:
        issues.append("'features' must be a non-empty ordered list.")
        features = []

    referenced: set = set()
    ref_semantics: Dict[str, set] = {}
    ref_keys: Dict[str, set] = {}
    for feat in features:
        if not isinstance(feat, dict):
            continue
        ftype = str(feat.get("type") or "")
        for key, name in _collect_param_refs(feat.get("parameters")):
            referenced.add(name)
            ref_semantics.setdefault(name, set()).add(_semantic_for_ref(ftype, key))
            ref_keys.setdefault(name, set()).add(f"{ftype}.{key}")

    for name, sems in sorted(ref_semantics.items()):
        if len(sems) > 1:
            issues.append(
                f"Dimension '{name}' is referenced with conflicting semantic "
                f"units {sorted(sems)} (by {sorted(ref_keys[name])}).")

    declared_missing = doc.get("missing_dimensions")
    if isinstance(declared_missing, list):
        missing_dimensions.extend(str(m) for m in declared_missing)

    # Validate referenced dimensions that are declared.
    for name in sorted(referenced):
        sems = ref_semantics.get(name) or set()
        expected_semantic = next(iter(sems)) if len(sems) == 1 else None
        if name not in dims_raw:
            if name not in missing_dimensions:
                missing_dimensions.append(name)
            unreliable.append(name)
            continue
        value, errs, warns = _check_dimension(
            name, dims_raw[name], referenced=True,
            expected_semantic=expected_semantic,
            min_confidence=min_confidence, max_rel_uncertainty=max_rel_uncertainty,
            allow_assumed=allow_assumed)
        issues.extend(errs)
        warnings.extend(warns)
        if value is None or errs:
            unreliable.append(name)
        else:
            dims[name] = value * scale_factor

    # Validate the remaining (declared but unreferenced) dimensions structurally.
    for name, raw in dims_raw.items():
        if name in dims:
            continue
        value, errs, warns = _check_dimension(
            name, raw, referenced=False,
            min_confidence=min_confidence, max_rel_uncertainty=max_rel_uncertainty,
            allow_assumed=allow_assumed)
        # Structural errors (missing value/unit/provenance) are hard errors even
        # for unreferenced dimensions, matching the JSON Schema.
        issues.extend(errs)
        warnings.extend(warns)
        if value is not None and not errs:
            dims[name] = value * scale_factor

    # ---- build the feature recipe ---------------------------------------
    built_features: List[Dict[str, Any]] = []
    for i, feat in enumerate(features):
        if not isinstance(feat, dict):
            issues.append(f"Feature #{i} must be an object.")
            continue
        fid = feat.get("id") or f"feature_{i}"
        ftype = feat.get("type")
        if not ftype:
            issues.append(f"Feature '{fid}' is missing 'type'.")
        derived_op = operation_for_type(str(ftype)) if ftype else None
        supplied_op = feat.get("operation")
        if supplied_op is None or str(supplied_op).strip() == "":
            issues.append(
                f"Feature '{fid}': 'operation' is required for every feature "
                f"(expected '{derived_op or '<operation>'}').")
        elif str(supplied_op) not in OPERATIONS:
            issues.append(
                f"Feature '{fid}': invalid operation '{supplied_op}' "
                f"(must be one of {OPERATIONS}).")
        elif derived_op is not None and str(supplied_op) != derived_op:
            issues.append(
                f"Feature '{fid}': operation '{supplied_op}' is inconsistent "
                f"with type '{ftype}' (expected '{derived_op}').")
        params = feat.get("parameters")
        if not isinstance(params, dict):
            issues.append(f"Feature '{fid}' must provide a 'parameters' object.")
            params = {}
        # Semantic validation of literal (non-reference) parameter values.
        for key, val in params.items():
            if isinstance(val, (dict, list)):
                continue
            sem = parameter_semantic(str(ftype), key)
            if sem == SEMANTIC_COUNT and _is_number(val) \
                    and abs(float(val) - round(float(val))) > 1e-9:
                issues.append(
                    f"Feature '{fid}': parameter '{key}' is a count and must be "
                    f"an integer (got {val}).")
        resolved = _resolve_dim_refs(copy.deepcopy(params), dims, missing_dimensions)
        unresolved = sorted(set(_iter_dim_refs(resolved)))
        if unresolved:
            # A feature that cannot be built because a required dimension is
            # missing is omitted *explicitly* (never modelled with a placeholder),
            # so the whole document is reported as needing more input.
            issues.append(
                f"Feature '{fid}' ({ftype}) omitted: required dimension(s) "
                f"{', '.join(unresolved)} are missing.")
            missing_related_issues.append(issues[-1])
            continue
        built_features.append({
            "id": str(fid),
            "type": str(ftype or ""),
            "operation": derived_op or (str(supplied_op) if supplied_op else ""),
            "parameters": resolved,
            "position": feat.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0},
            "orientation": feat.get("orientation") or {"axis": [0.0, 0.0, 1.0], "angleDeg": 0.0},
            "units": units.get("length", "mm") if isinstance(units, dict) else "mm",
            "depends_on": list(feat.get("depends_on") or []),
            "metadata": dict(feat.get("metadata") or {}),
        })

    result["dimension_semantics"] = {k: sorted(v) for k, v in ref_semantics.items()}


    if missing_dimensions:
        issues.append("Missing dimension(s) required by features: "
                      + ", ".join(sorted(set(missing_dimensions))) + ".")
        missing_related_issues.append(issues[-1])

    recipe_dict = {
        "format": "reforge-feature-recipe",
        "version": "1.0",
        "name": (comp.get("name") if isinstance(comp, dict) else None) or "reconstructed_part",
        "units": (units.get("length", "mm") if isinstance(units, dict) else "mm"),
        "features": built_features,
        "expected": dict(doc.get("expected") or {}),
        "metadata": {
            "source": "reconstruction-engine",
            "interface_format": INTERFACE_FORMAT,
            "interface_version": INTERFACE_VERSION,
            "component": result["component"],
            "provenance": doc.get("provenance") or {},
            "assumptions": list(doc.get("assumptions") or []),
            "dimensions": dict(dims_raw),
        },
    }

    # ---- run the standard recipe validator ------------------------------
    recipe_validation = validate_feature_recipe(recipe_dict)
    result["diagnostics"] = {
        "recipe_status": recipe_validation.status,
        "recipe_errors": list(recipe_validation.errors),
        "recipe_missing": list(recipe_validation.missing),
        "recipe_warnings": list(recipe_validation.warnings),
        "feature_status": dict(recipe_validation.feature_status),
    }
    warnings.extend(recipe_validation.warnings)
    if recipe_validation.status == "rejected":
        issues.extend(recipe_validation.errors)
    elif recipe_validation.status == "needs_input":
        for m in recipe_validation.missing:
            issues.append(f"Missing required parameter: {m}")
            missing_related_issues.append(issues[-1])

    recipe = recipe_validation.recipe
    result["recipe"] = recipe
    result["recipe_dict"] = recipe.to_dict()
    result["unreliable_dimensions"] = sorted(set(unreliable))

    result["valid"] = bool(not issues and recipe_validation.status == "ok")
    if result["valid"]:
        result["status"] = "ok"
    else:
        hard_issues = [i for i in issues if i not in missing_related_issues]
        if hard_issues or recipe_validation.status == "rejected":
            result["status"] = "rejected"
        else:
            result["status"] = "needs_input"
    return result


def feature_recipe_from_interface(doc: Any, **opts: Any) -> Dict[str, Any]:
    """Convenience alias for :func:`validate_interface`."""
    return validate_interface(doc, **opts)


# ---------------------------------------------------------------------------
# Recipe -> interface (reverse direction, used for the worked example)
# ---------------------------------------------------------------------------

def interface_from_recipe(recipe: Dict[str, Any], *,
                          provenance: str = "derived",
                          uncertainty: Optional[float] = None,
                          confidence: Optional[float] = None,
                          component_id: str = "reconstructed_part",
                          component_type: str = "housing",
                          geometry_style: str = "revolved_with_features",
                          source: str = "reconstruction-engine",
                          assumptions: Optional[List[str]] = None,
                          missing_dimensions: Optional[List[str]] = None) -> Dict[str, Any]:
    """Convert a feature recipe into a contract-shaped interface document.

    Every top-level numeric parameter becomes a named dimension entry carrying
    provenance metadata **and the correct semantic unit** (``mm`` for lengths,
    ``deg`` for angles, ``count`` for integer counts, ``dimensionless``
    otherwise), and the feature parameter is replaced by a ``$dim`` reference.
    Nested structures (segment lists, point coordinates) are kept literal.

    ``confidence`` / ``uncertainty`` are only emitted when explicitly supplied;
    they are never invented.
    """
    dims: Dict[str, Any] = {}
    out_features: List[Dict[str, Any]] = []

    for feat in recipe.get("features", []):
        fid = feat.get("id", "feature")
        ftype = str(feat.get("type") or "")
        params = feat.get("parameters", {})
        new_params: Dict[str, Any] = {}
        for key, val in params.items():
            if _is_number(val):
                sem = parameter_semantic(ftype, key)
                dim_name = f"{fid}__{key}"
                num = float(val)
                if sem == SEMANTIC_COUNT and num.is_integer():
                    num = int(num)
                entry: Dict[str, Any] = {
                    "value": num,
                    "unit": _SEMANTIC_UNIT[sem],
                    "provenance": provenance,
                }
                if uncertainty is not None:
                    entry["uncertainty"] = uncertainty
                if confidence is not None:
                    entry["confidence"] = confidence
                dims[dim_name] = entry
                new_params[key] = {"$dim": dim_name}
            else:
                new_params[key] = copy.deepcopy(val)
        out_features.append({
            "id": fid,
            "type": feat.get("type"),
            "operation": operation_for_type(ftype) or "",
            "parameters": new_params,
            "position": feat.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0},
            "orientation": feat.get("orientation") or {"axis": [0.0, 0.0, 1.0], "angleDeg": 0.0},
            "depends_on": list(feat.get("depends_on") or []),
            "metadata": dict(feat.get("metadata") or {}),
        })

    return {
        "format": INTERFACE_FORMAT,
        "version": INTERFACE_VERSION,
        "component": {
            "id": component_id,
            "type": component_type,
            "geometry_style": geometry_style,
            "name": recipe.get("name", "reconstructed_part"),
        },
        "units": {"length": "mm", "scale_status": "absolute", "scale_factor": 1.0},
        "dimensions": dims,
        "features": out_features,
        "missing_dimensions": list(missing_dimensions or []),
        "assumptions": list(assumptions or []),
        "expected": dict(recipe.get("expected") or {}),
        "provenance": {
            "source": source,
            "method": "feature-recipe-serialisation",
        },
    }


def example_housing_interface() -> Dict[str, Any]:
    """A complete example interface document for the reference housing.

    It is generated from the validated housing recipe so the example is real,
    self-consistent and round-trips back to the same model.
    """
    recipe = build_advanced_housing_recipe()
    doc = interface_from_recipe(
        recipe,
        # The reference dimensions are *documented user/fixture values*, not
        # measurements recovered from photographs.  Provenance is therefore
        # truthful and no confidence/uncertainty is fabricated.
        provenance="user_specified",
        component_id="adv_housing_001",
        component_type="housing",
        geometry_style="revolved_with_features",
        source="demo-fixture (documented reference dimensions)",
        assumptions=[
            "The part is symmetric about the Z axis unless a feature states otherwise.",
            "All unspecified fillets/chamfers are absent.",
            "Dimensions are documented reference values supplied by the user, "
            "not measured from imagery.",
        ],
        missing_dimensions=[],
    )
    doc["provenance"].update({
        "source": "demo-fixture",
        "method": "documented-reference-dimensions",
        "views": [],
        "units_scale": "absolute mm (documented)",
        "notes": "Reference example: every dimension is a documented fixture "
                 "value with provenance 'user_specified'. No confidence or "
                 "uncertainty is claimed because none was measured.",
    })
    doc["expected"] = dict(recipe.get("expected") or {})
    return doc


# ---------------------------------------------------------------------------
# Reconstruction SolverResult -> interface
# ---------------------------------------------------------------------------

def _solver_param_semantic(name: str) -> str:
    """Semantic unit class for a solver parameter name."""
    lname = name.lower()
    if "angle" in lname:
        return SEMANTIC_ANGLE
    if lname in ("teeth", "numteeth", "tooth_count", "count"):
        return SEMANTIC_COUNT
    return SEMANTIC_LENGTH


def _solver_dimension_provenance(param: Dict[str, Any]) -> str:
    """Map a solver GeometricParameter to the interface provenance vocabulary."""
    provs = [str(p) for p in (param.get("provenance") or [])]
    classification = str(param.get("classification") or "UNKNOWN")
    if classification == "MEASURED":
        if "USER_PROVIDED" in provs:
            return "user_specified"
        return "measured"
    if classification == "ESTIMATED":
        for p in provs:
            mapped = _SOLVER_PROVENANCE_MAP.get(p)
            if mapped and mapped != "user_specified":
                return mapped
        return "derived"
    return "unknown"


def interface_from_solver_result(result: Any, *,
                                 component_id: str = "reconstructed_part",
                                 component_type: str = "shaft",
                                 geometry_style: str = "revolved",
                                 source: str = "reconstruction-engine",
                                 name: Optional[str] = None) -> Dict[str, Any]:
    """Convert a Reconstruction ``SolverResult`` into a contract document.

    The mapping is deliberately conservative:

    * Solver units/scale are **preserved truthfully** (metric -> ``absolute``;
      ``relative``/``unknown`` -> ``scale_status = "unknown"`` so the contract
      rejects it rather than inventing a real-world size).
    * Parameter provenance/classification drive the interface provenance; no
      confidence or uncertainty is fabricated.
    * Missing critical dimensions are carried into ``missing_dimensions`` **and**
      into a feature parameter reference, so an incomplete result is rejected
      with a clear ``needs_input`` diagnostic instead of a silent default.
    * Only a small set of cylinder / flange features are synthesised; geometry
      is never invented for dimensions the solver could not determine.
    """
    data = result.to_dict() if hasattr(result, "to_dict") else dict(result)
    params: Dict[str, Dict[str, Any]] = dict(data.get("parameters") or {})
    missing = [str(m) for m in (data.get("missing_critical_dimensions") or [])]
    # Truthfully-recorded input source (see ``record_fixture_source``).  It wins
    # over the generic default so the adapted document and its evidence never
    # imply a COLMAP run that did not happen.
    meta: Dict[str, Any] = dict(data.get("metadata") or {})
    if meta.get("fixture_source"):
        source = str(meta["fixture_source"])

    solver_units = str(data.get("units") or "mm").lower()
    scale_class = str(data.get("scale_classification") or "metric").lower()
    metric = solver_units in ("mm", "millimeter", "millimeters")
    scale_status = "absolute" if (metric and scale_class == "metric") else "unknown"
    length_unit = "mm" if metric else (solver_units or "unknown")

    dims: Dict[str, Any] = {}
    dim_meta: Dict[str, Any] = {}
    for pname, pdata in params.items():
        if not isinstance(pdata, dict):
            continue
        value = pdata.get("value")
        sem = _solver_param_semantic(pname)
        unit = _SEMANTIC_UNIT[sem] if metric or sem != SEMANTIC_LENGTH else solver_units
        prov = _solver_dimension_provenance(pdata)
        dim_meta[pname] = {
            "classification": pdata.get("classification"),
            "solver_provenance": list(pdata.get("provenance") or []),
            "semantic": sem,
        }
        if value is None:
            if pname not in missing:
                missing.append(pname)
            continue
        entry: Dict[str, Any] = {
            "value": value,
            "unit": unit,
            "provenance": prov,
            "note": f"solver classification {pdata.get('classification')}",
        }
        u = pdata.get("uncertainty")
        if isinstance(u, (int, float)) and u is not None:
            entry["uncertainty"] = float(u)
        dims[pname] = entry

    def _val(name: str) -> Optional[float]:
        d = dims.get(name)
        return float(d["value"]) if d else None

    features: List[Dict[str, Any]] = []
    expected: Dict[str, Any] = {"solid_count": 1}
    ctype = (component_type or "").lower()

    od = _val("outer_diameter")
    height = _val("height")
    thickness = _val("thickness")
    has_inner_key = "inner_diameter" in params

    if od is not None:
        # Derive a radius dimension from the solver diameter (documented).
        dims["outer_radius"] = {
            "value": od / 2.0, "unit": "mm", "provenance": "derived",
            "note": "derived from outer_diameter",
        }
        dim_meta["outer_radius"] = {"semantic": SEMANTIC_LENGTH,
                                    "solver_provenance": ["DERIVED"]}

    if ctype in ("flange", "bushing", "bearing") and od is not None and thickness is not None:
        features.append({
            "id": "flange_body", "type": "flange", "operation": "additive",
            "parameters": {"shape": "circular",
                           "outerRadius": {"$dim": "outer_radius"},
                           "thickness": {"$dim": "thickness"}, "zStart": 0.0},
        })
        body_top = {"$dim": "thickness"}
    elif od is not None and height is not None:
        features.append({
            "id": "base_body", "type": "base_cylinder", "operation": "additive",
            "parameters": {"radius": {"$dim": "outer_radius"},
                           "zStart": 0.0, "zEnd": {"$dim": "height"}},
        })
        body_top = {"$dim": "height"}
    else:
        body_top = {"$dim": "height"}

    # A bore is only synthesised when the solver reports the concept at all
    # (even as a missing value) — never invented.
    if has_inner_key:
        features.append({
            "id": "bore", "type": "through_bore", "operation": "subtractive",
            "parameters": {"diameter": {"$dim": "inner_diameter"},
                           "zStart": -1.0, "zEnd": body_top},
            "depends_on": [f["id"] for f in features[:1]],
        })

    if od is not None and height is not None:
        expected["bbox"] = {"xlen": od, "ylen": od, "zlen": height}
    elif od is not None and thickness is not None:
        expected["bbox"] = {"xlen": od, "ylen": od, "zlen": thickness}

    return {
        "format": INTERFACE_FORMAT,
        "version": INTERFACE_VERSION,
        "component": {
            "id": component_id,
            "type": component_type,
            "geometry_style": geometry_style,
            "name": name or f"reconstructed_{component_type}",
        },
        "units": {"length": length_unit, "scale_status": scale_status,
                  "scale_factor": 1.0},
        "dimensions": dims,
        "features": features,
        "missing_dimensions": sorted(set(missing)),
        "assumptions": [
            "Solver output is the authoritative dimension source.",
            "No geometry is invented for dimensions the solver could not determine.",
        ],
        "expected": expected,
        "provenance": {
            "source": source,
            "method": "solver-result-adapter",
            "fixture_source": meta.get("fixture_source"),
            "colmap_executed": meta.get("colmap_executed"),
            "solver_input_note": meta.get("fixture_note"),
            "solver": {
                "schema_version": data.get("schema_version"),
                "job_id": data.get("job_id"),
                "status": data.get("status"),
                "units": data.get("units"),
                "scale_classification": data.get("scale_classification"),
                "coordinate_frame": data.get("coordinate_frame"),
            },
            "dimension_meta": dim_meta,
        },
    }



# ---------------------------------------------------------------------------
# JSON Schema
# ---------------------------------------------------------------------------

def interface_json_schema() -> Dict[str, Any]:
    """Return a JSON Schema (Draft 2020-12) for the interface document."""
    # The unit vocabulary is derived from the same aliases the runtime validator
    # uses, so the two can never disagree (in particular the empty string is
    # absent from both).  ``_COUNT_UNITS`` is used to force integer values.
    _all_units = sorted(set().union(*_SEMANTIC_UNIT_ALIASES.values()))
    dim_entry = {
        "type": "object",
        "required": ["value", "unit", "provenance"],
        "properties": {
            "value": {"type": "number"},
            "unit": {
                "type": "string",
                "description": "Semantic unit: metric length, degrees, "
                               "integer count, or dimensionless.",
                "enum": _all_units,
            },
            "provenance": {"type": "string", "enum": list(PROVENANCE_KINDS)},
            "uncertainty": {"type": "number", "minimum": 0},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "note": {"type": "string"},
        },
        # A dimension whose declared unit is a count must carry a whole number,
        # exactly as the runtime validator enforces (JSON Schema's "integer"
        # accepts 6 and 6.0, rejects 6.5).
        "allOf": [
            {
                "if": {
                    "required": ["unit"],
                    "properties": {"unit": {"enum": list(_COUNT_UNITS)}},
                },
                "then": {"properties": {"value": {"type": "integer"}}},
            }
        ],
        "additionalProperties": True,
    }
    feature = {
        "type": "object",
        "required": ["id", "type", "operation", "parameters"],
        "properties": {
            "id": {"type": "string", "minLength": 1},
            "type": {"type": "string", "minLength": 1},
            "operation": {
                "type": "string",
                "description": "Explicit operation class. Must agree with the "
                               "deterministic feature-type registry "
                               "(cad/feature_schema.FEATURE_OPERATION).",
                "enum": list(OPERATIONS),
            },
            "parameters": {"type": "object"},
            "position": {
                "type": "object",
                "properties": {"x": {"type": "number"}, "y": {"type": "number"},
                               "z": {"type": "number"}},
            },
            "orientation": {
                "type": "object",
                "properties": {
                    "axis": {"type": "array", "items": {"type": "number"},
                             "minItems": 3, "maxItems": 3},
                    "angleDeg": {"type": "number"},
                },
            },
            "depends_on": {"type": "array", "items": {"type": "string"}},
            "metadata": {"type": "object"},
        },
        "additionalProperties": True,
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://reforge.ai/schemas/reforge-cad-interface-1.0.json",
        "title": "ReForge AI Reconstruction-to-CAD interface",
        "type": "object",
        "required": ["format", "version", "component", "units", "dimensions", "features"],
        "properties": {
            "format": {"const": INTERFACE_FORMAT},
            "version": {"const": INTERFACE_VERSION},
            "component": {
                "type": "object",
                "required": ["id", "type", "geometry_style"],
                "properties": {
                    "id": {"type": "string", "minLength": 1},
                    "type": {"type": "string"},
                    "geometry_style": {"type": "string"},
                    "name": {"type": "string"},
                },
                "additionalProperties": True,
            },
            "units": {
                "type": "object",
                "required": ["length", "scale_status"],
                "properties": {
                    "length": {"type": "string", "enum": list(_METRIC_UNITS)},
                    "scale_status": {"type": "string", "enum": list(SCALE_STATUSES)},
                    "scale_factor": {"type": "number", "exclusiveMinimum": 0},
                },
                "additionalProperties": True,
            },
            "dimensions": {
                "type": "object",
                "additionalProperties": dim_entry,
            },
            "features": {
                "type": "array",
                "minItems": 1,
                "items": feature,
            },
            "missing_dimensions": {"type": "array", "items": {"type": "string"}},
            "assumptions": {"type": "array", "items": {"type": "string"}},
            "expected": {"type": "object"},
            "provenance": {"type": "object"},
            "metadata": {"type": "object"},
        },
        "additionalProperties": True,
    }
