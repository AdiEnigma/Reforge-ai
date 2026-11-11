"""
config.py — All env-var settings for the ReForge AI Vision Engine.
All settings have safe defaults. Override via environment variables.
"""
import os

VISION_PIPELINE_ENABLED = os.environ.get("VISION_PIPELINE_ENABLED", "false").lower() == "true"
VISION_SAM2_ENABLED = os.environ.get("VISION_SAM2_ENABLED", "true").lower() == "true"
VISION_DEPTH_ENABLED = os.environ.get("VISION_DEPTH_ENABLED", "true").lower() == "true"
VISION_FAIL_OPEN = os.environ.get("VISION_FAIL_OPEN", "true").lower() == "true"
VISION_DEVICE = os.environ.get("VISION_DEVICE", "auto")  # auto, cuda, mps, cpu
VISION_SAM2_VARIANT = os.environ.get("VISION_SAM2_VARIANT", "small")
VISION_DEPTH_VARIANT = os.environ.get("VISION_DEPTH_VARIANT", "vits")
VISION_REQUEST_TIMEOUT_SECONDS = int(os.environ.get("VISION_REQUEST_TIMEOUT_SECONDS", "60"))
VISION_MAX_CONCURRENCY = int(os.environ.get("VISION_MAX_CONCURRENCY", "2"))
VISION_SERVICE_HOST = os.environ.get("VISION_SERVICE_HOST", "127.0.0.1")
VISION_SERVICE_PORT = int(os.environ.get("VISION_SERVICE_PORT", "8765"))
VISION_MAX_IMAGE_WIDTH = int(os.environ.get("VISION_MAX_IMAGE_WIDTH", "4096"))
VISION_MAX_IMAGE_HEIGHT = int(os.environ.get("VISION_MAX_IMAGE_HEIGHT", "4096"))
VISION_MAX_IMAGE_PIXELS = int(os.environ.get("VISION_MAX_IMAGE_PIXELS", "16777216"))  # 4096*4096
VISION_MAX_PAYLOAD_BYTES = int(os.environ.get("VISION_MAX_PAYLOAD_BYTES", "20971520"))  # 20MB
VISION_ARTIFACTS_DIR = os.environ.get("VISION_ARTIFACTS_DIR", "./artifacts")
VISION_MODELS_DIR = os.environ.get("VISION_MODELS_DIR", "./models")

# SAM2.1 Small checkpoint
SAM2_CHECKPOINT_FILENAME = "sam2.1_hiera_small.pt"
SAM2_CONFIG_FILENAME = "sam2.1_hiera_s.yaml"

# Depth Anything V2 Small checkpoint
DEPTH_CHECKPOINT_FILENAME = "depth_anything_v2_vits.pth"
