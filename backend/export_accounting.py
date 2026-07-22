"""Accounting-software export formats — Tally Prime XML and a universal
3-column CSV (QuickBooks Online / Zoho Books / Wave all accept this same
shape for manual bank-transaction import).

Best-effort, not a certified integration: Tally's XML import expects ledger
names that already exist in the user's company (or auto-creates them under
whatever parent group Tally defaults to) — merchant/category names are used
directly as ledger names, so a fresh import will likely need reclassifying
inside Tally afterward. Stated plainly in the UI, same pattern as
QueryDoctor's dbt-mode caveat: useful scaffolding, not a certified sync.
"""

import csv
import io
from xml.sax.saxutils import escape

BANK_LEDGER = "Bank Account"


def _amount(row: dict) -> float:
    return float(row.get("credit") or 0) - float(row.get("debit") or 0)


def _narration(row: dict, masked: bool) -> str:
    text = row.get("narration") or row.get("merchant") or ""
    if masked:
        text = " ".join(w for w in text.split() if "@" not in w and not any(c.isdigit() for c in w))
    return text.strip() or "Transaction"


def build_tally_xml(rows: list[dict], masked: bool = False) -> bytes:
    """One Payment voucher per debit, one Receipt voucher per credit —
    the two Tally voucher types that map cleanly onto a bank statement
    line. Ledger for the non-bank leg is the transaction's category
    (falls back to merchant, then "Suspense" if neither is set)."""
    vouchers = []
    for row in rows:
        amt = _amount(row)
        if amt == 0:
            continue
        is_receipt = amt > 0
        vch_type = "Receipt" if is_receipt else "Payment"
        other_ledger = escape(row.get("category") or row.get("merchant") or "Suspense")
        narration = escape(_narration(row, masked))
        date_str = row["date"].strftime("%Y%m%d") if hasattr(row.get("date"), "strftime") else ""
        abs_amt = f"{abs(amt):.2f}"
        # Tally convention: the ledger receiving value is ISDEEMEDPOSITIVE=Yes.
        # Receipt: bank is debited (Yes), the income ledger is credited (No).
        # Payment: the expense ledger is debited (Yes), bank is credited (No).
        if is_receipt:
            bank_pos, other_pos = "Yes", "No"
        else:
            bank_pos, other_pos = "No", "Yes"
        vouchers.append(f"""    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="{vch_type}" ACTION="Create">
      <DATE>{date_str}</DATE>
      <NARRATION>{narration}</NARRATION>
      <VOUCHERTYPENAME>{vch_type}</VOUCHERTYPENAME>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>{escape(BANK_LEDGER)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>{bank_pos}</ISDEEMEDPOSITIVE>
       <AMOUNT>{abs_amt if bank_pos == "Yes" else "-" + abs_amt}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>{other_ledger}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>{other_pos}</ISDEEMEDPOSITIVE>
       <AMOUNT>{abs_amt if other_pos == "Yes" else "-" + abs_amt}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>""")

    body = "\n".join(vouchers)
    xml = f"""<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
   </REQUESTDESC>
   <REQUESTDATA>
{body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>"""
    return xml.encode("utf-8")


def build_accounting_csv(rows: list[dict], masked: bool = False) -> bytes:
    """3-column Date/Description/Amount CSV — the shape QuickBooks Online,
    Zoho Books, and Wave all accept for a manual bank-transaction import
    (positive = money in, negative = money out)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Description", "Amount"])
    for row in rows:
        amt = _amount(row)
        if amt == 0:
            continue
        date_str = row["date"].strftime("%m/%d/%Y") if hasattr(row.get("date"), "strftime") else ""
        w.writerow([date_str, _narration(row, masked), f"{amt:.2f}"])
    return buf.getvalue().encode("utf-8")
