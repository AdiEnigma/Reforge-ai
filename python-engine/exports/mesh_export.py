"""
mesh_export.py — STL/Mesh File Exporter for ReForge AI CAD Models.
"""

from __future__ import annotations

import os
from typing import Any
import cadquery as cq


class MeshExportError(Exception):
    """Raised when STL/Mesh export fails."""
    pass


def export_stl(workplane: Any, file_path: str, tolerance: float = 0.05, angular_tolerance: float = 0.2) -> str:
    """
    Exports a CadQuery Workplane to an ASCII/Binary STL file.

    Args:
        workplane: CadQuery Workplane or Shape.
        file_path: Destination filesystem path.
        tolerance: Linear deflection tolerance for meshing.
        angular_tolerance: Angular deflection tolerance for meshing in radians.

    Returns:
        Absolute path to the exported STL file.

    Raises:
        MeshExportError: If export fails or produces an empty/invalid file.
    """
    if workplane is None:
        raise MeshExportError("Cannot export None workplane to STL.")

    dir_name = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dir_name, exist_ok=True)

    try:
        cq.exporters.export(
            workplane,
            file_path,
            cq.exporters.ExportTypes.STL,
            tolerance=tolerance,
            angularTolerance=angular_tolerance,
        )
    except Exception as e:
        raise MeshExportError(f"OpenCASCADE STL export failed: {str(e)}") from e

    if not os.path.exists(file_path) or os.path.getsize(file_path) == 0:
        raise MeshExportError(f"STL export resulted in missing or empty file: {file_path}")

    return os.path.abspath(file_path)

