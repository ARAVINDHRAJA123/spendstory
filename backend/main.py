"""
SpendStory API — stateless bank-statement analysis service.

Security model (privacy by design):
  * The uploaded PDF is written to a private temp file, parsed, and deleted
    in a `finally` block — nothing is ever stored server-side.
  * No accounts, no database, no logging of financial contents.
  * Uploads are validated by size (15 MB cap) and PDF magic bytes before
    any parsing happens.
  * Every response carries strict security headers (CSP, no-sniff, etc.).
"""

import os
import sys
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyser import (  # noqa: E402
    category_summary,
    clean_and_enrich,
    detect_anomalies,
    detect_bank,
    extract_transactions,
    monthly_summary,
    spending_stats,
    top_merchants,
)

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")

app = FastAPI(title="SpendStory", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'"
    )
    return resp


def _decrypt_if_needed(path: str, password: str | None) -> None:
    """Bank PDFs are often password-locked. If a password is supplied,
    decrypt the temp file in place; the decrypted copy lives only for the
    duration of the request."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(path)
    if not reader.is_encrypted:
        return
    if not password:
        raise HTTPException(422, "This PDF is password-protected. Enter the password to continue.")
    if not reader.decrypt(password):
        raise HTTPException(422, "Wrong password for this PDF. Please check and try again.")
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    with open(path, "wb") as f:
        writer.write(f)


@app.post("/api/analyse")
async def analyse_statement(file: UploadFile = File(...), password: str = Form(default="")):
    blob = await file.read()

    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is larger than 15 MB. Please upload a smaller statement.")
    if not blob.startswith(b"%PDF"):
        raise HTTPException(415, "That file isn't a PDF. Please upload your bank statement PDF.")

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(blob)
        tmp.close()

        try:
            _decrypt_if_needed(tmp.name, password.strip() or None)
            raw = extract_transactions(tmp.name)
        except HTTPException:
            raise
        except ValueError:
            raise HTTPException(
                422,
                "Couldn't recognise this bank. Supported: HDFC, CUB, IOB, PNB, SBI text statements.",
            )
        except Exception:
            # Corrupt or malformed PDF — anything the parsers can't open.
            raise HTTPException(422, "This PDF couldn't be read. It may be damaged — try downloading it from your bank again.")
        if not raw:
            raise HTTPException(422, "No transactions found — is this a scanned/image PDF? Only text statements are supported.")

        rows = clean_and_enrich(raw)
        # detect_anomalies returns the flagged rows; mark them so the
        # transaction list carries the flag too.
        for r in detect_anomalies(rows):
            r["is_anomaly"] = True

        def txn(r):
            return {
                "date": r["date"].strftime("%Y-%m-%d") if hasattr(r["date"], "strftime") else str(r["date"]),
                "narration": r["narration"],
                "merchant": r["merchant"],
                "category": r["category"],
                "debit": r["debit"],
                "credit": r["credit"],
                "balance": r["balance"],
                "is_anomaly": bool(r.get("is_anomaly")),
            }

        return JSONResponse({
            "bank": detect_bank(tmp.name),
            "stats": spending_stats(rows),
            "monthly": monthly_summary(rows),
            "categories": category_summary(rows),
            "merchants": top_merchants(rows),
            "anomalies": [txn(r) for r in rows if r.get("is_anomaly")],
            "transactions": [txn(r) for r in rows],
        })
    finally:
        # Privacy guarantee: the statement never outlives the request.
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@app.get("/healthz")
async def healthz():
    return {"ok": True}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
