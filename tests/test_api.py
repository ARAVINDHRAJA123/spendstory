"""SpendStory API tests — error paths need no real statements."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from datetime import date

from fastapi.testclient import TestClient
from main import _bundle, app

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


def test_analyse_multi_rejects_single_file():
    r = client.post("/api/analyse-multi",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data={"password": ""})
    assert r.status_code == 422 and "2 or more" in r.json()["detail"]


def test_analyse_multi_rejects_too_many():
    files = [("files", (f"{i}.pdf", b"%PDF-1", "application/pdf")) for i in range(7)]
    r = client.post("/api/analyse-multi", files=files, data={"password": ""})
    assert r.status_code == 422 and "at most 6" in r.json()["detail"]


def test_export_excel_rejects_empty():
    r = client.post("/api/export-excel", files=[], data={"password": ""})
    assert r.status_code == 422


def test_export_excel_rejects_too_many():
    files = [("files", (f"{i}.pdf", b"%PDF-1", "application/pdf")) for i in range(7)]
    r = client.post("/api/export-excel", files=files, data={"password": ""})
    assert r.status_code == 422 and "at most 6" in r.json()["detail"]


def test_export_excel_rejects_non_pdf():
    r = client.post("/api/export-excel",
                    files=[("files", ("a.txt", b"hello", "application/pdf"))],
                    data={"password": ""})
    assert r.status_code == 415


def test_analyse_multi_labels_failing_file():
    # First file is a non-PDF so it fails immediately with a labeled message.
    files = [
        ("files", ("bad.txt", b"hello", "application/pdf")),
        ("files", ("other.pdf", b"%PDF-1", "application/pdf")),
    ]
    r = client.post("/api/analyse-multi", files=files, data={"password": ""})
    assert r.status_code == 415
    assert "bad.txt" in r.json()["detail"]


def test_bundle_includes_subscriptions_field():
    rows = [
        {"date": date(2026, 1, 15), "narration": "Netflix", "debit": 649.0, "credit": 0.0,
         "balance": 0.0, "merchant": "Netflix", "category": "Entertainment", "is_anomaly": False},
        {"date": date(2026, 2, 14), "narration": "Netflix", "debit": 649.0, "credit": 0.0,
         "balance": 0.0, "merchant": "Netflix", "category": "Entertainment", "is_anomaly": False},
    ]
    bundle = _bundle(rows, ["HDFC"])
    assert "subscriptions" in bundle
    assert bundle["subscriptions"][0]["merchant"] == "Netflix"
    assert bundle["subscriptions"][0]["next_expected"] == "2026-03-16"
