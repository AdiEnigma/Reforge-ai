"""
gear_generator.py — Parametric Involute Gear Generator for ReForge AI.

Constructs 3D spur gears using CadQuery and cq_gears.
Integrates with Step 2 (cad_generator.py) via:
    generate_gear(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]

Consumes validated gear parameters from CadSpec.spec['gear']:
- teeth: integer tooth count (>= 3)
- module: gear module in mm (> 0)
- faceWidth: gear face width in mm (> 0)
- pressureAngle: pressure angle in degrees (default 20.0)
- helixAngle: helix angle in degrees (default 0.0)
- boreRadius: central bore radius in mm (bore_d = 2 * boreRadius)

Reconciles missing or conflicting module with measured OD when available:
    module = OD / (teeth + 2)
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple, Union

import cadquery as cq
from cq_gears import SpurGear

logger = logging.getLogger("reforge.cad.gear_generator")


# ---------------------------------------------------------------------------
# Exceptions & Error Handling
# ---------------------------------------------------------------------------

class GearGenerationError(Exception):
    """Structured error raised when gear generation fails."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.style = "gear"
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "error": self.message,
            "style": self.style,
            "details": self.details,
        }


# ---------------------------------------------------------------------------
# Module Reconciliation
# ---------------------------------------------------------------------------

def reconcile_gear_module(
    gear_data: Dict[str, Any],
    measured_od: Optional[float] = None,
) -> Tuple[float, Optional[str]]:
    """
    Reconciles module from gear parameters and measured outer diameter (if provided).
    Standard spur gear relationship: OD = (teeth + 2) * module => module = OD / (teeth + 2).

    If measured_od implies a module differing by > 5% from provided module:
    - Measured module takes priority.
    - Emits a warning message.

    Returns:
        (reconciled_module, warning_message_or_None)
    """
    teeth = gear_data.get("teeth")
    if teeth is None or teeth < 3:
        raise GearGenerationError(f"Invalid or missing tooth count: {teeth}")

    provided_m = gear_data.get("module")
    warning: Optional[str] = None

    if measured_od is not None and measured_od > 0:
        inferred_m = measured_od / (float(teeth) + 2.0)
        if provided_m is not None and provided_m > 0:
            diff_pct = abs(inferred_m - float(provided_m)) / float(provided_m)
            if diff_pct > 0.05:
                warning = (
                    f"Measured OD ({measured_od:.2f} mm) implies module {inferred_m:.3f} mm, "
                    f"differing by {diff_pct * 100:.1f}% from provided module ({provided_m:.3f} mm). "
                    f"Measured dimension takes priority."
                )
                logger.warning(warning)
                return inferred_m, warning
            return float(provided_m), None
        else:
            return inferred_m, None

    if provided_m is None or provided_m <= 0:
        raise GearGenerationError(
            "Missing gear module and no measured outer diameter available for inference.",
            details={"teeth": teeth, "provided_module": provided_m, "measured_od": measured_od},
        )

    return float(provided_m), None


# ---------------------------------------------------------------------------
# Public Generator Dispatch
# ---------------------------------------------------------------------------

def generate_gear(spec: Dict[str, Any]) -> Tuple[cq.Workplane, Dict[str, Any]]:
    """
    Constructs a 3D involute spur gear from validated specification dictionary.

    Args:
        spec: CadSpec.spec or sub-spec dictionary containing 'gear' (or gear parameters directly).

    Returns:
        (cq.Workplane, feature_tree)

    Raises:
        GearGenerationError: On invalid parameters, missing required fields, or CAD generation failure.
    """
    if not isinstance(spec, dict):
        raise GearGenerationError(f"Expected dictionary specification, received {type(spec).__name__}.")

    # Extract gear parameters
    gear_data = spec.get("gear") if "gear" in spec and isinstance(spec["gear"], dict) else spec

    raw_teeth = gear_data.get("teeth")
    if raw_teeth is None:
        raise GearGenerationError("Missing required parameter: gear.teeth.")
    try:
        teeth = int(round(float(raw_teeth)))
        if teeth < 3:
            raise ValueError()
    except (TypeError, ValueError):
        raise GearGenerationError(f"Invalid gear tooth count (must be integer >= 3): {raw_teeth}")

    # Check face width
    raw_width = gear_data.get("faceWidth")
    if raw_width is None:
        raise GearGenerationError("Missing required parameter: gear.faceWidth.")
    try:
        width = float(raw_width)
        if width <= 0 or math.isnan(width) or math.isinf(width):
            raise ValueError()
    except (TypeError, ValueError):
        raise GearGenerationError(f"Invalid gear face width (must be > 0): {raw_width}")

    # Pressure angle
    pa = float(gear_data.get("pressureAngle", 20.0))
    if pa <= 0 or pa >= 90:
        raise GearGenerationError(f"Invalid pressure angle (must be between 0 and 90 deg): {pa}")

    # Helix angle (0.0 for spur gear)
    helix = float(gear_data.get("helixAngle", 0.0))

    # Bore radius / diameter
    bore_r = gear_data.get("boreRadius", 0.0)
    try:
        bore_r = float(bore_r) if bore_r is not None else 0.0
        if bore_r < 0 or math.isnan(bore_r) or math.isinf(bore_r):
            raise ValueError()
    except (TypeError, ValueError):
        raise GearGenerationError(f"Invalid bore radius: {bore_r}")

    bore_d = (2.0 * bore_r) if bore_r > 0 else None

    # Module reconciliation (checks outer_diameter if provided in spec or gear_data)
    measured_od = (
        spec.get("outer_diameter")
        or spec.get("outerDiameter")
        or gear_data.get("outer_diameter")
        or gear_data.get("outerDiameter")
    )
    if measured_od is not None:
        try:
            measured_od = float(measured_od)
        except (TypeError, ValueError):
            measured_od = None

    module, warning = reconcile_gear_module(gear_data, measured_od=measured_od)

    # Theoretical dimensions
    pitch_d = module * teeth
    tip_d = module * (teeth + 2.0)
    root_d = module * (teeth - 2.5)

    if bore_d is not None and bore_d >= root_d:
        raise GearGenerationError(
            f"Bore diameter ({bore_d:.2f} mm) exceeds or equals gear root diameter ({root_d:.2f} mm).",
            details={"bore_d": bore_d, "root_d": root_d, "module": module, "teeth": teeth},
        )

    # Construct cq_gears SpurGear object
    try:
        spur_gear = SpurGear(
            module=module,
            teeth_number=teeth,
            width=width,
            pressure_angle=pa,
            helix_angle=helix,
            bore_d=bore_d,
        )
        wp = cq.Workplane("XY").gear(spur_gear)
    except Exception as e:
        raise GearGenerationError(f"cq_gears generation failed: {str(e)}", details={"exception": str(e)})

    # Integrity verification
    solids = wp.solids().vals()
    if not solids:
        raise GearGenerationError("Generated gear geometry contains 0 solids.")
    if len(solids) != 1:
        raise GearGenerationError(f"Generated gear geometry produced {len(solids)} solids, expected 1.")

    vol = wp.val().Volume()
    if vol <= 0 or math.isnan(vol) or math.isinf(vol):
        raise GearGenerationError(f"Generated gear has non-positive or invalid volume: {vol}")

    # Build feature tree
    feature_tree = {
        "style": "gear",
        "parameters": {
            "teeth": teeth,
            "module": module,
            "faceWidth": width,
            "pressureAngle": pa,
            "helixAngle": helix,
            "boreRadius": bore_r,
            "boreDiameter": bore_d,
            "pitchDiameter": pitch_d,
            "tipDiameter": tip_d,
            "rootDiameter": root_d,
        },
        "operations": [
            {
                "type": "spur_gear",
                "teeth": teeth,
                "module": module,
                "width": width,
                "pressure_angle": pa,
                "helix_angle": helix,
                "bore_d": bore_d,
                "volume": vol,
            }
        ],
    }

    if warning:
        feature_tree["warnings"] = [warning]

    return wp, feature_tree

