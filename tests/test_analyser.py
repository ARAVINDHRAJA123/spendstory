"""SpendStory unit tests — pure-function coverage, no real bank data needed."""
import io
import sys, os
from datetime import date
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from openpyxl import load_workbook

from analyser import (parse_date, parse_amount, extract_merchant, assign_category,
                      detect_anomalies, monthly_summary, category_summary,
                      top_merchants, spending_stats, clean_and_enrich, export_excel)


def row(d, narration="x", debit=0.0, credit=0.0, balance=0.0, merchant="m", category="c"):
    return {"date": d, "narration": narration, "debit": debit, "credit": credit,
            "balance": balance, "merchant": merchant, "category": category, "is_anomaly": False,
            "ref_no": "", "value_date": d}


def test_parse_date_formats():
    assert parse_date("02/04/2026") == date(2026, 4, 2)
    assert parse_date("05-04-2026") == date(2026, 4, 5)
    assert parse_date("2 Apr 2026") == date(2026, 4, 2)
    assert parse_date("not a date") is None
    assert parse_date("") is None


def test_parse_amount():
    assert parse_amount("31,600.00") == 31600.0
    assert parse_amount("₹1,234.56") == 1234.56
    assert parse_amount("-") == 0.0
    assert parse_amount(None) == 0.0
    assert parse_amount("") == 0.0


def test_extract_merchant_patterns():
    # HDFC dash style
    assert extract_merchant("UPI-SWIGGY-SWIGGY@YBL-123") == "Swiggy"
    # SBI slash style
    assert extract_merchant("UPI/DR/609178413960/SALEEM K/YESB/q763/UPI") == "Saleem K"
    # Axis P2A/P2M style
    assert extract_merchant("UPI/P2A/646193132733/XAVIER INFANTA MICHE /UPI/TAMILNAD MERCANTILE") == "Xavier Infanta Miche"
    assert extract_merchant("UPI/P2M/125430393560/Swiggy /NO REM/ICICI Bank") == "Swiggy"
    # Axis NEFT (non-greedy: must stop at first slash after name)
    assert extract_merchant("NEFT/BOFAH26097003281/ACCENTURE SOLUTIONS PVT LTD/BANK OF AMERICA/123") == "Accenture Solutions Pvt Ltd"
    # Axis mobile transfer
    assert extract_merchant("MOB/TPFT/THERESE SIRU MA/914010047242727") == "Therese Siru Ma"
    # Unknown format falls back to truncation, never crashes
    assert extract_merchant("") == ""
    assert len(extract_merchant("A" * 500)) <= 40


def test_anomaly_detection_flags_outliers():
    rows = [row(date(2026, 1, i + 1), debit=100.0) for i in range(10)]
    rows.append(row(date(2026, 1, 20), debit=50000.0))
    flagged = detect_anomalies(rows)
    assert len(flagged) == 1 and flagged[0]["debit"] == 50000.0


def test_anomaly_needs_min_samples():
    assert detect_anomalies([row(date(2026, 1, 1), debit=5.0)]) == []


def test_summaries_reconcile():
    rows = [
        row(date(2026, 1, 5), debit=100.0, merchant="A", category="Food"),
        row(date(2026, 1, 6), credit=500.0, merchant="B", category="Salary"),
        row(date(2026, 2, 1), debit=50.0, merchant="A", category="Food"),
    ]
    s = spending_stats(rows)
    assert s["total_spend"] == 150.0 and s["total_income"] == 500.0 and s["txn_count"] == 3
    m = {x["month"]: x for x in monthly_summary(rows)}
    assert m["Jan 2026"]["expense"] == 100.0 and m["Jan 2026"]["income"] == 500.0
    top = top_merchants(rows)
    assert top[0] == {"merchant": "A", "total_spend": 150.0}


def test_clean_and_enrich_dedupes_and_sorts():
    raw = [
        {"date": date(2026, 1, 2), "narration": "UPI-SWIGGY-SWIGGY@YBL-1234", "debit": 10.0, "credit": 0.0, "balance": 90.0},
        {"date": date(2026, 1, 2), "narration": "UPI-SWIGGY-SWIGGY@YBL-1234", "debit": 10.0, "credit": 0.0, "balance": 90.0},  # dupe
        {"date": date(2026, 1, 1), "narration": "UPI-ZOMATO-ZOMATO@PAYTM-5678", "debit": 5.0, "credit": 0.0, "balance": 100.0},
        {"date": None, "narration": "garbage", "debit": 1.0, "credit": 0.0, "balance": 0.0},  # dropped
    ]
    out = clean_and_enrich(raw)
    assert len(out) == 2
    assert out[0]["date"] < out[1]["date"]
    assert out[1]["merchant"] == "Swiggy"


def test_export_excel_produces_valid_workbook():
    rows = [
        row(date(2026, 1, 5), narration="UPI-SWIGGY-SWIGGY@YBL-1", debit=100.0, merchant="Swiggy", category="Food"),
        row(date(2026, 1, 6), narration="NEFT-SALARY", credit=50000.0, merchant="Employer", category="Salary"),
        row(date(2026, 1, 20), narration="UPI-BIGSPEND", debit=40000.0, merchant="BigSpend", category="Shopping"),
    ]
    anomalies = detect_anomalies(rows)
    for r in anomalies:
        r["is_anomaly"] = True
    monthly, cats, merchants = monthly_summary(rows), category_summary(rows), top_merchants(rows)
    stats = spending_stats(rows)

    buf = io.BytesIO()
    export_excel(rows, monthly, cats, merchants, anomalies, stats, buf)
    buf.seek(0)

    wb = load_workbook(buf)
    assert {"Summary", "Transactions", "Monthly Summary", "Categories", "Top Merchants", "Anomalies"} <= set(wb.sheetnames)
    assert wb["Transactions"].max_row >= len(rows) + 1  # +1 header row
