"""
feature_schema.py — Versioned feature-based CAD recipe schema for ReForge AI.

This module defines the structured, versioned representation of an *advanced*
feature recipe: an ordered sequence of modelling operations (features) that
together build a mechanical part from a base body using additive (union) and
subtractive (cut) operations, plus finishing operations (fillets/chamfers).

Design goals
------------
* Pure data + (de)serialisation.  No CadQuery / OpenCASCADE imports live here so
  the schema can be inspected, diffed and stored without a geometry kernel.
* Every feature carries a unique id, a type, an operation class
  (``additive`` / ``subtractive`` / ``finish``), geometric parameters, position
  and orientation, units, explicit dependencies, and a validation status with
  diagnostics.
* The full feature history is preserved so a model can be inspected and
  reproduced deterministically.

The schema is intentionally separate from the legacy recipe format handled by
``recipe_validator.py``.  ``advanced_recipe_adapter.py`` bridges the two.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Version / format identifiers
# ---------------------------------------------------------------------------

FEATURE_RECIPE_VERSION = "1.0"
FEATURE_RECIPE_FORMAT = "reforge-feature-recipe"

# Operation classes
OPERATION_ADDITIVE = "additive"
OPERATION_SUBTRACTIVE = "subtractive"
OPERATION_FINISH = "finish"

# ---------------------------------------------------------------------------
# Feature type registry
# ---------------------------------------------------------------------------

#: Additive (material-adding) external mechanical features.
ADDITIVE_FEATURE_TYPES: tuple = (
    "base_cylinder",
    "base_box",
    "revolve_profile",
    "extrude_profile",
    "flange",
    "boss_cylindrical",
    "boss_rectangular",
    "rib",
    "connector",
)

#: Subtractive (material-removing) internal / machining features.
SUBTRACTIVE_FEATURE_TYPES: tuple = (
    "through_bore",
    "blind_bore",
    "stepped_bore",
    "counterbore",
    "countersink",
    "pocket_circular",
    "pocket_rectangular",
    "radial_port",
    "axial_port",
    "internal_passage",
    "cavity",
    "bolt_circle",
    "hole_pattern",
)

#: Finishing features applied to existing edges.
FINISH_FEATURE_TYPES: tuple = (
    "fillet",
    "chamfer",
)

#: Map of feature type -> operation class.
FEATURE_OPERATION: Dict[str, str] = {}
for _t in ADDITIVE_FEATURE_TYPES:
    FEATURE_OPERATION[_t] = OPERATION_ADDITIVE
for _t in SUBTRACTIVE_FEATURE_TYPES:
    FEATURE_OPERATION[_t] = OPERATION_SUBTRACTIVE
for _t in FINISH_FEATURE_TYPES:
    FEATURE_OPERATION[_t] = OPERATION_FINISH

ALL_FEATURE_TYPES: tuple = (
    ADDITIVE_FEATURE_TYPES + SUBTRACTIVE_FEATURE_TYPES + FINISH_FEATURE_TYPES
)

# Validation / execution status vocabulary for a single feature.
FEATURE_STATUSES: tuple = (
    "pending",   # not yet evaluated
    "valid",     # recipe-level validation passed
    "invalid",   # recipe-level validation failed
    "applied",   # executed successfully against geometry
    "failed",    # execution attempted but failed (diagnostics recorded)
    "skipped",   # deliberately not executed (dependency failed / no-op)
)

# Supported length units (normalised to millimetres by the validator).
SUPPORTED_UNITS: tuple = ("mm", "millimeter", "millimeters", "cm", "centimeter",
                          "centimeters", "m", "meter", "meters", "in", "inch",
                          "inches")


def operation_for_type(feature_type: str) -> Optional[str]:
    """Return the operation class for a feature type, or ``None`` if unknown."""
    return FEATURE_OPERATION.get(feature_type)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Feature:
    """A single ordered modelling operation in a feature recipe."""

    id: str
    type: str
    operation: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)
    position: Dict[str, float] = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "z": 0.0})
    orientation: Dict[str, Any] = field(default_factory=lambda: {"axis": [0.0, 0.0, 1.0], "angleDeg": 0.0})
    units: str = "mm"
    depends_on: List[str] = field(default_factory=list)
    validation_status: str = "pending"
    diagnostics: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Operation is derivable from the type; keep it authoritative.
        derived = operation_for_type(self.type)
        if derived is not None:
            self.operation = derived

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "operation": self.operation,
            "parameters": dict(self.parameters),
            "position": dict(self.position),
            "orientation": dict(self.orientation),
            "units": self.units,
            "depends_on": list(self.depends_on),
            "validation_status": self.validation_status,
            "diagnostics": list(self.diagnostics),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Feature":
        return cls(
            id=str(data.get("id", "")),
            type=str(data.get("type", "")),
            operation=str(data.get("operation", "")),
            parameters=dict(data.get("parameters") or {}),
            position=dict(data.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0}),
            orientation=dict(data.get("orientation") or {"axis": [0.0, 0.0, 1.0], "angleDeg": 0.0}),
            units=str(data.get("units", "mm")),
            depends_on=list(data.get("depends_on") or []),
            validation_status=str(data.get("validation_status", "pending")),
            diagnostics=list(data.get("diagnostics") or []),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass
class FeatureRecipe:
    """A versioned, ordered collection of features plus expected outcomes."""

    name: str = "untitled"
    version: str = FEATURE_RECIPE_VERSION
    format: str = FEATURE_RECIPE_FORMAT
    units: str = "mm"
    features: List[Feature] = field(default_factory=list)
    expected: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "format": self.format,
            "version": self.version,
            "name": self.name,
            "units": self.units,
            "features": [f.to_dict() for f in self.features],
            "expected": dict(self.expected),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FeatureRecipe":
        return cls(
            name=str(data.get("name", "untitled")),
            version=str(data.get("version", FEATURE_RECIPE_VERSION)),
            format=str(data.get("format", FEATURE_RECIPE_FORMAT)),
            units=str(data.get("units", "mm")),
            features=[Feature.from_dict(f) for f in (data.get("features") or [])],
            expected=dict(data.get("expected") or {}),
            metadata=dict(data.get("metadata") or {}),
        )

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    @classmethod
    def from_json(cls, text: str) -> "FeatureRecipe":
        return cls.from_dict(json.loads(text))

    def feature_ids(self) -> List[str]:
        return [f.id for f in self.features]

    def get_feature(self, feature_id: str) -> Optional[Feature]:
        for f in self.features:
            if f.id == feature_id:
                return f
        return None

    def summary(self) -> Dict[str, Any]:
        counts = {OPERATION_ADDITIVE: 0, OPERATION_SUBTRACTIVE: 0, OPERATION_FINISH: 0}
        for f in self.features:
            counts[f.operation] = counts.get(f.operation, 0) + 1
        return {
            "name": self.name,
            "version": self.version,
            "units": self.units,
            "num_features": len(self.features),
            "operation_counts": counts,
            "feature_types": sorted({f.type for f in self.features}),
        }


# ---------------------------------------------------------------------------
# Convenience constructors used by specimens / adapters
# ---------------------------------------------------------------------------

def make_feature(
    feature_id: str,
    feature_type: str,
    parameters: Optional[Dict[str, Any]] = None,
    position: Optional[Dict[str, float]] = None,
    orientation: Optional[Dict[str, Any]] = None,
    units: str = "mm",
    depends_on: Optional[List[str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Feature:
    """Build a :class:`Feature` with sensible defaults and derived operation."""
    return Feature(
        id=feature_id,
        type=feature_type,
        operation=operation_for_type(feature_type) or "",
        parameters=dict(parameters or {}),
        position=dict(position or {"x": 0.0, "y": 0.0, "z": 0.0}),
        orientation=dict(orientation or {"axis": [0.0, 0.0, 1.0], "angleDeg": 0.0}),
        units=units,
        depends_on=list(depends_on or []),
        metadata=dict(metadata or {}),
    )


def is_feature_recipe_dict(recipe: Any) -> bool:
    """Return True if ``recipe`` looks like a structured feature recipe."""
    if not isinstance(recipe, dict):
        return False
    if recipe.get("format") == FEATURE_RECIPE_FORMAT:
        return True
    if recipe.get("style") == "feature":
        return True
    # Heuristic: an ordered feature list plus a version tag.
    if isinstance(recipe.get("features"), list) and (
        recipe.get("version") is not None or recipe.get("featureVersion") is not None
    ):
        return True
    return False
