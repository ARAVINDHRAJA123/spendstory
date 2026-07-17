"""
Prototype paid-tier insights — zombie-subscription finder, tax-deductible
expense flagging, and multi-month trend analysis.

Isolated from analyser.py on purpose: this is unvalidated product surface,
not the core parsing pipeline. Pure functions, no PDF/HTTP dependency, so
they're testable and removable in one piece if the feature doesn't pan out.
"""

import re
from datetime import date


# ── Zombie-subscription finder ──────────────────────────────────────────────
# A "subscription" here is a debit to the same merchant, for the same (or
# near-identical) amount, recurring at a roughly monthly cadence — the
# classic signature of an auto-renewing charge someone forgot about.

SUBSCRIPTION_INTERVAL_DAYS = (25, 35)   # "roughly monthly"
SUBSCRIPTION_AMOUNT_TOLERANCE = 0.05    # 5% — allows for tax/FX drift


def find_recurring_subscriptions(rows: list[dict]) -> list[dict]:
    """Groups debits by merchant, flags merchants with 2+ occurrences whose
    gaps and amounts are consistent with a monthly subscription. Returns one
    entry per detected subscription, sorted by amount descending (biggest
    "wait, what's this?" first)."""
    by_merchant: dict[str, list[tuple[date, float]]] = {}
    for r in rows:
        if r["debit"] and r["merchant"]:
            by_merchant.setdefault(r["merchant"], []).append((r["date"], r["debit"]))

    found = []
    for merchant, occurrences in by_merchant.items():
        occurrences.sort(key=lambda o: o[0])
        if len(occurrences) < 2:
            continue

        # Walk consecutive pairs, keep only the ones that look monthly + same amount.
        matches = []
        for (d1, a1), (d2, a2) in zip(occurrences, occurrences[1:]):
            gap = (d2 - d1).days
            amount_delta = abs(a2 - a1) / max(a1, a2)
            if SUBSCRIPTION_INTERVAL_DAYS[0] <= gap <= SUBSCRIPTION_INTERVAL_DAYS[1] and amount_delta <= SUBSCRIPTION_AMOUNT_TOLERANCE:
                matches.append((d1, d2, gap, a2))

        if not matches:
            continue

        avg_gap = round(sum(m[2] for m in matches) / len(matches))
        last_date, last_amount = occurrences[-1]
        found.append({
            "merchant": merchant,
            "amount": last_amount,
            "occurrences": len(matches) + 1,
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
