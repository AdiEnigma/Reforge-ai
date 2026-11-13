"""
advanced_recipe_adapter.py — Bridge between legacy recipes and the advanced
feature-recipe pipeline.

Responsibilities
----------------
* **Detect** whether an incoming recipe is an advanced feature recipe.
* **Convert** a subset of legacy recipes (``revolved``, ``extruded``,
  ``combination``) into an equivalent feature recipe, so older inputs can be
  reproduced through the new engine.
* Provide a single **entry point** ``generate_cad_from_recipe`` that routes to
  the advanced modeller for feature recipes and to the existing
  ``cad_generator.generate_cad`` for everything else.  The legacy behaviour and
  its public interface are preserved unchanged.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

try:
    from cad.feature_schema import (
        FEATURE_RECIPE_FORMAT,
        FEATURE_RECIPE_VERSION,
        FeatureRecipe,
        is_feature_recipe_dict,
    )
    from cad.feature_modeller import model_feature_recipe
except ImportError:  # pragma: no cover
    try:
        from feature_schema import (  # type: ignore
            FEATURE_RECIPE_FORMAT,
            FEATURE_RECIPE_VERSION,
            FeatureRecipe,
            is_feature_recipe_dict,
        )
        from feature_modeller import model_feature_recipe  # type: ignore
    except ImportError:
        from python_engine.cad.feature_schema import (  # type: ignore
            FEATURE_RECIPE_FORMAT,
            FEATURE_RECIPE_VERSION,
            FeatureRecipe,
            is_feature_recipe_dict,
        )
        from python_engine.cad.feature_modeller import model_feature_recipe  # type: ignore


def is_advanced_recipe(recipe: Any) -> bool:
    """Return True when ``recipe`` is an advanced feature recipe."""
    return is_feature_recipe_dict(recipe)


def legacy_recipe_to_feature_recipe(recipe: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a supported legacy recipe dict into an advanced feature recipe dict.

    Raises:
        ValueError: if the legacy style cannot be represented as features.
    """
    if not isinstance(recipe, dict):
        raise ValueError("Legacy recipe must be a dictionary.")
    style = recipe.get("style")

    features: List[Dict[str, Any]] = []
    expected: Dict[str, Any] = {"solid_count": 1}

    if style == "revolved":
        profile = recipe.get("revolvedProfile")
        if not profile:
            raise ValueError("Revolved recipe is missing 'revolvedProfile'.")
        features.append({
            "id": "revolve_1",
            "type": "revolve_profile",
            "parameters": {"profile": profile, "angleDeg": 360.0},
        })
    elif style == "extruded":
        outline = recipe.get("outline")
        depth = recipe.get("depth")
        if not outline or depth is None:
            raise ValueError("Extruded recipe requires 'outline' and 'depth'.")
        features.append({
            "id": "extrude_1",
            "type": "extrude_profile",
            "parameters": {"outline": outline, "depth": float(depth), "zStart": 0.0},
        })
        for i, h in enumerate(recipe.get("holes", [])):
            features.append({
                "id": f"hole_{i + 1}",
                "type": "through_bore",
                "parameters": {
                    "diameter": 2.0 * float(h["radius"]),
                    "center": {"x": float(h["cx"]), "y": float(h["cy"])},
                    "zStart": -1.0,
                    "zEnd": float(depth) + 1.0,
                },
                "depends_on": ["extrude_1"],
            })
    elif style == "combination":
        prims = recipe.get("primitives")
        if not prims:
            raise ValueError("Combination recipe requires 'primitives'.")
        for i, p in enumerate(prims):
            kind = p.get("kind")
            pos = p.get("position", {}) or {}
            rot = p.get("rotation", {}) or {}
            fid = f"prim_{i + 1}"
            if kind == "box":
                features.append({
                    "id": fid, "type": "base_box",
                    "parameters": {
                        "length": float(p.get("width", 10.0)),
                        "width": float(p.get("height", 10.0)),
                        "height": float(p.get("depth", 10.0)),
                        "center": {"x": float(pos.get("x", 0.0)), "y": float(pos.get("y", 0.0)),
                                   "z": float(pos.get("z", 0.0))},
                        "rotation": {"x": float(rot.get("x", 0.0)), "y": float(rot.get("y", 0.0)),
                                     "z": float(rot.get("z", 0.0))},
                    },
                })
            elif kind == "cylinder":
                features.append({
                    "id": fid, "type": "base_cylinder",
                    "parameters": {
                        "radius": float(p.get("radius", 5.0)),
                        "height": float(p.get("height", 10.0)),
                        "center": {"x": float(pos.get("x", 0.0)), "y": float(pos.get("y", 0.0)),
                                   "z": float(pos.get("z", 0.0))},
                        "rotation": {"x": float(rot.get("x", 0.0)), "y": float(rot.get("y", 0.0)),
                                     "z": float(rot.get("z", 0.0))},
                    },
                })
            else:
                raise ValueError(
                    f"Primitive kind '{kind}' cannot be represented as a feature recipe."
                )
    else:
        raise ValueError(f"Legacy style '{style}' has no feature-recipe conversion.")

    return {
        "format": FEATURE_RECIPE_FORMAT,
        "version": FEATURE_RECIPE_VERSION,
        "name": recipe.get("name", f"legacy_{style}"),
        "units": recipe.get("units", "mm"),
        "features": features,
        "expected": expected,
        "metadata": {"converted_from_style": style},
    }


def generate_cad_from_recipe(recipe: Any, strict: bool = False) -> Tuple[Any, Dict[str, Any]]:
    """Route a recipe through the correct CAD pipeline.

    * Advanced feature recipes -> :func:`feature_modeller.model_feature_recipe`
      (returns ``(workplane, history)`` where ``history['format']`` is the
      feature-recipe format).
    * Any other recipe -> the existing
      :func:`cad_generator.generate_cad` (returns ``(workplane, feature_tree)``).

    The return type ``(workplane, info_dict)`` is identical to the legacy
    generator so callers can switch transparently.
    """
    if is_advanced_recipe(recipe):
        return model_feature_recipe(recipe, strict=strict)

    # Lazy import keeps this module importable without CadQuery until needed.
    try:
        from cad.cad_generator import generate_cad
    except ImportError:  # pragma: no cover
        from cad_generator import generate_cad  # type: ignore
    return generate_cad(recipe)
