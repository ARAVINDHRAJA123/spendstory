/* SpendStory frontend.
   Flow: pick/drop PDF → POST /api/analyse → render dashboard.
   If the API says the PDF is locked, reveal the password field and retry. */

"use strict";

const $ = (id) => document.getElementById(id);
const screens = { upload: $("screen-upload"), loading: $("screen-loading"), results: $("screen-results") };

let pendingFiles = [];   // kept only in browser memory for the password retry
let charts = [];
let lastRenderedData = null; // re-drawn on theme change so chart text colour stays readable

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

["dragover", "dragenter"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
dz.addEventListener("drop", (e) => { const fs = [...e.dataTransfer.files]; if (fs.length) handleFiles(fs); });

$("pw-submit").addEventListener("click", () => {
  if (pendingFiles.length === 1) analyse(pendingFiles[0], $("pdf-password").value);
  else if (pendingFiles.length > 1) analyseMulti(pendingFiles, $("pdf-password").value);
});
$("pdf-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pw-submit").click(); });

$("btn-again").addEventListener("click", () => {
  fileInput.value = "";
  pendingFiles = [];
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
  if (!pendingFiles.length) return;
  const btn = $("btn-export");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  $("export-error").hidden = true;

  try {
    const form = new FormData();
    for (const f of pendingFiles) form.append("files", f);
    form.append("password", $("pdf-password").value || "");
    const res = await fetch("api/export-excel", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Couldn't generate the report.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "SpendStory_Report.xlsx";
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

  // Merchants with proportional bars
  const maxSpend = d.merchants[0]?.total_spend || 1;
  $("merchant-list").innerHTML = d.merchants.map((m) => `
    <li><div class="m-left"><div class="m-name">${esc(m.merchant)}</div>
    <div class="merchant-bar" style="width:0%" data-w="${(m.total_spend / maxSpend * 100).toFixed(1)}"></div></div>
    <span class="amount">${INR.format(m.total_spend)}</span></li>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.querySelectorAll(".merchant-bar").forEach((b) => { b.style.width = b.dataset.w + "%"; })));

  renderTable(d.transactions);
  $("txn-search").value = "";
  $("txn-search").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    renderTable(d.transactions.filter((t) =>
      (t.merchant + " " + t.category + " " + t.narration).toLowerCase().includes(q)));
  };
}

/* Chart colours are baked into the canvas at draw time, so a CSS-variable
   theme switch alone won't re-tint existing charts — they must be rebuilt.
   Split out so the theme toggle can call this alone, without re-running
   count-up animations or duplicating history entries. */
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
  charts.push(new Chart($("chart-cats"), {
    type: "doughnut",
    data: {
      labels: cats.map((c) => c.category),
      datasets: [{ data: cats.map((c) => c.spend), backgroundColor: PALETTE, borderWidth: 0, hoverOffset: 10 }],
    },
    options: {
      cutout: "62%", maintainAspectRatio: false,
      animation: { animateRotate: true, duration: 900, easing: "easeOutCubic" },
      plugins: {
        legend: { position: "right", labels: { boxWidth: 14, boxHeight: 14, padding: 10 } },
        // caretSize: 0 — Chart.js's default tooltip arrow is positioned for
        // bar/line charts; on a doughnut it points from the arc's centroid
        // and renders as a disconnected floating triangle near the edge.
        tooltip: { caretSize: 0, cornerRadius: 8, padding: 10, callbacks: { label: (c) => " " + INR.format(c.parsed) } },
      },
    },
  }));

  const barGradient = (topColor, bottomColor) => (ctx) => {
    const { chartArea } = ctx.chart;
    if (!chartArea) return topColor;
    const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, topColor);
    g.addColorStop(1, bottomColor);
    return g;
  };
  const topRadius = { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 };

  charts.push(new Chart($("chart-months"), {
    type: "bar",
    data: {
      labels: d.monthly.map((m) => m.month),
      datasets: [
        { label: "In", data: d.monthly.map((m) => m.income), backgroundColor: barGradient("#10b981", "rgba(16,185,129,.35)"), borderRadius: topRadius },
        { label: "Out", data: d.monthly.map((m) => m.expense), backgroundColor: barGradient("#ef4444", "rgba(239,68,68,.35)"), borderRadius: topRadius },
      ],
    },
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
      <td>${fmtDate(t.date)}</td>
      <td title="${esc(t.narration)}">${esc(t.merchant)}</td>
      <td><span class="cat-chip">${esc(t.category)}</span></td>
      <td class="num ${t.credit > 0 ? "pos" : "neg"}">${t.credit > 0 ? "+" + INR.format(t.credit) : "−" + INR.format(t.debit)}</td>
    </tr>`).join("");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });

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
