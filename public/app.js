"use strict";

// All external strings (news headlines, company names, …) pass through esc()
// before touching innerHTML — RSS content is untrusted.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// esc() blocks attribute breakout but not scheme smuggling — an href from an
// untrusted feed could be javascript: . Only real web URLs get through.
const safeHref = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? u : "#");

const $ = (id) => document.getElementById(id);

const el = {
  form: $("searchForm"),
  input: $("tickerInput"),
  setup: $("setupCard"),
  btn: $("analyzeBtn"),
  intro: $("intro"),
  status: $("status"),
  statusText: $("statusText"),
  error: $("error"),
  suggest: $("suggest"),
  demoNote: $("demoNote"),
  warnings: $("warnings"),
  results: $("results"),
  tmResults: $("tmResults"),
  dateInput: $("dateInput"),
  changes: $("changesCard"),
  company: $("companyCard"),
  history: $("historyCard"),
  verdict: $("verdictCard"),
  keyNumbers: $("keyNumbersCard"),
  trajectory: $("trajectoryCard"),
  insiders: $("insidersCard"),
  filings: $("filingsCard"),
  range: $("rangeCard"),
  analyst: $("analystCard"),
  earnings: $("earningsCard"),
  peers: $("peersCard"),
  news: $("newsCard"),
};

// ---------- formatting helpers ----------

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const NA = '<span class="na">N/A</span>';

const fmtNum = (v, digits = 2) => (isNum(v) ? v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : null);
const fmtX = (v) => (isNum(v) ? `${fmtNum(v)}×` : null);
const fmtPct = (v, signed = false) => (isNum(v) ? `${signed && v > 0 ? "+" : ""}${fmtNum(v)}%` : null);
const fmtMoney = (v, currency = "USD") =>
  isNum(v) ? v.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 2 }) : null;

function fmtMarketCap(millions) {
  if (!isNum(millions)) return null;
  const usd = millions * 1e6;
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(2)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(0)}M`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 8) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------- state transitions ----------

// View generation counter: analyze and time-machine requests can overlap
// (chip clicked mid-analysis, hashchange mid-time-machine); only the newest
// request is allowed to render.
let viewSeq = 0;

function setLoading(ticker) {
  viewSeq++;
  stopLive();
  el.intro.hidden = true;
  el.results.hidden = true;
  el.tmResults.hidden = true;
  el.error.hidden = true;
  el.suggest.hidden = true;
  el.demoNote.hidden = true;
  el.warnings.hidden = true;
  el.status.hidden = false;
  el.statusText.textContent = `Analyzing ${ticker} — quote, fundamentals, ratings, and news…`;
  el.btn.disabled = true;
}

function setError(msg) {
  el.status.hidden = true;
  el.btn.disabled = false;
  el.error.textContent = msg;
  el.error.hidden = false;
}

// ---------- render ----------

function verdictClass(verdict) {
  return {
    "STRONG BUY": "v-strongbuy",
    BUY: "v-buy",
    HOLD: "v-hold",
    SELL: "v-sell",
    "STRONG SELL": "v-strongsell",
  }[verdict] ?? "v-nodata";
}

function scoreBand(score) {
  if (score >= 66) return "good";
  if (score >= 55) return "warning";
  if (score >= 47) return "serious";
  return "critical";
}

// "Since you last looked" — the diff banner, shown only when a previous
// different-day snapshot exists and something actually moved.
function renderChanges(d) {
  if (!Array.isArray(d.changes) || !d.changes.length || !d.lastSeen) {
    el.changes.hidden = true;
    return;
  }
  el.changes.hidden = false;
  el.changes.innerHTML = `
    <h2>Since you last looked — ${esc(d.lastSeen)}</h2>
    <ul class="changes-list">
      ${d.changes.map((c) => `<li>${esc(c)}</li>`).join("")}
    </ul>`;
}

function renderCompany(d) {
  const p = d.profile ?? {};
  const q = d.quote;
  const currency = p.currency || "USD";
  const metaBits = [d.ticker, p.exchange, p.industry].filter(Boolean).map(esc).join(" · ");
  const factBits = [
    p.marketCap != null ? `Market cap ${fmtMarketCap(p.marketCap)}` : null,
    p.ipo ? `IPO ${esc(p.ipo)}` : null,
    p.website ? `<a href="${esc(safeHref(p.website))}" target="_blank" rel="noopener noreferrer">${esc(p.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : null,
  ].filter(Boolean).join(" · ");

  let priceHtml = `<div class="price-now">${NA}</div><div class="price-sub">Live quote unavailable</div>`;
  if (!(q && isNum(q.price)) && isNum(d.history?.last?.close)) {
    priceHtml = `
      <div class="price-now">${fmtMoney(d.history.last.close, currency)}</div>
      <div class="price-sub">Last close ${esc(d.history.last.date)} — local data, not a live quote</div>`;
  }
  if (q && isNum(q.price)) {
    const dir = !isNum(q.change) || q.change === 0 ? "flat" : q.change > 0 ? "up" : "down";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
    const delta = isNum(q.change)
      ? `${arrow} ${q.change > 0 ? "+" : ""}${fmtNum(q.change)} (${q.changePercent > 0 ? "+" : ""}${fmtNum(q.changePercent)}%)`
      : "";
    priceHtml = `
      <div class="price-now">${fmtMoney(q.price, currency)}</div>
      <div class="price-delta ${dir}">${esc(delta)} today</div>
      <div class="price-sub">Prev close ${fmtMoney(q.previousClose, currency) ?? "N/A"} · as of ${new Date(d.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>`;
  }

  el.company.innerHTML = `
    <div class="company-head">
      <div class="company-id">
        ${p.logo ? `<img class="company-logo" src="${esc(p.logo)}" alt="" onerror="this.remove()" />` : ""}
        <div>
          <h1 class="company-name">${esc(p.name || d.ticker)}</h1>
          <div class="company-meta">${metaBits}</div>
          ${factBits ? `<div class="company-meta">${factBits}</div>` : ""}
        </div>
      </div>
      <div class="price-block">${priceHtml}</div>
    </div>`;
}

function fmtDetailValue(detail) {
  if (detail.value == null) return "N/A";
  switch (detail.fmt) {
    case "%": return fmtPct(detail.value, true);
    case "x": return fmtX(detail.value);
    case "pos": return `${Math.round(detail.value * 100)}% of range`;
    case "tilt": return `${detail.value > 0 ? "+" : ""}${detail.value.toFixed(2)} of ±2`;
    case "pct01": return `${Math.round(detail.value * 100)}%`;
    default: return String(detail.value);
  }
}

function horizonBlockHtml(s) {
  if (!Array.isArray(s.horizons) || !s.horizons.length) return "";
  const rows = s.horizons.map((h) => {
    const comps = h.components
      .map((c) => `${esc(c.label)} ${c.available ? c.score : "n/a"} (w ${c.weight})`)
      .join(" · ");
    const call = h.insufficientData
      ? `<span class="pill-sm v-nodata">NO DATA</span>`
      : `<span class="pill-sm ${verdictClass(h.verdict)}">${esc(h.verdict)}</span>
         <span class="h-score">${Math.round(h.score)}</span>`;
    return `
      <div class="horizon-row">
        <span class="h-label">${esc(h.label)} <span class="h-hint">(${esc(h.hint)})</span></span>
        ${call}
      </div>
      <div class="h-comps">${comps}</div>`;
  }).join("");
  return `
    <div class="horizon-box">
      ${rows}
      <div class="h-note">Same inputs regrouped by the horizon they usually speak to — a decomposition of the score above, not independent forecasts.</div>
    </div>`;
}

function renderVerdict(d) {
  const s = d.scoring;
  const meters = s.categories.map((c) => {
    const detail = c.details
      .map((m) => `${esc(m.label)} ${esc(fmtDetailValue(m) ?? "N/A")}${m.score != null ? ` → ${m.score}` : ""}`)
      .join(" · ");
    if (!c.available) {
      return `
        <div class="meter-row">
          <div class="meter-head">
            <span class="meter-label">${esc(c.label)} <span class="wt">· ${c.weight}%</span></span>
            <span class="meter-val na">no data</span>
          </div>
          <div class="meter-track"></div>
          <div class="meter-detail">${detail}</div>
        </div>`;
    }
    const band = scoreBand(c.score);
    return `
      <div class="meter-row">
        <div class="meter-head">
          <span class="meter-label">${esc(c.label)} <span class="wt">· ${c.weight}%</span></span>
          <span class="meter-val">${c.score}</span>
        </div>
        <div class="meter-track band-${band}"><div class="meter-fill band-${band}" style="width:${c.score}%"></div></div>
        <div class="meter-detail">${detail}</div>
      </div>`;
  }).join("");

  const missing = s.categories.filter((c) => !c.available).length;
  const note = s.insufficientData
    ? "Too little data to score responsibly — no verdict is shown rather than a fake one."
    : `Weighted average of the ${s.availableCount} categories with data${missing ? ` (${missing} missing — weights renormalized)` : ""}. Bands are percentile-calibrated against 16,497 historical S&P scores — a verdict states rank, not prophecy: ≥74 STRONG BUY (top ~10%) · ≥66 BUY (top ~30%) · ≥55 HOLD · ≥47 SELL · <47 STRONG SELL (bottom ~10%).`;

  const hero = s.insufficientData
    ? `<div class="verdict-score">–<small>/100</small></div>
       <div class="verdict-pill v-nodata">NOT ENOUGH DATA</div>
       <div class="verdict-conf">${s.availableCount}/${s.totalCategories} categories had data</div>`
    : `<div class="verdict-score">${Math.round(s.score)}<small>/100</small></div>
       <div class="verdict-pill ${verdictClass(s.verdict)}">${esc(s.verdict)}</div>
       <div class="verdict-conf">Confidence: ${esc(s.confidence)} (${s.availableCount}/${s.totalCategories} categories)</div>`;

  // Honest-evidence line (see EVIDENCE.md): backtests of the testable
  // components found no predictive power, and the very highest scores
  // historically leaned the wrong way (glamour effect). Description, not
  // forecast — the ledger is the ongoing test.
  const evidence = s.insufficientData
    ? ""
    : `<div class="scoring-note evidence-note">Backtested honestly: this formula (16,497 point-in-time calls, 2011–2024) showed <b>no predictive power</b>${s.score >= 72 ? ", and its most confident calls historically <b>underperformed</b> the index" : ""} — a score describes current fundamentals, it does not forecast returns (see EVIDENCE.md; the <a href="/ledger.html">ledger</a> is the live test).</div>`;

  // Your call, not the formula's: logged to a private, append-only track
  // record and graded against the index over time — the feature that tells
  // you your real accuracy instead of letting you remember the wins.
  const pickRow = d.demo || !hasKey
    ? ""
    : `<div class="pick-row" id="pickRow">
         <span class="pick-label">Your call on ${esc(d.ticker)} (logged to <a href="/ledger.html">your track record</a>, graded vs SPY):</span>
         <button type="button" data-dir="buy">I'd buy</button>
         <button type="button" data-dir="avoid">I'd pass</button>
         <button type="button" data-dir="sell">I'd sell</button>
         <span class="pick-msg" id="pickMsg"></span>
       </div>`;

  el.verdict.innerHTML = `
    <h2>Verdict</h2>
    <p class="sub">A mechanical score from the numbers below — transparent, not advice.${d.logged ? ` Call logged to the <a href="/ledger.html">verdict ledger</a>.` : ""}</p>
    <div class="verdict-wrap">
      <div class="verdict-hero">${hero}</div>
      <div>${meters}<div class="scoring-note">${note}</div>${evidence}</div>
    </div>
    ${horizonBlockHtml(s)}
    ${pickRow}`;

  el.verdict.querySelectorAll("#pickRow button").forEach((b) =>
    b.addEventListener("click", async () => {
      const msg = $("pickMsg");
      msg.textContent = "…";
      try {
        const res = await fetch("/api/picks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: d.ticker, direction: b.dataset.dir }),
        });
        const body = await res.json();
        msg.textContent = res.ok ? body.message : body.error ?? "Failed.";
      } catch {
        msg.textContent = "Could not reach the server.";
      }
    })
  );
}

// ---------- price history chart (local research data) ----------

let histRange = "1Y";
const HIST_RANGES = { "1Y": 366, "5Y": 5 * 365 + 2, "MAX": Infinity };

function niceTicks(lo, hi, target = 4) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / target;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}

function histSourceLabel(h) {
  if (h.source === "sp500-panel") return `Local S&P daily panel — updated through ${h.through}`;
  if (h.source === "tiingo-archive") return `Local Tiingo research archive (static snapshot) — through ${h.through}; adjusted close`;
  if (h.source === "tiingo-api") return `Live Tiingo data through ${h.through} — split/dividend-adjusted, updates daily`;
  if (h.source === "demo") return "Fictional demo series";
  return `Local data through ${h.through}`;
}

function renderHistory(d) {
  const h = d.history;
  if (!h || !Array.isArray(h.series) || h.series.length < 2) {
    el.history.hidden = true;
    return;
  }
  el.history.hidden = false;
  el.history.innerHTML = `
    <div class="hist-head">
      <div>
        <h2>Price history</h2>
        <p class="sub">${esc(histSourceLabel(h))}</p>
      </div>
      <div class="range-btns">
        ${Object.keys(HIST_RANGES).map((r) => `<button type="button" data-r="${r}" class="${r === histRange ? "active" : ""}">${r}</button>`).join("")}
      </div>
    </div>
    <div class="hist-plot"><svg role="img" aria-label="Price history chart"></svg><div class="hist-tip"></div></div>
    <div class="hist-note">Older points are down-sampled (daily &lt; 1 year, weekly &lt; 5 years, monthly beyond). Hover for exact values.</div>`;
  el.history.querySelectorAll(".range-btns button").forEach((b) =>
    b.addEventListener("click", () => {
      histRange = b.dataset.r;
      renderHistory(d);
    })
  );
  drawHistoryChart(h);
}

function drawHistoryChart(h) {
  const plot = el.history.querySelector(".hist-plot");
  const svg = plot.querySelector("svg");
  const tip = plot.querySelector(".hist-tip");

  const lastT = Date.parse(h.series[h.series.length - 1][0]);
  const cutoff = lastT - HIST_RANGES[histRange] * 86_400_000;
  let pts = h.series
    .map(([ds, c]) => ({ t: Date.parse(ds), ds, c }))
    .filter((p) => Number.isFinite(p.t) && isNum(p.c) && p.t >= cutoff);
  if (pts.length < 2) pts = h.series.slice(-2).map(([ds, c]) => ({ t: Date.parse(ds), ds, c }));

  const W = Math.max(280, plot.clientWidth);
  const H = 230;
  const pad = { l: 52, r: 14, t: 12, b: 22 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map((p) => p.c));
  let hi = Math.max(...pts.map((p) => p.c));
  const padY = (hi - lo || hi || 1) * 0.06;
  lo -= padY;
  hi += padY;

  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);

  const fmtTick = (v) => (hi >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(hi < 10 ? 2 : 0));
  const gridlines = niceTicks(lo, hi)
    .map((v) => `<line class="hist-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"></line>
      <text class="hist-axis-text" x="${pad.l - 8}" y="${Y(v) + 3.5}" text-anchor="end">$${fmtTick(v)}</text>`)
    .join("");

  const spanYears = (t1 - t0) / (365.25 * 86_400_000);
  const xLabels = [0.02, 0.35, 0.68, 0.98]
    .map((f) => {
      const t = t0 + f * (t1 - t0);
      const dte = new Date(t);
      const label = spanYears > 3 ? dte.getFullYear() : dte.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      return `<text class="hist-axis-text" x="${X(t)}" y="${H - 6}" text-anchor="${f > 0.9 ? "end" : f < 0.1 ? "start" : "middle"}">${label}</text>`;
    })
    .join("");

  const lineD = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.c).toFixed(1)}`).join("");
  const areaD = `${lineD}L${X(t1).toFixed(1)},${H - pad.b}L${X(t0).toFixed(1)},${H - pad.b}Z`;

  svg.innerHTML = `
    ${gridlines}${xLabels}
    <path class="hist-area" d="${areaD}"></path>
    <path class="hist-line" d="${lineD}"></path>
    <circle class="hist-dot" r="4.5" cx="${X(t1)}" cy="${Y(pts[pts.length - 1].c)}"></circle>
    <circle class="hist-dot hover-dot" r="5" style="display:none"></circle>
    <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent"></rect>`;

  const hoverDot = svg.querySelector(".hover-dot");
  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    hoverDot.style.display = "";
    hoverDot.setAttribute("cx", X(best.t));
    hoverDot.setAttribute("cy", Y(best.c));
    tip.style.display = "block";
    tip.style.left = `${X(best.t)}px`;
    tip.style.top = `${Y(best.c)}px`;
    tip.innerHTML = `${esc(best.ds)} · <b>${esc(fmtMoney(best.c) ?? best.c)}</b>`;
  });
  svg.addEventListener("mouseleave", () => {
    hoverDot.style.display = "none";
    tip.style.display = "none";
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastPayload && !el.history.hidden) renderHistory(lastPayload);
  }, 150);
});

function renderKeyNumbers(d) {
  const m = d.metrics ?? {};
  // [label, value, provenance key, glossary term]
  const tiles = [
    ["P/E (TTM)", fmtX(m.pe), "pe", "pe"],
    ["P/S", fmtX(m.ps), "ps", "ps"],
    ["P/B", fmtX(m.pb), null, "pb"],
    ["PEG", fmtX(m.peg), null, "peg"],
    ["Net margin", fmtPct(m.netMargin), "netMargin", "netMargin"],
    ["ROE", fmtPct(m.roe), "roe", "roe"],
    ["ROA", fmtPct(m.roa), null, "roa"],
    ["Revenue growth YoY", fmtPct(m.revenueGrowth, true), "revenueGrowth", "revenueGrowth"],
    ["EPS growth YoY", fmtPct(m.epsGrowth, true), "epsGrowth", "epsGrowth"],
    ["Current ratio", fmtNum(m.currentRatio), "currentRatio", "currentRatio"],
    ["Debt / equity", fmtNum(m.debtEquity), "debtEquity", "debtEquity"],
    ["Dividend yield", fmtPct(m.dividendYield), null, "dividendYield"],
    ["Beta", fmtNum(m.beta), null, "beta"],
    ["52-week high", fmtMoney(m.high52), null, "range52"],
    ["52-week low", fmtMoney(m.low52), null, "range52"],
  ];
  // In-context learning: each tile carries its plain-English definition,
  // revealed on click — what it is, and what it can't tell you.
  const termPop = (term) => {
    const t = window.TERMS?.[term];
    if (!t) return "";
    return `<div class="kn-pop">
      <b>${esc(t.name)}</b>
      <p>${esc(t.what)}</p>
      <p class="learn-caveat">${esc(t.caveat)}</p>
      <a href="/learn.html#term-${esc(term)}">Learn more →</a>
    </div>`;
  };
  // Provenance chips: SEC = value came from EDGAR filings (Finnhub had none),
  // ✓ = both sources agree, ⚠ = they disagree (hover for both values).
  const pn = (v) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v));
  const provMark = (key) => {
    const p = key ? d.metricProvenance?.[key] : null;
    if (!p) return "";
    if (p.src === "edgar") return ` <span class="prov prov-edgar" title="From SEC EDGAR filings (Finnhub had no value)">SEC</span>`;
    if (p.src === "both") return ` <span class="prov prov-ok" title="Finnhub ${esc(pn(p.finnhub))} — SEC filings agree (${esc(pn(p.edgar))})">✓</span>`;
    if (p.src === "conflict") return ` <span class="prov prov-warn" title="Sources disagree: Finnhub ${esc(pn(p.finnhub))} vs SEC filings ${esc(pn(p.edgar))} — Finnhub shown">⚠</span>`;
    return "";
  };
  el.keyNumbers.innerHTML = `
    <h2>Key numbers</h2>
    <p class="sub">Fundamentals from Finnhub, cross-checked against SEC EDGAR filings${d.edgarThrough ? ` (filed data through ${esc(d.edgarThrough)})` : ""}. N/A = no source has a value.</p>
    <div class="kn-grid">
      ${tiles.map(([label, val, key, term]) => `
        <div class="kn-tile${term && window.TERMS?.[term] ? " has-term" : ""}" ${term ? `data-term="${esc(term)}"` : ""}>
          <div class="kn-label">${esc(label)}${provMark(key)}${term && window.TERMS?.[term] ? ` <span class="term-q" title="What is this?">?</span>` : ""}</div>
          <div class="kn-value${val == null ? " na" : ""}">${val == null ? "N/A" : esc(val)}</div>
          ${term ? termPop(term) : ""}
        </div>`).join("")}
    </div>`;
}

// One open definition at a time; clicking the same tile closes it.
el.keyNumbers.addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const tile = e.target.closest(".kn-tile.has-term");
  if (!tile) return;
  const wasOpen = tile.classList.contains("open");
  el.keyNumbers.querySelectorAll(".kn-tile.open").forEach((t) => t.classList.remove("open"));
  if (!wasOpen) tile.classList.add("open");
});

function fmtBillions(v) {
  if (!isNum(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

// Trajectory: 8 quarters of revenue/margin plus share-count drift — the
// direction of the business, and whether ownership is being diluted away.
function renderTrajectory(d) {
  const t = d.trajectory;
  if (!t?.quarters?.length) {
    el.trajectory.hidden = true;
    return;
  }
  el.trajectory.hidden = false;
  const maxRev = Math.max(...t.quarters.map((q) => q.revenue ?? 0), 1);
  const rows = t.quarters.map((q) => `
    <tr>
      <td>${esc(String(q.end).slice(0, 7))}</td>
      <td class="num">${fmtBillions(q.revenue)}</td>
      <td class="traj-bar-cell"><div class="traj-bar" style="width:${Math.max(2, (q.revenue / maxRev) * 100)}%"></div></td>
      <td class="num">${q.revYoY == null ? "—" : `<span class="${q.revYoY >= 0 ? "delta-up" : "delta-down"}">${q.revYoY > 0 ? "+" : ""}${q.revYoY.toFixed(1)}%</span>`}</td>
      <td class="num">${q.margin == null ? "—" : `${q.margin.toFixed(1)}%`}</td>
    </tr>`).join("");

  let dilutionHtml = "";
  const dil = t.dilution;
  if (dil && isNum(dil.annualPct)) {
    const pct = dil.annualPct;
    const cls = pct > 2 ? "delta-down" : pct < -0.5 ? "delta-up" : "delta-flat";
    const verdict = pct > 2
      ? `diluting ~${pct.toFixed(1)}%/yr — your ownership share shrinks that fast before returns start`
      : pct < -0.5
        ? `buying back ~${Math.abs(pct).toFixed(1)}%/yr — your ownership share grows without you doing anything`
        : `roughly flat (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%/yr)`;
    dilutionHtml = `<p class="traj-dilution">Share count ${esc(String(dil.from).slice(0, 7))} → ${esc(String(dil.to).slice(0, 7))}:
      <span class="${cls}">${esc(verdict)}</span></p>`;
  }

  el.trajectory.innerHTML = `
    <h2>Trajectory — last ${t.quarters.length} quarters</h2>
    <p class="sub">Straight from SEC filings: is the business growing, shrinking, or treading water — and is the share count working for you or against you.</p>
    <div class="ledger-table-wrap">
      <table class="ledger-table traj-table">
        <thead><tr><th>Quarter</th><th class="num">Revenue</th><th></th><th class="num">YoY</th><th class="num">Net margin</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${dilutionHtml}`;
}

// What the company has told the SEC lately — 8-Ks are material events.
function renderFilings(d) {
  const f = d.filings;
  if (!Array.isArray(f) || !f.length) {
    el.filings.hidden = true;
    return;
  }
  el.filings.hidden = false;
  el.filings.innerHTML = `
    <h2>Recent SEC filings</h2>
    <p class="sub">Primary sources, newest first. An 8-K means the company was required to disclose a material event — often before the news writes it up.</p>
    <ul class="filing-list">
      ${f.map((x) => `
        <li class="filing-item">
          <span class="filing-form">${esc(x.form)}</span>
          <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.label)}</a>
          <span class="filing-date">${esc(x.filed)}</span>
        </li>`).join("")}
    </ul>`;
}

function renderRange(d) {
  const m = d.metrics ?? {};
  const usingLocalPrice = !isNum(d.quote?.price) && isNum(d.history?.last?.close);
  const price = isNum(d.quote?.price) ? d.quote.price : d.history?.last?.close;
  if (!isNum(m.high52) || !isNum(m.low52) || !isNum(price) || m.high52 <= m.low52) {
    el.range.innerHTML = `<h2>52-week range</h2><p class="sub">Not enough data to draw the range.</p>`;
    return;
  }
  const pos = Math.min(1, Math.max(0, (price - m.low52) / (m.high52 - m.low52)));
  const pct = pos * 100;
  const labelPct = Math.min(91, Math.max(9, pct)); // keep the price label inside the card

  // Volatility reality check from the past year of daily closes: what a
  // normal day looks like, and the worst peak-to-trough already survived.
  let volHtml = "";
  const series = d.history?.series;
  if (Array.isArray(series) && series.length > 60) {
    const yearAgo = Date.parse(series[series.length - 1][0]) - 366 * 86_400_000;
    const daily = series.filter(([ds]) => Date.parse(ds) >= yearAgo).map(([, c]) => c).filter(isNum);
    if (daily.length > 60) {
      const rets = daily.slice(1).map((c, i) => c / daily[i] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) * 100;
      let peak = daily[0];
      let maxDd = 0;
      for (const c of daily) {
        if (c > peak) peak = c;
        maxDd = Math.min(maxDd, c / peak - 1);
      }
      volHtml = `<p class="vol-note">Reality check: this stock typically moves <b>±${sd.toFixed(1)}%</b> a day; its worst peak-to-trough drop in the past year was <b>${(maxDd * 100).toFixed(0)}%</b>. Swings inside that range are noise, not news.</p>`;
    }
  }
  el.range.innerHTML = `
    <h2>52-week range</h2>
    <p class="sub">Price sits at ${Math.round(pct)}% of the year's range.${usingLocalPrice ? " (Using last local close — no live quote.)" : ""}</p>
    <div class="range-plot">
      <div class="range-price" style="left:${labelPct}%">${esc(fmtMoney(price))}</div>
      <div class="range-track">
        <div class="range-fill" style="width:${pct}%"></div>
        <div class="range-dot" style="left:${pct}%"></div>
      </div>
    </div>
    <div class="range-ends">
      <span>Low <b>${esc(fmtMoney(m.low52))}</b>${m.low52Date ? ` <span>(${esc(String(m.low52Date).slice(0, 10))})</span>` : ""}</span>
      <span>High <b>${esc(fmtMoney(m.high52))}</b>${m.high52Date ? ` <span>(${esc(String(m.high52Date).slice(0, 10))})</span>` : ""}</span>
    </div>
    ${volHtml}`;
}

function renderAnalyst(d) {
  const a = d.analystTrends;
  if (!a || !a.total) {
    el.analyst.innerHTML = `<h2>Analyst ratings</h2><p class="sub">No analyst coverage data for this ticker.</p>`;
    return;
  }
  const segs = [
    ["sbuy", "Strong buy", a.strongBuy],
    ["buy", "Buy", a.buy],
    ["hold", "Hold", a.hold],
    ["sell", "Sell", a.sell],
    ["ssell", "Strong sell", a.strongSell],
  ];
  const bar = segs
    .filter(([, , n]) => n > 0)
    .map(([cls, label, n]) => `<div class="an-seg ${cls}" style="flex-grow:${n}" title="${esc(label)}: ${n}"></div>`)
    .join("");
  const legend = segs
    .map(([cls, label, n]) => `<span><span class="swatch an-seg ${cls}"></span>${esc(label)} <b>${n}</b></span>`)
    .join("");
  // Drift over the last few months: the level is always buy-skewed, so the
  // direction of change is the informative part.
  let driftHtml = "";
  const hist = d.analystHistory;
  if (Array.isArray(hist) && hist.length >= 2) {
    const first = hist[0];
    const last = hist[hist.length - 1];
    const buys = (m) => (m.strongBuy ?? 0) + (m.buy ?? 0);
    const sells = (m) => (m.sell ?? 0) + (m.strongSell ?? 0);
    const dTilt = (last.tilt ?? 0) - (first.tilt ?? 0);
    const word = dTilt > 0.08 ? '<span class="delta-up">drifting more bullish</span>'
      : dTilt < -0.08 ? '<span class="delta-down">drifting more bearish</span>'
      : '<span class="delta-flat">holding steady</span>';
    const months = hist.map((m) => {
      const total = buys(m) + (m.hold ?? 0) + sells(m);
      const seg = (n, cls) => (total && n > 0 ? `<div class="an-seg ${cls}" style="height:${Math.max(6, (n / total) * 100)}%"></div>` : "");
      return `<div class="an-mini" title="${esc(String(m.period ?? "").slice(0, 7))}: ${buys(m)} buy / ${m.hold ?? 0} hold / ${sells(m)} sell">
        ${seg(sells(m), "ssell")}${seg(m.hold ?? 0, "hold")}${seg(buys(m), "buy")}
      </div>`;
    }).join("");
    driftHtml = `
      <div class="an-drift">
        <div class="an-mini-row">${months}</div>
        <span>Drift, ${esc(String(first.period ?? "").slice(0, 7))} → ${esc(String(last.period ?? "").slice(0, 7))}:
        buys ${buys(first)} → ${buys(last)}, sells ${sells(first)} → ${sells(last)} — ${word}.
        The level is always buy-skewed; watch the direction.</span>
      </div>`;
  }

  el.analyst.innerHTML = `
    <h2>Analyst ratings</h2>
    <p class="sub">${a.total} analysts · ${esc(String(a.period ?? "").slice(0, 7))}</p>
    <div class="an-bar">${bar}</div>
    <div class="an-legend">${legend}</div>
    ${driftHtml}`;
}

function nextEarningsLine(d) {
  const n = d.nextEarnings;
  if (!n?.date) return "";
  const days = Math.round((Date.parse(n.date) - Date.now()) / 86_400_000);
  const when = { amc: "after the close", bmo: "before the open", dmh: "during market hours" }[n.hour] ?? "";
  const est = isNum(n.epsEstimate) ? ` — street expects EPS ${fmtNum(n.epsEstimate)}` : "";
  return ` <b>Next report: ${esc(n.date)}${days >= 0 ? ` (in ${days} day${days === 1 ? "" : "s"}${when ? `, ${when}` : ""})` : ""}${est}.</b> Earnings days are the year's biggest single-day moves — know the date before money moves.`;
}

function renderEarnings(d) {
  const rows = d.earnings ?? [];
  if (!rows.length) {
    el.earnings.innerHTML = `<h2>Earnings — last 4 quarters</h2><p class="sub">No earnings history available.${nextEarningsLine(d)}</p>`;
    return;
  }
  el.earnings.innerHTML = `
    <h2>Earnings — last 4 quarters</h2>
    <p class="sub">Reported EPS vs analyst estimate.${nextEarningsLine(d)}</p>
    <div class="earn-grid">
      ${rows.map((e) => {
        const chip = e.beat == null
          ? `<span class="earn-chip na">no estimate</span>`
          : e.beat
            ? `<span class="earn-chip beat">▲ Beat${isNum(e.surprisePercent) ? ` +${fmtNum(e.surprisePercent, 1)}%` : ""}</span>`
            : `<span class="earn-chip miss">▼ Miss${isNum(e.surprisePercent) ? ` ${fmtNum(e.surprisePercent, 1)}%` : ""}</span>`;
        return `
          <div class="earn-card">
            <div class="earn-q">${e.quarter && e.year ? `Q${e.quarter} ${e.year}` : "Quarter"}</div>
            <div class="earn-date">${esc(e.period ?? "")}</div>
            <div class="earn-eps">EPS <b>${fmtNum(e.actual) ?? "N/A"}</b> vs ${fmtNum(e.estimate) ?? "N/A"} est.</div>
            ${chip}
          </div>`;
      }).join("")}
    </div>`;
}

// Insider open-market activity — honestly framed: sales have a hundred
// mundane explanations; clusters of open-market BUYING are the rarer tell.
function renderInsiders(d) {
  const ins = d.insiders;
  if (!ins || (!ins.buys.count && !ins.sells.count)) {
    el.insiders.hidden = true;
    return;
  }
  el.insiders.hidden = false;
  const money = (v) => (isNum(v) && v > 0 ? fmtBillions(v) : "—");
  const rows = ins.recent.map((t) => `
    <tr>
      <td>${esc(t.date ?? "")}</td>
      <td class="ins-name">${esc(t.name ?? "")}</td>
      <td><span class="${t.action === "BUY" ? "delta-up" : "delta-down"}">${t.action}</span></td>
      <td class="num">${isNum(t.shares) ? t.shares.toLocaleString("en-US") : "—"}</td>
      <td class="num">${t.price ? esc(fmtMoney(t.price)) : "—"}</td>
    </tr>`).join("");
  el.insiders.innerHTML = `
    <h2>Insider activity — last 3 months</h2>
    <p class="sub">Open-market trades only (SEC Form 4; gifts and option exercises excluded).
    <span class="delta-up">${ins.buys.count} buy${ins.buys.count === 1 ? "" : "s"} (${money(ins.buys.value)})</span> vs
    <span class="delta-down">${ins.sells.count} sell${ins.sells.count === 1 ? "" : "s"} (${money(ins.sells.value)})</span>.
    Insiders sell for many reasons — taxes, diversification, houses; clusters of open-market <b>buying</b> are the rarer signal.</p>
    <div class="ledger-table-wrap">
      <table class="ledger-table ins-table">
        <thead><tr><th>Date</th><th>Insider</th><th>Action</th><th class="num">Shares</th><th class="num">Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderPeers(d) {
  const peers = d.peers ?? [];
  if (!peers.length) {
    el.peers.innerHTML = `<h2>Peers</h2><p class="sub">No peer list available.</p>`;
    return;
  }
  const canCompare = !d.demo && hasKey;
  el.peers.innerHTML = `
    <h2>Peers</h2>
    <p class="sub">Companies Finnhub groups with ${esc(d.ticker)} — click one to analyze it.</p>
    <div class="peer-list">
      ${peers.map((p) => `<button class="peer-chip" data-t="${esc(p)}">${esc(p)}</button>`).join("")}
      ${canCompare ? `<button class="peer-chip cmp-btn" id="compareBtn">Compare key numbers →</button>` : ""}
    </div>
    <div id="compareOut"></div>`;
  el.peers.querySelectorAll(".peer-chip:not(.cmp-btn)").forEach((b) => b.addEventListener("click", () => go(b.dataset.t)));
  const btn = $("compareBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Comparing…";
      try {
        const res = await fetch(`/api/compare?ticker=${encodeURIComponent(d.ticker)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Comparison failed.");
        const f = (v, suffix = "", digits = 1) => (isNum(v) ? `${fmtNum(v, digits)}${suffix}` : "—");
        $("compareOut").innerHTML = `
          <div class="ledger-table-wrap" style="margin-top:12px">
            <table class="ledger-table cmp-table">
              <thead><tr><th>Symbol</th><th class="num">Mkt cap</th><th class="num">P/E</th><th class="num">P/S</th><th class="num">Net margin</th><th class="num">ROE</th><th class="num">Rev YoY</th><th class="num">D/E</th></tr></thead>
              <tbody>
                ${body.rows.map((r) => `
                  <tr class="${r.symbol === d.ticker ? "cmp-me" : ""}">
                    <td><a href="/#${esc(r.symbol)}">${esc(r.symbol)}</a></td>
                    <td class="num">${isNum(r.marketCap) ? esc(fmtMarketCap(r.marketCap)) : "—"}</td>
                    <td class="num">${f(r.pe, "×")}</td>
                    <td class="num">${f(r.ps, "×")}</td>
                    <td class="num">${f(r.netMargin, "%")}</td>
                    <td class="num">${f(r.roe, "%")}</td>
                    <td class="num">${f(r.revenueGrowth, "%")}</td>
                    <td class="num">${f(r.debtEquity, "", 2)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
          <p class="sub" style="margin:8px 0 0">Same vendor data as the tiles above — the point is context: high FOR THIS GROUP is information; high in the abstract is noise.</p>`;
        btn.remove();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Compare key numbers →";
        $("compareOut").innerHTML = `<p class="sub" style="margin-top:8px">${esc(err.message)}</p>`;
      }
    });
  }
}

function renderNews(d) {
  const items = d.news ?? [];
  if (!items.length) {
    el.news.innerHTML = `<h2>News</h2><p class="sub">No recent news found across the sources.</p>`;
    return;
  }
  el.news.innerHTML = `
    <h2>News</h2>
    <p class="sub">Merged from Google News (hundreds of publishers), Yahoo Finance, and Finnhub — filtered to items that actually mention the company, deduplicated, newest first.</p>
    <ul class="news-list">
      ${items.map((n) => `
        <li class="news-item">
          <a class="news-headline" href="${esc(safeHref(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>
          <div class="news-meta">${esc(n.source)}${n.date ? ` · ${esc(relTime(n.date))}` : ""}</div>
          ${n.summary ? `<p class="news-summary">${esc(n.summary)}</p>` : ""}
        </li>`).join("")}
    </ul>`;
}

// ---------- AI brief: the whole page as paste-ready markdown ----------

function buildBrief(d) {
  const m = d.metrics ?? {};
  const s = d.scoring;
  const p = d.profile ?? {};
  const line = (label, val) => (val != null ? `- ${label}: ${val}` : `- ${label}: N/A`);
  const L = [];

  L.push(`# ${p.name ?? d.ticker} (${d.ticker}) — research brief`);
  L.push("");
  L.push(`Generated ${new Date(d.asOf).toLocaleString("en-US")} by Crosscheck (github.com/EvanDRas/crosscheck) — sources: Finnhub API, SEC EDGAR filings; news merged from Google News RSS, Yahoo Finance RSS, Finnhub. Data may be delayed, incomplete, or wrong. Research/education only — not financial advice.`);
  if (d.demo) L.push("", "**WARNING: this is the app's DEMO ticker — every number and headline below is fictional sample data.**");
  if (d.warnings?.length) L.push("", `Partial data — failed sources: ${d.warnings.join("; ")}`);

  L.push("", "## Company");
  L.push(line("Exchange / industry", [p.exchange, p.industry].filter(Boolean).join(" / ") || null));
  L.push(line("Market cap", fmtMarketCap(p.marketCap)));
  L.push(line("IPO", p.ipo || null));
  L.push(line("Website", p.website || null));

  L.push("", "## Quote");
  if (d.quote && isNum(d.quote.price)) {
    L.push(line("Price", `${fmtMoney(d.quote.price, p.currency || "USD")} (${fmtNum(d.quote.change) ?? "?"} / ${fmtNum(d.quote.changePercent) ?? "?"}% today, prev close ${fmtMoney(d.quote.previousClose, p.currency || "USD") ?? "N/A"})`));
  } else {
    L.push("- Live quote unavailable");
  }
  if (isNum(m.low52) && isNum(m.high52)) {
    const pos = isNum(m.pricePosition) ? ` — price at ${Math.round(m.pricePosition * 100)}% of the range` : "";
    L.push(line("52-week range", `${fmtMoney(m.low52)} (${m.low52Date ?? "?"}) to ${fmtMoney(m.high52)} (${m.high52Date ?? "?"})${pos}`));
  }
  if (d.history) {
    L.push(line("Price history on file", `${d.history.series.length} points through ${d.history.through} (${d.history.source})`));
    if (!(d.quote && isNum(d.quote.price)) && isNum(d.history.last?.close)) {
      L.push(line("Last close (local data, not live)", `${fmtMoney(d.history.last.close)} on ${d.history.last.date}`));
    }
  }

  L.push("", "## App verdict (mechanical formula, not advice)");
  if (s.insufficientData) {
    L.push(`- NOT ENOUGH DATA — only ${s.availableCount}/${s.totalCategories} scoring categories had data.`);
  } else {
    L.push(`- Overall ${Math.round(s.score)}/100 → ${s.verdict} (confidence ${s.confidence}, ${s.availableCount}/${s.totalCategories} categories)`);
    L.push(`- Bands (percentile-calibrated vs 16,497 historical S&P scores; a verdict states rank among large caps): >=74 STRONG BUY (top ~10%), >=66 BUY (top ~30%), >=55 HOLD, >=47 SELL, <47 STRONG SELL. Weights renormalize over categories with data.`);
  }
  for (const c of s.categories) {
    const detail = c.details.map((x) => `${x.label} ${fmtDetailValue(x) ?? "N/A"}${x.score != null ? ` (sub-score ${x.score})` : ""}`).join(", ");
    L.push(`- ${c.label} (weight ${c.weight}%): ${c.available ? `${c.score}/100` : "no data"} — ${detail}`);
  }
  if (Array.isArray(s.horizons) && s.horizons.length) {
    L.push("", "### Horizon views (same inputs regrouped by horizon — not independent forecasts)");
    for (const h of s.horizons) {
      const comps = h.components.map((c) => `${c.label} ${c.available ? c.score : "n/a"} (w ${c.weight})`).join(", ");
      L.push(h.insufficientData
        ? `- ${h.label} (${h.hint}): NO DATA — ${comps}`
        : `- ${h.label} (${h.hint}): ${Math.round(h.score)}/100 → ${h.verdict} (confidence ${h.confidence}) — ${comps}`);
    }
  }

  L.push("", "## Key numbers");
  L.push(line("P/E (TTM)", fmtX(m.pe)));
  L.push(line("P/S", fmtX(m.ps)));
  L.push(line("P/B", fmtX(m.pb)));
  L.push(line("PEG", fmtX(m.peg)));
  L.push(line("Net margin", fmtPct(m.netMargin)));
  L.push(line("ROE", fmtPct(m.roe)));
  L.push(line("ROA", fmtPct(m.roa)));
  L.push(line("Revenue growth YoY", fmtPct(m.revenueGrowth, true)));
  L.push(line("EPS growth YoY", fmtPct(m.epsGrowth, true)));
  L.push(line("Current ratio", fmtNum(m.currentRatio)));
  L.push(line("Debt/equity", fmtNum(m.debtEquity)));
  L.push(line("Dividend yield", fmtPct(m.dividendYield)));
  L.push(line("Beta", fmtNum(m.beta)));

  L.push("", "## Analyst ratings");
  if (d.analystTrends?.total) {
    const a = d.analystTrends;
    L.push(`- ${a.total} analysts (${String(a.period ?? "").slice(0, 7)}): ${a.strongBuy} strong buy, ${a.buy} buy, ${a.hold} hold, ${a.sell} sell, ${a.strongSell} strong sell`);
  } else {
    L.push("- No analyst coverage data");
  }

  L.push("", "## Earnings — last 4 quarters (EPS actual vs estimate)");
  if (d.earnings?.length) {
    for (const e of d.earnings) {
      const tag = e.beat == null ? "no estimate" : e.beat ? `BEAT${isNum(e.surprisePercent) ? ` +${fmtNum(e.surprisePercent, 1)}%` : ""}` : `MISS${isNum(e.surprisePercent) ? ` ${fmtNum(e.surprisePercent, 1)}%` : ""}`;
      L.push(`- Q${e.quarter ?? "?"} ${e.year ?? "?"} (${e.period ?? "?"}): ${fmtNum(e.actual) ?? "N/A"} vs ${fmtNum(e.estimate) ?? "N/A"} est. — ${tag}`);
    }
  } else {
    L.push("- No earnings history available");
  }

  L.push("", "## Peers");
  L.push(d.peers?.length ? `- ${d.peers.join(", ")}` : "- No peer list available");

  L.push("", `## Recent news (${d.news?.length ?? 0} items, multiple sources, deduped, newest first)`);
  for (const n of d.news ?? []) {
    const when = n.date ? new Date(n.date).toISOString().slice(0, 10) : "?";
    L.push(`- [${n.source}, ${when}] ${n.headline}${n.summary ? ` — ${n.summary}` : ""}${n.link && n.link !== "#" ? ` (${n.link})` : ""}`);
  }

  return L.join("\n");
}

async function copyBrief() {
  if (!lastPayload) return;
  const text = buildBrief(lastPayload);
  const btn = $("copyBriefBtn");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can be blocked outside secure contexts — fall back.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  btn.classList.add("copied");
  btn.textContent = "Copied — paste it into an AI chat";
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.textContent = "Copy AI brief";
  }, 2200);
}

// ---------- live price stream ----------

let liveStream = null;

function stopLive() {
  liveStream?.close();
  liveStream = null;
}

// Streams real-time trades for the rendered ticker into the price block.
// Quiet outside market hours (no trades, no updates) — the static quote
// simply stays put. The stream dies silently on any server/key problem.
function startLive(d) {
  stopLive();
  if (d.demo || !d.quote || !isNum(d.quote.previousClose)) return;
  const currency = d.profile?.currency || "USD";
  const prevClose = d.quote.previousClose;
  const es = new EventSource(`/api/stream?ticker=${encodeURIComponent(d.ticker)}`);
  liveStream = es;
  es.onmessage = (ev) => {
    let tick;
    try {
      tick = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!isNum(tick.price)) return;
    const now = el.company.querySelector(".price-now");
    const deltaEl = el.company.querySelector(".price-delta");
    const sub = el.company.querySelector(".price-sub");
    if (!now) return;
    now.textContent = fmtMoney(tick.price, currency);
    const change = tick.price - prevClose;
    const pct = (change / prevClose) * 100;
    const dir = Math.abs(change) < 1e-9 ? "flat" : change > 0 ? "up" : "down";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
    if (deltaEl) {
      deltaEl.className = `price-delta ${dir}`;
      deltaEl.textContent = `${arrow} ${change > 0 ? "+" : ""}${fmtNum(change)} (${pct > 0 ? "+" : ""}${fmtNum(pct)}%) today`;
    }
    if (sub) {
      // Upstream trade timestamps aren't reliable wall-clock; the arrival
      // time is (ticks reach us within ~a second of the trade).
      sub.innerHTML = `<span class="live-dot" aria-hidden="true"></span>Live · updated ${esc(new Date().toLocaleTimeString("en-US"))} · prev close ${esc(fmtMoney(prevClose, currency) ?? "N/A")}`;
    }
  };
}

// ---------- share card: the verdict as an image, honesty baked in ----------

const BAND_COLORS = { "STRONG BUY": "#3d9c6b", BUY: "#63a97f", HOLD: "#c0912f", SELL: "#c07048", "STRONG SELL": "#bf4d4d" };

function drawShareCard(d) {
  const s = d.scoring;
  const W = 1000;
  const H = 560;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const mono = '600 (px) ui-monospace, Consolas, monospace';

  x.fillStyle = "#0c0d0f";
  x.fillRect(0, 0, W, H);
  x.strokeStyle = "#33373e";
  x.lineWidth = 2;
  x.strokeRect(1, 1, W - 2, H - 2);

  // Wordmark
  x.fillStyle = "#4f86c6";
  x.fillRect(40, 42, 12, 12);
  x.fillStyle = "#e9eaec";
  x.font = "800 22px system-ui, sans-serif";
  x.fillText("C R O S S C H E C K", 64, 54);
  x.fillStyle = "#7d828b";
  x.font = "13px system-ui, sans-serif";
  x.textAlign = "right";
  x.fillText(new Date(d.asOf).toISOString().slice(0, 10), W - 40, 54);
  x.textAlign = "left";

  // Ticker + name
  x.fillStyle = "#e9eaec";
  x.font = mono.replace("(px)", "44px");
  x.fillText(d.ticker, 40, 130);
  x.fillStyle = "#b9bcc2";
  x.font = "16px system-ui, sans-serif";
  x.fillText((d.profile?.name ?? "").slice(0, 60), 40, 158);

  // Score + band
  const band = s.insufficientData ? null : (s.verdict ?? null);
  x.fillStyle = "#e9eaec";
  x.font = mono.replace("(px)", "96px");
  x.fillText(s.insufficientData ? "–" : String(Math.round(s.score)), 40, 290);
  x.fillStyle = "#7d828b";
  x.font = mono.replace("(px)", "24px");
  x.fillText("/100", 40 + x.measureText(" ").width + (s.insufficientData ? 60 : String(Math.round(s.score)).length * 58), 290);
  if (band) {
    const col = BAND_COLORS[band] ?? "#7d828b";
    x.strokeStyle = col;
    x.lineWidth = 1.5;
    x.font = "700 20px system-ui, sans-serif";
    const tw = x.measureText(band).width;
    x.strokeRect(42, 315, tw + 28, 40);
    x.fillStyle = col;
    x.fillText(band, 56, 342);
  }

  // Category bars (right column)
  const cats = s.categories ?? [];
  let cy = 110;
  for (const cat of cats) {
    x.fillStyle = "#b9bcc2";
    x.font = "13px system-ui, sans-serif";
    x.fillText(cat.label, 560, cy);
    x.fillStyle = "#e9eaec";
    x.font = mono.replace("(px)", "14px");
    x.textAlign = "right";
    x.fillText(cat.available ? String(cat.score) : "—", W - 40, cy);
    x.textAlign = "left";
    x.fillStyle = "#1b1e22";
    x.fillRect(560, cy + 8, 400, 5);
    if (cat.available) {
      const bandCls = cat.score >= 66 ? "#3d9c6b" : cat.score >= 55 ? "#c0912f" : cat.score >= 47 ? "#c07048" : "#bf4d4d";
      x.fillStyle = bandCls;
      x.fillRect(560, cy + 8, 4 * cat.score, 5);
    }
    cy += 46;
  }

  // The honesty line — the whole point of sharing this instead of a hot tip.
  x.strokeStyle = "#33373e";
  x.setLineDash([3, 4]);
  x.beginPath();
  x.moveTo(40, 420);
  x.lineTo(W - 40, 420);
  x.stroke();
  x.setLineDash([]);
  x.fillStyle = "#7d828b";
  x.font = "14px system-ui, sans-serif";
  const disclaimer = "Backtested honestly: this formula (16,497 point-in-time calls, 2011–2024) showed no predictive power. A score states rank among large caps on these metrics — it does not forecast returns. Not financial advice.";
  let line = "";
  let ly = 448;
  for (const word of disclaimer.split(" ")) {
    if (x.measureText(line + word).width > W - 80) {
      x.fillText(line, 40, ly);
      line = "";
      ly += 22;
    }
    line += word + " ";
  }
  x.fillText(line, 40, ly);
  x.fillStyle = "#4f86c6";
  x.font = "13px system-ui, sans-serif";
  x.fillText("crosscheck — the honest stock analyzer · github.com/EvanDRas/crosscheck", 40, H - 28);

  return c;
}

function shareCard() {
  if (!lastPayload || lastPayload.demo || !lastPayload.scoring) return;
  const canvas = drawShareCard(lastPayload);
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${lastPayload.ticker}-crosscheck.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
}

let lastPayload = null;

function render(d) {
  lastPayload = d;
  el.status.hidden = true;
  el.btn.disabled = false;
  el.demoNote.hidden = !d.demo;
  $("shareCardBtn").hidden = Boolean(d.demo); // a share card of fictional data helps no one

  if (d.warnings?.length) {
    el.warnings.textContent = `Partial data — some sources failed: ${d.warnings.join("; ")}`;
    el.warnings.hidden = false;
  }

  // Unhide before rendering: the chart measures its container's width.
  el.results.hidden = false;
  renderChanges(d);
  renderCompany(d);
  renderHistory(d);
  renderVerdict(d);
  renderKeyNumbers(d);
  renderTrajectory(d);
  renderInsiders(d);
  renderFilings(d);
  renderRange(d);
  renderAnalyst(d);
  renderEarnings(d);
  renderPeers(d);
  renderNews(d);
  startLive(d);
  if (!d.demo && d.ticker) pushRecent(d.ticker);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- time machine ----------

// What the formula would have said on a past date — only information filed
// and priced by that day — graded against everything since. The honesty
// claim, made interactive.
async function timeMachine(ticker, date) {
  setLoading(`${ticker} on ${date}`);
  const seq = viewSeq;
  el.statusText.textContent = `Rewinding to ${date} — filings and prices as known that day…`;
  try {
    const res = await fetch(`/api/timemachine?ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(date)}`);
    const p = await res.json();
    if (seq !== viewSeq) return; // a newer view took over while we fetched
    el.status.hidden = true;
    el.btn.disabled = false;
    if (!res.ok) {
      // Clear the date so the NEXT search isn't poisoned into re-failing —
      // especially the keyless user who clicked the demo chip.
      el.dateInput.value = "";
      setError(p.error ?? "Time machine failed.");
      return;
    }
    renderTimeMachine(p);
  } catch {
    if (seq !== viewSeq) return;
    el.btn.disabled = false;
    el.dateInput.value = "";
    setError("Could not reach the server. Is it still running?");
  }
}

function renderTimeMachine(p) {
  const s = p.scoring;
  const meters = s.categories.map((c) => {
    if (!c.available) {
      return `<div class="meter-row"><div class="meter-head"><span class="meter-label">${esc(c.label)}</span><span class="meter-val na">no data then</span></div><div class="meter-track"></div></div>`;
    }
    const band = scoreBand(c.score);
    return `<div class="meter-row"><div class="meter-head"><span class="meter-label">${esc(c.label)}</span><span class="meter-val">${c.score}</span></div><div class="meter-track band-${band}"><div class="meter-fill band-${band}" style="width:${c.score}%"></div></div></div>`;
  }).join("");

  const i = p.inputs;
  const fmtIn = (v, suffix = "", digits = 1) => (isNum(v) ? `${fmtNum(v, digits)}${suffix}` : "n/a");
  const inputsLine = [
    `P/E ${fmtIn(i.pe, "×")}`,
    `P/S ${fmtIn(i.ps, "×")}`,
    `margin ${fmtIn(i.netMargin, "%")}`,
    `rev YoY ${fmtIn(i.revenueGrowth, "%")}`,
    `D/E ${fmtIn(i.debtEquity, "", 2)}`,
    i.pricePosition == null ? "52w pos n/a" : `52w pos ${Math.round(i.pricePosition * 100)}%`,
  ].join(" · ");

  const o = p.outcome;
  const cell = (v) => (v == null ? "—" : `<span class="${v > 0.0001 ? "delta-up" : v < -0.0001 ? "delta-down" : "delta-flat"}">${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%</span>`);
  const hero = s.insufficientData
    ? `<div class="verdict-score">–<small>/100</small></div><div class="verdict-pill v-nodata">NOT ENOUGH DATA</div>`
    : `<div class="verdict-score">${Math.round(s.score)}<small>/100</small></div>
       <div class="verdict-pill ${verdictClass(s.verdict)}">${esc(s.verdict)}</div>
       <div class="verdict-conf">${s.availableCount}/6 categories knowable then</div>`;

  el.tmResults.innerHTML = `
    <section class="card">
      <h2>Time machine — ${esc(p.ticker)} on ${esc(p.date)}</h2>
      <p class="sub">Reconstructed from information available THAT day: SEC filings <b>submitted</b> by ${esc(p.date)}
      (latest covered period ${esc(p.edgarThrough)}) and prices through the close. Filing lags included, no hindsight.
      Analyst ratings and estimates have no free history, so those categories are missing — weights renormalize, same as live.
      Known limit: mostly today's tickers resolve — companies since delisted or renamed usually can't be summoned,
      so browsing history here skews toward survivors.</p>
      <div class="verdict-wrap">
        <div class="verdict-hero">${hero}</div>
        <div>${meters}<div class="scoring-note">${esc(inputsLine)}</div></div>
      </div>
      ${p.notes?.length ? `<p class="sub" style="margin-top:10px">${esc(p.notes.join(" "))}</p>` : ""}
    </section>
    <section class="card">
      <h2>What actually happened since</h2>
      <p class="sub">${o.years.toFixed(1)} years, ${esc(p.date)} → ${esc(o.through)}, split- and dividend-adjusted.</p>
      <div class="tm-outcome">
        <div class="tm-stat"><div class="tm-label">${esc(p.ticker)}</div><div class="tm-val">${cell(o.ret)}</div></div>
        <div class="tm-stat"><div class="tm-label">S&P (SPY)</div><div class="tm-val">${cell(o.spyRet)}</div></div>
        <div class="tm-stat"><div class="tm-label">Excess</div><div class="tm-val">${cell(o.excess)}</div></div>
      </div>
      <p class="scoring-note evidence-note">One graded call is an anecdote — the point is that you can run this on ANY
      ticker and date and the formula can't hide from its history. Full methodology and 16,497-call results:
      <a href="/evidence.html">Evidence</a>.</p>
    </section>`;
  el.tmResults.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- fetch & routing ----------

let inFlight = null;

// Company-name fallback: when the input isn't a ticker (or the ticker isn't
// found), search by name and offer clickable matches. Terminal states are
// always real messages — never a stuck "Searching…" and never an empty
// "did you mean:" with nothing after the colon.
async function suggestFor(query, { foundMsg, fallbackMsg } = {}) {
  const deadEnd = fallbackMsg
    ?? (hasKey
      ? `Nothing found for "${query}". Double-check the spelling, or try the ticker symbol directly.`
      : `Search needs an API key — use the setup card above to add your free Finnhub key, or try the DEMO ticker.`);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const { results } = await res.json();
    el.status.hidden = true;
    el.btn.disabled = false;
    if (!results?.length) {
      setError(deadEnd);
      return;
    }
    setError(foundMsg ?? `Matches for "${query}":`);
    el.suggest.innerHTML = results
      .map((r) => `<button type="button" data-t="${esc(r.symbol)}">${esc(r.symbol)}<span>${esc(r.name)}</span></button>`)
      .join("");
    el.suggest.hidden = false;
    el.suggest.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.t)));
  } catch {
    el.status.hidden = true;
    el.btn.disabled = false;
    setError(deadEnd);
  }
}

async function analyze(ticker) {
  ticker = String(ticker ?? "").trim().toUpperCase();
  if (!ticker) return;
  el.input.value = ticker;
  setLoading(ticker);
  inFlight?.abort();
  const ctrl = new AbortController();
  inFlight = ctrl;
  const seq = viewSeq;
  try {
    const res = await fetch(`/api/analyze?ticker=${encodeURIComponent(ticker)}`, { signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (seq !== viewSeq) return; // a newer view (e.g. time machine) took over
    if (!res.ok) {
      if (res.status === 404) {
        // Offer close matches, but never discard the server's guidance —
        // keyless users need the "add a key" message, not an empty list.
        await suggestFor(ticker, {
          foundMsg: `No data for "${ticker}" — closest matches:`,
          fallbackMsg: body?.error ?? `Nothing found for "${ticker}".`,
        });
        return;
      }
      setError(body?.error ?? `Request failed (${res.status}). Try again in a moment.`);
      return;
    }
    render(body);
  } catch (err) {
    if (err.name === "AbortError") return;
    setError("Could not reach the server. Is it still running?");
  }
}

function go(ticker) {
  const t = String(ticker ?? "").trim().toUpperCase();
  if (!t) return;
  // Any normal navigation (peer chip, suggestion, hash link) is a "today"
  // view — a leftover time-machine date must not silently ride along.
  el.dateInput.value = "";
  if (location.hash.slice(1) === t) analyze(t);
  else location.hash = t; // hashchange handler runs analyze
}

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = el.input.value.trim();
  if (!raw) return;
  const date = el.dateInput.value;
  if (date) {
    if (/^[A-Za-z0-9.\-^]{1,10}$/.test(raw)) timeMachine(raw.toUpperCase(), date);
    else setError("The time machine needs a ticker symbol (e.g. NVDA) — clear the date to search by company name.");
    return;
  }
  // A ticker goes straight through; anything else ("apple", "berkshire
  // hathaway") becomes a name search.
  if (/^[A-Za-z0-9.\-^]{1,10}$/.test(raw)) go(raw);
  else {
    setLoading(raw);
    suggestFor(raw, { foundMsg: `Matches for "${raw}":` });
  }
});

$("copyBriefBtn").addEventListener("click", copyBrief);
$("shareCardBtn").addEventListener("click", shareCard);

// Terminal muscle memory: "/" anywhere jumps to the search box.
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    el.input.focus();
    el.input.select();
  }
});

$("introChips").addEventListener("click", (e) => {
  const t = e.target?.dataset?.t;
  const d = e.target?.dataset?.d;
  if (t && d) {
    el.input.value = t;
    el.dateInput.value = d;
    timeMachine(t, d);
  } else if (t) {
    el.dateInput.value = "";
    go(t);
  }
});

// One canonical way back to the landing view — used by the brand link and
// by the browser back button (hash cleared). Bumping viewSeq and aborting
// the in-flight request means a half-finished analysis can't render over it.
function showHome() {
  viewSeq++;
  inFlight?.abort();
  stopLive();
  el.results.hidden = true;
  el.tmResults.hidden = true;
  el.dateInput.value = "";
  el.error.hidden = true;
  el.suggest.hidden = true;
  el.demoNote.hidden = true;
  el.warnings.hidden = true;
  el.status.hidden = true;
  el.btn.disabled = false;
  el.intro.hidden = false;
  loadMarket();
}

$("brandLink").addEventListener("click", (e) => {
  e.preventDefault();
  history.replaceState(null, "", location.pathname);
  showHome();
  el.input.value = "";
  el.input.focus();
});

// ---------- market overview (the landing page) ----------

const chgCls = (v) => (isNum(v) ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "");
// Prices always get two decimals — "354.3" reads like a typo on a terminal.
const fmtPrice = (v) =>
  isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

// Inline sparkline: 30 sessions, colored by the sign of the whole window.
function sparkSvg(vals, w = 84, h = 24) {
  if (!Array.isArray(vals) || vals.length < 2) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) =>
    `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark ${up ? "pos" : "neg"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Last rendered strip prices: a tile flashes green/red when its price moves
// between refreshes, so a live page visibly breathes.
let lastStripPrices = {};

function renderMarket(m) {
  const sparks = m.sparks ?? {};
  const strip = $("marketStrip");
  if (m.indices?.length) {
    const prev = lastStripPrices;
    lastStripPrices = Object.fromEntries(m.indices.map((i) => [i.symbol, i.price]));
    const flash = (i) => (isNum(prev[i.symbol]) && prev[i.symbol] !== i.price ? (i.price > prev[i.symbol] ? " flash-up" : " flash-down") : "");
    strip.innerHTML = m.indices.map((i) => `
      <div class="mkt-tile${flash(i)}">
        <div class="mkt-label">${esc(i.label)} · ${esc(i.symbol)}</div>
        <div class="mkt-price">${esc(fmtPrice(i.price) ?? "—")}</div>
        <div class="mkt-chg">${isNum(i.change) && isNum(i.changePercent) ? `<span class="badge ${chgCls(i.changePercent)}">${esc(`${i.change > 0 ? "+" : ""}${fmtPrice(i.change)} (${fmtPct(i.changePercent, true)})`)}</span>` : "—"}</div>
        ${sparks[i.symbol] ? `<div class="mkt-spark" title="Last 30 sessions">${sparkSvg(sparks[i.symbol], 120, 26)}</div>` : ""}
      </div>`).join("");
    strip.hidden = false;
  } else strip.hidden = true;

  // (Big board cut — the heat map and movers already carry those quotes.)

  screenData = m.screen ?? [];
  renderScreen();

  newsData = { items: m.news ?? [], hasKey: Boolean(m.hasKey) };
  lastUpdatedAt = Date.now();
  renderToday();
  renderHero();
  if (feedTab === "top" && feedLimit === 10) feedItems = newsData.items;
  renderNewsCard();
  renderWatch(); // verdict pills need screenData, which just arrived
  if (moversData) renderHeat(); // so do the heat-tile dots
}

// ---------- news card: lead story, ticker tags, trending ----------

let newsData = null;
let moversData = null;

// Which universe names does a headline mention? Aliases come from
// data/universe.json; bare tickers count only at 4+ letters (T, V, MA, GE…
// are ordinary words).
function tickersIn(text) {
  const names = moversData?.names ?? {};
  const out = [];
  for (const [t, aliases] of Object.entries(names)) {
    const pats = [...aliases, ...(t.length >= 4 ? [t] : [])];
    if (pats.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))) out.push(t);
  }
  return out;
}

function tagChip(t) {
  const q = moversData?.rows?.find((r) => r.ticker === t);
  const dp = q?.changePercent;
  return `<button type="button" class="news-tag mkt-row" data-t="${esc(t)}">${esc(t)}${isNum(dp) ? ` <span class="${chgCls(dp)}">${esc(fmtPct(dp, true))}</span>` : ""}</button>`;
}

// ---------- feed tabs: Top / Markets / World / For you ----------

let feedTab = "top";
let feedItems = [];
let feedLimit = 10;
let feedLoading = false;
const FEED_TABS = [["top", "Top"], ["markets", "Markets"], ["world", "World"], ["you", "For you"]];
const hasImg = (n) => /^https:\/\//i.test(n?.image ?? "");
const youTickers = () => [...new Set([...readWatch(), ...readRecent()])].slice(0, 6);

async function loadFeed(tab, limit = 10) {
  feedTab = tab;
  feedLimit = limit;
  if (tab === "top" && limit === 10 && newsData) {
    feedItems = newsData.items;
    renderNewsCard();
    return;
  }
  const t = tab === "you" ? youTickers() : [];
  if (tab === "you" && !t.length) {
    feedItems = [];
    renderNewsCard();
    return;
  }
  feedLoading = true;
  renderNewsCard();
  try {
    const res = await fetch(`/api/feed?tab=${tab}&limit=${limit}${t.length ? `&t=${encodeURIComponent(t.join(","))}` : ""}`);
    if (res.ok && feedTab === tab) feedItems = (await res.json()).items ?? [];
  } catch {
    /* keep whatever was showing */
  }
  feedLoading = false;
  renderNewsCard();
}

// The lead story lives in the hero, not the list — one dominant item is
// what makes a front page read as a front page. Prefer a market story for
// the slot: the wire mix includes world news, and a stock site leading
// with geopolitics reads off-brand.
const MARKETISH = /\b(stocks?|shares|markets?|nasdaq|s&p|dow|earnings|fed|wall street|investors?|rally|selloff|inflation|tariffs?)\b/i;
function pickLead() {
  const items = newsData?.items ?? [];
  // Preference order: market photo story, any photo story, market text
  // story, anything — a keyless install gets no photos (Google RSS carries
  // none), and a dead hero slot reads as broken.
  return items.find((n) => hasImg(n) && (tickersIn(n.headline).length || MARKETISH.test(n.headline)))
    ?? items.find(hasImg)
    ?? items.find((n) => tickersIn(n.headline).length || MARKETISH.test(n.headline))
    ?? items[0];
}

function renderHero() {
  const hero = $("heroLead");
  const lead = pickLead();
  if (!lead) {
    hero.hidden = true;
    return;
  }
  const tags = tickersIn(lead.headline);
  hero.innerHTML = `
    <a class="hero-link" href="${esc(safeHref(lead.link))}" target="_blank" rel="noopener noreferrer">
      ${hasImg(lead) ? `<img class="hero-img" src="${esc(lead.image)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.querySelector('.hero-title')?.classList.add('hero-title-xl'); this.remove()">` : ""}
      <div class="hero-title${hasImg(lead) ? "" : " hero-title-xl"}">${esc(lead.headline)}</div>
    </a>
    <div class="news-meta">${esc(lead.source)}${lead.date ? ` · ${esc(relTime(lead.date))}` : ""}${tags.length ? ` <span class="news-tags">${tags.map(tagChip).join("")}</span>` : ""}</div>`;
  hero.hidden = false;
}

function renderNewsCard() {
  const newsEl = $("marketNews");
  const items = feedItems;
  const leadLink = feedTab === "top" ? pickLead()?.link : null;
  const list = items.filter((n) => n.link !== leadLink);
  const tagged = list.map((n) => ({ n, tags: n.tickers ?? tickersIn(n.headline) }));
  const counts = new Map();
  for (const { tags } of tagged) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const trending = feedTab === "top" ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t) : [];
  const tagsFor = (n) => tagged.find((x) => x.n === n)?.tags ?? [];
  const item = (n) => `
    <li class="news-item${hasImg(n) ? " has-thumb" : ""}">
      ${hasImg(n) ? `<img class="news-thumb" src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('li').classList.remove('has-thumb'); this.remove()">` : ""}
      <div class="news-body">
        <a class="news-headline" href="${esc(safeHref(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>
        <div class="news-meta">${esc(n.source)}${n.date ? ` · ${esc(relTime(n.date))}` : ""}${tagsFor(n).length ? ` <span class="news-tags">${tagsFor(n).map(tagChip).join("")}</span>` : ""}</div>
      </div>
    </li>`;
  const empty = feedTab === "you" && !youTickers().length
    ? `<p class="feed-empty">Star a few stocks and their news lands here. Try the suggestions under <b>Your stocks</b>.</p>`
    : feedLoading && !list.length ? `<p class="feed-empty">Loading…</p>` : !list.length ? `<p class="feed-empty">Nothing here right now.</p>` : "";
  newsEl.innerHTML = `
    <div class="news-tabs">${FEED_TABS.map(([k, label]) => `<button type="button" data-tab="${k}" class="${feedTab === k ? "active" : ""}">${label}</button>`).join("")}</div>
    ${trending.length ? `<div class="news-trending"><span class="mkt-label">Trending</span>${trending.map(tagChip).join("")}</div>` : ""}
    ${empty}
    <ul class="news-list${feedLoading ? " loading" : ""}">${list.map(item).join("")}</ul>
    ${list.length && !(feedTab === "you" && !youTickers().length) ? `<button type="button" class="load-more" data-more="1">${feedLoading ? "Loading…" : "More stories"}</button>` : ""}`;
  newsEl.hidden = false;
}

$("marketNews").addEventListener("click", (e) => {
  const tab = e.target.closest?.("[data-tab]")?.dataset?.tab;
  if (tab) {
    loadFeed(tab, 10);
    return;
  }
  if (e.target.closest?.("[data-more]")) loadFeed(feedTab, Math.min(40, feedLimit + 15));
});

// ---------- today bar: the daily ritual ----------

let lastUpdatedAt = null;
const readJSON = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
};
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function marketStatus() {
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = ny.getHours() * 60 + ny.getMinutes();
  return ny.getDay() >= 1 && ny.getDay() <= 5 && mins >= 570 && mins < 960 ? "open" : "closed";
}

// The streak belongs to PLAYING the Daily 5 (callit.js owns bumping it on
// the first daily reveal of the day) — a streak for merely loading a page
// attaches the "don't break the chain" pressure to the wrong action.
function readStreak() {
  const s = readJSON("cc_streak", { last: null, count: 0, best: 0 });
  const today = localDay();
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  const current = s.last === today || s.last === yesterday ? s.count : 0;
  return { current, best: Math.max(s.best ?? 0, s.count ?? 0), playedToday: s.last === today };
}

function renderToday() {
  const s = readStreak();
  const st = marketStatus();
  const daily = readJSON("cc_callit_daily", { date: null, rounds: [] });
  const played = daily.date === localDay() ? daily.rounds.length : 0;
  const ago = lastUpdatedAt ? Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000)) : null;
  $("todayBar").innerHTML = `
    <span class="today-date">${esc(new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}</span>
    <span class="today-mkt ${st}"><i></i>Market ${st}</span>
    <span class="today-upd">${ago == null ? "loading…" : `updated ${ago}s ago`}</span>
    <button type="button" class="today-daily" data-scroll="callitCard">Daily 5: ${played >= 5 ? "done" : `${played}/5`}${s.current ? ` · ${s.current}-day streak` : ""}${s.best > s.current ? ` · best ${s.best}` : ""}</button>
    <span class="today-tag">The analyzer that backtested itself and published the null — graded live below.</span>`;
}
setInterval(() => { if (!el.intro.hidden) renderToday(); }, 5000);

$("todayBar").addEventListener("click", (e) => {
  const target = e.target.closest?.("[data-scroll]")?.dataset?.scroll;
  if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- watchlist ----------

const WATCH_KEY = "cc_watch";
const readWatch = () => readJSON(WATCH_KEY, []).filter((t) => typeof t === "string").slice(0, 12);
let watchQuotes = {};

function toggleWatch(t) {
  const w = readWatch();
  writeJSON(WATCH_KEY, w.includes(t) ? w.filter((x) => x !== t) : [t, ...w].slice(0, 12));
  refreshStars();
  loadWatchQuotes();
  if (feedTab === "you") loadFeed("you", 10);
}

const starBtn = (t) => {
  const on = readWatch().includes(t);
  return `<button type="button" class="star${on ? " on" : ""}" data-star="${esc(t)}" title="${on ? "Unwatch" : "Watch"} ${esc(t)}">${on ? "★" : "☆"}</button>`;
};

function refreshStars() {
  const w = readWatch();
  document.querySelectorAll("[data-star]").forEach((b) => {
    const on = w.includes(b.dataset.star);
    b.classList.toggle("on", on);
    if (b.classList.contains("star")) b.textContent = on ? "★" : "☆";
  });
}

// Capture phase so a star inside a clickable row never also opens the row.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-star]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  toggleWatch(b.dataset.star);
}, true);

// "Since your last visit": once per browser session, diff current watchlist
// prices against the prices stored at the END of the previous session —
// the payoff that makes returning to the page feel like something happened.
let watchDelta = null;
function computeWatchDeltas() {
  try {
    if (sessionStorage.getItem("cc_watch_session")) {
      watchDelta = readJSON("cc_watch_delta", null);
      return;
    }
    const prev = readJSON("cc_watch_seen", {});
    const deltas = [];
    for (const [t, q] of Object.entries(watchQuotes)) {
      const p = prev[t];
      if (p?.price && q.price && Math.abs(q.price - p.price) / p.price >= 0.005) {
        deltas.push({ t, pct: (100 * (q.price - p.price)) / p.price });
      }
    }
    watchDelta = deltas.length ? { deltas: deltas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 4) } : null;
    writeJSON("cc_watch_delta", watchDelta);
    sessionStorage.setItem("cc_watch_session", "1");
  } catch {
    /* private mode */
  }
}

function rememberWatchPrices() {
  const seen = readJSON("cc_watch_seen", {});
  for (const [t, q] of Object.entries(watchQuotes)) if (q.price) seen[t] = { price: q.price, at: Date.now() };
  writeJSON("cc_watch_seen", seen);
}

async function loadWatchQuotes() {
  const w = readWatch();
  if (!w.length || !hasKey) {
    watchQuotes = {};
    renderWatch();
    return;
  }
  try {
    const res = await fetch(`/api/quotes?t=${encodeURIComponent(w.join(","))}`);
    if (res.ok) watchQuotes = (await res.json()).quotes ?? {};
  } catch {
    /* rows show dashes */
  }
  computeWatchDeltas();
  rememberWatchPrices();
  renderWatch();
}

function renderWatch() {
  const card = $("watchCard");
  const w = readWatch();
  if (!w.length) {
    const byMove = [...(moversData?.rows ?? [])].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).map((r) => r.ticker);
    // Keyless installs have no movers — fall back to the universe list so
    // the empty state still offers something to star (For you news is
    // keyless, so starring pays off immediately either way).
    const pool = byMove.length ? byMove : (moversData?.universe ?? []);
    const sugg = [...new Set([...readRecent(), ...pool])].slice(0, 6);
    card.innerHTML = `
      <h2>Your stocks</h2>
      <p class="watch-empty">Star any stock and it lives here — price, verdict, and its own news under <b>For you</b>.</p>
      ${sugg.length ? `<div class="watch-sugg">${sugg.map((t) => `<button type="button" class="chip" data-star="${esc(t)}">☆ ${esc(t)}</button>`).join("")}</div>` : ""}`;
    return;
  }
  card.innerHTML = `
    <h2>Your stocks</h2>
    <table class="mkt-table watch-table">
      ${w.map((t) => {
        const q = watchQuotes[t];
        const v = screenData.find((r) => r.ticker === t);
        return `<tr class="mkt-row" data-t="${esc(t)}">
          <td class="mkt-sym">${esc(t)}</td>
          <td class="num">${q ? esc(fmtPrice(q.price)) : "—"}</td>
          <td class="num">${q && isNum(q.changePercent) ? `<span class="badge ${chgCls(q.changePercent)}">${esc(fmtPct(q.changePercent, true))}</span>` : ""}</td>
          <td>${v ? `<span class="pill-sm ${verdictClass(v.verdict)}">${esc(v.verdict)}</span>` : ""}</td>
          <td class="star-cell">${starBtn(t)}</td>
        </tr>`;
      }).join("")}
    </table>
    ${watchDelta?.deltas?.length ? `<p class="watch-delta">Since your last visit: ${watchDelta.deltas.map((d) =>
      `<button type="button" class="watch-delta-item mkt-row ${d.pct > 0 ? "pos" : "neg"}" data-t="${esc(d.t)}">${esc(d.t)} ${esc(fmtPct(d.pct, true))}</button>`).join(" ")}</p>` : ""}`;
}

// Verdict screen state: the payload survives refreshes; sort and filter are
// view state that must survive the 2-minute re-poll without snapping back.
let screenData = [];
let screenSort = { key: "score", dir: -1 };
let screenFilter = "ALL";
const SCREEN_GROUPS = { BUY: ["STRONG BUY", "BUY"], HOLD: ["HOLD"], SELL: ["SELL", "STRONG SELL"] };
const SCREEN_LABELS = { ALL: "All", BUY: "Buys", HOLD: "Holds", SELL: "Sells" };

function renderScreen() {
  const scr = $("screenCard");
  if (!screenData.length) {
    scr.hidden = true;
    return;
  }
  const counts = { ALL: screenData.length };
  for (const [g, vs] of Object.entries(SCREEN_GROUPS)) counts[g] = screenData.filter((r) => vs.includes(r.verdict)).length;
  const rows = (screenFilter === "ALL" ? [...screenData] : screenData.filter((r) => SCREEN_GROUPS[screenFilter].includes(r.verdict)))
    .sort((a, b) => (screenSort.key === "ticker"
      ? screenSort.dir * a.ticker.localeCompare(b.ticker)
      : screenSort.dir * ((a.score ?? 0) - (b.score ?? 0))));
  const arrow = (k) => (screenSort.key === k ? (screenSort.dir === -1 ? " ↓" : " ↑") : "");
  scr.innerHTML = `
    <h2>Verdict screen</h2>
    <p class="sub">${screenData.length} stocks ranked by the formula's latest score (logged ${esc(screenData[0].date)}) ·
      every call graded on the <a href="/ledger.html">track record</a> · not advice — the formula's own
      <a href="/evidence.html">backtests</a> showed no predictive edge.</p>
    <div class="screen-filters">
      ${["ALL", "BUY", "HOLD", "SELL"].map((g) =>
        `<button type="button" data-f="${g}" class="${screenFilter === g ? "active" : ""}">${SCREEN_LABELS[g]} · ${counts[g]}</button>`).join("")}
    </div>
    <div class="screen-scroll">
      <table class="mkt-table screen-table">
        <thead>
          <tr><th>#</th><th class="sortable" data-sort="ticker">Ticker${arrow("ticker")}</th><th class="num sortable" data-sort="score">Score${arrow("score")}</th><th>Verdict</th></tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr class="mkt-row" data-t="${esc(r.ticker)}">
              <td class="rank">${i + 1}</td>
              <td class="mkt-sym">${esc(r.ticker)} ${starBtn(r.ticker)}</td>
              <td class="num">${esc(fmtNum(r.score, 1) ?? "—")}</td>
              <td><span class="pill-sm ${verdictClass(r.verdict)}">${esc(r.verdict ?? "—")}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  scr.hidden = false;
}

// Filter chips and sortable headers live inside the same card as the rows;
// they have no data-t / .mkt-row, so the row-click delegation ignores them.
$("screenCard").addEventListener("click", (e) => {
  const f = e.target.closest?.("[data-f]")?.dataset?.f;
  if (f) {
    screenFilter = f;
    renderScreen();
    return;
  }
  const s = e.target.closest?.("th[data-sort]")?.dataset?.sort;
  if (s) {
    screenSort = { key: s, dir: screenSort.key === s ? -screenSort.dir : (s === "score" ? -1 : 1) };
    renderScreen();
  }
});

// Heat map tile color: intensity scales with |change|, capped at 3%, in the
// site's own desaturated green/red so it reads as data, not a carnival.
function heatStyle(dp) {
  if (!isNum(dp) || dp === 0) return "";
  const a = (Math.min(Math.abs(dp), 3) / 3) * 0.6 + 0.08;
  return dp > 0 ? `background: rgba(61, 156, 107, ${a.toFixed(2)})` : `background: rgba(191, 77, 77, ${a.toFixed(2)})`;
}

function renderHeat() {
  const card = $("heatCard");
  const rows = (moversData?.rows ?? []).filter((r) => isNum(r.changePercent));
  const sectors = moversData?.sectors;
  if (rows.length < 10 || !sectors || !Object.keys(sectors).length) {
    card.hidden = true;
    return;
  }
  // Cross-link: the formula's latest verdict as a dot on each tile, so the
  // map shows both what moved today and what the numbers say.
  const verdictOf = (t) => screenData.find((r) => r.ticker === t);
  const groups = new Map();
  for (const r of rows) {
    const s = sectors[r.ticker] ?? "Other";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(r);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const adv = rows.filter((r) => r.changePercent > 0).length;
  const dec = rows.filter((r) => r.changePercent < 0).length;
  const flat = rows.length - adv - dec;
  const avg = (list) => list.reduce((s, r) => s + r.changePercent, 0) / list.length;
  card.innerHTML = `
    <h2>Sector heat map</h2>
    <div class="breadth" title="Advancing vs declining across the universe">
      <div class="breadth-bar">
        <span class="breadth-adv" style="width:${((adv / rows.length) * 100).toFixed(1)}%"></span>
        <span class="breadth-flat" style="width:${((flat / rows.length) * 100).toFixed(1)}%"></span>
        <span class="breadth-dec" style="width:${((dec / rows.length) * 100).toFixed(1)}%"></span>
      </div>
      <div class="breadth-label"><span class="pos">${adv} advancing</span> · <span class="neg">${dec} declining</span>${flat ? ` · ${flat} flat` : ""}</div>
    </div>
    <div class="heat-grid">
      ${ordered.map(([sec, list]) => `
        <div class="heat-sector">
          <div class="heat-sector-label">${esc(sec)} <span class="${chgCls(avg(list))}">${esc(fmtPct(avg(list), true))}</span></div>
          <div class="heat-tiles">
            ${[...list].sort((a, b) => b.changePercent - a.changePercent).map((r) => `
              <button type="button" class="heat-tile mkt-row" data-t="${esc(r.ticker)}" style="${heatStyle(r.changePercent)}" title="${esc(r.ticker)}${verdictOf(r.ticker) ? ` · formula: ${verdictOf(r.ticker).verdict} ${verdictOf(r.ticker).score}/100` : ""}">
                ${verdictOf(r.ticker) ? `<span class="heat-dot ${verdictClass(verdictOf(r.ticker).verdict)}"></span>` : ""}
                <span class="heat-sym">${esc(r.ticker)}</span>
                <span class="heat-chg">${esc(fmtPct(r.changePercent, true))}</span>
              </button>`).join("")}
          </div>
        </div>`).join("")}
    </div>`;
  card.hidden = false;
}

let callitMounted = false;
let moversPoll = null;

// A cold server answers /api/movers progressively (partial: true while its
// budget-gated sweep runs) — keep re-polling until the map is complete.
async function loadMovers() {
  try {
    const res = await fetch("/api/movers");
    if (res.ok) renderMovers(await res.json());
  } catch {
    /* best-effort */
  }
}

function renderMovers(m) {
  moversData = m;
  clearTimeout(moversPoll);
  if (m.partial && !el.intro.hidden) moversPoll = setTimeout(loadMovers, 4000);
  const card = $("moversCard");
  const rows = (m.rows ?? []).filter((r) => isNum(r.changePercent));
  renderHeat();
  if (newsData) {
    renderHero();
    renderNewsCard(); // ticker tags need the quotes that just arrived
  }
  if (!readWatch().length) renderWatch(); // suggestions come from the movers
  // The game needs the universe list (for random picks) and a Tiingo key.
  const gameCard = $("callitCard");
  if (m.universe?.length && hasTiingo && window.mountCallIt) {
    if (!callitMounted) {
      window.mountCallIt($("callitMount"), { tickers: m.universe, compact: true });
      callitMounted = true;
    }
    gameCard.hidden = false;
  } else if (m.universe?.length && !callitMounted) {
    // Tease the game instead of vanishing — the Daily 5 is the best reason
    // to bother adding the free key.
    $("callitMount").innerHTML = `<p class="callit-msg">The Daily 5 — five mystery stocks a day, same five for everyone,
      you versus the formula — needs a free <a href="https://www.tiingo.com" target="_blank" rel="noopener noreferrer">Tiingo</a> key.
      Add it and today's five unlock.</p>`;
    gameCard.hidden = false;
  } else if (!callitMounted) {
    gameCard.hidden = true;
  }
  if (rows.length < 10) {
    card.hidden = true;
    return;
  }
  const sorted = [...rows].sort((a, b) => b.changePercent - a.changePercent);
  const cols = [
    ["Gainers", sorted.slice(0, 5)],
    ["Losers", sorted.slice(-5).reverse()],
  ];
  card.innerHTML = `
    <h2>Movers</h2>
    <div class="movers-cols">
      ${cols.map(([label, list]) => `
        <div>
          <div class="movers-label">${label}</div>
          <table class="mkt-table">
            ${list.map((r) => `
              <tr class="mkt-row" data-t="${esc(r.ticker)}">
                <td class="mkt-sym">${esc(r.ticker)}</td>
                <td class="num">${esc(fmtPrice(r.price) ?? "—")}</td>
                <td class="num"><span class="badge ${chgCls(r.changePercent)}">${esc(fmtPct(r.changePercent, true) ?? "—")}</span></td>
              </tr>`).join("")}
          </table>
        </div>`).join("")}
    </div>`;
  card.hidden = false;
}

function renderRecord(s) {
  const card = $("recordCard");
  if (!s || s.empty || !s.calls) {
    card.hidden = true;
    return;
  }
  const exc = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${fmtNum(v, 1)}% vs SPY` : "—");
  // The server only reports a hit rate once enough calls are 30+ days old —
  // until then the honest label is "too early", not a green number.
  const tiles = [
    ["Calls logged", String(s.calls), ""],
    ["Days running", String(s.days), ""],
    ["Graded so far", String(s.graded), ""],
    ["Beat the S&P (30d+ calls)", isNum(s.beatPct) ? `${fmtNum(s.beatPct, 0)}%` : "too early", isNum(s.beatPct) && s.beatPct >= 53 ? "pos" : ""],
    s.best && s.graded >= 5 ? ["Best aged call", `${esc(s.best.ticker)} ${exc(s.best.excessPct)}`, s.best.excessPct > 0 ? "pos" : ""] : null,
    s.worst && s.graded >= 5 ? ["Worst aged call", `${esc(s.worst.ticker)} ${exc(s.worst.excessPct)}`, ""] : null,
  ].filter(Boolean);
  card.innerHTML = `
    <h2>The forward test</h2>
    <p class="sub">Every call frozen and graded vs the S&amp;P, wins and losses alike — <a href="/ledger.html">full ledger</a>.
      Young calls read like a coin flip; that matches the <a href="/evidence.html">backtests</a>.</p>
    <div class="mkt-strip record-strip">
      ${tiles.map(([label, val, cls]) => `
        <div class="mkt-tile">
          <div class="mkt-label">${label}</div>
          <div class="mkt-price record-val ${cls}">${val}</div>
        </div>`).join("")}
    </div>`;
  card.hidden = false;
}

// Curated past dates worth exploring — each one runs the point-in-time
// engine: only that day's filings and prices, graded against everything
// since. Needs a Tiingo key, so the row hides without one.
const MOMENTS = [
  ["NVDA", "2023-01-03", "NVDA on the eve of the AI boom"],
  ["META", "2022-11-04", "Meta at the 2022 bottom"],
  ["TSLA", "2020-01-02", "Tesla before the 2020 run"],
  ["AMD", "2016-01-04", "AMD left for dead"],
  ["GME", "2021-01-04", "GameStop, the month of the squeeze"],
  ["BA", "2019-03-01", "Boeing days before the second MAX crash"],
];

function renderMoments() {
  const card = $("momentsCard");
  if (!hasTiingo) {
    card.hidden = true;
    return;
  }
  card.innerHTML = `
    <h2>Time machine moments</h2>
    <p class="sub">Only what was filed and priced by that day — then graded against everything since.</p>
    <div class="intro-chips">
      ${MOMENTS.map(([t, d, label]) =>
        `<button type="button" class="tm-chip" data-t="${esc(t)}" data-d="${esc(d)}">${esc(label)}</button>`).join("")}
    </div>`;
  card.hidden = false;
}

$("momentsCard").addEventListener("click", (e) => {
  const t = e.target?.dataset?.t;
  const d = e.target?.dataset?.d;
  if (t && d) {
    el.input.value = t;
    el.dateInput.value = d;
    timeMachine(t, d);
  }
});

// "Learn as you look": one concept a day (rotates deterministically by
// date so everyone sees the same one), tied to a live example, plus the
// lessons most worth reading first.
function renderLearn() {
  const card = $("learnCard");
  const terms = window.TERMS ?? {};
  const keys = Object.keys(terms);
  if (!keys.length) {
    card.hidden = true;
    return;
  }
  const dayIndex = Math.floor(Date.now() / 86_400_000) % keys.length;
  const key = keys[dayIndex];
  const t = terms[key];
  const featured = [
    ["l-verdict", "How to read a verdict"],
    ["l-pit", "Look-ahead bias: the mistake that makes fake edges"],
    ["l-backtest", "What this site found when it tested itself"],
    ["l-checklist", "How to use this site without fooling yourself"],
  ];
  card.innerHTML = `
    <h2>Learn</h2>
    <div class="learn-cols stack">
      <div class="learn-concept">
        <div class="mkt-label">Today's concept</div>
        <div class="learn-name">${esc(t.name)}</div>
        <p>${esc(t.what)}</p>
        <p class="learn-caveat"><b>What it can't tell you:</b> ${esc(t.caveat)}</p>
        <p class="learn-live">${t.live ? `<a href="#" data-t="${esc(t.live)}">See it on ${esc(t.live)} →</a> ` : ""}<a href="/learn.html#term-${esc(key)}">Full definition →</a></p>
      </div>
      <div class="learn-featured">
        <div class="mkt-label">Start here</div>
        <ol class="learn-list">
          ${featured.map(([id, title]) => `<li><a href="/learn.html#${id}">${esc(title)}</a></li>`).join("")}
        </ol>
      </div>
    </div>`;
  card.hidden = false;
}

$("learnCard").addEventListener("click", (e) => {
  const t = e.target?.dataset?.t;
  if (t) {
    e.preventDefault();
    go(t);
  }
});

async function loadMarket() {
  renderToday();
  renderRecent();
  renderMoments();
  renderLearn();
  renderWatch();
  loadWatchQuotes();
  const grab = async (url, render) => {
    try {
      const res = await fetch(url);
      if (res.ok) render(await res.json());
    } catch {
      /* each landing block is independent garnish — the search bar always works */
    }
  };
  await Promise.allSettled([
    grab("/api/market", renderMarket),
    loadMovers(),
    grab("/api/homestats", renderRecord),
  ]);
}

for (const id of ["screenCard", "moversCard", "heatCard", "marketNews", "heroLead", "watchCard"]) {
  $(id).addEventListener("click", (e) => {
    const t = e.target.closest?.(".mkt-row")?.dataset?.t;
    if (t) {
      el.dateInput.value = "";
      go(t);
    }
  });
}

// Keep the landing data fresh while it's on screen. The server caches the
// payload for 2 minutes, so this polling costs nothing extra upstream.
setInterval(() => {
  if (!el.intro.hidden) loadMarket();
}, 120_000);

window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (t) analyze(t);
  else showHome(); // browser back from #TICKER lands on the market overview
});

// ---------- recently viewed ----------

const RECENT_KEY = "cc_recent";

function readRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(a) ? a.filter((t) => typeof t === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(t) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...readRecent().filter((x) => x !== t)].slice(0, 8)));
  } catch {
    /* storage blocked (private mode) — recents just don't persist */
  }
}

function renderRecent() {
  const row = $("recentRow");
  const a = readRecent();
  if (!a.length) {
    row.hidden = true;
    return;
  }
  row.innerHTML = `<span class="recent-label">Recent</span>`
    + a.map((t) => `<button type="button" data-t="${esc(t)}">${esc(t)}</button>`).join("")
    + `<button type="button" class="recent-clear" data-clear="1">clear</button>`;
  row.hidden = false;
}

$("recentRow").addEventListener("click", (e) => {
  if (e.target?.dataset?.clear) {
    try { localStorage.removeItem(RECENT_KEY); } catch { /* already gone */ }
    renderRecent();
    return;
  }
  const t = e.target?.dataset?.t;
  if (t) go(t);
});

// ---------- search typeahead ----------

// Company-name-to-ticker as you type: debounced against /api/search (which
// has its own 1-hour server cache), best-effort, keyboard-first. Keyless
// installs skip it — search needs a Finnhub key.
const ta = $("typeahead");
let taSeq = 0;
let taTimer = null;
let taItems = [];
let taActive = -1;

function taClose() {
  ta.hidden = true;
  taItems = [];
  taActive = -1;
}

function taRender() {
  ta.innerHTML = taItems.map((r, i) =>
    `<button type="button" data-i="${i}" class="${i === taActive ? "active" : ""}"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span></button>`).join("");
  ta.hidden = !taItems.length;
}

el.input.addEventListener("input", () => {
  const q = el.input.value.trim();
  clearTimeout(taTimer);
  if (!hasKey || q.length < 2) {
    taClose();
    return;
  }
  taTimer = setTimeout(async () => {
    const seq = ++taSeq;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const { results } = await res.json();
      if (seq !== taSeq || document.activeElement !== el.input) return;
      taItems = (results ?? []).slice(0, 6);
      taActive = -1;
      taRender();
    } catch {
      /* typeahead is best-effort — plain submit still works */
    }
  }, 250);
});

el.input.addEventListener("keydown", (e) => {
  if (ta.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const d = e.key === "ArrowDown" ? 1 : -1;
    taActive = (taActive + d + taItems.length) % taItems.length;
    taRender();
  } else if (e.key === "Enter") {
    if (taActive >= 0) {
      e.preventDefault();
      const t = taItems[taActive].symbol;
      taClose();
      go(t);
    } else {
      taClose(); // fall through to the normal form submit
    }
  } else if (e.key === "Escape") {
    taClose();
  }
});

// mousedown (not click) so the pick lands before the input's blur closes us.
ta.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const b = e.target.closest("button");
  if (!b) return;
  const t = taItems[Number(b.dataset.i)]?.symbol;
  taClose();
  if (t) go(t);
});

el.input.addEventListener("blur", () => setTimeout(taClose, 120));
el.form.addEventListener("submit", taClose);

// ---------- first-run setup ----------

let hasKey = true; // optimistic until /api/health says otherwise
let hasTiingo = false; // pessimistic — gates the time-machine moments row

async function checkSetup() {
  try {
    const res = await fetch("/api/health");
    const h = await res.json();
    hasKey = Boolean(h.hasKey);
    hasTiingo = Boolean(h.hasTiingo);
    el.setup.hidden = hasKey;
    renderMoments(); // flags arrived after the first landing render
    // The intro time-machine chip needs Tiingo — a keyless friend clicking
    // it got a bare error page. Hide it until the key exists.
    document.querySelectorAll("#introChips .tm-chip").forEach((b) => { b.hidden = !hasTiingo; });
  } catch {
    /* server unreachable — the analyze path will surface it */
  }
}

$("setupSaveBtn").addEventListener("click", async () => {
  const errEl = $("setupError");
  errEl.hidden = true;
  const btn = $("setupSaveBtn");
  btn.disabled = true;
  btn.textContent = "Validating with Finnhub…";
  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        finnhubKey: $("setupFinnhub").value,
        tiingoKey: $("setupTiingo").value,
        contact: $("setupContact").value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Setup failed.");
    btn.textContent = "✓ Saved — you're live";
    // Reload so every key-gated surface (indices, movers, heat map, Daily 5,
    // moments) comes alive at once — without this the page looked dead for
    // up to two minutes after a successful setup.
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = "Validate & save";
  }
});

checkSetup();

$("setupDemoBtn")?.addEventListener("click", () => go("DEMO"));

// Deep link: /#AAPL analyzes on load; otherwise land on the market overview.
if (location.hash.length > 1) analyze(location.hash.slice(1));
else {
  el.input.focus();
  loadMarket();
}
