"""
Prototype paid-tier insights — zombie-subscription finder, tax-deductible
expense flagging, and multi-month trend analysis.

Isolated from analyser.py on purpose: this is unvalidated product surface,
not the core parsing pipeline. Pure functions, no PDF/HTTP dependency, so
they're testable and removable in one piece if the feature doesn't pan out.
"""

import re
import statistics
from datetime import date


# ── Zombie-subscription finder ──────────────────────────────────────────────
# A "subscription" here is a debit to the same merchant, for the same (or
# near-identical) amount, recurring at a roughly monthly cadence — the
# classic signature of an auto-renewing charge someone forgot about.
#
# Real-world statements are full of look-alikes that are NOT subscriptions:
# person-to-person UPI transfers (rent, splitting bills, loan repayment to
# an individual) and loan/SIP auto-debits. Both can be same-amount and
# monthly, so numeric pattern-matching alone false-positives on them —
# verified against real HDFC/Axis/SBI statements during testing, e.g. a
# recurring transfer to a person ("Govinda R") and a mutual fund SIP mandate
# both looked identical to a Netflix charge by the numbers alone. Two extra
# checks rule those out: (1) ALL occurrences for a merchant must be
# consistent, not just any two of them — a merchant with 5 irregular
# payments and 2 that coincidentally line up isn't a subscription; (2) a
# merchant that ever sends money back (a credit, not just debits) is a
# person, not a subscription service.

SUBSCRIPTION_INTERVAL_DAYS = (25, 35)   # "roughly monthly"
SUBSCRIPTION_AMOUNT_TOLERANCE = 0.05    # 5% — allows for tax/FX drift

# Loan/investment auto-debits and person-to-person transfers: numerically
# identical to a subscription (fixed amount, monthly, recurring) but not
# something to "cancel." "MTUAL FUND" (not a typo here) is how at least one
# real SBI statement spells "mutual fund" in its own narration text — matched
# as observed, not corrected, since that's what real statements contain.
# "P2A" is UPI's own transaction-type code for Person-to-Account transfers,
# as opposed to P2M (Person-to-Merchant) — a reliable person-vs-business signal.
_NON_SUBSCRIPTION_RE = re.compile(
    r"MU?TUAL FUND|\bSIP\b|\bLOAN\b|\bEMI\b|ACH-DR|\bNACH\b|\bECS\b|\bP2A\b", re.I
)


def find_recurring_subscriptions(rows: list[dict]) -> list[dict]:
    """Groups debits by merchant, flags merchants whose ENTIRE debit history
    (not just some subset of it) is consistent with a monthly subscription:
    every gap 25-35 days, every amount within 5% of the median, no reverse
    (credit) transactions to the same name, and no loan/SIP narration
    markers. Returns one entry per detected subscription, sorted by amount
    descending (biggest "wait, what's this?" first)."""
    debits_by_merchant: dict[str, list[tuple[date, float]]] = {}
    has_credit: set[str] = set()
    for r in rows:
        if not r["merchant"]:
            continue
        if r["credit"]:
            has_credit.add(r["merchant"])
        if r["debit"]:
            debits_by_merchant.setdefault(r["merchant"], []).append((r["date"], r["debit"]))

    found = []
    for merchant, occurrences in debits_by_merchant.items():
        if merchant in has_credit or len(occurrences) < 2:
            continue

        occurrences.sort(key=lambda o: o[0])
        amounts = [a for _, a in occurrences]
        median_amount = statistics.median(amounts)
        if any(abs(a - median_amount) / median_amount > SUBSCRIPTION_AMOUNT_TOLERANCE for a in amounts):
            continue  # not every payment matches — not a clean subscription

        gaps = [(d2 - d1).days for (d1, _), (d2, _) in zip(occurrences, occurrences[1:])]
        if any(not (SUBSCRIPTION_INTERVAL_DAYS[0] <= g <= SUBSCRIPTION_INTERVAL_DAYS[1]) for g in gaps):
            continue  # not every gap is monthly-ish

        narrations = " ".join(r["narration"] for r in rows if r["merchant"] == merchant)
        if _NON_SUBSCRIPTION_RE.search(narrations):
            continue  # loan/SIP mandate, not a subscription

        avg_gap = round(sum(gaps) / len(gaps))
        last_date, last_amount = occurrences[-1]
        found.append({
            "merchant": merchant,
            "amount": last_amount,
            "occurrences": len(occurrences),
            "avg_interval_days": avg_gap,
            "last_charged": last_date,
            "next_expected": last_date.toordinal() + avg_gap,  # caller converts back to date
            "annual_cost": round(last_amount * (365 / avg_gap), 2),
        })

    found.sort(key=lambda f: -f["amount"])
    for f in found:
        f["next_expected"] = date.fromordinal(f["next_expected"])
    return found


# ── Tax-deductible expense flagging ─────────────────────────────────────────
# Heuristic, keyword-based — same shape as the category classifier, but a
# separate concern (a transaction can be "Bills & Utilities" AND deductible).
# Conservative list: common freelancer/self-employed business tools. This is
# NOT tax advice — it's a "worth asking your accountant about" flag.

_DEDUCTIBLE_KEYWORDS = [
    # cloud / hosting / dev tools
    "aws", "amazon web services", "google cloud", "gcp", "azure", "digitalocean",
    "github", "gitlab", "vercel", "netlify", "heroku", "cloudflare", "namecheap",
    "godaddy", "hostinger", "domain",
    # SaaS / productivity
    "notion", "figma", "adobe", "canva", "slack", "zoom", "microsoft 365",
    "google workspace", "dropbox", "asana", "trello", "clickup", "airtable",
    # AI / API tools
    "openai", "anthropic", "claude", "chatgpt",
    # professional
    "linkedin premium", "coworking", "wework",
]
_DEDUCTIBLE_RE = re.compile("|".join(re.escape(k) for k in _DEDUCTIBLE_KEYWORDS), re.I)


def flag_tax_deductible(rows: list[dict]) -> list[dict]:
    """Returns the subset of debit rows whose narration matches a known
    business-tool keyword, each with a `matched_keyword` field explaining why."""
    flagged = []
    for r in rows:
        if not r["debit"]:
            continue
        m = _DEDUCTIBLE_RE.search(r["narration"])
        if m:
            flagged.append({**r, "matched_keyword": m.group(0)})
    return flagged


# ── Multi-month trend view ──────────────────────────────────────────────────
# Builds on the existing monthly_summary() output — no new parsing, just
# month-over-month deltas so a multi-statement merge tells a story instead
# of just being a longer table.

def monthly_trend(monthly: list[dict]) -> list[dict]:
    """Takes monthly_summary()'s output (chronological) and adds
    month-over-month % change for income/expense/net. First month has no
    prior month, so its deltas are None."""
    trend = []
    prev = None
    for m in monthly:
        row = dict(m)
        if prev is None:
            row["income_change_pct"] = None
            row["expense_change_pct"] = None
        else:
            row["income_change_pct"] = _pct_change(prev["income"], m["income"])
            row["expense_change_pct"] = _pct_change(prev["expense"], m["expense"])
        trend.append(row)
        prev = m
    return trend


def _pct_change(old: float, new: float) -> float | None:
    if old == 0:
        return None  # can't express % change from zero meaningfully
    return round((new - old) / old * 100, 1)
