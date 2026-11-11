"""
app.py — FastAPI application for ReForge AI Vision Engine.
Binds to 127.0.0.1:8765 (loopback only) by default.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import uvicorn

import config
from schemas import ProcessRequest, ProcessResponse
from vision.pipeline import process_images
from vision.model_registry import registry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vision-engine")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Startup and shutdown lifecycle."""
    logger.info("Starting ReForge Vision Engine on %s:%d", config.VISION_SERVICE_HOST, config.VISION_SERVICE_PORT)
    registry.initialize()
    yield
    logger.info("Shutting down ReForge Vision Engine")


app = FastAPI(
    title="ReForge AI Vision Preprocessing Service",
    description="Internal computer vision service providing SAM2 segmentation, OpenCV features, and Depth Anything V2 cues.",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors()), "error": "Invalid request payload"},
    )


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "ok": True,
        "service": "reforge-vision-engine",
        "device": {
            "requested": config.VISION_DEVICE,
            "actual": registry.device,
            "sam2_loaded": registry.sam2_loaded,
            "depth_loaded": registry.depth_loaded,
        },
        "config": {
            "pipeline_enabled": config.VISION_PIPELINE_ENABLED,
            "fail_open": config.VISION_FAIL_OPEN,
            "max_concurrency": config.VISION_MAX_CONCURRENCY,
            "request_timeout": config.VISION_REQUEST_TIMEOUT_SECONDS,
        },
    }


@app.post("/process", response_model=ProcessResponse)
async def process(payload: ProcessRequest):
    """
    Process 1-8 images through SAM 2, OpenCV, and Depth Anything V2.
    Returns structured vision evidence without raw tensor data.
    """
    if not payload.images:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No images provided in request.",
        )
    if len(payload.images) > 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many images: {len(payload.images)} (max 8).",
        )

    try:
        response = await process_images(payload.images, payload.reference)
        return response
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(ve),
        )
    except Exception as exc:
        logger.exception("Error processing vision request")
        if config.VISION_FAIL_OPEN:
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content={
                    "schema_version": "1.0",
                    "status": "unavailable",
                    "device": {
                        "requested": config.VISION_DEVICE,
                        "actual": registry.device,
                        "sam2_loaded": registry.sam2_loaded,
                        "depth_loaded": registry.depth_loaded,
                    },
                    "images": [],
                    "warnings": [f"Vision processing failed: {exc}"],
                },
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Vision processing failed: {exc}",
        )


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=config.VISION_SERVICE_HOST,
        port=config.VISION_SERVICE_PORT,
        log_level="info",
    )
