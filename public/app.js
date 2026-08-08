"use strict";

// All external strings (news headlines, company names, …) pass through esc()
// before touching innerHTML — RSS content is untrusted.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  company: $("companyCard"),
  history: $("historyCard"),
  verdict: $("verdictCard"),
  keyNumbers: $("keyNumbersCard"),
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

function setLoading(ticker) {
  stopLive();
  el.intro.hidden = true;
  el.results.hidden = true;
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
  if (score >= 58) return "good";
  if (score >= 42) return "warning";
  if (score >= 28) return "serious";
  return "critical";
}

function renderCompany(d) {
  const p = d.profile ?? {};
  const q = d.quote;
  const currency = p.currency || "USD";
  const metaBits = [d.ticker, p.exchange, p.industry].filter(Boolean).map(esc).join(" · ");
  const factBits = [
    p.marketCap != null ? `Market cap ${fmtMarketCap(p.marketCap)}` : null,
    p.ipo ? `IPO ${esc(p.ipo)}` : null,
    p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(p.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : null,
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
    : `Weighted average of the ${s.availableCount} categories with data${missing ? ` (${missing} missing — weights renormalized)` : ""}. Bands: ≥72 STRONG BUY · ≥58 BUY · ≥42 HOLD · ≥28 SELL · <28 STRONG SELL.`;

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
  const tiles = [
    ["P/E (TTM)", fmtX(m.pe), "pe"],
    ["P/S", fmtX(m.ps), "ps"],
    ["P/B", fmtX(m.pb)],
    ["PEG", fmtX(m.peg)],
    ["Net margin", fmtPct(m.netMargin), "netMargin"],
    ["ROE", fmtPct(m.roe), "roe"],
    ["ROA", fmtPct(m.roa)],
    ["Revenue growth YoY", fmtPct(m.revenueGrowth, true), "revenueGrowth"],
    ["EPS growth YoY", fmtPct(m.epsGrowth, true), "epsGrowth"],
    ["Current ratio", fmtNum(m.currentRatio), "currentRatio"],
    ["Debt / equity", fmtNum(m.debtEquity), "debtEquity"],
    ["Dividend yield", fmtPct(m.dividendYield)],
    ["Beta", fmtNum(m.beta)],
    ["52-week high", fmtMoney(m.high52)],
    ["52-week low", fmtMoney(m.low52)],
  ];
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
      ${tiles.map(([label, val, key]) => `
        <div class="kn-tile">
          <div class="kn-label">${esc(label)}${provMark(key)}</div>
          <div class="kn-value${val == null ? " na" : ""}">${val == null ? "N/A" : esc(val)}</div>
        </div>`).join("")}
    </div>`;
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
    </div>`;
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
  el.analyst.innerHTML = `
    <h2>Analyst ratings</h2>
    <p class="sub">${a.total} analysts · ${esc(String(a.period ?? "").slice(0, 7))}</p>
    <div class="an-bar">${bar}</div>
    <div class="an-legend">${legend}</div>`;
}

function renderEarnings(d) {
  const rows = d.earnings ?? [];
  if (!rows.length) {
    el.earnings.innerHTML = `<h2>Earnings — last 4 quarters</h2><p class="sub">No earnings history available.</p>`;
    return;
  }
  el.earnings.innerHTML = `
    <h2>Earnings — last 4 quarters</h2>
    <p class="sub">Reported EPS vs analyst estimate.</p>
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

function renderPeers(d) {
  const peers = d.peers ?? [];
  if (!peers.length) {
    el.peers.innerHTML = `<h2>Peers</h2><p class="sub">No peer list available.</p>`;
    return;
  }
  el.peers.innerHTML = `
    <h2>Peers</h2>
    <p class="sub">Companies Finnhub groups with ${esc(d.ticker)} — click one to analyze it.</p>
    <div class="peer-list">
      ${peers.map((p) => `<button class="peer-chip" data-t="${esc(p)}">${esc(p)}</button>`).join("")}
    </div>`;
  el.peers.querySelectorAll(".peer-chip").forEach((b) => b.addEventListener("click", () => go(b.dataset.t)));
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
          <a class="news-headline" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>
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
  L.push(`Generated ${new Date(d.asOf).toLocaleString("en-US")} by a personal stock-analyzer app (sources: Finnhub API; news merged from Google News RSS, Yahoo Finance RSS, Finnhub). Data may be delayed, incomplete, or wrong. Research/education only — not financial advice.`);
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
    L.push(`- Bands: >=72 STRONG BUY, >=58 BUY, >=42 HOLD, >=28 SELL, <28 STRONG SELL. Weights renormalize over categories with data.`);
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

let lastPayload = null;

function render(d) {
  lastPayload = d;
  el.status.hidden = true;
  el.btn.disabled = false;
  el.demoNote.hidden = !d.demo;

  if (d.warnings?.length) {
    el.warnings.textContent = `Partial data — some sources failed: ${d.warnings.join("; ")}`;
    el.warnings.hidden = false;
  }

  // Unhide before rendering: the chart measures its container's width.
  el.results.hidden = false;
  renderCompany(d);
  renderHistory(d);
  renderVerdict(d);
  renderKeyNumbers(d);
  renderRange(d);
  renderAnalyst(d);
  renderEarnings(d);
  renderPeers(d);
  renderNews(d);
  startLive(d);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- fetch & routing ----------

let inFlight = null;

// Company-name fallback: when the input isn't a ticker (or the ticker isn't
// found), search by name and offer clickable matches instead of a dead end.
async function suggestFor(query, contextMsg) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const { results } = await res.json();
    el.status.hidden = true;
    el.btn.disabled = false;
    if (!results?.length) {
      setError(contextMsg ?? `Nothing found for "${query}".`);
      return;
    }
    setError(contextMsg ?? `No exact ticker "${query}" — did you mean:`);
    el.suggest.innerHTML = results
      .map((r) => `<button type="button" data-t="${esc(r.symbol)}">${esc(r.symbol)}<span>${esc(r.name)}</span></button>`)
      .join("");
    el.suggest.hidden = false;
    el.suggest.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.t)));
  } catch {
    setError(contextMsg ?? `Nothing found for "${query}".`);
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
  try {
    const res = await fetch(`/api/analyze?ticker=${encodeURIComponent(ticker)}`, { signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      if (res.status === 404) {
        await suggestFor(ticker, `No data for "${ticker}" — closest matches:`);
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
  if (location.hash.slice(1) === t) analyze(t);
  else location.hash = t; // hashchange handler runs analyze
}

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = el.input.value.trim();
  if (!raw) return;
  // A ticker goes straight through; anything else ("apple", "berkshire
  // hathaway") becomes a name search.
  if (/^[A-Za-z0-9.\-^]{1,10}$/.test(raw)) go(raw);
  else {
    setLoading(raw);
    suggestFor(raw, `Searching for "${raw}"…`).then(() => {
      if (!el.suggest.hidden) el.error.textContent = `Matches for "${raw}":`;
    });
  }
});

$("copyBriefBtn").addEventListener("click", copyBrief);

$("introChips").addEventListener("click", (e) => {
  const t = e.target?.dataset?.t;
  if (t) go(t);
});

$("brandLink").addEventListener("click", (e) => {
  e.preventDefault();
  stopLive();
  history.replaceState(null, "", location.pathname);
  el.results.hidden = true;
  el.error.hidden = true;
  el.demoNote.hidden = true;
  el.warnings.hidden = true;
  el.status.hidden = true;
  el.intro.hidden = false;
  el.input.value = "";
  el.input.focus();
});

window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (t) analyze(t);
});

// ---------- first-run setup ----------

let hasKey = true; // optimistic until /api/health says otherwise

async function checkSetup() {
  try {
    const res = await fetch("/api/health");
    const h = await res.json();
    hasKey = Boolean(h.hasKey);
    el.setup.hidden = hasKey;
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
    hasKey = true;
    setTimeout(() => {
      el.setup.hidden = true;
      el.input.focus();
    }, 900);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = "Validate & save";
  }
});

checkSetup();

// Deep link: /#AAPL analyzes on load.
if (location.hash.length > 1) analyze(location.hash.slice(1));
else el.input.focus();
