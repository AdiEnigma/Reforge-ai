"""
advanced_cad_validator.py — Independent validation for feature-based CAD models.

Extends the CAD validation layer (``cad_validator.py``) for models produced by
``feature_modeller.py`` without changing the existing validator or its public
interface.  It checks, for a modelled feature recipe:

* OpenCASCADE solid validity and the expected solid count,
* positive, finite volume,
* bounding-box dimensions against the recipe's declared expectations,
* per-feature Boolean success (from the modelling history),
* feature counts (bores / holes / ports / passages),
* explicitly declared intersecting internal passages (verified geometrically),
* feature-history consistency (order, ids, recorded volume).

Diagnostics are recorded for every failed or uncertain feature.  Failed geometry
is never silently replaced: a failed feature always lowers the result to
``valid == False`` unless the recipe explicitly marks it optional.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple, Union

import cadquery as cq

try:
    from cad.feature_schema import Feature, FeatureRecipe
    from cad.feature_recipe_validator import validate_feature_recipe
    from cad.feature_modeller import build_feature_tool, shapes_intersect
except ImportError:  # pragma: no cover
    try:
        from feature_schema import Feature, FeatureRecipe  # type: ignore
        from feature_recipe_validator import validate_feature_recipe  # type: ignore
        from feature_modeller import build_feature_tool, shapes_intersect  # type: ignore
    except ImportError:
        from python_engine.cad.feature_schema import Feature, FeatureRecipe  # type: ignore
        from python_engine.cad.feature_recipe_validator import validate_feature_recipe  # type: ignore
        from python_engine.cad.feature_modeller import build_feature_tool, shapes_intersect  # type: ignore

DEFAULT_BBOX_TOLERANCE = 0.01
DEFAULT_VOLUME_TOLERANCE = 0.02


# ---------------------------------------------------------------------------
# Geometry inspection helpers
# ---------------------------------------------------------------------------

def _coerce_recipe(recipe: Union[FeatureRecipe, Dict[str, Any]]) -> Tuple[Optional[FeatureRecipe], List[str]]:
    if isinstance(recipe, FeatureRecipe):
        return recipe, []
    if isinstance(recipe, dict):
        if "features" in recipe:
            fr = FeatureRecipe.from_dict(recipe)
            return fr, []
        # Possibly a validation result wrapper
        inner = recipe.get("recipe")
        if isinstance(inner, dict) and "features" in inner:
            return FeatureRecipe.from_dict(inner), []
    return None, ["Feature recipe could not be interpreted for validation."]


def _count_cylindrical_faces(solid: cq.Shape) -> int:
    try:
        return sum(1 for f in solid.Faces() if f.geomType() == "CYLINDER")
    except Exception:
        return 0


def _expected_bbox_from_recipe(fr: FeatureRecipe) -> Optional[Dict[str, float]]:
    exp = fr.expected or {}
    bbox = exp.get("bbox")
    if isinstance(bbox, dict):
        return bbox
    return None


# ---------------------------------------------------------------------------
# Primary validation
# ---------------------------------------------------------------------------

def validate_feature_geometry(
    workplane: Any,
    recipe: Union[FeatureRecipe, Dict[str, Any]],
    history: Optional[Dict[str, Any]] = None,
    expected: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Validate a feature-modelled workplane against its recipe and history."""
    issues: List[str] = []
    feature_diagnostics: Dict[str, List[str]] = {}

    metrics: Dict[str, Any] = {
        "style": "feature",
        "solid_count": 0,
        "actual_volume_mm3": 0.0,
        "actual_bbox": {},
        "expected_bbox": {},
        "bbox_relative_errors": {},
        "bbox_valid": False,
        "geometry_valid": False,
        "feature_checks": {},
        "history_consistent": None,
        "fit_score_method": "none",
    }

    fr, coerce_issues = _coerce_recipe(recipe)
    issues.extend(coerce_issues)
    if fr is None:
        return {"valid": False, "fit_score": 0.0, "issues": issues,
                "metrics": metrics, "feature_diagnostics": feature_diagnostics}

    exp = dict(fr.expected or {})
    if expected:
        exp.update(expected)

    # ---- 1. Basic integrity ---------------------------------------------
    if workplane is None or not isinstance(workplane, cq.Workplane):
        issues.append("Workplane is None or not a valid CadQuery Workplane.")
        return {"valid": False, "fit_score": 0.0, "issues": issues,
                "metrics": metrics, "feature_diagnostics": feature_diagnostics}

    try:
        solids = workplane.solids().vals()
    except Exception as e:
        issues.append(f"Failed to retrieve solids: {e}")
        return {"valid": False, "fit_score": 0.0, "issues": issues,
                "metrics": metrics, "feature_diagnostics": feature_diagnostics}

    metrics["solid_count"] = len(solids)
    expected_solids = int(exp.get("solid_count", 1))
    if len(solids) == 0:
        issues.append("Geometry contains 0 solids.")
        return {"valid": False, "fit_score": 0.0, "issues": issues,
                "metrics": metrics, "feature_diagnostics": feature_diagnostics}
    if len(solids) != expected_solids:
        issues.append(f"Expected {expected_solids} solid(s), found {len(solids)}.")

    solid = solids[0]

    try:
        is_valid = bool(solid.isValid())
    except Exception as e:
        is_valid = False
        issues.append(f"OCC validity check raised: {e}")
    if not is_valid:
        issues.append("OpenCASCADE solid validity (isValid) returned False.")

    try:
        volume = float(solid.Volume())
    except Exception as e:
        volume = 0.0
        issues.append(f"Failed to compute volume: {e}")
    metrics["actual_volume_mm3"] = volume
    if volume <= 0 or math.isnan(volume) or math.isinf(volume):
        issues.append(f"Solid has non-positive/invalid volume: {volume}")

    actual_bbox: Dict[str, float] = {}
    try:
        bb = solid.BoundingBox()
        actual_bbox = {
            "xmin": bb.xmin, "xmax": bb.xmax, "xlen": bb.xlen,
            "ymin": bb.ymin, "ymax": bb.ymax, "ylen": bb.ylen,
            "zmin": bb.zmin, "zmax": bb.zmax, "zlen": bb.zlen,
        }
        metrics["actual_bbox"] = actual_bbox
        if bb.xlen <= 0 or bb.ylen <= 0 or bb.zlen <= 0:
            issues.append(f"Degenerate bounding box ({bb.xlen}, {bb.ylen}, {bb.zlen}).")
    except Exception as e:
        issues.append(f"Failed to compute bounding box: {e}")

    metrics["geometry_valid"] = bool(
        is_valid and len(solids) == expected_solids and volume > 0
        and actual_bbox.get("xlen", 0) > 0
        and actual_bbox.get("ylen", 0) > 0
        and actual_bbox.get("zlen", 0) > 0
    )

    # ---- 2. Bounding box comparison -------------------------------------
    exp_bbox = _expected_bbox_from_recipe(fr)
    tolerance = float(exp.get("bbox_tolerance", DEFAULT_BBOX_TOLERANCE))
    metrics["expected_bbox"] = exp_bbox or {}
    bbox_valid = True
    max_e_b = 0.0
    if exp_bbox:
        bbox_errors: Dict[str, float] = {}
        for dim in ("xlen", "ylen", "zlen"):
            if dim not in exp_bbox:
                continue
            exp_d = float(exp_bbox[dim])
            act_d = float(actual_bbox.get(dim, 0.0))
            if exp_d > 0:
                rel = abs(act_d - exp_d) / exp_d
                bbox_errors[dim] = rel
                max_e_b = max(max_e_b, rel)
                if rel > tolerance:
                    issues.append(
                        f"Bounding box '{dim}' ({act_d:.3f} mm) differs from expected "
                        f"({exp_d:.3f} mm) by {rel * 100:.2f}% (> {tolerance * 100:.0f}%)."
                    )
        metrics["bbox_relative_errors"] = bbox_errors
        bbox_valid = all(v <= tolerance for v in bbox_errors.values())
    metrics["bbox_valid"] = bbox_valid

    # ---- 3. Feature history checks --------------------------------------
    feature_checks: Dict[str, Any] = {}
    optional_ids = set(exp.get("optional_features", []))
    failed_features: List[str] = []

    if history is not None:
        steps = history.get("steps", [])
        step_ids = [s.get("id") for s in steps]
        recipe_ids = fr.feature_ids()
        consistent = step_ids == recipe_ids
        metrics["history_consistent"] = consistent
        if not consistent:
            issues.append("Feature history is inconsistent with the recipe feature order/ids.")

        for s in steps:
            fid = s.get("id")
            status = s.get("status")
            diags = s.get("diagnostics") or []
            if status != "applied":
                feature_diagnostics[fid] = diags or [f"Feature status '{status}'."]
                if fid not in optional_ids:
                    failed_features.append(fid)
                    issues.append(
                        f"Feature '{fid}' ({s.get('type')}) was not applied (status={status}): "
                        + "; ".join(diags)
                    )
            elif diags:
                feature_diagnostics.setdefault(fid, []).extend(diags)

        # History final volume should match the actual solid.
        final_vol = (history.get("summary", {}).get("final", {}) or {}).get("volume")
        if final_vol is not None and volume > 0:
            if abs(float(final_vol) - volume) / max(volume, 1e-9) > 1e-3:
                issues.append(
                    f"History final volume ({final_vol}) disagrees with measured volume ({volume:.3f})."
                )

    feature_checks["failed_features"] = failed_features
    feature_checks["num_failed_features"] = len(failed_features)

    # ---- 4. Feature count checks ----------------------------------------
    type_counts: Dict[str, int] = {}
    for f in fr.features:
        type_counts[f.type] = type_counts.get(f.type, 0) + 1
    feature_checks["feature_type_counts"] = type_counts

    feature_count_ok = True
    expected_counts = exp.get("feature_counts", {})
    for ftype, want in expected_counts.items():
        got = type_counts.get(ftype, 0)
        if got != want:
            feature_count_ok = False
            issues.append(f"Feature count for '{ftype}': expected {want}, found {got}.")

    # Bore / hole accounting (declared expectations)
    bore_like = ("through_bore", "blind_bore", "stepped_bore", "counterbore",
                 "countersink", "cavity", "axial_port")
    bore_count = sum(type_counts.get(t, 0) for t in bore_like)
    hole_count = sum(type_counts.get(t, 0) * int(round(f.parameters.get("count", 1)))
                     for t in ("bolt_circle", "hole_pattern") for f in fr.features if f.type == t)
    port_count = type_counts.get("radial_port", 0) + type_counts.get("axial_port", 0)
    passage_count = type_counts.get("internal_passage", 0)
    feature_checks["bore_feature_count"] = bore_count
    feature_checks["pattern_hole_count"] = hole_count
    feature_checks["port_count"] = port_count
    feature_checks["passage_count"] = passage_count
    feature_checks["cylindrical_faces"] = _count_cylindrical_faces(solid)

    if "bore_count" in exp and bore_count != int(exp["bore_count"]):
        feature_count_ok = False
        issues.append(f"Bore feature count: expected {exp['bore_count']}, found {bore_count}.")
    if "hole_count" in exp and hole_count != int(exp["hole_count"]):
        feature_count_ok = False
        issues.append(f"Hole count: expected {exp['hole_count']}, found {hole_count}.")
    if "port_count" in exp and port_count != int(exp["port_count"]):
        feature_count_ok = False
        issues.append(f"Port count: expected {exp['port_count']}, found {port_count}.")

    # ---- 5. Intersecting internal passages (verified geometrically) -----
    intersecting_ok = True
    passage_pairs = exp.get("intersecting_passages", [])
    passage_results: List[Dict[str, Any]] = []
    for pair in passage_pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        fa = fr.get_feature(pair[0])
        fb = fr.get_feature(pair[1])
        if fa is None or fb is None:
            intersecting_ok = False
            issues.append(f"Intersecting passage pair references unknown feature: {pair}.")
            continue
        ta, tb = build_feature_tool(fa), build_feature_tool(fb)
        if ta is None or tb is None:
            intersecting_ok = False
            issues.append(f"Could not rebuild passage tools for pair {pair}.")
            continue
        try:
            overlaps, vol = shapes_intersect(ta.val(), tb.val())
        except Exception as e:
            overlaps, vol = False, 0.0
            issues.append(f"Passage intersection test failed for {pair}: {e}")
        passage_results.append({"pair": list(pair), "intersect": overlaps, "volume": vol})
        if not overlaps:
            intersecting_ok = False
            issues.append(f"Declared passages {pair} do not intersect.")
    feature_checks["intersecting_passages"] = passage_results
    feature_checks["intersecting_passages_ok"] = intersecting_ok

    metrics["feature_checks"] = feature_checks

    # ---- 6. Fit score (qualified) ---------------------------------------
    # The fit score measures agreement with the *declared acceptance
    # expectations* (expected volume and/or bounding box).  It is NOT a
    # reference-model or photograph accuracy metric, and when only the
    # bounding box is available it must never be presented as one.
    if not metrics["geometry_valid"]:
        fit_score = 0.0
        metrics["fit_score_method"] = "zero_invalid_geometry"
        fit_basis_label = "invalid geometry (score forced to 0)"
        fit_reference = "none"
    elif not bbox_valid:
        fit_score = 0.0
        metrics["fit_score_method"] = "zero_invalid_bbox"
        fit_basis_label = "bounding-box mismatch (score forced to 0)"
        fit_reference = "none"
    else:
        error_term = max_e_b
        exp_vol = exp.get("volume")
        if exp_vol:
            e_v = abs(volume - float(exp_vol)) / float(exp_vol)
            metrics["volume_relative_error"] = e_v
            error_term = max(error_term, e_v)
            metrics["fit_score_method"] = "volume_and_bbox"
            fit_basis_label = ("volume + bounding-box agreement with declared "
                               "acceptance expectations")
            fit_reference = "declared_expected_volume_and_bbox"
        else:
            metrics["fit_score_method"] = "bbox_only"
            fit_basis_label = ("bounding-box agreement only — NOT reference-model "
                               "or photograph accuracy")
            fit_reference = "declared_expected_bbox_only"
        fit_score = max(0.0, min(1.0, 1.0 - error_term))

    fit_score_basis = {
        "method": metrics["fit_score_method"],
        "reference": fit_reference,
        "label": fit_basis_label,
        "is_accuracy_metric": False,
        "note": ("fit_score measures agreement with declared acceptance "
                 "expectations only; it is not a measure of reference-model or "
                 "photograph accuracy."),
    }

    # Independent, separately-reported check categories (never merged into the
    # single fit score).
    check_categories = {
        "geometry_validity": bool(metrics["geometry_valid"]),
        "feature_count": bool(feature_count_ok),
        "intersecting_passages": bool(intersecting_ok),
        "bounding_box": bool(bbox_valid),
        "feature_history": bool(metrics.get("history_consistent", True)),
        "failed_features": len(failed_features),
    }

    # ---- 7. Overall validity --------------------------------------------
    fatal = [i for i in issues if not i.startswith("Bounding box")]
    valid = (
        metrics["geometry_valid"]
        and bbox_valid
        and len(failed_features) == 0
        and intersecting_ok
        and len(fatal) == 0
    )

    return {
        "valid": valid,
        "fit_score": round(fit_score, 4),
        "fit_score_basis": fit_score_basis,
        "check_categories": check_categories,
        "issues": issues,
        "metrics": metrics,
        "feature_diagnostics": feature_diagnostics,
    }
