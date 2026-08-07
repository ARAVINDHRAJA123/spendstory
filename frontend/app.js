/* SpendStory frontend.
   Flow: pick/drop PDF → POST /api/analyse → render dashboard.
   If the API says the PDF is locked, reveal the password field and retry. */

"use strict";

const $ = (id) => document.getElementById(id);
const screens = { upload: $("screen-upload"), loading: $("screen-loading"), results: $("screen-results") };

let pendingFiles = [];   // kept only in browser memory for the password retry
let charts = [];
let lastRenderedData = null; // re-drawn on theme change so chart text colour stays readable
let isSampleMode = false; // viewing canned demo data — export/history are disabled

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  window.scrollTo({ top: 0 });
}

function setError(msg) {
  const el = $("upload-error");
  el.hidden = !msg;
  el.textContent = msg || "";
  if (msg) { // restart the shake animation
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  }
}

/* ── Upload wiring ─────────────────────────────────────────── */
const dz = $("dropzone");
const fileInput = $("file-input");

dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => { if (fileInput.files.length) handleFiles([...fileInput.files]); });

const dzTitle = $("dropzone").querySelector(".dz-title");
const DZ_TITLE_DEFAULT = dzTitle.textContent;
["dragover", "dragenter"].forEach((t) => dz.addEventListener(t, (e) => {
  e.preventDefault(); dz.classList.add("dragover"); dzTitle.textContent = "Drop it right here!";
}));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => {
  e.preventDefault(); dz.classList.remove("dragover"); dzTitle.textContent = DZ_TITLE_DEFAULT;
}));
dz.addEventListener("drop", (e) => { const fs = [...e.dataTransfer.files]; if (fs.length) handleFiles(fs); });

$("pw-submit").addEventListener("click", () => {
  if (pendingFiles.length === 1) analyse(pendingFiles[0], $("pdf-password").value);
  else if (pendingFiles.length > 1) analyseMulti(pendingFiles, $("pdf-password").value);
});
$("pdf-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pw-submit").click(); });

$("btn-again").addEventListener("click", () => {
  fileInput.value = "";
  pendingFiles = [];
  isSampleMode = false;
  $("sample-banner").hidden = true;
  $("btn-export").disabled = false;
  $("btn-export").title = "";
  $("mask-toggle").checked = false;
  // A new statement is a new purchase — carrying the old payment over would
  // hand out a second statement's report on one payment.
  lastVerifiedPayment = null;
  $("btn-dl-confirm").textContent = DL_BTN_DEFAULT;
  document.querySelectorAll(".fmt-check").forEach((c, i) => (c.checked = i === 0));
  setDlError("");
  $("password-row").hidden = true;
  $("trust-strip").hidden = false;
  $("pdf-password").value = "";
  setError("");
  show("upload");
});

function handleFiles(fileList) {
  setError("");
  for (const f of fileList) {
    if (!/\.pdf$/i.test(f.name)) return setError(`"${f.name}" isn't a PDF — please choose bank statement PDFs.`);
    if (f.size > 15 * 1024 * 1024) return setError(`"${f.name}" is bigger than 15 MB.`);
  }
  pendingFiles = fileList;
  if (fileList.length === 1) analyse(fileList[0], $("pdf-password").value);
  else analyseMulti(fileList, $("pdf-password").value);
}

/* ── API call ──────────────────────────────────────────────── */
const LOADING_MSGS = ["Reading your statement…", "Finding your transactions…", "Sorting your spending…", "Almost there…"];

async function analyse(file, password) {
  show("loading");
  let i = 0;
  const ticker = setInterval(() => { $("loading-msg").textContent = LOADING_MSGS[++i % LOADING_MSGS.length]; }, 1600);

  try {
    const form = new FormData();
    form.append("file", file);
    form.append("password", password || "");
    const res = await fetch("api/analyse", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      show("upload");
      const msg = body.detail || "Something went wrong. Please try again.";
      if (/password/i.test(msg)) {
        $("password-row").hidden = false;
        $("trust-strip").hidden = true;
        $("pdf-password").focus();
      }
      return setError(msg);
    }
    // Show the screen BEFORE drawing: Chart.js needs visible (non-zero)
    // containers to size the canvases correctly.
    show("results");
    render(body);
    addToHistory(body);
  } catch {
    show("upload");
    setError("Couldn't reach the server. Check your internet connection and try again.");
  } finally {
    clearInterval(ticker);
  }
}

async function analyseMulti(files, password) {
  show("loading");
  let i = 0;
  const ticker = setInterval(() => { $("loading-msg").textContent = LOADING_MSGS[++i % LOADING_MSGS.length]; }, 1600);

  try {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.append("password", password || "");
    const res = await fetch("api/analyse-multi", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      show("upload");
      const msg = body.detail || "Something went wrong. Please try again.";
      if (/password/i.test(msg)) {
        $("password-row").hidden = false;
        $("trust-strip").hidden = true;
        $("pdf-password").focus();
      }
      return setError(msg);
    }
    show("results");
    render(body);
    addToHistory(body);
  } catch {
    show("upload");
    setError("Couldn't reach the server. Check your internet connection and try again.");
  } finally {
    clearInterval(ticker);
  }
}

/* ── Excel export (paid — Razorpay order-then-verify) ─────────
   Flow: create an order server-side -> open Razorpay's own hosted Checkout
   (we never see card/UPI details) -> on success, send the payment_id/
   order_id/signature to /api/export-excel, which verifies the signature
   server-side before generating anything. If the user closes the Checkout
   popup without paying, nothing happens — no charge, no file. */
const EXPORT_BTN_DEFAULT = $("btn-export").textContent;
const DL_BTN_DEFAULT = $("btn-dl-confirm").textContent;

function setExportError(msg) {
  const el = $("export-error");
  el.hidden = !msg;
  el.textContent = msg || "";
}
function setDlError(msg) {
  const el = $("dl-error");
  el.hidden = !msg;
  el.textContent = msg || "";
}

let lastVerifiedPayment = null; // reused for the extra formats below — same paid unlock, no re-charge

/* Which formats the picker offers. endpoint/filename live here so adding a
   format is one entry, not edits scattered across the download path. */
const FORMATS = {
  excel: {
    endpoint: "api/export-excel",
    filename: (masked) => (masked ? "SpendStory_Report_Anonymized.xlsx" : "SpendStory_Report.xlsx"),
  },
  tally: { endpoint: "api/export-tally", filename: () => "SpendStory_Tally_Import.xml" },
  csv: { endpoint: "api/export-accounting-csv", filename: () => "SpendStory_Accounting_Import.csv" },
};

const selectedFormats = () =>
  [...document.querySelectorAll(".fmt-check")].filter((c) => c.checked).map((c) => c.value);

async function downloadFormat(payment, endpoint, filename, extra = {}) {
  const masked = $("mask-toggle").checked;
  const form = new FormData();
  for (const f of pendingFiles) form.append("files", f);
  form.append("password", $("pdf-password").value || "");
  form.append("masked", masked ? "true" : "false");
  form.append("razorpay_order_id", payment.razorpay_order_id);
  form.append("razorpay_payment_id", payment.razorpay_payment_id);
  form.append("razorpay_signature", payment.razorpay_signature);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(endpoint, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || "Couldn't generate the file.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred: revoking synchronously can cancel the download before the
  // browser has actually read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/* One request, one file. Asking the per-format endpoints for three formats
   meant re-uploading and re-parsing the same PDF three times (slow), then
   firing three downloads back-to-back — which browsers throttle, so some
   files silently never arrived. The server now bundles multiple formats
   into a single zip off one parse. */
async function downloadSelected(payment, keys) {
  const masked = $("mask-toggle").checked;
  const zipped = keys.length > 1;
  const name = zipped
    ? (masked ? "SpendStory_Reports_Anonymized.zip" : "SpendStory_Reports.zip")
    : FORMATS[keys[0]].filename(masked);
  await downloadFormat(payment, "api/export-bundle", name, { formats: keys.join(",") });
}

async function runDownload(payment, keys) {
  const btn = $("btn-dl-confirm");
  btn.disabled = true;
  btn.textContent = "Preparing your files…";
  try {
    await downloadSelected(payment, keys);
    lastVerifiedPayment = payment;
    // Already paid: the button becomes a plain re-download for any format
    // they didn't pick the first time, with no second charge.
    btn.textContent = "⬇ Download";
  } catch (e) {
    setDlError(e.message);
    btn.textContent = DL_BTN_DEFAULT;
  } finally {
    btn.disabled = false;
    if (lastVerifiedPayment) btn.textContent = "⬇ Download";
  }
}

$("btn-dl-confirm").addEventListener("click", async () => {
  const keys = selectedFormats();
  if (!keys.length) return setDlError("Pick at least one format to download.");
  setDlError("");

  // Already paid for this statement — no second charge for the formats
  // they skipped the first time round.
  if (lastVerifiedPayment) return runDownload(lastVerifiedPayment, keys);

  const btn = $("btn-dl-confirm");

  // Temporary QA mode (SPENDSTORY_EXPORTS_FREE=true server-side) — skip
  // Razorpay entirely, backend ignores the empty signature while it's on.
  const statusRes = await fetch("api/exports-status").catch(() => null);
  const status = statusRes && statusRes.ok ? await statusRes.json() : { free: false };
  if (status.free) {
    return runDownload({ razorpay_order_id: "", razorpay_payment_id: "", razorpay_signature: "" }, keys);
  }

  if (typeof Razorpay === "undefined") {
    return setDlError("Payment widget failed to load — check your connection and try again.");
  }
  btn.disabled = true;
  btn.textContent = "Starting checkout…";

  try {
    const res = await fetch("api/create-order", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Couldn't start checkout.");
    }
    const order = await res.json();

    const rzp = new Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      order_id: order.order_id,
      name: "SpendStory",
      description: "Deep-Dive Report",
      theme: { color: "#7c3aed" },
      handler: (response) => runDownload(response, keys),
      modal: {
        ondismiss: () => {
          btn.disabled = false;
          btn.textContent = DL_BTN_DEFAULT;
        },
      },
    });
    rzp.on("payment.failed", () => setDlError("Payment failed. You have not been charged — please try again."));
    rzp.open();
    btn.textContent = DL_BTN_DEFAULT;
    btn.disabled = false;
  } catch (e) {
    setDlError(e.message || "Couldn't reach the server. Please try again.");
    btn.disabled = false;
    btn.textContent = DL_BTN_DEFAULT;
  }
});

$("btn-export").addEventListener("click", () => {
  if (isSampleMode) {
    return setExportError("This is sample data — upload your own statement to download a real report.");
  }
  if (!pendingFiles.length) return;
  setExportError("");
  setDlError("");
  openModal("dl-modal", "dl-backdrop");
});

/* ── Sample data demo ─────────────────────────────────────────
   Lets a visitor see the dashboard/charts/anomaly detection before
   trusting the app with a real statement. Never hits the API, never
   saved to "past analyses" — it's obviously fake data, not a real
   analysis. Shape must match backend/main.py's _bundle() exactly. */
const SAMPLE_TXNS = [
  { date: "2026-01-03", narration: "SAL/ACME CORP/JAN", merchant: "Acme Corp", category: "Salary / Income", debit: 0, credit: 68000, is_anomaly: false },
  { date: "2026-01-04", narration: "UPI-SWIGGY-swiggy@ybl", merchant: "Swiggy", category: "Food & Dining", debit: 480, credit: 0, is_anomaly: false },
  { date: "2026-01-06", narration: "UPI-BIGBAZAAR-bb@okhdfc", merchant: "Big Bazaar", category: "Shopping", debit: 3200, credit: 0, is_anomaly: false },
  { date: "2026-01-08", narration: "UPI-UBER-uber@paytm", merchant: "Uber", category: "Transport", debit: 340, credit: 0, is_anomaly: false },
  { date: "2026-01-10", narration: "UPI-NETFLIX-netflix-bil", merchant: "Netflix", category: "Entertainment", debit: 649, credit: 0, is_anomaly: false },
  { date: "2026-01-12", narration: "UPI-ELECTRICITYBOARD-bil", merchant: "Electricity Board", category: "Bills & Utilities", debit: 2100, credit: 0, is_anomaly: false },
  { date: "2026-01-15", narration: "UPI-APOLLOPHARMACY-med", merchant: "Apollo Pharmacy", category: "Health", debit: 860, credit: 0, is_anomaly: false },
  { date: "2026-01-18", narration: "UPI-SWIGGY-swiggy@ybl", merchant: "Swiggy", category: "Food & Dining", debit: 610, credit: 0, is_anomaly: false },
  { date: "2026-01-22", narration: "UPI-AMAZON-amazon@apl", merchant: "Amazon", category: "Shopping", debit: 4500, credit: 0, is_anomaly: false },
  { date: "2026-01-28", narration: "UPI-GYMFIT-gymfit@okic", merchant: "Gym Fit", category: "Health", debit: 1200, credit: 0, is_anomaly: false },
  { date: "2026-02-03", narration: "SAL/ACME CORP/FEB", merchant: "Acme Corp", category: "Salary / Income", debit: 0, credit: 68000, is_anomaly: false },
  { date: "2026-02-05", narration: "UPI-SWIGGY-swiggy@ybl", merchant: "Swiggy", category: "Food & Dining", debit: 720, credit: 0, is_anomaly: false },
  { date: "2026-02-09", narration: "UPI-CROMA-electronics", merchant: "Croma Electronics", category: "Shopping", debit: 45000, credit: 0, is_anomaly: true },
  { date: "2026-02-10", narration: "UPI-NETFLIX-netflix-bil", merchant: "Netflix", category: "Entertainment", debit: 649, credit: 0, is_anomaly: false },
  { date: "2026-02-13", narration: "UPI-UBER-uber@paytm", merchant: "Uber", category: "Transport", debit: 410, credit: 0, is_anomaly: false },
  { date: "2026-02-14", narration: "UPI-ELECTRICITYBOARD-bil", merchant: "Electricity Board", category: "Bills & Utilities", debit: 2250, credit: 0, is_anomaly: false },
  { date: "2026-02-19", narration: "UPI-BIGBAZAAR-bb@okhdfc", merchant: "Big Bazaar", category: "Shopping", debit: 2800, credit: 0, is_anomaly: false },
  { date: "2026-02-24", narration: "UPI-GYMFIT-gymfit@okic", merchant: "Gym Fit", category: "Health", debit: 1200, credit: 0, is_anomaly: false },
  { date: "2026-03-03", narration: "SAL/ACME CORP/MAR", merchant: "Acme Corp", category: "Salary / Income", debit: 0, credit: 71000, is_anomaly: false },
  { date: "2026-03-06", narration: "UPI-SWIGGY-swiggy@ybl", merchant: "Swiggy", category: "Food & Dining", debit: 550, credit: 0, is_anomaly: false },
  { date: "2026-03-10", narration: "UPI-NETFLIX-netflix-bil", merchant: "Netflix", category: "Entertainment", debit: 649, credit: 0, is_anomaly: false },
  { date: "2026-03-12", narration: "UPI-UBER-uber@paytm", merchant: "Uber", category: "Transport", debit: 380, credit: 0, is_anomaly: false },
  { date: "2026-03-15", narration: "UPI-ELECTRICITYBOARD-bil", merchant: "Electricity Board", category: "Bills & Utilities", debit: 1980, credit: 0, is_anomaly: false },
  { date: "2026-03-20", narration: "UPI-AMAZON-amazon@apl", merchant: "Amazon", category: "Shopping", debit: 3100, credit: 0, is_anomaly: false },
];

function buildSampleBundle() {
  const income = SAMPLE_TXNS.reduce((s, t) => s + t.credit, 0);
  const spend = SAMPLE_TXNS.reduce((s, t) => s + t.debit, 0);
  const byMonth = {};
  const byCat = {};
  const byMerchant = {};
  for (const t of SAMPLE_TXNS) {
    const month = new Date(t.date + "T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });
    byMonth[month] ??= { month, income: 0, expense: 0 };
    byMonth[month].income += t.credit;
    byMonth[month].expense += t.debit;
    if (t.debit) {
      byCat[t.category] = (byCat[t.category] || 0) + t.debit;
      byMerchant[t.merchant] = (byMerchant[t.merchant] || 0) + t.debit;
    }
  }
  return {
    bank: "Sample", banks: ["Sample"],
    stats: { total_spend: spend, total_income: income, net_cash_flow: income - spend, txn_count: SAMPLE_TXNS.length },
    monthly: Object.values(byMonth),
    categories: Object.entries(byCat).map(([category, spend]) => ({ category, spend })),
    merchants: Object.entries(byMerchant).map(([merchant, total_spend]) => ({ merchant, total_spend })).sort((a, b) => b.total_spend - a.total_spend),
    anomalies: SAMPLE_TXNS.filter((t) => t.is_anomaly),
    subscriptions: [{
      merchant: "Netflix", amount: 649, occurrences: 3, avg_interval_days: 30,
      last_charged: "2026-03-10", next_expected: "2026-04-09", annual_cost: 7897,
    }],
    transactions: SAMPLE_TXNS,
  };
}

$("btn-try-sample").addEventListener("click", () => {
  isSampleMode = true;
  show("results");
  render(buildSampleBundle());
  $("sample-banner").hidden = false;
  // Disabled, not clickable-then-erroring — the persistent banner above
  // already says this is sample data; a second message on click was
  // redundant clutter, not a second explanation anyone needed.
  const exportBtn = $("btn-export");
  exportBtn.disabled = true;
  exportBtn.title = "Sample data can't be exported — upload your own statement to download a real report.";
});

/* ── Rendering ─────────────────────────────────────────────── */
function countUp(el, target, formatter) {
  const dur = 900, t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(target * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const PALETTE = ["#8b5cf6", "#d946ef", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#71717a", "#f97316"];

/* ── Merchant brand badges ──────────────────────────────────────
   A fixed, locally-bundled icon set (frontend/icons/merchants/, from
   Simple Icons, CC0) — not a live per-merchant fetch to a logo API. That
   would mean the browser tells a third party which merchants appear in
   someone's private bank statement, every time the dashboard renders;
   bundling avoids that entirely and works offline like the rest of this
   PWA. Only ~30 brands are covered by design — merchant names come from
   free-text bank-narration parsing (extract_merchant() in analyser.py),
   an open-ended set no fixed icon library can fully cover. Anything not
   matched gets a deterministic colour-hashed initial instead of a fake
   or missing logo — same "say what's actually known" pattern as the
   category classifier.

   `match` is a short list of how a brand's name actually shows up in a
   cleaned-up merchant string (title-cased, spaces kept) — not exhaustive,
   just the obvious variants. */
const BRAND_ICONS = [
  { slug: "swiggy", hex: "FC8019", match: ["swiggy"] },
  { slug: "zomato", hex: "E23744", match: ["zomato"] },
  { slug: "uber", hex: "000000", match: ["uber"] },
  { slug: "netflix", hex: "E50914", match: ["netflix"] },
  { slug: "bigbasket", hex: "A5CD39", match: ["bigbasket", "big basket"] },
  { slug: "airtel", hex: "E40000", match: ["airtel"] },
  { slug: "jio", hex: "0A2885", match: ["jio"] },
  { slug: "paytm", hex: "20336B", match: ["paytm"] },
  { slug: "phonepe", hex: "5F259F", match: ["phonepe", "phone pe"] },
  { slug: "googlepay", hex: "4285F4", match: ["google pay", "googlepay", "gpay"] },
  { slug: "spotify", hex: "1ED760", match: ["spotify"] },
  { slug: "mcdonalds", hex: "FBC817", match: ["mcdonald"] },
  { slug: "starbucks", hex: "006241", match: ["starbucks"] },
  { slug: "ikea", hex: "0058A3", match: ["ikea"] },
  { slug: "bookmyshow", hex: "C4242B", match: ["bookmyshow", "book my show"] },
  { slug: "zoom", hex: "0B5CFF", match: ["zoom"] },
  { slug: "github", hex: "181717", match: ["github"] },
  { slug: "apple", hex: "000000", match: ["apple"] },
  { slug: "google", hex: "4285F4", match: ["google"] },
  { slug: "gmail", hex: "EA4335", match: ["gmail"] },
  { slug: "whatsapp", hex: "25D366", match: ["whatsapp"] },
  { slug: "instagram", hex: "FF0069", match: ["instagram"] },
  { slug: "facebook", hex: "0866FF", match: ["facebook"] },
  { slug: "youtube", hex: "FF0000", match: ["youtube"] },
  { slug: "dropbox", hex: "0061FF", match: ["dropbox"] },
  { slug: "notion", hex: "000000", match: ["notion"] },
  { slug: "figma", hex: "F24E1E", match: ["figma"] },
  { slug: "airbnb", hex: "FF5A5F", match: ["airbnb"] },
  { slug: "oyo", hex: "EE2E24", match: ["oyo"] },
  { slug: "dunzo", hex: "00D290", match: ["dunzo"] },
];

function findBrandIcon(merchant) {
  const m = (merchant || "").toLowerCase();
  if (!m) return null;
  return BRAND_ICONS.find((b) => b.match.some((kw) => m.includes(kw))) || null;
}

/* Same colour a merchant always gets across the whole dashboard, chosen
   from the app's existing chart PALETTE rather than a random colour per
   render — a hash of the name, not a counter, so it's stable regardless
   of list order or which merchants happen to appear in a given statement. */
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function merchantBadge(merchant) {
  const icon = findBrandIcon(merchant);
  if (icon) {
    return `<span class="merchant-badge" style="background:#${icon.hex}"><img src="icons/merchants/${icon.slug}.svg" alt="" width="16" height="16"></span>`;
  }
  const letter = esc((merchant || "?").trim().charAt(0).toUpperCase() || "?");
  return `<span class="merchant-badge" style="background:${hashColor(merchant || "")}">${letter}</span>`;
}

function render(d) {
  applyCatOverrides(d);
  lastRenderedData = d;
  renderOverrideNote();

  $("bank-badge").textContent = d.bank === "UNKNOWN" ? "Bank statement" : d.bank + " statement";

  countUp($("stat-spend"), d.stats.total_spend, (v) => INR.format(v));
  countUp($("stat-income"), d.stats.total_income, (v) => INR.format(v));
  const net = $("stat-net");
  countUp(net, d.stats.net_cash_flow, (v) => INR.format(v));
  net.className = d.stats.net_cash_flow >= 0 ? "pos" : "neg";
  countUp($("stat-count"), d.stats.txn_count, (v) => Math.round(v).toLocaleString("en-IN"));

  buildCharts(d);

  // Anomalies — the card stays put with an explicit "nothing found", which
  // is a real result, not an absence worth hiding.
  $("anomaly-empty").hidden = d.anomalies.length > 0;
  $("anomaly-list").innerHTML = d.anomalies.slice(0, 6).map((a) => `
    <li>${merchantBadge(a.merchant)}<div class="m-left"><div class="m-name">${esc(a.merchant)}</div><small class="muted">${fmtDate(a.date)}</small></div>
    <span class="amount neg">−${INR.format(a.debit)}</span></li>`).join("");

  renderMoM(d);
  renderHeadline(d);
  renderSparklines(d);
  renderSectionNav();

  // Recurring subscriptions
  const hasSubs = d.subscriptions.length > 0;
  $("sub-empty").hidden = hasSubs;
  $("sub-total").hidden = !hasSubs;
  if (hasSubs) renderSubTotal(d.subscriptions);
  $("subscription-list").innerHTML = d.subscriptions.slice(0, 6).map((s) => `
    <li>${merchantBadge(s.merchant)}<div class="m-left"><div class="m-name">${esc(s.merchant)}</div>
    <small class="muted">every ~${s.avg_interval_days}d · next ~${fmtDate(s.next_expected)} · ${INR.format(s.annual_cost)}/yr</small></div>
    <span class="amount neg">−${INR.format(s.amount)}</span></li>`).join("");

  // Merchants with proportional bars
  const maxSpend = d.merchants[0]?.total_spend || 1;
  $("merchant-list").innerHTML = d.merchants.map((m) => `
    <li>${merchantBadge(m.merchant)}<div class="m-left"><div class="m-name">${esc(m.merchant)}</div>
    <div class="merchant-bar" style="width:0%" data-w="${(m.total_spend / maxSpend * 100).toFixed(1)}"></div></div>
    <span class="amount">${INR.format(m.total_spend)}</span></li>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.querySelectorAll(".merchant-bar").forEach((b) => { b.style.width = b.dataset.w + "%"; })));

  activeStatFilter = null;
  $("stat-spend-card").classList.remove("is-active");
  $("stat-income-card").classList.remove("is-active");
  $("txn-search").value = "";
  renderCatPills(d);
  applyTxnFilters();
}

/* KPI cards double as transaction-table filters — click "Money out" to see
   only debits, "Money in" for only credits, click again to clear. Combines
   with the free-text search and the category pill row rather than
   replacing either. */
let activeStatFilter = null; // null | "debit" | "credit"
let activeCatFilter = null;  // null | a category name

function renderCatPills(d) {
  const bar = $("cat-filter-bar");
  const counts = new Map();
  for (const t of d.transactions) counts.set(t.category, (counts.get(t.category) || 0) + 1);
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  activeCatFilter = null;
  bar.innerHTML = `<button type="button" class="cat-pill is-active" data-cat="">All</button>` +
    cats.map(([cat]) => `<button type="button" class="cat-pill" data-cat="${esc(cat)}">${esc(cat)}</button>`).join("");
  bar.querySelectorAll(".cat-pill").forEach((btn) => btn.addEventListener("click", () => {
    activeCatFilter = btn.dataset.cat || null;
    bar.querySelectorAll(".cat-pill").forEach((b) => b.classList.toggle("is-active", b === btn));
    applyTxnFilters();
  }));
}

function applyTxnFilters() {
  const d = lastRenderedData;
  if (!d) return;
  const q = $("txn-search").value.toLowerCase();
  const filtered = d.transactions.filter((t) => {
    if (activeStatFilter === "debit" && !(t.debit > 0)) return false;
    if (activeStatFilter === "credit" && !(t.credit > 0)) return false;
    if (activeCatFilter && t.category !== activeCatFilter) return false;
    return (t.merchant + " " + t.category + " " + t.narration).toLowerCase().includes(q);
  });
  renderTable(filtered);
  const note = $("txn-filter-note");
  if (activeStatFilter) {
    note.hidden = false;
    note.textContent = `Showing only ${activeStatFilter === "debit" ? "money out" : "money in"} (${filtered.length} of ${d.transactions.length}) — tap the card again to clear.`;
  } else {
    note.hidden = true;
  }
}

$("txn-search").addEventListener("input", applyTxnFilters);

function toggleStatFilter(type) {
  activeStatFilter = activeStatFilter === type ? null : type;
  $("stat-spend-card").classList.toggle("is-active", activeStatFilter === "debit");
  $("stat-income-card").classList.toggle("is-active", activeStatFilter === "credit");
  applyTxnFilters();
  if (activeStatFilter) $("txn-table").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("stat-spend-card").addEventListener("click", () => toggleStatFilter("debit"));
$("stat-income-card").addEventListener("click", () => toggleStatFilter("credit"));

/* Chart colours are baked into the canvas at draw time, so a CSS-variable
   theme switch alone won't re-tint existing charts — they must be rebuilt.
   Split out so the theme toggle can call this alone, without re-running
   count-up animations or duplicating history entries. */
/* Real HTML legend for the doughnut, built from the same `cats` array used
   for the chart data — so colours/labels/order always match exactly.
   Clicking an item toggles that slice via Chart.js's own visibility API,
   same behaviour as the built-in legend, just with a discoverable look. */
/* index === null resets to the total. Shared by the doughnut's own hover
   and the HTML legend below it, so both point at the same source of truth. */
function updateDonutCenter(index, cats, totalSpend) {
  const val = $("donut-center-value"), label = $("donut-center-label");
  if (index === null || !cats[index]) {
    val.textContent = INR.format(totalSpend);
    label.textContent = "Total spend";
    return;
  }
  const c = cats[index];
  const pct = totalSpend > 0 ? Math.round((c.spend / totalSpend) * 100) : 0;
  val.textContent = INR.format(c.spend);
  label.textContent = `${c.category} · ${pct}%`;
}

function buildCatLegend(chart, cats) {
  const el = $("cat-legend");
  el.innerHTML = cats.map((c, i) => `
    <button type="button" class="cat-legend-item" data-i="${i}">
      <span class="cat-legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span class="cat-legend-label">${esc(c.category)}</span>
    </button>`).join("");
  const totalSpend = cats.reduce((sum, c) => sum + c.spend, 0);
  el.querySelectorAll(".cat-legend-item").forEach((btn) => {
    const i = Number(btn.dataset.i);
    btn.addEventListener("click", () => {
      chart.toggleDataVisibility(i);
      chart.update();
      btn.classList.toggle("is-off", !chart.getDataVisibility(i));
    });
    // Hovering the legend highlights the same slice the chart itself would
    // on a direct hover, via Chart.js's own element-active API — so the
    // two hover paths land on identical visuals instead of two look-alikes
    // that could quietly drift apart.
    btn.addEventListener("mouseenter", () => {
      if (!chart.getDataVisibility(i)) return;
      chart.setActiveElements([{ datasetIndex: 0, index: i }]);
      chart.update();
      updateDonutCenter(i, cats, totalSpend);
    });
    btn.addEventListener("mouseleave", () => {
      chart.setActiveElements([]);
      chart.update();
      updateDonutCenter(null, cats, totalSpend);
    });
  });
}

function buildCharts(d) {
  charts.forEach((c) => c.destroy());
  charts = [];

  const ink = getComputedStyle(document.body).getPropertyValue("--ink").trim();
  Chart.defaults.color = ink;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif";
  Chart.defaults.font.size = 13;

  let cats = d.categories.filter((c) => c.spend > 0);
  if (cats.length > 6) {
    const visible = cats.slice(0, 6);
    const otherSpend = cats.slice(6).reduce((sum, c) => sum + c.spend, 0);
    visible.push({ category: "Other", spend: otherSpend });
    cats = visible;
  }
  const catChart = new Chart($("chart-cats"), {
    type: "doughnut",
    data: {
      labels: cats.map((c) => c.category),
      datasets: [{ data: cats.map((c) => c.spend), backgroundColor: PALETTE, borderWidth: 0, hoverOffset: 10 }],
    },
    options: {
      // cutout/radius: Chart.js auto-sizes the doughnut's base radius to
      // fill the canvas, but does NOT reserve room for hoverOffset pushing
      // the hovered slice further out — so hovering ANY slice (top, bottom,
      // either side) pushed it past the canvas edge and got clipped.
      // radius: '88%' shrinks the base ring so that 10px hover expansion
      // always lands inside the canvas, on every edge, regardless of size.
      cutout: "62%", radius: "88%", maintainAspectRatio: false,
      layout: { padding: 12 },
      animation: { animateRotate: true, duration: 900, easing: "easeOutCubic" },
      // Redraws the centre label to the hovered slice's own value/share —
      // Chart.js's hoverOffset already pops the slice out; this is the
      // other half of that gesture, since a floating tooltip near the edge
      // is easy to miss but the centre of the ring is always in view.
      onHover: (_evt, elements) => updateDonutCenter(elements[0]?.index ?? null, cats, totalSpend),
      plugins: {
        // Built-in legend replaced by a real HTML panel below (see
        // buildCatLegend) — a canvas-drawn legend can't be given hover
        // states, a "tap to filter" hint, or a glass background, and
        // nothing signalled that the colour squares were clickable toggles.
        legend: { display: false },
        // caretSize: 0 — Chart.js's default tooltip arrow is positioned for
        // bar/line charts; on a doughnut it points from the arc's centroid
        // and renders as a disconnected floating triangle near the edge.
        tooltip: { caretSize: 0, cornerRadius: 8, padding: 10, callbacks: { label: (c) => " " + INR.format(c.parsed) } },
      },
    },
  });
  charts.push(catChart);
  buildCatLegend(catChart, cats);
  const totalSpend = cats.reduce((sum, c) => sum + c.spend, 0);
  updateDonutCenter(null, cats, totalSpend);
  $("chart-cats").addEventListener("mouseleave", () => updateDonutCenter(null, cats, totalSpend));

  const barGradient = (topColor, bottomColor) => (ctx) => {
    const { chartArea } = ctx.chart;
    if (!chartArea) return topColor;
    const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, topColor);
    g.addColorStop(1, bottomColor);
    return g;
  };
  const topRadius = { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 };
  const BAR_GLOW_COLORS = ["#10b981", "#ef4444"]; // matches the "In"/"Out" datasets below

  // Redraws whichever bar is currently hovered with a canvas shadow behind
  // it, so it glows in its own colour instead of just Chart.js's default
  // flat hover-darken.
  const barGlowPlugin = {
    id: "barGlow",
    afterDatasetsDraw(chart) {
      const active = chart.getActiveElements();
      if (!active.length) return;
      const { ctx } = chart;
      active.forEach(({ element, datasetIndex }) => {
        ctx.save();
        ctx.shadowColor = BAR_GLOW_COLORS[datasetIndex] || "#8b5cf6";
        ctx.shadowBlur = 18;
        element.draw(ctx);
        ctx.restore();
      });
    },
  };

  const sortedMonths = monthsSorted(d);
  const monthsChart = new Chart($("chart-months"), {
    type: "bar",
    data: {
      // Sorted: monthly_summary() emits months in first-seen order, so an
      // out-of-order statement drew Feb before Jan on the x-axis.
      labels: sortedMonths.map((m) => m.month),
      datasets: [
        { label: "In", data: sortedMonths.map((m) => m.income), backgroundColor: barGradient("#10b981", "rgba(16,185,129,.35)"), borderRadius: topRadius },
        { label: "Out", data: sortedMonths.map((m) => m.expense), backgroundColor: barGradient("#ef4444", "rgba(239,68,68,.35)"), borderRadius: topRadius },
      ],
    },
    plugins: [barGlowPlugin],
    options: {
      maintainAspectRatio: false,
      animation: {
        duration: 900, easing: "easeOutCubic",
        // Each bar starts a beat after the last — a month-by-month chart
        // reads left-to-right, so the entrance draws attention the same
        // direction the eye already scans. Only the initial draw staggers
        // (ctx.mode !== "resize" excludes the reflow on a theme-toggle
        // rebuild, which shouldn't replay the whole entrance every time).
        delay: (ctx) => ctx.type === "data" && ctx.mode !== "resize" ? ctx.dataIndex * 70 + ctx.datasetIndex * 90 : 0,
      },
      // categoryPercentage/barPercentage: Chart.js defaults pack the two
      // bars in a month flush against each other and nearly fill the slot,
      // which reads as one striped block rather than two values.
      datasets: { bar: { categoryPercentage: 0.68, barPercentage: 0.86 } },
      scales: {
        y: { ticks: { callback: (v) => "₹" + (v >= 1000 ? (v / 1000) + "k" : v), padding: 6 },
             border: { display: false }, grid: { color: "rgba(128,128,128,.15)", drawTicks: false } },
        x: { grid: { display: false }, border: { display: false }, ticks: { padding: 6 } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: "circle", padding: 16 } },
        tooltip: { cornerRadius: 8, padding: 10, boxPadding: 4,
                   callbacks: { label: (c) => ` ${c.dataset.label}: ${INR.format(c.parsed.y)}` } },
      },
    },
  });
  charts.push(monthsChart);
  animateMonthsChartOnScroll(monthsChart);
}

/* The staggered entrance plays the instant the data loads, which is at the
   TOP of the page — by the time someone scrolls down to actually see this
   chart, the animation already finished and they just see fully-grown
   bars. Reported directly: "I click month by month, nothing grows, the
   bars are just present fully."

   A reset() plus a scroll-triggered replay isn't enough on its own either:
   Chart.js has its own built-in ResizeObserver, and the results screen
   going from hidden to visible (container jumps from 0 to real size)
   fires Chart.js's own instant, non-animated resize redraw — filling the
   bars to full height while still off-screen. That frame IS briefly on
   screen the moment the user scrolls it into view, a beat before our own
   reset()+update() catches up and replays properly — reported as "it
   quickly goes from already-present bar to growing one."

   Fix: hide the canvas (opacity 0) the instant it's built, before Chart.js
   gets any chance to draw that premature full frame where anyone could
   see it, and only reveal it in the same tick as the real reset+animate —
   so the only thing ever visible is one clean zero-to-full transition. */
let monthsChartObserver = null;
function animateMonthsChartOnScroll(chart) {
  monthsChartObserver?.disconnect();
  const canvas = $("chart-months");
  canvas.style.opacity = "0";
  chart.reset();
  monthsChartObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    chart.reset();   // undo any resize-triggered instant fill from while
    canvas.style.opacity = "1";  // it was hidden, then reveal and replay —
    chart.update();  // this is the only frame sequence anyone ever sees
    monthsChartObserver.disconnect();
  }, { threshold: 0.35 });
  monthsChartObserver.observe(canvas);
}

function renderTable(rows) {
  $("txn-table").querySelector("tbody").innerHTML = rows.map((t) => `
    <tr class="${t.is_anomaly ? "flag" : ""}">
      <td>${fmtDateShort(t.date)}</td>
      <td class="td-merchant" title="${esc(t.narration)}">${merchantBadge(t.merchant)}<span class="td-merchant-name">${esc(t.merchant)}</span></td>
      <td><button type="button" class="cat-chip cat-chip-btn${CAT_OVERRIDES[catKey(t)] ? " is-overridden" : ""}" data-merchant="${esc(t.merchant)}" data-cat="${esc(t.category)}" title="Tap to change this category">${esc(t.category)}</button></td>
      <td class="num ${t.credit > 0 ? "pos" : "neg"}">${t.credit > 0 ? "+" + INR.format(t.credit) : "−" + INR.format(t.debit)}</td>
    </tr>`).join("");
}

/* ── Category correction ──────────────────────────────────────
   The classifier is a keyword match, so a merchant it doesn't know lands in
   a generic bucket. Rather than pretend that's always right, let people fix
   it — keyed by merchant so one correction applies to every transaction
   from that merchant, past and future. Stored on this device only, like
   history: it's a personal preference about your own statement, not
   something we need on a server.

   Only the category-derived views are recomputed. Totals, monthly figures,
   merchants and anomalies don't depend on category at all, so recomputing
   them would be work that couldn't change any number on screen. */
const CAT_KEY = "ss-cat-overrides";
const CATEGORIES = [
  "Food & Dining", "Shopping", "Transport", "Bills & Utilities", "Entertainment",
  "Health", "Insurance", "Finance & EMI", "Salary / Income", "Other Income", "Other Expense",
];

function loadCatOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAT_KEY) || "{}");
    // Anything could be sitting in localStorage — a hand-edited value, or a
    // shape from an older build. Keep only string->string pairs.
    const clean = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (typeof v === "string") clean[k] = v;
    }
    return clean;
  } catch { return {}; }
}
let CAT_OVERRIDES = loadCatOverrides();

const catKey = (t) => (t.merchant || "").trim().toLowerCase();

/* Applies saved corrections to a freshly-fetched bundle and rebuilds the
   category totals from the corrected rows. Mutates in place: `d` is this
   render's own copy, and lastRenderedData must see the same objects the
   table and charts were built from. */
function applyCatOverrides(d) {
  if (!d || !d.transactions) return d;
  for (const t of d.transactions) {
    if (t._origCategory === undefined) t._origCategory = t.category;
    const o = CAT_OVERRIDES[catKey(t)];
    t.category = o || t._origCategory;
  }
  const totals = new Map();
  for (const t of d.transactions) {
    const amt = t.debit ? t.debit : t.credit;
    const e = totals.get(t.category) || { category: t.category, spend: 0, txn_count: 0 };
    e.spend += amt; e.txn_count += 1;
    totals.set(t.category, e);
  }
  d.categories = [...totals.values()].sort((a, b) => b.spend - a.spend);
  return d;
}

function renderOverrideNote() {
  const n = Object.keys(CAT_OVERRIDES).length;
  $("cat-override-note").hidden = n === 0;
  $("cat-override-count").textContent =
    `${n} merchant${n === 1 ? "" : "s"} recategorised on this device.`;
}

function saveCatOverride(merchant, category) {
  const key = (merchant || "").trim().toLowerCase();
  if (!key) return;
  const original = (lastRenderedData?.transactions || []).find((t) => catKey(t) === key)?._origCategory;
  // Choosing the original category back is a removal, not an override —
  // otherwise "reset all" would leave behind entries that change nothing.
  if (category === original) delete CAT_OVERRIDES[key];
  else CAT_OVERRIDES[key] = category;
  try { localStorage.setItem(CAT_KEY, JSON.stringify(CAT_OVERRIDES)); } catch {}
  renderOverrideNote();
  if (lastRenderedData) {
    applyCatOverrides(lastRenderedData);
    buildCharts(lastRenderedData);
    refreshCatPillsKeepingFilter();
  }
}

$("btn-reset-cats").addEventListener("click", () => {
  CAT_OVERRIDES = {};
  try { localStorage.removeItem(CAT_KEY); } catch {}
  renderOverrideNote();
  if (lastRenderedData) {
    applyCatOverrides(lastRenderedData);
    buildCharts(lastRenderedData);
    refreshCatPillsKeepingFilter();
  }
});

// A correction can rename a category out of existence (0 transactions left
// in it) or introduce one that wasn't in the pill row before — rebuild the
// row, but keep the user's active filter selected if that category still
// has transactions in it, rather than silently resetting to "All".
function refreshCatPillsKeepingFilter() {
  const wanted = activeCatFilter;
  renderCatPills(lastRenderedData);
  if (wanted && [...lastRenderedData.transactions].some((t) => t.category === wanted)) {
    activeCatFilter = wanted;
    $("cat-filter-bar").querySelectorAll(".cat-pill").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.cat === wanted));
  }
  applyTxnFilters();
}

const catMenu = $("cat-menu");
let catMenuFor = null;

function closeCatMenu() { catMenu.hidden = true; catMenuFor = null; }

function openCatMenu(btn) {
  const merchant = btn.dataset.merchant;
  const current = btn.dataset.cat;
  catMenuFor = merchant;
  catMenu.innerHTML = `<div class="cat-menu-head">${esc(merchant || "this merchant")}</div>` +
    CATEGORIES.map((c) => `<button type="button" role="menuitem" class="cat-menu-item${c === current ? " is-current" : ""}" data-value="${esc(c)}">${esc(c)}</button>`).join("");
  catMenu.hidden = false;
  // Positioned after unhiding so the measured height is the real one, then
  // clamped into the viewport — near the bottom of a long table the menu
  // would otherwise open below the fold.
  const r = btn.getBoundingClientRect();
  const mh = catMenu.offsetHeight, mw = catMenu.offsetWidth;
  const top = r.bottom + 6 + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 6) : r.bottom + 6;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
  catMenu.style.top = `${top + window.scrollY}px`;
  catMenu.style.left = `${left + window.scrollX}px`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".cat-chip-btn");
  if (btn) {
    e.stopPropagation();
    if (catMenuFor === btn.dataset.merchant && !catMenu.hidden) return closeCatMenu();
    return openCatMenu(btn);
  }
  const item = e.target.closest(".cat-menu-item");
  if (item) {
    e.stopPropagation();
    const m = catMenuFor;
    closeCatMenu();
    return saveCatOverride(m, item.dataset.value);
  }
  if (!catMenu.hidden) closeCatMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCatMenu(); });
// Anchored to a row's on-screen position, so it must follow or close.
window.addEventListener("scroll", () => { if (!catMenu.hidden) closeCatMenu(); }, { passive: true });
window.addEventListener("resize", () => { if (!catMenu.hidden) closeCatMenu(); });

/* ── Subscription cancellation value ──────────────────────────
   The per-item annual costs were already computed server-side; what was
   missing is the number people actually react to — the total. */
function renderSubTotal(subs) {
  const yearly = subs.reduce((sum, s) => sum + (s.annual_cost || 0), 0);
  $("sub-total-year").textContent = INR.format(yearly);
  $("sub-total-month").textContent = INR.format(yearly / 12);
  $("sub-total-count").textContent = `${subs.length} subscription${subs.length === 1 ? "" : "s"}`;
}

/* ── Month-over-month comparison ──────────────────────────────
   Compares the two most recent months present in the statement. Needs two
   full months to say anything honest, so with one month the card stays
   hidden rather than showing a comparison against nothing. */
function renderMoM(d) {
  const months = monthsSorted(d);
  const single = months.length < 2;
  $("mom-single").hidden = !single;
  $("mom-hero").hidden = single;
  $("mom-cats").hidden = single;
  document.querySelector(".mom-sub-head").hidden = single;
  if (single) {
    $("mom-title").textContent = "Compare with another month";
    $("mom-sub").textContent = "";
    $("mom-empty").hidden = true;
    return;
  }

  const cur = months[months.length - 1], prev = months[months.length - 2];
  $("mom-title").textContent = `${cur.month} vs ${prev.month}`;
  $("mom-sub").textContent = months.length > 2
    ? `The two most recent of ${months.length} months in this statement.`
    : "The two months in this statement.";

  const curNet = cur.income - cur.expense, prevNet = prev.income - prev.expense;
  setDelta("mom-spend", "mom-spend-delta", cur.expense, prev.expense, true);
  setDelta("mom-income", "mom-income-delta", cur.income, prev.income, false);
  setDelta("mom-net", "mom-net-delta", curNet, prevNet, false);

  // Per-category movement, computed from the transactions rather than asking
  // the server for it — the numbers must reflect any category corrections
  // the user has made, and those only exist in this browser.
  const byCat = new Map();
  for (const t of d.transactions) {
    if (!t.debit) continue;
    const m = monthLabel(t.date);
    if (m !== cur.month && m !== prev.month) continue;
    const e = byCat.get(t.category) || { category: t.category, cur: 0, prev: 0 };
    if (m === cur.month) e.cur += t.debit; else e.prev += t.debit;
    byCat.set(t.category, e);
  }
  const moved = [...byCat.values()]
    .map((e) => ({ ...e, diff: e.cur - e.prev }))
    .filter((e) => Math.abs(e.diff) >= 1)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 5);

  $("mom-empty").hidden = moved.length > 0;
  $("mom-cats").innerHTML = moved.map((e) => {
    const up = e.diff > 0;
    // A category with no spend last month has no meaningful % change —
    // "+∞%" is noise, so it's labelled as new instead.
    const pct = e.prev > 0 ? Math.round(Math.abs(e.diff) / e.prev * 100) : null;
    return `<li>
      <div class="mom-cat-left">
        <div class="mom-cat-name">${esc(e.category)}</div>
        <small class="muted">${INR.format(e.prev)} → ${INR.format(e.cur)}</small>
      </div>
      <span class="mom-cat-delta ${up ? "is-up" : "is-down"}">
        ${up ? "▲" : "▼"} ${INR.format(Math.abs(e.diff))}${pct === null ? " · new" : ` · ${pct}%`}
      </span>
    </li>`;
  }).join("");
}

/* "2026-01-04" -> "Jan 2026", matching monthly_summary()'s own key format
   so transactions can be bucketed against it. */
const monthLabel = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
/* Sortable ordinal for a "Jan 2026" label. */
const monthOrd = (label) => {
  const d = new Date("1 " + label);
  return isNaN(d) ? 0 : d.getFullYear() * 12 + d.getMonth();
};

/* Months in chronological order. monthly_summary() keys them "Jan 2026" in
   first-seen order, which is not sortable as a string and not necessarily
   in date order. */
const monthsSorted = (d) =>
  (d.monthly || []).filter((m) => m.month).slice().sort((a, b) => monthOrd(a.month) - monthOrd(b.month));

/* ── Headline ─────────────────────────────────────────────────
   One sentence at the top so the page has an obvious entry point instead
   of nine equally-weighted cards. Everything here is derived from figures
   already on screen — it restates them, it never introduces a new claim. */
function renderHeadline(d) {
  const el = $("headline"), text = $("headline-text"), sub = $("headline-sub");
  const months = monthsSorted(d);
  const spend = d.stats.total_spend;
  if (!spend && !d.stats.total_income) { el.hidden = true; return; }
  el.hidden = false;

  const topCat = (d.categories || []).filter((c) => c.category !== "Salary / Income" && c.category !== "Other Income")[0];
  const period = months.length === 1 ? `in ${months[0].month}`
    : months.length ? `across ${months.length} months` : "in this statement";

  let main = `You spent <b>${INR.format(spend)}</b> ${period}`;
  if (topCat) main += `, most of it on <b>${esc(topCat.category)}</b>`;
  text.innerHTML = main + ".";

  const bits = [];
  if (months.length >= 2) {
    const cur = months[months.length - 1], prev = months[months.length - 2];
    const diff = cur.expense - prev.expense;
    bits.push(Math.abs(diff) < 1
      ? `Spending held steady between ${prev.month} and ${cur.month}.`
      : `That's <b>${INR.format(Math.abs(diff))} ${diff > 0 ? "more" : "less"}</b> in ${cur.month} than ${prev.month}.`);
  }
  const subs = d.subscriptions || [];
  if (subs.length) {
    const yearly = subs.reduce((sum, x) => sum + (x.annual_cost || 0), 0);
    bits.push(`${subs.length} recurring charge${subs.length === 1 ? "" : "s"} cost you <b>${INR.format(yearly)}</b> a year.`);
  }
  if ((d.anomalies || []).length) {
    bits.push(`${d.anomalies.length} payment${d.anomalies.length === 1 ? " was" : "s were"} unusually large.`);
  }
  sub.innerHTML = bits.join(" ");
  sub.hidden = bits.length === 0;
}

/* ── Sparklines ───────────────────────────────────────────────
   Inline SVG rather than a charting library: four more Chart.js instances
   for eight data points each would cost far more than the polyline they'd
   draw. Needs at least two months — a single point is not a trend, so the
   card just shows its number, as before. */
function sparkline(values, color) {
  if (values.length < 2) return "";
  const W = 100, H = 26, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - pad - ((v - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(",");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="${color}"/>
  </svg>`;
}

function renderSparklines(d) {
  const months = monthsSorted(d);
  // Transaction counts aren't in monthly_summary, so they're counted here
  // from the same rows the table renders.
  const counts = new Map(months.map((m) => [m.month, 0]));
  for (const t of d.transactions || []) {
    const k = monthLabel(t.date);
    if (counts.has(k)) counts.set(k, counts.get(k) + 1);
  }
  const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
  const neg = css("--neg") || "#ef4444", pos = css("--pos") || "#10b981", brand = css("--brand") || "#7c3aed";
  $("spark-spend").innerHTML = sparkline(months.map((m) => m.expense), neg);
  $("spark-income").innerHTML = sparkline(months.map((m) => m.income), pos);
  $("spark-net").innerHTML = sparkline(months.map((m) => m.income - m.expense), brand);
  $("spark-count").innerHTML = sparkline(months.map((m) => counts.get(m.month) || 0), brand);
}

/* ── Section nav ──────────────────────────────────────────────
   The results page is a long scroll on a phone. Links to cards that can be
   empty are dropped rather than left pointing at a hidden section. */
/* The topbar wraps to two rows on narrow screens, so its height isn't a
   constant the CSS can assume. Measured here and published as a variable
   the sticky offset and anchor scroll-margin both read. */
function measureStickyOffsets() {
  const bar = document.querySelector(".topbar"), nav = $("section-nav");
  if (bar) document.documentElement.style.setProperty("--topbar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
  if (nav) document.documentElement.style.setProperty("--nav-h", `${Math.round(nav.getBoundingClientRect().height)}px`);
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(measureStickyOffsets);
  ro.observe(document.querySelector(".topbar"));
  ro.observe($("section-nav"));
}
window.addEventListener("resize", measureStickyOffsets);
window.addEventListener("orientationchange", measureStickyOffsets);
/* Also recomputed on scroll, throttled to one measurement per frame. The
   ResizeObserver is the primary signal, but its callback is deferred and
   doesn't run at all while the tab is backgrounded — so a rotation or
   window resize that happens off-screen would leave a stale offset, and
   the nav would park in the wrong place the moment the user scrolled.
   Scroll is exactly when the offset has to be right. */
let stickyTick = false;
window.addEventListener("scroll", () => {
  if (stickyTick) return;
  stickyTick = true;
  requestAnimationFrame(() => { stickyTick = false; measureStickyOffsets(); });
}, { passive: true });
measureStickyOffsets();

function renderSectionNav() {
  measureStickyOffsets();
  for (const a of document.querySelectorAll("#section-nav a[data-optional]")) {
    const target = document.querySelector(a.getAttribute("href"));
    a.hidden = !target || target.hidden;
  }
}

function setDelta(valueId, deltaId, cur, prev, lowerIsBetter) {
  $(valueId).textContent = INR.format(cur);
  const el = $(deltaId);
  const diff = cur - prev;
  if (Math.abs(diff) < 1) {
    el.textContent = "no change";
    el.className = "delta is-flat";
    return;
  }
  const up = diff > 0;
  const pct = prev !== 0 ? ` (${Math.round(Math.abs(diff) / Math.abs(prev) * 100)}%)` : "";
  el.textContent = `${up ? "▲" : "▼"} ${INR.format(Math.abs(diff))}${pct}`;
  // "Good" depends on the metric: spending more is bad, earning more is good.
  const good = lowerIsBetter ? !up : up;
  el.className = `delta ${good ? "is-good" : "is-bad"}`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
// Transaction-table-only: the whole table is one statement period, so
// repeating the year on every single row is clutter, not information.
const fmtDateShort = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

/* ── Past analyses (localStorage — this device only) ───────── */
const HIST_KEY = "ss-history";
const HIST_MAX = 5; // full dashboards are large; keep the last few

const loadHist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } };

function addToHistory(data) {
  const entry = {
    ts: Date.now(),
    bank: data.bank,
    spend: data.stats.total_spend,
    txns: data.stats.txn_count,
    months: data.monthly.length ? `${data.monthly[0].month} – ${data.monthly[data.monthly.length - 1].month}` : "",
    data,
  };
  if (JSON.stringify(entry).length > 1_500_000) return; // don't blow the storage quota
  const h = [entry, ...loadHist()].slice(0, HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* quota full — skip silently */ }
  renderHistory();
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function renderHistory() {
  const h = loadHist();
  $("history-empty").hidden = h.length > 0;
  $("history-list").innerHTML = h.map((e, i) => `
    <li data-i="${i}" title="Tap to reopen this analysis">
      <span class="h-badge">${esc(e.bank)}</span>
      <div class="h-meta"><div class="h-title">${INR.format(e.spend)} out · ${e.txns} txns</div>
      <div class="h-sub">${esc(e.months)} · ${timeAgo(e.ts)}</div></div>
    </li>`).join("");
  document.querySelectorAll("#history-list li").forEach((li) =>
    li.addEventListener("click", () => {
      const e = loadHist()[+li.dataset.i];
      if (!e) return;
      closeDrawer();
      pendingFiles = []; // history keeps only a summary, never the original PDF
      lastVerifiedPayment = null; // different statement — don't carry a purchase across
      show("results");
      render(e.data);
      const exportBtn = $("btn-export");
      exportBtn.disabled = true;
      exportBtn.title = "This is a past analysis — we don't keep your original PDF (nothing is stored), so re-upload the statement to download a fresh Excel report.";
    }));
}

function openDrawer() {
  renderHistory();
  $("drawer").classList.add("open");
  $("drawer-backdrop").hidden = false;
  requestAnimationFrame(() => $("drawer-backdrop").classList.add("show"));
}
function closeDrawer() {
  $("drawer").classList.remove("open");
  $("drawer-backdrop").classList.remove("show");
  setTimeout(() => ($("drawer-backdrop").hidden = true), 300);
}
$("btn-history").addEventListener("click", () =>
  $("drawer").classList.contains("open") ? closeDrawer() : openDrawer());
$("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

/* ── Topbar dropdowns (banks / sample data) ───────────────────
   Small on-demand popovers — same open/close pattern as the history drawer.
   wireDropdown handles both so they share open/close/outside-click logic. */
let closeOpenDropdown = null; // only one topbar popover open at a time
function wireDropdown(btnId, popoverId) {
  const btn = $(btnId), pop = $(popoverId);
  const close = () => { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (closeOpenDropdown === close) closeOpenDropdown = null; };
  const open = () => {
    if (closeOpenDropdown) closeOpenDropdown();
    pop.hidden = false; btn.setAttribute("aria-expanded", "true"); closeOpenDropdown = close;
    // Default is right-anchored (correct on desktop, where these buttons sit
    // at the right edge). Once the topbar wraps they move left and that
    // overflows off-screen — so measure and flip to left-anchored, unless
    // that would overflow the other way.
    pop.classList.remove("align-left");
    const r = pop.getBoundingClientRect();
    if (r.left < 8 && btn.getBoundingClientRect().left + r.width <= window.innerWidth - 8) {
      pop.classList.add("align-left");
    }
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !e.target.closest(`#${btnId}`) && !e.target.closest(`#${popoverId}`)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  return close;
}
wireDropdown("btn-banks", "banks-popover");
wireDropdown("btn-sample", "sample-popover");

/* ── Modals (download picker + about) ─────────────────────────
   `hidden` is set synchronously and the .open class one frame later so the
   CSS transition has a start state to animate from. Every open/close check
   reads `hidden`, never the class — a toggle fired inside that one-frame
   gap would otherwise read a stale class and do nothing. */
function openModal(modalId, backdropId) {
  const m = $(modalId), b = $(backdropId);
  m.hidden = false; b.hidden = false;
  // setTimeout, not requestAnimationFrame: rAF never fires while the tab is
  // backgrounded, which would leave the modal un-hidden but stuck at
  // opacity 0 — visible to the accessibility tree, invisible on screen.
  setTimeout(() => { m.classList.add("open"); b.classList.add("show"); }, 16);
}
function closeModal(modalId, backdropId) {
  const m = $(modalId), b = $(backdropId);
  m.classList.remove("open"); b.classList.remove("show");
  setTimeout(() => { m.hidden = true; b.hidden = true; }, 220);
}
$("btn-dl-close").addEventListener("click", () => closeModal("dl-modal", "dl-backdrop"));
$("dl-backdrop").addEventListener("click", () => closeModal("dl-modal", "dl-backdrop"));
$("btn-about").addEventListener("click", () =>
  $("about-modal").hidden ? openModal("about-modal", "about-backdrop") : closeModal("about-modal", "about-backdrop"));
$("btn-about-close").addEventListener("click", () => closeModal("about-modal", "about-backdrop"));
$("about-backdrop").addEventListener("click", () => closeModal("about-modal", "about-backdrop"));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("dl-modal").hidden) closeModal("dl-modal", "dl-backdrop");
  if (!$("about-modal").hidden) closeModal("about-modal", "about-backdrop");
  if (!$("feedback-modal").hidden) closeModal("feedback-modal", "feedback-backdrop");
});

/* ── Feedback modal (+ shake-to-report) ─────────────────────────
   mailto:, not a backend endpoint — no inbox to build, host, or check
   separately from the address already being read. */
const FEEDBACK_EMAIL = "aravinth7859@gmail.com";
let feedbackType = "Bug report";
let feedbackViaShake = false;

$("btn-feedback").addEventListener("click", () => {
  if (!$("feedback-modal").hidden) return closeModal("feedback-modal", "feedback-backdrop");
  $("feedback-shake-note").hidden = true; // only shake-triggered opens show this
  feedbackViaShake = false;
  openModal("feedback-modal", "feedback-backdrop");
});
$("btn-feedback-close").addEventListener("click", () => closeModal("feedback-modal", "feedback-backdrop"));
$("feedback-backdrop").addEventListener("click", () => closeModal("feedback-modal", "feedback-backdrop"));

document.querySelectorAll(".feedback-type").forEach((btn) =>
  btn.addEventListener("click", () => {
    feedbackType = btn.dataset.type;
    document.querySelectorAll(".feedback-type").forEach((b) => b.classList.toggle("is-active", b === btn));
  }));

$("btn-feedback-send").addEventListener("click", () => {
  const body = $("feedback-text").value.trim();
  const context = [
    `Page: ${location.href}`,
    `Bank(s) analysed: ${lastRenderedData?.bank || "none loaded"}`,
    `Screen: ${innerWidth}×${innerHeight}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");
  const fullBody = `${body}\n\n---\n${context}`;
  const subject = `SpendStory feedback: ${feedbackType}${feedbackViaShake ? " (via shake)" : ""}`;
  location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fullBody)}`;
});

/* Shake-to-report: a real, if blunt, "something's wrong" signal on a phone
   — no separate bug-report flow, it just opens this same modal with
   context pre-attached. iOS 13+ gates DeviceMotionEvent behind an explicit
   permission prompt that can only be requested from a user gesture, so it's
   requested lazily on first tap rather than a jarring prompt on page load;
   everywhere else (Android, desktop) has no such gate and just works. */
let shakeReady = false, lastShakeTime = 0, lastMagnitude = 0, shakeCount = 0, shakeWindowStart = 0;
const SHAKE_THRESHOLD = 15;   // m/s² delta between readings
const SHAKE_COUNT_NEEDED = 3; // this many spikes...
const SHAKE_WINDOW_MS = 1200; // ...within this long
const SHAKE_COOLDOWN_MS = 4000; // don't re-trigger immediately after firing

function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const now = Date.now();
  const magnitude = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const delta = Math.abs(magnitude - lastMagnitude);
  lastMagnitude = magnitude;
  if (delta < SHAKE_THRESHOLD) return;
  if (now - shakeWindowStart > SHAKE_WINDOW_MS) { shakeWindowStart = now; shakeCount = 0; }
  shakeCount++;
  if (shakeCount < SHAKE_COUNT_NEEDED) return;
  shakeCount = 0;
  if (now - lastShakeTime < SHAKE_COOLDOWN_MS) return;
  lastShakeTime = now;
  // iOS's own "Shake to Undo" gesture is native-OS-level — it fires
  // whenever a text field has focus + edit history and the device is
  // shaken, entirely independent of this listener; there's no web API to
  // suppress it (that control only exists for native apps). Blurring
  // whatever's focused the moment WE detect a shake can't reliably win a
  // race against an alert already mid-flight, but it's the only lever
  // available and removes the focused state for next time.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (navigator.vibrate) navigator.vibrate(120);
  $("feedback-shake-note").hidden = false;
  document.querySelectorAll(".feedback-type").forEach((b) => b.classList.toggle("is-active", b.dataset.type === "Bug report"));
  feedbackType = "Bug report";
  feedbackViaShake = true;
  if ($("feedback-modal").hidden) openModal("feedback-modal", "feedback-backdrop");
  // Deliberately NOT auto-focusing the textarea here: iOS has its own
  // built-in "Shake to Undo" gesture tied to any focused editable field,
  // completely separate from our JS — focusing right as a shake is
  // detected (residual physical motion often continues a beat after our
  // threshold fires) puts a text field into focus exactly while that
  // system gesture is still watching, and iOS pops its own "Undo Typing"
  // dialog on top of ours. Leaving focus alone avoids the conflict
  // entirely; the user can tap the box themselves when ready to type.
}
function enableShakeToReport() {
  if (shakeReady) return;
  shakeReady = true;
  window.addEventListener("devicemotion", onDeviceMotion);
}
// requestPermission only exists on iOS 13+ Safari; everywhere else just
// attach directly. Never prompt more than once per page load.
let shakePermissionAsked = false;
document.addEventListener("click", function askShakePermissionOnce() {
  if (shakePermissionAsked) return;
  shakePermissionAsked = true;
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission().then((state) => { if (state === "granted") enableShakeToReport(); }).catch(() => {});
  } else if (typeof DeviceMotionEvent !== "undefined") {
    enableShakeToReport();
  }
}, { once: true });

/* Privacy tooltip: :hover/:focus-visible show it via CSS on desktop; this
   adds tap-to-show (with auto-hide) for touch devices, where hover never fires. */
let privacyTipTimer;
$("btn-privacy").addEventListener("click", (e) => {
  e.stopPropagation();
  const tip = $("privacy-tip");
  tip.classList.add("show");
  clearTimeout(privacyTipTimer);
  privacyTipTimer = setTimeout(() => tip.classList.remove("show"), 3000);
});
document.addEventListener("click", () => $("privacy-tip").classList.remove("show"));
$("btn-clear-history").addEventListener("click", () => {
  localStorage.removeItem(HIST_KEY);
  renderHistory();
});
renderHistory();

/* ── Theme toggle (View Transitions circular wipe) ─────────── */
const THEME_KEY = "ss-theme";
const rootEl = document.documentElement;
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme === "light" || savedTheme === "dark") rootEl.dataset.theme = savedTheme;

const currentTheme = () => rootEl.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function applyTheme(next) {
  rootEl.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", next === "dark" ? "#0a0a0c" : "#fafafa");
  // Chart.js bakes text colour into the canvas at draw time, so existing
  // charts stay the old colour after a CSS variable flip — rebuild them.
  if (!$("screen-results").hidden && lastRenderedData) buildCharts(lastRenderedData);
}

$("btn-theme").addEventListener("click", (ev) => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Both the topbar and the sticky section-nav use backdrop-filter, and
    // both show the same one-frame stutter during the circular wipe (see
    // .topbar.no-blur's comment) — either one left blurred flashes
    // whatever's behind it for a frame.
    const blurred = [document.querySelector(".topbar"), $("section-nav")].filter(Boolean);
    blurred.forEach((el) => el.classList.add("no-blur"));
    const r = ev.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(() => applyTheme(next));
    vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 600, easing: "cubic-bezier(.22,1,.36,1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
    vt.finished.then(() => blurred.forEach((el) => el.classList.remove("no-blur")));
  } else {
    applyTheme(next);
  }
});

/* ── PWA ───────────────────────────────────────────────────── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}
