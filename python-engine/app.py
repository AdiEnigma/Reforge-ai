"""
app.py — FastAPI service for ReForge AI Reconstruction Engine.

Provides endpoints for:
1. /health: reports capability status (SciPy, OpenCV, COLMAP).
2. /reconstruct/multiview: runs optional COLMAP SfM pipeline.
3. /reconstruct/solve: runs SciPy geometric parameter solver.
4. /reconstruct: end-to-end reconstruction passing multi-view evidence into geometry solver.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from reconstruction.multiview import find_colmap_executable, run_multiview_reconstruction
from reconstruction.geometry_solver import solve_geometry
from recipe_validator import validate_recipe, CadSpec
from cad.cad_generator import generate_cad, CadGenerationError
from cad.cad_validator import validate_cad_geometry
from exports.step_export import export_step, StepExportError
from exports.mesh_export import export_stl, MeshExportError
from dataclasses import asdict
import os
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("reforge-reconstruction-service")

app = FastAPI(
    title="ReForge AI Reconstruction Engine",
    description="Local reconstruction engine powered by COLMAP multi-view SfM and SciPy parameter optimization.",
    version="1.0.0",
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors()), "error": "Invalid request payload"},
    )


class MultiviewRequest(BaseModel):
    job_id: str = Field(default="job_001")
    image_paths: List[str] = Field(default_factory=list)
    reference: Optional[Dict[str, Any]] = None
    masks: Optional[Dict[str, str]] = None
    options: Optional[Dict[str, Any]] = None


class SolveRequest(BaseModel):
    job_id: str = Field(default="job_001")
    component_type: str = Field(default="cylinder")
    user_dimensions: Optional[Dict[str, Any]] = None
    gemini_proposal: Optional[Dict[str, Any]] = None
    multiview_evidence: Optional[Dict[str, Any]] = None
    opencv_observations: Optional[Dict[str, Any]] = None
    constraints: Optional[List[Dict[str, Any]]] = None
    options: Optional[Dict[str, Any]] = None


class ReconstructRequest(BaseModel):
    job_id: str = Field(default="job_001")
    component_type: str = Field(default="cylinder")
    image_paths: List[str] = Field(default_factory=list)
    user_dimensions: Optional[Dict[str, Any]] = None
    gemini_proposal: Optional[Dict[str, Any]] = None
    opencv_observations: Optional[Dict[str, Any]] = None
    constraints: Optional[List[Dict[str, Any]]] = None
    masks: Optional[Dict[str, str]] = None
    options: Optional[Dict[str, Any]] = None


@app.get("/health")
def health():
    colmap_path = find_colmap_executable()
    return {
        "ok": True,
        "service": "reforge-reconstruction-engine",
        "capabilities": {
            "scipy_solver_available": True,
            "colmap_available": colmap_path is not None,
            "colmap_path": colmap_path,
        },
    }


@app.post("/reconstruct/multiview")
def multiview_endpoint(payload: MultiviewRequest):
    res = run_multiview_reconstruction(
        image_paths=payload.image_paths,
        job_id=payload.job_id,
        reference=payload.reference,
        masks=payload.masks,
        options=payload.options,
    )
    return res.to_dict()


@app.post("/reconstruct/solve")
def solve_endpoint(payload: SolveRequest):
    res = solve_geometry(
        job_id=payload.job_id,
        component_type=payload.component_type,
        user_dimensions=payload.user_dimensions,
        gemini_proposal=payload.gemini_proposal,
        multiview_evidence=payload.multiview_evidence,
        opencv_observations=payload.opencv_observations,
        constraints=payload.constraints,
        options=payload.options,
    )
    return res.to_dict()


@app.post("/reconstruct")
def full_reconstruct_endpoint(payload: ReconstructRequest):
    """
    End-to-end reconstruction:
    1. Runs optional multi-view SfM if >= 2 images provided.
    2. Passes multi-view evidence and geometric observations into SciPy solver.
    3. Returns validated, serializable engineering parameters and diagnostics.
    """
    mv_res = None
    if payload.image_paths and len(payload.image_paths) >= 2:
        mv_res = run_multiview_reconstruction(
            image_paths=payload.image_paths,
            job_id=payload.job_id,
            reference=payload.user_dimensions,
            masks=payload.masks,
            options=payload.options,
        ).to_dict()

    solver_res = solve_geometry(
        job_id=payload.job_id,
        component_type=payload.component_type,
        user_dimensions=payload.user_dimensions,
        gemini_proposal=payload.gemini_proposal,
        multiview_evidence=mv_res,
        opencv_observations=payload.opencv_observations,
        constraints=payload.constraints,
        options=payload.options,
    ).to_dict()

    return {
        "job_id": payload.job_id,
        "multiview": mv_res,
        "solver": solver_res,
    }


class CadGenerateRequest(BaseModel):
    job_id: str = Field(default="cad_001")
    recipe: Dict[str, Any] = Field(..., description="Component recipe dictionary")
    user_dimensions: Optional[Dict[str, Any]] = Field(default=None, description="Explicit user dimensional overrides")
    solver_output: Optional[Dict[str, Any]] = Field(default=None, description="Reconstruction solver output")
    output_dir: Optional[str] = Field(default=None, description="Custom directory for export files")


@app.post("/cad/generate")
def generate_cad_endpoint(payload: CadGenerateRequest):
    """
    Executes the end-to-end CAD generation pipeline:
    1. Recipe validation (validate_recipe).
    2. CAD solid generation (generate_cad).
    3. CAD geometry validation (validate_cad_geometry).
    4. STEP file export.
    5. STL file export.
    6. Structured response delivery.
    """
    # 1. Recipe Validation
    try:
        cad_spec = validate_recipe(
            recipe=payload.recipe,
            solver_result=payload.solver_output,
            user_dims=payload.user_dimensions,
        )
    except Exception as e:
        logger.exception("Recipe validation encountered unexpected exception")
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "status": "error",
                "stage": "recipe_validation",
                "error": f"Recipe validation failed: {str(e)}",
                "job_id": payload.job_id,
            },
        )

    # Check status
    if cad_spec.status == "rejected":
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "status": "error",
                "stage": "recipe_validation",
                "error": "Recipe was rejected by specification validator.",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
            },
        )
    elif cad_spec.status == "needs_input":
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "status": "needs_input",
                "stage": "recipe_validation",
                "error": "Recipe requires additional input or missing parameters.",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "missing": cad_spec.missing,
            },
        )

    # 2. CAD Solid Generation
    try:
        workplane, feature_tree = generate_cad(cad_spec)
    except CadGenerationError as cge:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "cad_generation",
                "error": cge.message,
                "style": cge.style,
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
            },
        )
    except Exception as e:
        logger.exception("CAD generation encountered unexpected exception")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "cad_generation",
                "error": f"CAD generation failed unexpectedly: {str(e)}",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
            },
        )

    # 3. CAD Geometry Validation
    try:
        validation_report = validate_cad_geometry(workplane, cad_spec, feature_tree)
    except Exception as e:
        logger.exception("CAD validation encountered unexpected exception")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "cad_validation",
                "error": f"CAD validation encountered unexpected exception: {str(e)}",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
            },
        )

    if not validation_report.get("valid", False):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "cad_validation",
                "error": "Generated CAD geometry failed geometric or bounding-box validation.",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
                "validation_report": validation_report,
            },
        )

    # 4 & 5. STEP and STL Export
    target_dir = payload.output_dir
    if not target_dir:
        target_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "exports"))
    os.makedirs(target_dir, exist_ok=True)

    uid = uuid.uuid4().hex[:8]
    base_name = f"{payload.job_id}_{uid}"
    step_path = os.path.join(target_dir, f"{base_name}.step")
    stl_path = os.path.join(target_dir, f"{base_name}.stl")

    try:
        exported_step_path = export_step(workplane, step_path)
    except StepExportError as see:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "step_export",
                "error": str(see),
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
                "validation_report": validation_report,
            },
        )
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "step_export",
                "error": f"STEP export encountered unexpected exception: {str(e)}",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
                "validation_report": validation_report,
            },
        )

    try:
        exported_stl_path = export_stl(workplane, stl_path)
    except MeshExportError as mee:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "stl_export",
                "error": str(mee),
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
                "validation_report": validation_report,
            },
        )
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "stl_export",
                "error": f"STL export encountered unexpected exception: {str(e)}",
                "job_id": payload.job_id,
                "cad_spec": asdict(cad_spec),
                "feature_tree": feature_tree,
                "validation_report": validation_report,
            },
        )

    # 6. Structured Success Response
    return {
        "status": "success",
        "job_id": payload.job_id,
        "cad_spec": asdict(cad_spec),
        "feature_tree": feature_tree,
        "validation_report": validation_report,
        "step_path": exported_step_path,
        "stl_path": exported_stl_path,
    }
