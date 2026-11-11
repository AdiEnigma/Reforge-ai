"""
test_adversarial_cases.py — Adversarial inputs, extreme cases, and robustness tests.
"""
import base64
import pytest
from fastapi.testclient import TestClient

from app import app
from schemas import ImageInput
from vision.image_io import decode_and_validate_image


@pytest.fixture
def client():
    return TestClient(app)


def test_adversarial_random_bytes():
    bad_bytes = b"NOT_AN_IMAGE_1234567890!@#$%^&*()_+"
    b64 = base64.b64encode(bad_bytes).decode("ascii")
    inp = ImageInput(data=b64, mimeType="image/jpeg", image_index=0)
    with pytest.raises(ValueError):
        decode_and_validate_image(inp)


def test_adversarial_empty_payload(client):
    res = client.post("/process", json={})
    assert res.status_code in (400, 422)


def test_adversarial_null_image_data(client):
    res = client.post("/process", json={
        "images": [{"data": None, "mimeType": "image/png", "image_index": 0}]
    })
    assert res.status_code == 422


def test_adversarial_unsupported_mime(client):
    b64 = base64.b64encode(b"dummy").decode("ascii")
    res = client.post("/process", json={
        "images": [{"data": b64, "mimeType": "image/bmp", "image_index": 0}]
    })
    assert res.status_code == 422


def test_adversarial_negative_index(client):
    b64 = base64.b64encode(b"dummy").decode("ascii")
    res = client.post("/process", json={
        "images": [{"data": b64, "mimeType": "image/png", "image_index": -1}]
    })
    assert res.status_code == 422

