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

/* ── Excel export ──────────────────────────────────────────── */
$("btn-export").addEventListener("click", async () => {
  if (isSampleMode) {
    const el = $("export-error");
    el.hidden = false;
    el.textContent = "This is sample data — upload your own statement to download a real report.";
    return;
  }
  if (!pendingFiles.length) return;
  const btn = $("btn-export");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  $("export-error").hidden = true;

  try {
    const masked = $("mask-toggle").checked;
    const form = new FormData();
    for (const f of pendingFiles) form.append("files", f);
    form.append("password", $("pdf-password").value || "");
    form.append("masked", masked ? "true" : "false");
    const res = await fetch("api/export-excel", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Couldn't generate the report.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = masked ? "SpendStory_Report_Anonymized.xlsx" : "SpendStory_Report.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    const el = $("export-error");
    el.hidden = false;
    el.textContent = e.message || "Couldn't reach the server. Please try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
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

function render(d) {
  lastRenderedData = d;

  $("bank-badge").textContent = d.bank === "UNKNOWN" ? "Bank statement" : d.bank + " statement";

  countUp($("stat-spend"), d.stats.total_spend, (v) => INR.format(v));
  countUp($("stat-income"), d.stats.total_income, (v) => INR.format(v));
  const net = $("stat-net");
  countUp(net, d.stats.net_cash_flow, (v) => INR.format(v));
  net.className = d.stats.net_cash_flow >= 0 ? "pos" : "neg";
  countUp($("stat-count"), d.stats.txn_count, (v) => Math.round(v).toLocaleString("en-IN"));

  buildCharts(d);

  // Anomalies
  $("anomaly-card").hidden = d.anomalies.length === 0;
  $("anomaly-list").innerHTML = d.anomalies.slice(0, 6).map((a) => `
    <li><div class="m-left"><div class="m-name">${esc(a.merchant)}</div><small class="muted">${fmtDate(a.date)}</small></div>
    <span class="amount neg">−${INR.format(a.debit)}</span></li>`).join("");

  // Recurring subscriptions
  $("subscription-card").hidden = d.subscriptions.length === 0;
  $("subscription-list").innerHTML = d.subscriptions.slice(0, 6).map((s) => `
    <li><div class="m-left"><div class="m-name">${esc(s.merchant)}</div>
    <small class="muted">every ~${s.avg_interval_days}d · next ~${fmtDate(s.next_expected)} · ${INR.format(s.annual_cost)}/yr</small></div>
    <span class="amount neg">−${INR.format(s.amount)}</span></li>`).join("");

  // Merchants with proportional bars
  const maxSpend = d.merchants[0]?.total_spend || 1;
  $("merchant-list").innerHTML = d.merchants.map((m) => `
    <li><div class="m-left"><div class="m-name">${esc(m.merchant)}</div>
    <div class="merchant-bar" style="width:0%" data-w="${(m.total_spend / maxSpend * 100).toFixed(1)}"></div></div>
    <span class="amount">${INR.format(m.total_spend)}</span></li>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.querySelectorAll(".merchant-bar").forEach((b) => { b.style.width = b.dataset.w + "%"; })));

  activeStatFilter = null;
  $("stat-spend-card").classList.remove("is-active");
  $("stat-income-card").classList.remove("is-active");
  $("txn-search").value = "";
  applyTxnFilters();
}

/* KPI cards double as transaction-table filters — click "Money out" to see
   only debits, "Money in" for only credits, click again to clear. Combines
   with the free-text search rather than replacing it. */
let activeStatFilter = null; // null | "debit" | "credit"

function applyTxnFilters() {
  const d = lastRenderedData;
  if (!d) return;
  const q = $("txn-search").value.toLowerCase();
  const filtered = d.transactions.filter((t) => {
    if (activeStatFilter === "debit" && !(t.debit > 0)) return false;
    if (activeStatFilter === "credit" && !(t.credit > 0)) return false;
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
function buildCatLegend(chart, cats) {
  const el = $("cat-legend");
  el.innerHTML = cats.map((c, i) => `
    <button type="button" class="cat-legend-item" data-i="${i}">
      <span class="cat-legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span class="cat-legend-label">${esc(c.category)}</span>
    </button>`).join("");
  el.querySelectorAll(".cat-legend-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      chart.toggleDataVisibility(i);
      chart.update();
      btn.classList.toggle("is-off", !chart.getDataVisibility(i));
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

  charts.push(new Chart($("chart-months"), {
    type: "bar",
    data: {
      labels: d.monthly.map((m) => m.month),
      datasets: [
        { label: "In", data: d.monthly.map((m) => m.income), backgroundColor: barGradient("#10b981", "rgba(16,185,129,.35)"), borderRadius: topRadius },
        { label: "Out", data: d.monthly.map((m) => m.expense), backgroundColor: barGradient("#ef4444", "rgba(239,68,68,.35)"), borderRadius: topRadius },
      ],
    },
    plugins: [barGlowPlugin],
    options: {
      maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutCubic" },
      scales: { y: { ticks: { callback: (v) => "₹" + (v >= 1000 ? (v / 1000) + "k" : v) }, grid: { color: "rgba(128,128,128,.15)" } }, x: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR.format(c.parsed.y)}` } } },
    },
  }));
}

function renderTable(rows) {
  $("txn-table").querySelector("tbody").innerHTML = rows.map((t) => `
    <tr class="${t.is_anomaly ? "flag" : ""}">
      <td>${fmtDateShort(t.date)}</td>
      <td title="${esc(t.narration)}">${esc(t.merchant)}</td>
      <td><span class="cat-chip">${esc(t.category)}</span></td>
      <td class="num ${t.credit > 0 ? "pos" : "neg"}">${t.credit > 0 ? "+" + INR.format(t.credit) : "−" + INR.format(t.debit)}</td>
    </tr>`).join("");
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
      show("results");
      render(e.data);
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
  } else {
    applyTheme(next);
  }
});

/* ── PWA ───────────────────────────────────────────────────── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}
