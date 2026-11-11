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
