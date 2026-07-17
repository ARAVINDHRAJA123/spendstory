"""Tests for the prototype paid-tier insights (backend/insights.py)."""
import sys, os
from datetime import date
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from insights import find_recurring_subscriptions, flag_tax_deductible, monthly_trend


def row(d, narration="x", debit=0.0, credit=0.0, merchant="m"):
    return {"date": d, "narration": narration, "debit": debit, "credit": credit,
            "merchant": merchant, "balance": 0.0, "category": "c", "is_anomaly": False}


# ── find_recurring_subscriptions ────────────────────────────────────────────

def test_detects_monthly_same_amount_subscription():
    rows = [
        row(date(2026, 1, 15), merchant="Netflix", debit=649.0),
        row(date(2026, 2, 14), merchant="Netflix", debit=649.0),
        row(date(2026, 3, 16), merchant="Netflix", debit=649.0),
    ]
    found = find_recurring_subscriptions(rows)
    assert len(found) == 1
    assert found[0]["merchant"] == "Netflix"
    assert found[0]["occurrences"] == 3
    assert found[0]["amount"] == 649.0
    assert found[0]["next_expected"] == date(2026, 4, 15)


def test_ignores_frequent_non_monthly_spending():
    # Every 2 days — a habitual purchase, not a subscription.
    rows = [row(date(2026, 1, d), merchant="Tea Stall", debit=35.0) for d in range(1, 15, 2)]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_one_off_purchase():
    rows = [row(date(2026, 1, 15), merchant="Amazon", debit=1200.0)]
    assert find_recurring_subscriptions(rows) == []


def test_amount_drift_within_tolerance_still_matches():
    rows = [
        row(date(2026, 1, 15), merchant="Spotify", debit=119.0),
        row(date(2026, 2, 14), merchant="Spotify", debit=121.0),  # <5% drift
    ]
    found = find_recurring_subscriptions(rows)
    assert len(found) == 1


def test_amount_drift_beyond_tolerance_does_not_match():
    rows = [
        row(date(2026, 1, 15), merchant="Random", debit=100.0),
        row(date(2026, 2, 14), merchant="Random", debit=500.0),  # unrelated-looking charge
    ]
    assert find_recurring_subscriptions(rows) == []


def test_annual_cost_computed():
    rows = [
        row(date(2026, 1, 1), merchant="Gym", debit=1000.0),
        row(date(2026, 2, 1), merchant="Gym", debit=1000.0),
    ]
    found = find_recurring_subscriptions(rows)
    assert found[0]["annual_cost"] > 11000  # ~12 * 1000, allowing for exact day-count


def test_ignores_person_who_also_sends_money_back():
    # Real bug found on a live SBI statement: a P2P UPI transfer to a person
    # (splitting bills, rent, repaying) can look exactly like a subscription
    # by the numbers, but the same name also appears on the credit side —
    # a real subscription service never sends money back.
    rows = [
        row(date(2026, 1, 5), merchant="Ganaga", debit=1000.0),
        row(date(2026, 2, 4), merchant="Ganaga", debit=1000.0),
        row(date(2026, 2, 15), merchant="Ganaga", credit=500.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_mostly_regular_merchant_with_one_outlier_payment():
    # Real bug found on a live SBI statement: a merchant with several
    # irregular payments can still have ONE coincidentally-matching
    # consecutive pair. A true subscription must be consistent across
    # its ENTIRE history, not just some subset of it.
    rows = [
        row(date(2026, 1, 1), merchant="Govinda", debit=11600.0),
        row(date(2026, 1, 15), merchant="Govinda", debit=800.0),
        row(date(2026, 1, 31), merchant="Govinda", debit=11600.0),  # coincidental match with Jan 1
        row(date(2026, 2, 20), merchant="Govinda", debit=900.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_sip_mutual_fund_mandate():
    rows = [
        row(date(2026, 1, 5), narration="DEBIT CMP MANDATE DEBIT UTI MUTUAL FUND SIP", merchant="UTI", debit=2000.0),
        row(date(2026, 2, 5), narration="DEBIT CMP MANDATE DEBIT UTI MUTUAL FUND SIP", merchant="UTI", debit=2000.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_mutual_fund_misspelled_as_seen_on_real_statement():
    # A real SBI statement spells it "MTUAL FUND" (missing the U) — matched
    # as observed in production data, not the "correct" spelling.
    rows = [
        row(date(2026, 1, 5), narration="DEBIT CMP MANDATE DEBIT UTI MTUAL FUND SMS", merchant="Uti", debit=2000.0),
        row(date(2026, 2, 5), narration="DEBIT CMP MANDATE DEBIT UTI MTUAL FUND SMS", merchant="Uti", debit=2000.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_upi_p2a_person_transfer():
    # P2A = UPI's own "Person-to-Account" transaction-type code, as opposed
    # to P2M (Person-to-Merchant) — a real Axis statement had a recurring
    # P2A transfer to an individual that otherwise looked exactly like a
    # subscription by amount and interval alone.
    rows = [
        row(date(2026, 1, 29), narration="UPI/P2A/611998458856/SOMEONE A /UPI/State Bank Of India", merchant="Someone A", debit=4973.0),
        row(date(2026, 2, 28), narration="UPI/P2A/651589653885/SOMEONE A /UPI/State Bank Of India", merchant="Someone A", debit=4992.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_ignores_loan_ach_debit():
    rows = [
        row(date(2026, 1, 7), narration="ACH-DR-HDFC BANK LIMITED-0000161743135", merchant="Hdfc Bank Limited", debit=12549.0),
        row(date(2026, 2, 7), narration="ACH-DR-HDFC BANK LIMITED-0000161743135", merchant="Hdfc Bank Limited", debit=12549.0),
    ]
    assert find_recurring_subscriptions(rows) == []


def test_still_detects_genuine_subscription_amid_noise():
    # Sanity check: the stricter rules shouldn't kill real subscriptions.
    rows = [
        row(date(2026, 1, 15), narration="UPI/DR/Netflix/YESB/netflix-bil", merchant="Netflix", debit=649.0),
        row(date(2026, 2, 14), narration="UPI/DR/Netflix/YESB/netflix-bil", merchant="Netflix", debit=649.0),
        row(date(2026, 3, 16), narration="UPI/DR/Netflix/YESB/netflix-bil", merchant="Netflix", debit=649.0),
    ]
    found = find_recurring_subscriptions(rows)
    assert len(found) == 1 and found[0]["merchant"] == "Netflix"


# ── flag_tax_deductible ──────────────────────────────────────────────────────

def test_flags_known_business_tool():
    rows = [
        row(date(2026, 1, 1), narration="UPI-GITHUB-billing", debit=800.0),
        row(date(2026, 1, 2), narration="UPI-SWIGGY-lunch", debit=300.0),
    ]
    flagged = flag_tax_deductible(rows)
    assert len(flagged) == 1
    assert flagged[0]["matched_keyword"].lower() == "github"


def test_flags_multiple_known_tools():
    rows = [
        row(date(2026, 1, 1), narration="AWS billing", debit=2000.0),
        row(date(2026, 1, 2), narration="Notion subscription", debit=500.0),
        row(date(2026, 1, 3), narration="Grocery store", debit=1500.0),
    ]
    assert len(flag_tax_deductible(rows)) == 2


def test_ignores_credits():
    rows = [row(date(2026, 1, 1), narration="AWS refund", credit=2000.0, debit=0.0)]
    assert flag_tax_deductible(rows) == []


# ── monthly_trend ────────────────────────────────────────────────────────────

def test_first_month_has_no_deltas():
    monthly = [{"month": "Jan 2026", "income": 1000.0, "expense": 500.0, "net": 500.0}]
    trend = monthly_trend(monthly)
    assert trend[0]["income_change_pct"] is None
    assert trend[0]["expense_change_pct"] is None


def test_computes_month_over_month_pct_change():
    monthly = [
        {"month": "Jan 2026", "income": 1000.0, "expense": 500.0, "net": 500.0},
        {"month": "Feb 2026", "income": 1200.0, "expense": 400.0, "net": 800.0},
    ]
    trend = monthly_trend(monthly)
    assert trend[1]["income_change_pct"] == 20.0
    assert trend[1]["expense_change_pct"] == -20.0


def test_zero_previous_value_gives_none_not_error():
    monthly = [
        {"month": "Jan 2026", "income": 0.0, "expense": 0.0, "net": 0.0},
        {"month": "Feb 2026", "income": 500.0, "expense": 100.0, "net": 400.0},
    ]
    trend = monthly_trend(monthly)
    assert trend[1]["income_change_pct"] is None
