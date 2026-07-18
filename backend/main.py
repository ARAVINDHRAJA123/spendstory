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

import io
import os
import sys
import tempfile
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyser import (  # noqa: E402
    category_summary,
    clean_and_enrich,
    detect_anomalies,
    detect_bank,
    export_excel,
    extract_transactions,
    monthly_summary,
    spending_stats,
    top_merchants,
)
from insights import find_recurring_subscriptions  # noqa: E402
import payments  # noqa: E402

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB
MAX_PDF_PAGES = 80          # statements rarely exceed this; caps CPU per request
PARSE_TIMEOUT_S = 60        # a pathological PDF can't hold a worker hostage
RATE_LIMIT = 20             # analyses per IP per window
RATE_WINDOW_S = 600

_hits: dict[str, deque] = defaultdict(deque)
_parse_pool = ThreadPoolExecutor(max_workers=4)


def _rate_limited(ip: str) -> bool:
    """Sliding-window per-IP limit. In-memory is fine: Cloud Run instances are
    capped, so worst case the effective limit is N-instances x RATE_LIMIT."""
    now = time.monotonic()
    q = _hits[ip]
    while q and now - q[0] > RATE_WINDOW_S:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return True
    q.append(now)
    return False


def _client_ip(request: Request) -> str:
    # Cloud Run puts the real client IP first in X-Forwarded-For.
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")
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
        # checkout.razorpay.com is Razorpay's own hosted payment widget —
        # it handles card/UPI details directly with Razorpay; we never see
        # or touch that data ourselves, only the payment result.
        "script-src 'self' https://checkout.razorpay.com; "
        "frame-src https://api.razorpay.com; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "img-src 'self' data: https://*.razorpay.com; "
        "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com"
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


def _txn(r):
    return {
        "date": r["date"].strftime("%Y-%m-%d") if hasattr(r["date"], "strftime") else str(r["date"]),
        "narration": r["narration"],
        "merchant": r["merchant"],
        "category": r["category"],
        "debit": r["debit"],
        "credit": r["credit"],
        "balance": r["balance"],
        "is_anomaly": bool(r.get("is_anomaly")),
        "source_bank": r.get("source_bank", ""),
    }


def _parse_one(blob: bytes, password: str, label: str = "") -> dict:
    """Validate, decrypt, and parse a single statement PDF. Raises
    HTTPException on any user-facing failure. `label` is only used to make
    error messages identify which file failed in a multi-file batch."""
    prefix = f"{label}: " if label else ""
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{prefix}File is larger than 15 MB. Please upload a smaller statement.")
    if not blob.startswith(b"%PDF"):
        raise HTTPException(415, f"{prefix}That file isn't a PDF. Please upload your bank statement PDF.")

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(blob)
        tmp.close()

        try:
            _decrypt_if_needed(tmp.name, password.strip() or None)
            import pdfplumber as _pp
            with _pp.open(tmp.name) as _pdf:
                if len(_pdf.pages) > MAX_PDF_PAGES:
                    raise HTTPException(422, f"{prefix}This statement has more than {MAX_PDF_PAGES} pages. Please upload a shorter period.")
            future = _parse_pool.submit(extract_transactions, tmp.name)
            try:
                raw = future.result(timeout=PARSE_TIMEOUT_S)
            except FutureTimeout:
                future.cancel()
                raise HTTPException(422, f"{prefix}This PDF took too long to read. It may be malformed — try re-downloading it from your bank.")
        except HTTPException:
            raise
        except ValueError:
            raise HTTPException(422, f"{prefix}Couldn't recognise this bank. Supported: HDFC, SBI, Axis, PNB, IOB, CUB text statements.")
        except Exception:
            raise HTTPException(422, f"{prefix}This PDF couldn't be read. It may be damaged — try downloading it from your bank again.")
        if not raw:
            raise HTTPException(422, f"{prefix}No transactions found — is this a scanned/image PDF? Only text statements are supported.")

        bank = detect_bank(tmp.name)
        rows = clean_and_enrich(raw)
        for r in rows:
            r["source_bank"] = bank
        for r in detect_anomalies(rows):
            r["is_anomaly"] = True
        return {"bank": bank, "rows": rows}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _subscription_json(s: dict) -> dict:
    return {
        "merchant": s["merchant"],
        "amount": s["amount"],
        "occurrences": s["occurrences"],
        "avg_interval_days": s["avg_interval_days"],
        "last_charged": s["last_charged"].strftime("%Y-%m-%d"),
        "next_expected": s["next_expected"].strftime("%Y-%m-%d"),
        "annual_cost": s["annual_cost"],
    }


def _bundle(rows: list[dict], banks: list[str]) -> dict:
    return {
        "bank": " + ".join(dict.fromkeys(banks)) if len(set(banks)) > 1 else (banks[0] if banks else "UNKNOWN"),
        "banks": list(dict.fromkeys(banks)),
        "stats": spending_stats(rows),
        "monthly": monthly_summary(rows),
        "categories": category_summary(rows),
        "merchants": top_merchants(rows),
        "anomalies": [_txn(r) for r in rows if r.get("is_anomaly")],
        "subscriptions": [_subscription_json(s) for s in find_recurring_subscriptions(rows)],
        "transactions": [_txn(r) for r in sorted(rows, key=lambda r: r["date"])],
    }


@app.post("/api/analyse")
async def analyse_statement(request: Request, file: UploadFile = File(...), password: str = Form(default="")):
    if _rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many analyses from this device right now — please wait a few minutes and try again.")
    blob = await file.read()
    result = _parse_one(blob, password)
    return JSONResponse(_bundle(result["rows"], [result["bank"]]))


@app.post("/api/analyse-multi")
async def analyse_multi(request: Request, files: list[UploadFile] = File(...), password: str = Form(default="")):
    """Merge 2+ statements (e.g. different banks) into one unified view.
    A single shared password is tried against every file; a statement that
    needs a different password fails with a clear per-file message —
    analyse it alone via /api/analyse, then merging isn't supported for it
    in this v1 (documented limitation, not a silent bug)."""
    if _rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many analyses from this device right now — please wait a few minutes and try again.")
    if len(files) < 2:
        raise HTTPException(422, "Upload 2 or more statements to merge them.")
    if len(files) > 6:
        raise HTTPException(422, "Please merge at most 6 statements at a time.")

    all_rows: list[dict] = []
    banks: list[str] = []
    for f in files:
        blob = await f.read()
        result = _parse_one(blob, password, label=f.filename or "file")
        all_rows.extend(result["rows"])
        banks.append(result["bank"])

    return JSONResponse(_bundle(all_rows, banks))


@app.post("/api/create-order")
async def create_order(request: Request):
    """Creates a Razorpay order for one Excel report (₹19, one-time — see
    payments.PRICE_PAISE). Returns the order id + the PUBLIC key id the
    frontend needs to open Razorpay's Checkout widget. Never returns the
    secret key — that stays server-side, used only to verify the payment
    after the fact in /api/export-excel."""
    if _rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many requests from this device right now — please wait a few minutes and try again.")
    if not payments.payments_configured():
        raise HTTPException(503, "Payments aren't set up on this server yet.")
    try:
        order = payments.create_order()
    except payments.PaymentError as e:
        raise HTTPException(502, str(e))
    return JSONResponse({
        "order_id": order["id"],
        "amount": order["amount"],
        "currency": order["currency"],
        "key_id": payments.RAZORPAY_KEY_ID,
    })


@app.post("/api/export-excel")
async def export_excel_report(request: Request, files: list[UploadFile] = File(...),
                               password: str = Form(default=""), masked: bool = Form(default=False),
                               razorpay_order_id: str = Form(default=""),
                               razorpay_payment_id: str = Form(default=""),
                               razorpay_signature: str = Form(default="")):
    """Re-parses the uploaded statement(s) (stateless, same privacy model as
    /api/analyse) and streams back a multi-sheet Excel report — summary,
    transactions, monthly/category/merchant breakdowns, anomalies. Nothing
    is written to disk; the workbook is built entirely in memory.

    Paid feature: requires a verified Razorpay payment (see /api/create-order
    and payments.verify_signature) — the signature is the only thing that
    actually proves payment happened, so it's checked server-side before any
    parsing work starts, not just trusted from the client.

    masked=True scrubs UPI handles/account-number fragments out of the
    Narration and Ref No columns (amounts, dates, categories untouched) —
    for sharing the file with a CA/advisor without exposing raw account IDs."""
    if _rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many analyses from this device right now — please wait a few minutes and try again.")
    if not payments.payments_configured():
        raise HTTPException(503, "Payments aren't set up on this server yet.")
    if not payments.verify_signature(razorpay_order_id, razorpay_payment_id, razorpay_signature):
        raise HTTPException(402, "Payment verification failed. If you were charged, please contact support.")
    if not files:
        raise HTTPException(422, "Upload a statement to export.")
    if len(files) > 6:
        raise HTTPException(422, "Please export at most 6 statements at a time.")

    all_rows: list[dict] = []
    for f in files:
        blob = await f.read()
        result = _parse_one(blob, password, label=f.filename or "file")
        all_rows.extend(result["rows"])

    monthly   = monthly_summary(all_rows)
    cats      = category_summary(all_rows)
    merchants = top_merchants(all_rows)
    anomalies = [r for r in all_rows if r.get("is_anomaly")]
    stats     = spending_stats(all_rows)

    buf = io.BytesIO()
    export_excel(all_rows, monthly, cats, merchants, anomalies, stats, buf, masked=masked)
    buf.seek(0)
    filename = "SpendStory_Report_Anonymized.xlsx" if masked else "SpendStory_Report.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/healthz")
async def healthz():
    return {"ok": True}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
