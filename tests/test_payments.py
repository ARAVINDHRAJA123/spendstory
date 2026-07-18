"""Tests for backend/payments.py — signature verification is pure and
testable without a real Razorpay account; create_order() hits a real
network API and is intentionally NOT covered here (no live keys in CI)."""
import hashlib
import hmac
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import payments


def _sign(order_id, payment_id, secret):
    return hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()


def test_payments_configured_false_when_env_unset(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "")
    assert payments.payments_configured() is False


def test_payments_configured_true_when_both_set(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    assert payments.payments_configured() is True


def test_verify_signature_accepts_correctly_signed_payment(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    sig = _sign("order_abc", "pay_xyz", "secret123")
    assert payments.verify_signature("order_abc", "pay_xyz", sig) is True


def test_verify_signature_rejects_wrong_signature(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    assert payments.verify_signature("order_abc", "pay_xyz", "not-the-real-signature") is False


def test_verify_signature_rejects_signature_for_different_order(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    sig = _sign("order_abc", "pay_xyz", "secret123")
    # Same signature, different order_id — must NOT verify (this is exactly
    # the attack a naive "just check the IDs exist" implementation misses).
    assert payments.verify_signature("order_different", "pay_xyz", sig) is False


def test_verify_signature_false_when_not_configured(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "")
    assert payments.verify_signature("order_abc", "pay_xyz", "anything") is False


def test_verify_signature_false_on_missing_fields(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "secret123")
    assert payments.verify_signature("", "pay_xyz", "sig") is False
    assert payments.verify_signature("order_abc", "", "sig") is False
    assert payments.verify_signature("order_abc", "pay_xyz", "") is False


def test_create_order_raises_when_not_configured(monkeypatch):
    monkeypatch.setattr(payments, "RAZORPAY_KEY_ID", "")
    monkeypatch.setattr(payments, "RAZORPAY_KEY_SECRET", "")
    try:
        payments.create_order()
        assert False, "expected PaymentError"
    except payments.PaymentError:
        pass
