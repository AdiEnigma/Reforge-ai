"""
step_export.py — STEP File Exporter for ReForge AI CAD Models.
"""

from __future__ import annotations

import os
from typing import Any
import cadquery as cq


class StepExportError(Exception):
    """Raised when STEP export fails."""
    pass


def export_step(workplane: Any, file_path: str) -> str:
    """
    Exports a CadQuery Workplane to an AP214/AP203 STEP file.

    Args:
        workplane: CadQuery Workplane or Shape.
        file_path: Destination filesystem path.

    Returns:
        Absolute path to the exported STEP file.

    Raises:
        StepExportError: If export fails or produces an empty/invalid file.
    """
    if workplane is None:
        raise StepExportError("Cannot export None workplane to STEP.")

    dir_name = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dir_name, exist_ok=True)

    try:
        cq.exporters.export(workplane, file_path, cq.exporters.ExportTypes.STEP)
    except Exception as e:
        raise StepExportError(f"OpenCASCADE STEP export failed: {str(e)}") from e

    if not os.path.exists(file_path) or os.path.getsize(file_path) == 0:
        raise StepExportError(f"STEP export resulted in missing or empty file: {file_path}")

    return os.path.abspath(file_path)

