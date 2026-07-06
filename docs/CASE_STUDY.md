# Case Study: SpendStory

## The problem
My Bank-Statement-Analyser pipeline (PDF → BigQuery → dbt → Airflow) worked well — for me.
Anyone else needed Python, a venv, GCP credentials, and patience. My family wanted the
insights, not the infrastructure. The real product question: **can a data pipeline become
a consumer product a non-technical person uses in under 30 seconds?**

## Key decisions

**Stateless by design.** The PDF is parsed in memory and deleted in a `finally` block —
no accounts, no database, nothing stored. For a finance app this inverts the usual
trade-off: we gave up server-side analytics and got a privacy story you can explain in
one sentence ("we can't leak what we never keep"). User history still exists — but in the
browser's localStorage, on the user's own device. Separating "data the user wants to keep"
from "data the server needs to see" was the single best architectural call in the project.

**PWA over native apps.** One codebase installs on iPhone, Android, Windows, and Mac.
No app-store review, and updates ship by redeploying the server.

**Reuse the proven engine.** The parsers came from the pipeline project unchanged in
spirit — battle-tested code wrapped in a new, thin, secure delivery layer.

## Hard bugs worth remembering

1. **Cross-bank false detection.** Axis statements name other banks inside UPI narrations
   ("…/State Bank Of India"), so whole-document signature scanning misidentified the bank.
   Fix: two-pass detection — match signatures against the statement *header* (before the
   transaction table) first, fall back to full text only if that fails.
2. **The inverted layout.** Axis puts date + amounts on the *last* physical line of a
   multi-line transaction block; every other bank leads with the date. The parser buffers
   narration lines and closes a transaction when a date-bearing line arrives.
3. **Charts ignoring theme switches.** Chart.js bakes text colour into canvas pixels at
   draw time — CSS variable flips don't re-tint them. Charts must be rebuilt on theme
   change (and only the charts, to avoid re-running count-up animations).

## Verification, not vibes
Every parser is validated by **row-level balance reconciliation**: for each transaction,
`previous_balance − debit + credit` must equal the printed running balance. The Axis parser
shipped with 0 mismatches across 222 rows; SBI-v2 with 0 across 613 — and computed totals
match each statement's own printed TRANSACTION TOTAL line to the paisa.

## Results
Live at https://spendstory-616665622891.asia-south1.run.app — 6 banks, password-locked
PDF support, installable on any device, ~₹0/month to run (Cloud Run scales to zero),
17-test CI suite.
