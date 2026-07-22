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


def _fake_paid(monkeypatch):
    """Export is now payment-gated — these tests exercise file-validation
    logic, which is a separate concern from payment verification, so fake
    a valid paid state rather than needing a real Razorpay account in CI."""
    import payments
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    monkeypatch.setattr(payments, "verify_signature", lambda *a, **k: True)


def _paid_data(**extra):
    return {"password": "", "razorpay_order_id": "o1", "razorpay_payment_id": "p1",
            "razorpay_signature": "s1", **extra}


def test_export_excel_rejects_empty(monkeypatch):
    _fake_paid(monkeypatch)
    r = client.post("/api/export-excel", files=[], data=_paid_data())
    assert r.status_code == 422


def test_export_excel_rejects_too_many(monkeypatch):
    _fake_paid(monkeypatch)
    files = [("files", (f"{i}.pdf", b"%PDF-1", "application/pdf")) for i in range(7)]
    r = client.post("/api/export-excel", files=files, data=_paid_data())
    assert r.status_code == 422 and "at most 6" in r.json()["detail"]


def test_export_excel_rejects_non_pdf(monkeypatch):
    _fake_paid(monkeypatch)
    r = client.post("/api/export-excel",
                    files=[("files", ("a.txt", b"hello", "application/pdf"))],
                    data=_paid_data())
    assert r.status_code == 415


def test_export_excel_blocked_when_payments_not_configured():
    r = client.post("/api/export-excel",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data=_paid_data())
    assert r.status_code == 503


def test_export_excel_blocked_on_invalid_signature(monkeypatch):
    import payments
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    r = client.post("/api/export-excel",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data=_paid_data(razorpay_signature="forged"))
    assert r.status_code == 402


def test_export_tally_blocked_when_payments_not_configured():
    r = client.post("/api/export-tally",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data=_paid_data())
    assert r.status_code == 503


def test_export_accounting_csv_blocked_when_payments_not_configured():
    r = client.post("/api/export-accounting-csv",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data=_paid_data())
    assert r.status_code == 503


def test_export_tally_blocked_on_invalid_signature(monkeypatch):
    import payments
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    r = client.post("/api/export-tally",
                    files=[("files", ("a.pdf", b"%PDF-1", "application/pdf"))],
                    data=_paid_data(razorpay_signature="forged"))
    assert r.status_code == 402


def test_build_tally_xml_well_formed():
    import xml.etree.ElementTree as ET
    from datetime import date
    from export_accounting import build_tally_xml
    rows = [
        {"date": date(2026, 1, 15), "narration": "Swiggy", "debit": 500.0, "credit": 0.0, "merchant": "Swiggy", "category": "Food"},
        {"date": date(2026, 1, 20), "narration": "Salary", "debit": 0.0, "credit": 68000.0, "merchant": "Acme", "category": "Salary"},
    ]
    root = ET.fromstring(build_tally_xml(rows))
    vouchers = root.findall(".//VOUCHER")
    assert len(vouchers) == 2
    assert {v.get("VCHTYPE") for v in vouchers} == {"Payment", "Receipt"}


def test_build_accounting_csv_shape():
    from datetime import date
    from export_accounting import build_accounting_csv
    rows = [{"date": date(2026, 1, 15), "narration": "Swiggy", "debit": 500.0, "credit": 0.0}]
    out = build_accounting_csv(rows).decode()
    assert out.splitlines()[0] == "Date,Description,Amount"
    assert "-500.00" in out


def test_create_order_blocked_when_not_configured():
    r = client.post("/api/create-order")
    assert r.status_code == 503


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
