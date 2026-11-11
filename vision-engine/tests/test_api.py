"""
test_api.py — Test FastAPI REST endpoints (/health and /process).
"""
import base64
import io
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import app


@pytest.fixture
def client():
    return TestClient(app)


def make_b64(size=(64, 64), color="blue"):
    img = Image.new("RGB", size, color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_health_endpoint(client):
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "device" in data
    assert "actual" in data["device"]


def test_process_valid_image(client):
    b64 = make_b64((100, 100))
    payload = {
        "images": [
            {"data": b64, "mimeType": "image/png", "image_index": 0}
        ],
        "reference": {"known_diameter_mm": 50.0}
    }
    res = client.post("/process", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["schema_version"] == "1.0"
    assert "status" in data
    assert "device" in data
    assert len(data["images"]) == 1

    img0 = data["images"][0]
    assert img0["image_index"] == 0
    assert img0["width"] == 100
    assert img0["height"] == 100
    assert "quality" in img0
    assert "segmentation" in img0
    assert "opencv" in img0
    assert "depth" in img0
    assert img0["depth"]["depth_type"] == "relative"
    assert img0["depth"]["metric"] is False


def test_process_too_many_images(client):
    b64 = make_b64()
    # 9 images exceeds limit of 8
    payload = {
        "images": [{"data": b64, "mimeType": "image/png", "image_index": i} for i in range(9)]
    }
    res = client.post("/process", json=payload)
    assert res.status_code in (400, 422)


def test_process_empty_images(client):
    payload = {"images": []}
    res = client.post("/process", json=payload)
    assert res.status_code in (400, 422)


def test_process_invalid_base64(client):
    payload = {
        "images": [{"data": "invalid-base64", "mimeType": "image/png", "image_index": 0}]
    }
    res = client.post("/process", json=payload)
    assert res.status_code in (400, 422)

