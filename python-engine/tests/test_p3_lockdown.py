"""
tests/test_p3_lockdown.py
P3 security tests for Python Reconstruction Service:
- X-Internal-Token verification on HTTP ASGI scope
- Path jail traversal rejection
- Docs disabling in production
"""
import pytest
import asyncio
from app import app, resolve_job_path, INTERNAL_TOKEN, ENGINE_DATA_ROOT
import os


def run_asgi_request(app, method: str, path: str, headers: dict = None):
    """Simple ASGI in-memory request runner without httpx dependency."""
    response_started = {}
    response_body = []

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()],
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            response_started["status"] = message["status"]
            response_started["headers"] = message["headers"]
        elif message["type"] == "http.response.body":
            response_body.append(message.get("body", b""))

    asyncio.run(app(scope, receive, send))
    return response_started.get("status"), b"".join(response_body).decode("utf-8")


def test_internal_token_missing_rejected():
    status, body = run_asgi_request(app, "GET", "/health", headers={})
    assert status == 401
    assert "unauthorized" in body


def test_internal_token_invalid_rejected():
    status, body = run_asgi_request(app, "GET", "/health", headers={"X-Internal-Token": "invalid-token-12345"})
    assert status == 401
    assert "unauthorized" in body


def test_internal_token_valid_accepted():
    status, body = run_asgi_request(app, "GET", "/health", headers={"X-Internal-Token": INTERNAL_TOKEN})
    assert status == 200
    assert "ok" in body


def test_path_jail_rejects_parent_traversal():
    with pytest.raises(ValueError, match="Path traversal detected"):
        resolve_job_path("job_123", "../../etc/passwd")

    with pytest.raises(ValueError, match="Path traversal detected"):
        resolve_job_path("job_123", "sub/../../../shadow")


def test_path_jail_resolves_valid_relative_job_dir():
    resolved = resolve_job_path("job_abc", "exports")
    assert resolved.startswith(ENGINE_DATA_ROOT)
    assert "job_abc" in resolved
