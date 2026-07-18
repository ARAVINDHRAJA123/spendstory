"""
Razorpay integration — order creation + payment-signature verification.

Standard order-then-verify flow: the backend creates an order, the frontend
opens Razorpay's own hosted Checkout widget (card/UPI/etc — we never see or
touch the actual payment details), and on success the backend verifies the
signature server-side before releasing anything. No card/UPI data ever
reaches this app directly.

Requires RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET as environment variables —
get these from the Razorpay dashboard (test-mode keys first). Nothing here
works until those are set; payments_configured() tells callers that clearly
instead of failing in a confusing way deeper in the flow.
"""

import hmac
import hashlib
import json
import os
import urllib.request
import urllib.error
from uuid import uuid4

RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")

# ₹19 one-time, per the owner's pricing decision (not the ₹49 originally
# floated) — see memory/spendstory_excel_paywall_pricing.
PRICE_PAISE = 1900
CURRENCY = "INR"


def payments_configured() -> bool:
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


class PaymentError(Exception):
    pass


def create_order() -> dict:
    """Creates a Razorpay order for the fixed report price. Returns the
    order dict (has "id", "amount", "currency") straight from Razorpay's
    API. Raises PaymentError on any failure — callers turn that into a
    clean HTTP error, not a stack trace."""
    if not payments_configured():
        raise PaymentError("Payments are not configured on this server.")

    body = json.dumps({
        "amount": PRICE_PAISE,
        "currency": CURRENCY,
        "receipt": f"ss_{uuid4().hex[:12]}",
    }).encode()

    req = urllib.request.Request(
        "https://api.razorpay.com/v1/orders",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    # Razorpay auth is HTTP Basic: key_id as username, key_secret as password.
    import base64
    auth = base64.b64encode(f"{RAZORPAY_KEY_ID}:{RAZORPAY_KEY_SECRET}".encode()).decode()
    req.add_header("Authorization", f"Basic {auth}")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise PaymentError(f"Razorpay order creation failed: {detail}") from e
    except urllib.error.URLError as e:
        raise PaymentError(f"Couldn't reach Razorpay: {e}") from e


def verify_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """Razorpay's documented verification scheme: HMAC-SHA256 of
    "{order_id}|{payment_id}" using the key secret, compared to the
    signature Checkout.js hands back on success. This is the ONLY thing
    that actually proves the payment happened — the order_id/payment_id
    alone are not proof, they're just IDs a client could send unpaid."""
    if not payments_configured():
        return False
    if not (order_id and payment_id and signature):
        return False
    expected = hmac.new(
        RAZORPAY_KEY_SECRET.encode(),
        f"{order_id}|{payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
