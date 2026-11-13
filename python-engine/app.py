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
from cad.advanced_recipe_adapter import (
    generate_cad_from_recipe,
    is_advanced_recipe,
    legacy_recipe_to_feature_recipe,
)
from cad.feature_modeller import FeatureModellingError
from cad.advanced_cad_validator import validate_feature_geometry
from cad import advanced_preview
from cad import integration_contract
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


# ---------------------------------------------------------------------------
# Advanced (feature-based) CAD pipeline
# ---------------------------------------------------------------------------

class AdvancedCadGenerateRequest(BaseModel):
    job_id: str = Field(default="cad_adv_001")
    recipe: Dict[str, Any] = Field(
        ...,
        description="Advanced feature recipe, or a legacy recipe to be converted "
                    "through the feature pipeline.",
    )
    output_dir: Optional[str] = Field(default=None, description="Custom directory for export files")
    strict: bool = Field(default=False, description="Fail on the first invalid feature")
    generate_previews: bool = Field(default=False, description="Render SVG/PNG preview images")


@app.post("/cad/generate-advanced")
def generate_advanced_cad_endpoint(payload: AdvancedCadGenerateRequest):
    """
    Executes the advanced, feature-based CAD pipeline (Phase 1, Stages 1-2):

    1. Detect / convert the incoming recipe to a feature recipe.
    2. Model the ordered feature sequence (additive / subtractive / finish).
    3. Validate the resulting geometry (solid validity, bbox, bores, passages,
       feature history) and report per-feature diagnostics.
    4. Export STEP + STL.
    5. Optionally render preview and section images.

    The legacy ``/cad/generate`` endpoint and its contract are unchanged.
    """
    recipe = payload.recipe

    # 1. Resolve to a feature recipe.
    try:
        if not is_advanced_recipe(recipe):
            recipe = legacy_recipe_to_feature_recipe(recipe)
    except ValueError as ve:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "status": "error",
                "stage": "recipe_conversion",
                "error": str(ve),
                "hint": "Use /cad/generate for recipes that cannot be expressed as features.",
                "job_id": payload.job_id,
            },
        )

    # 2. Model.
    try:
        workplane, history = generate_cad_from_recipe(recipe, strict=payload.strict)
    except FeatureModellingError as fme:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "feature_modelling",
                "error": fme.message,
                "feature_id": fme.feature_id,
                "details": fme.details,
                "job_id": payload.job_id,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Advanced CAD generation encountered unexpected exception")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "feature_modelling",
                "error": f"Feature modelling failed unexpectedly: {str(e)}",
                "job_id": payload.job_id,
            },
        )

    # 3. Validate.
    try:
        validation_report = validate_feature_geometry(workplane, recipe, history)
    except Exception as e:  # noqa: BLE001
        logger.exception("Advanced CAD validation encountered unexpected exception")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "cad_validation",
                "error": f"Feature validation failed unexpectedly: {str(e)}",
                "job_id": payload.job_id,
                "feature_history": history,
            },
        )

    if not validation_report.get("valid", False):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "cad_validation",
                "error": "Feature-modelled CAD geometry failed validation.",
                "job_id": payload.job_id,
                "feature_history": history,
                "validation_report": validation_report,
            },
        )

    # 4. Export STEP + STL.
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
        exported_stl_path = export_stl(workplane, stl_path)
    except (StepExportError, MeshExportError) as ee:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "export",
                "error": str(ee),
                "job_id": payload.job_id,
                "feature_history": history,
                "validation_report": validation_report,
            },
        )

    # 5. Optional previews.
    previews = None
    if payload.generate_previews:
        try:
            preview_dir = os.path.join(target_dir, f"{base_name}_previews")
            previews = advanced_preview.generate_preview_bundle(
                workplane, preview_dir, payload.job_id, include_section=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("Preview generation failed: %s", e)
            previews = {"error": str(e)}

    return {
        "status": "success",
        "job_id": payload.job_id,
        "mode": "feature",
        "feature_history": history,
        "validation_report": validation_report,
        "step_path": exported_step_path,
        "stl_path": exported_stl_path,
        "previews": previews,
    }


# ---------------------------------------------------------------------------
# Reconstruction -> CAD integration contract (versioned)
# ---------------------------------------------------------------------------

class ReconstructionCadRequest(BaseModel):
    job_id: str = Field(default="cad_recon_001")
    interface: Dict[str, Any] = Field(
        ...,
        description="A 'reforge-cad-interface' v1.0 document produced by the "
                    "Reconstruction Engine (see docs/CAD_INTEGRATION_CONTRACT.md).",
    )
    model: bool = Field(default=True, description="Model the geometry once validated")
    output_dir: Optional[str] = Field(default=None, description="Custom directory for export files")
    generate_previews: bool = Field(default=False, description="Render SVG/PNG preview images")
    allow_assumed: bool = Field(
        default=False,
        description="Accept dimensions explicitly marked as 'assumed' (off by default).",
    )


@app.post("/cad/from-reconstruction")
def cad_from_reconstruction_endpoint(payload: ReconstructionCadRequest):
    """
    Consumes the stable Reconstruction -> CAD interface contract
    (``reforge-cad-interface`` v1.0), validates it, and — when ``model`` is set —
    builds, validates and exports the geometry.

    Incomplete or unreliable input is rejected with explicit diagnostics
    (HTTP 422).  The legacy ``/cad/generate`` and ``/cad/generate-advanced``
    contracts are unchanged.
    """
    contract = integration_contract.validate_interface(
        payload.interface, allow_assumed=payload.allow_assumed)

    if not contract["valid"]:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "integration_contract",
                "error": "Reconstruction interface document failed validation.",
                "job_id": payload.job_id,
                "issues": contract["issues"],
                "missing_dimensions": contract["missing_dimensions"],
                "unreliable_dimensions": contract["unreliable_dimensions"],
                "diagnostics": contract["diagnostics"],
            },
        )

    recipe = contract["recipe_dict"]

    if not payload.model:
        return {
            "status": "success",
            "job_id": payload.job_id,
            "mode": "contract_only",
            "component": contract["component"],
            "recipe": recipe,
            "warnings": contract["warnings"],
        }

    # Model + validate the reconstructed feature recipe.
    try:
        workplane, history = generate_cad_from_recipe(recipe, strict=False)
    except FeatureModellingError as fme:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "feature_modelling",
                "error": fme.message,
                "feature_id": fme.feature_id,
                "details": fme.details,
                "job_id": payload.job_id,
            },
        )

    validation_report = validate_feature_geometry(workplane, recipe, history)
    if not validation_report.get("valid", False):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "status": "error",
                "stage": "cad_validation",
                "error": "Reconstructed CAD geometry failed validation.",
                "job_id": payload.job_id,
                "validation_report": validation_report,
                "feature_history": history,
            },
        )

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
        exported_stl_path = export_stl(workplane, stl_path)
    except (StepExportError, MeshExportError) as ee:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "stage": "export",
                "error": str(ee),
                "job_id": payload.job_id,
            },
        )

    previews = None
    if payload.generate_previews:
        try:
            preview_dir = os.path.join(target_dir, f"{base_name}_previews")
            previews = advanced_preview.generate_preview_bundle(
                workplane, preview_dir, payload.job_id, include_section=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("Preview generation failed: %s", e)
            previews = {"error": str(e)}

    return {
        "status": "success",
        "job_id": payload.job_id,
        "mode": "feature",
        "component": contract["component"],
        "feature_history": history,
        "validation_report": validation_report,
        "step_path": exported_step_path,
        "stl_path": exported_stl_path,
        "previews": previews,
    }
