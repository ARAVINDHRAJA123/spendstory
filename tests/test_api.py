"""SpendStory API tests — error paths need no real statements."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def post_pdf(content: bytes, password=""):
    return client.post("/api/analyse", files={"file": ("test.pdf", content, "application/pdf")},
                       data={"password": password})


def test_rejects_non_pdf():
    r = post_pdf(b"hello world")
    assert r.status_code == 415


def test_rejects_oversized():
    r = post_pdf(b"%PDF" + b"0" * (16 * 1024 * 1024))
    assert r.status_code == 413


def test_rejects_corrupt_pdf():
    r = post_pdf(b"%PDF-1.4 garbage that is not a pdf")
    assert r.status_code == 422
    assert "damaged" in r.json()["detail"]


def test_frontend_served():
    r = client.get("/")
    assert r.status_code == 200 and b"SpendStory" in r.content


def test_security_headers():
    r = client.get("/")
    assert r.headers["X-Frame-Options"] == "DENY"
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
