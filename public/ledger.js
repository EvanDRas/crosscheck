"use strict";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const pillClass = (v) =>
  ({ "STRONG BUY": "v-strongbuy", BUY: "v-buy", HOLD: "v-hold", SELL: "v-sell", "STRONG SELL": "v-strongsell" }[v] ?? "");

const money = (v) => (isNum(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—");

// The server declares the current formula era; guessing it from entry
// contents made a v1-only ledger call v1 "current" and contradict the
// server-built (v2-filtered) aggregates on the same page.
const currentEra = (data) => data.currentEra ?? (data.entries.some((e) => e.formulaVersion === "v2") ? "v2" : "v1");

function pct(v, digits = 2) {
  if (!isNum(v)) return null;
  const x = v * 100;
  return `${x > 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

function deltaCell(v) {
  if (!isNum(v)) return `<span class="delta-flat">—</span>`;
  const cls = v > 0.0001 ? "delta-up" : v < -0.0001 ? "delta-down" : "delta-flat";
  const arrow = v > 0.0001 ? "▲ " : v < -0.0001 ? "▼ " : "";
  return `<span class="${cls}">${arrow}${pct(v)}</span>`;
}

function renderSummary(data) {
  // Same hygiene as the aggregates AND the homepage tiles: current-era,
  // aged, total-return-graded rows only — one definition of "graded"
  // everywhere, or the site contradicts itself about its headline number.
  const era = currentEra(data);
  const graded = data.entries.filter((e) => (e.formulaVersion ?? "v1") === era && e.excess != null && e.ageDays > 0 && e.basis === "tr");
  const dates = data.entries.map((e) => e.date).sort();
  const avgExcess = graded.length ? graded.reduce((a, e) => a + e.excess, 0) / graded.length : null;
  // Direction-aware: a buy is right when its stock beat SPY, a sell is
  // right when it trailed. A plain "beat SPY" count scored wrong sells as
  // wins. HOLDs abstain from the accuracy stat.
  const isBuy = (v) => /BUY/.test(v ?? "");
  const isSell = (v) => /SELL/.test(v ?? "");
  const called = graded.filter((e) => isBuy(e.verdict) || isSell(e.verdict));
  const right = called.filter((e) => (isBuy(e.verdict) ? e.excess > 0 : e.excess < 0)).length;
  const eraCounts = {};
  for (const e of data.entries) {
    const v = e.formulaVersion ?? "v1";
    eraCounts[v] = (eraCounts[v] ?? 0) + 1;
  }
  const eras = Object.entries(eraCounts).map(([v, n]) => `${v} ×${n}`).join(" · ");
  const tiles = [
    ["Calls logged", String(data.entries.length)],
    ["First call", dates[0] ?? "—"],
    ["Graded (current era, aged, TR)", String(graded.length)],
    ["Avg vs SPY (same graded set)", graded.length ? pct(avgExcess) : "—"],
    ["Right on direction", called.length ? `${right} of ${called.length}` : "—"],
    ["Formula eras", eras || "—"],
  ];
  const thru = data.entries.reduce((m, e) => (e.gradedThrough && e.gradedThrough > (m ?? "") ? e.gradedThrough : m), null);
  const rp = called.length ? (right / called.length) * 100 : null;
  // Both sides parse as UTC midnights of ET market days, so the span rolls
  // at the day boundary — Date.now() on the left made it roll at 8 AM ET.
  const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const daysRunning = dates.length ? Math.max(1, Math.round((Date.parse(todayEt) - Date.parse(dates[0])) / 86_400_000)) : 0;
  // The reading scales with the sample: a coin flip lands within
  // ±1.96·√(.25/n) of 50%, so the words say "noise" or "signal" by the same
  // rule the homepage tile uses to color itself — never fixed thresholds
  // that flatter small samples and shrug off large ones.
  const band = called.length ? 196 * Math.sqrt(0.25 / called.length) : 0;
  // When the rate leaves the band, name WHICH side is doing it — "the
  // formula is losing" invites the question, so answer it in the same line.
  const sideBreakdown = () => {
    const buys = called.filter((e) => isBuy(e.verdict));
    const sells = called.filter((e) => isSell(e.verdict));
    if (buys.length < 10 || sells.length < 10) return "";
    const bPct = Math.round((buys.filter((e) => e.excess > 0).length / buys.length) * 100);
    const sPct = Math.round((sells.filter((e) => e.excess < 0).length / sells.length) * 100);
    return ` (buys ${bPct}% right of ${buys.length}, sells ${sPct}% of ${sells.length})`;
  };
  const read = called.length < 20 ? "too few aged directional calls to judge yet"
    : rp - 50 > band ? `better than a coin flip and outside the ±${Math.round(band)}-point noise band for this sample${sideBreakdown()} — but these calls overlap in time and share one market backdrop, so it only counts if it holds for months`
    : 50 - rp > band ? `worse than a coin flip and outside the ±${Math.round(band)}-point noise band for this sample${sideBreakdown()} — the backtests predicted a coin flip, and honesty cuts both ways: right now the formula is losing on direction`
    : "within the noise band of a coin flip, which is exactly what the backtests predicted";
  const headline = graded.length
    ? `<p class="sub"><b>The story so far:</b> after ${data.entries.length} calls over ${daysRunning} days, the formula is right on
       direction ${called.length ? `${Math.round(rp)}% of the time (${right} of ${called.length})` : "— (no directional calls aged yet — HOLDs abstain)"} and its average
       graded call sits ${pct(avgExcess)} vs the market — ${read}.</p>`
    : "";
  $("summaryCard").innerHTML = `
    <h2>Summary</h2>
    ${headline}
    <p class="sub">${data.source === "official" ? `<b>Official forward test</b> — the project's published call log (formula
    output only), which this installation grades itself with its own keys. Your personal picks above stay
    local; run <code>npm run batch</code> to build a local formula ledger instead. ` : ""}Graded ${new Date(data.asOf).toLocaleString("en-US")}${thru ? `, prices through the ${thru} close` : ""}. Total-return grading: split- and
    dividend-adjusted closes (call date &rarr; latest), SPY measured the same way over the same window.
    SPY is an S&amp;P 500 index fund — shorthand for "the market." Costs excluded.
    Terms: <b>excess</b> = the call's return minus SPY's over the same window (positive = beat the market) ·
    <b>right on direction</b> = buys whose stock beat SPY plus sells whose stock trailed it (HOLDs abstain) ·
    <b>aged</b> = at least one trading session old · <b>TR</b> = total return, dividends and splits included ·
    <b>eras</b> = formula versions (calls are only compared within their own era).</p>
    <div class="kn-grid">
      ${tiles.map(([l, v]) => `<div class="kn-tile"><div class="kn-label">${esc(l)}</div><div class="kn-value">${esc(v)}</div></div>`).join("")}
    </div>`;
}

function renderAggregates(data) {
  if (!data.aggregates.length) {
    $("aggCard").innerHTML = `<h2>By verdict</h2><p class="sub">Nothing graded yet — come back once calls have some age (and a live quote).</p>`;
    return;
  }
  $("aggCard").innerHTML = `
    <h2>By verdict</h2>
    <p class="sub">The test the formula has to pass over time: buys above SPY, sells below.
    "Right" is direction-aware — for sell bands it means the stock <i>trailed</i> SPY.
    Current formula era only; aged, total-return-graded rows only.</p>
    <div class="ledger-table-wrap">
      <table class="ledger-table">
        <thead><tr>
          <th>Verdict</th><th class="num">Calls</th><th class="num">Avg return</th>
          <th class="num">Avg vs SPY</th><th class="num">Beat SPY</th><th class="num">Right</th>
        </tr></thead>
        <tbody>
          ${data.aggregates.map((a) => {
            const buy = /BUY/.test(a.verdict);
            const sell = /SELL/.test(a.verdict);
            const rightPct = buy ? a.winRateVsSpy : sell ? 1 - a.winRateVsSpy : null;
            return `
            <tr>
              <td><span class="pill-sm ${pillClass(a.verdict)}">${esc(a.verdict)}</span></td>
              <td class="num">${a.n}</td>
              <td class="num">${deltaCell(a.avgReturn)}</td>
              <td class="num">${deltaCell(a.avgExcess)}</td>
              <td class="num">${Math.round(a.winRateVsSpy * 100)}%</td>
              <td class="num">${rightPct == null ? "—" : `${Math.round(rightPct * 100)}%`}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderCalls(data, showAll = false) {
  const era = currentEra(data);
  const CAP = 100;
  const visible = showAll ? data.entries : data.entries.slice(0, CAP);
  const anyRaw = data.entries.some((e) => e.basis === "raw");
  const anyFrozen = data.entries.some((e) => e.frozen);
  const notes = [];
  if (anyRaw) notes.push("* graded from raw live quotes (ticker outside the local panel) — not split/dividend-adjusted.");
  if (anyFrozen) notes.push("† price series stopped updating (left the index); graded through its last close, SPY over the same window.");
  notes.push("Returns run from the call date's split/dividend-adjusted close to the latest adjusted close, so they won't match arithmetic on the Price then column — especially across splits.");
  $("callsCard").innerHTML = `
    <h2>All calls — newest first</h2>
    <p class="sub">Each row froze the moment it was logged; only the "now" columns move.
      <button type="button" id="ledgerCsvBtn" class="linklike">Download graded CSV</button></p>
    ${notes.length ? `<p class="sub">${esc(notes.join(" "))}</p>` : ""}
    <div class="ledger-table-wrap">
      <table class="ledger-table">
        <thead><tr>
          <th>Date</th><th>Ticker</th><th>Verdict</th><th class="num">Score</th>
          <th>Near-term</th><th>Long-term</th>
          <th class="num">Price then</th><th class="num">Latest close</th>
          <th class="num">Return</th><th class="num">vs SPY</th><th class="num">Age</th>
        </tr></thead>
        <tbody>
          ${visible.map((e) => `
            <tr>
              <td>${esc(e.date)}${(e.formulaVersion ?? "v1") !== era ? ` <span class="era-tag">${esc(e.formulaVersion ?? "v1")}</span>` : ""}</td>
              <td><a href="/#${esc(e.ticker)}">${esc(e.ticker)}</a></td>
              <td><span class="pill-sm ${pillClass(e.verdict)}">${esc(e.verdict)}</span></td>
              <td class="num">${isNum(e.score) ? (e.score % 1 === 0 ? e.score : e.score.toFixed(1)) : "—"}</td>
              <td>${e.ntVerdict ? `<span class="pill-sm ${pillClass(e.ntVerdict)}">${esc(e.ntVerdict)}</span>` : "—"}</td>
              <td>${e.ltVerdict ? `<span class="pill-sm ${pillClass(e.ltVerdict)}">${esc(e.ltVerdict)}</span>` : "—"}</td>
              <td class="num">${money(e.price)}</td>
              <td class="num">${money(e.nowPrice)}${e.basis === "raw" ? "*" : ""}${e.frozen ? "†" : ""}</td>
              <td class="num">${deltaCell(e.ret)}</td>
              <td class="num">${deltaCell(e.excess)}</td>
              <td class="num">${e.ageDays === 0 ? "today" : `${e.ageDays}d`}</td>
            </tr>`).join("")}
          ${!showAll && data.entries.length > CAP ? `<tr><td colspan="11" style="text-align:center; padding:10px"><button type="button" id="showAllCalls" class="linklike">Show all ${data.entries.length} calls</button></td></tr>` : ""}
        </tbody>
      </table>
    </div>`;
  document.getElementById("showAllCalls")?.addEventListener("click", () => renderCalls(data, true));
  // The graded rows, raw — the same open-data promise as the published log,
  // but with this install's own grading attached.
  document.getElementById("ledgerCsvBtn")?.addEventListener("click", () => {
    const f = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? (v * 100).toFixed(d) : "");
    const csv = ["date,ticker,verdict,score,near_term,long_term,price_then,latest_close,return_pct,vs_spy_pct,age_days,basis,formula_version",
      ...data.entries.map((e) => [e.date, e.ticker, e.verdict, e.score ?? "", e.ntVerdict ?? "", e.ltVerdict ?? "",
        e.price ?? "", e.nowPrice ?? "", f(e.ret), f(e.excess), e.ageDays ?? "", e.basis ?? "", e.formulaVersion ?? "v1"].join(","))].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `crosscheck-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function renderMyPicks(data) {
  const card = $("myPicksCard");
  if (!data.entries.length) {
    card.innerHTML = `
      <h2>Your calls</h2>
      <p class="sub" style="margin-bottom:0">None logged yet. On any analysis page, hit
      <b>I'd buy / I'd pass / I'd sell</b> under the verdict — your call freezes at that
      moment's price and gets graded here against SPY. Your real accuracy, measured,
      instead of remembered.</p>`;
    return;
  }
  const s = data.summary;
  const acc = s ? `${s.correct} of ${s.graded} right (${Math.round(s.accuracy * 100)}%)${s.rawGraded ? ` — ${s.rawGraded} graded price-only*` : ""}` : "— (calls need at least a day of age)";
  const dirLabel = { buy: "BUY", avoid: "PASS", sell: "SELL" };
  const dirClass = { buy: "v-buy", avoid: "v-hold", sell: "v-sell" };
  card.innerHTML = `
    <h2>Your calls</h2>
    <p class="sub">A buy is right if it beat SPY; a pass/sell is right if the stock trailed SPY.
    Accuracy so far: <b>${esc(acc)}</b>. For calibration: a coin flip scores ~50%.</p>
    <div class="ledger-table-wrap">
      <table class="ledger-table">
        <thead><tr>
          <th>Date</th><th>Ticker</th><th>Your call</th><th>Note</th>
          <th class="num">Price then</th><th class="num">Latest close</th>
          <th class="num">Return</th><th class="num">vs SPY</th><th>Right?</th>
        </tr></thead>
        <tbody>
          ${data.entries.map((e) => {
            // A dead-even excess is a tie, not a miss — the accuracy stat
            // excludes it, so the row's mark must agree.
            const graded = e.excess != null && e.ageDays > 0 && Math.abs(e.excess) > 1e-9;
            const right = !graded ? "—" : (e.direction === "buy" ? e.excess > 0 : e.excess < 0) ? "✓" : "✗";
            return `
            <tr>
              <td>${esc(e.date)}</td>
              <td><a href="/#${esc(e.ticker)}">${esc(e.ticker)}</a></td>
              <td><span class="pill-sm ${dirClass[e.direction] ?? ""}">${esc(dirLabel[e.direction] ?? e.direction)}</span></td>
              <td class="pick-note">${esc(e.note ?? "")}</td>
              <td class="num">${money(e.price)}</td>
              <td class="num">${money(e.nowPrice)}${e.basis === "raw" ? "*" : ""}</td>
              <td class="num">${deltaCell(e.ret)}</td>
              <td class="num">${deltaCell(e.excess)}</td>
              <td>${right}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${data.entries.some((e) => e.basis === "raw") ? `<p class="sub">* graded price-only (no split/dividend adjustment) — a split can distort these rows; add a free Tiingo key for adjusted grading.</p>` : ""}`;
}

// The outcome DISTRIBUTION: every graded call's excess return in 2-point
// bins. Means hide the spread, and the spread is the honesty — one fat tail
// can pay for (or destroy) a whole strategy, and a histogram is the only
// chart that shows it.
function renderDistribution(data) {
  const card = $("distCard");
  const era = currentEra(data);
  const xs = data.entries
    .filter((e) => (e.formulaVersion ?? "v1") === era && e.excess != null && e.ageDays > 0 && e.basis === "tr")
    .map((e) => e.excess * 100);
  if (xs.length < 30) { card.hidden = true; return; }
  const BIN = 2, LIM = 20; // percent
  const bins = new Map(); // lower edge -> count
  let clippedLo = 0, clippedHi = 0;
  for (const x of xs) {
    if (x < -LIM) { clippedLo++; continue; }
    if (x >= LIM) { clippedHi++; continue; }
    const lo = Math.floor(x / BIN) * BIN;
    bins.set(lo, (bins.get(lo) ?? 0) + 1);
  }
  const edges = [];
  for (let b = -LIM; b < LIM; b += BIN) edges.push(b);
  const maxN = Math.max(...edges.map((b) => bins.get(b) ?? 0), clippedLo, clippedHi, 1);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const W = 720, H = 170, pad = { l: 10, r: 10, t: 14, b: 24 };
  const cols = edges.length + 2; // + one clipped bucket each side
  const bw = (W - pad.l - pad.r) / cols;
  const Xi = (i) => pad.l + i * bw;
  const Yh = (n) => (n / maxN) * (H - pad.t - pad.b);
  const bar = (i, n, lo, label) => n === 0 ? "" : `<rect class="dist-bar ${lo != null ? (lo >= 0 ? "pos" : "neg") : "clip"}"
      x="${(Xi(i) + 1).toFixed(1)}" y="${(H - pad.b - Yh(n)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Yh(n).toFixed(1)}">
      <title>${label}: ${n} call${n === 1 ? "" : "s"}</title></rect>`;
  const bars = [
    bar(0, clippedLo, null, `worse than −${LIM}%`),
    ...edges.map((lo, i) => bar(i + 1, bins.get(lo) ?? 0, lo, `${lo >= 0 ? "+" : ""}${lo}% to ${lo + BIN >= 0 ? "+" : ""}${lo + BIN}%`)),
    bar(cols - 1, clippedHi, null, `better than +${LIM}%`),
  ].join("");
  const zeroX = Xi(1 + LIM / BIN); // left edge of the 0..+2 bin = the zero line
  const meanX = Xi(1 + (Math.max(-LIM, Math.min(LIM, mean)) + LIM) / BIN);
  card.innerHTML = `
    <h2>Outcome distribution</h2>
    <p class="sub">Every aged, total-return-graded call's excess vs SPY, in 2-point bins — the spread the averages hide.
      Mean ${pct(mean / 100)} · median ${pct(median / 100)} · ${xs.length} calls. The dashed line is zero: right of it beat the market.</p>
    <div class="ledger-table-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of excess returns">
      ${bars}
      <line class="dist-zero" x1="${zeroX.toFixed(1)}" x2="${zeroX.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"></line>
      <line class="dist-mean" x1="${meanX.toFixed(1)}" x2="${meanX.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"><title>mean ${pct(mean / 100)}</title></line>
      <text class="hist-axis-text" x="${pad.l}" y="${H - 8}">&lt; −${LIM}%</text>
      <text class="hist-axis-text" x="${zeroX.toFixed(1)}" y="${H - 8}" text-anchor="middle">0</text>
      <text class="hist-axis-text" x="${W - pad.r}" y="${H - 8}" text-anchor="end">&gt; +${LIM}%</text>
    </svg></div>`;
  card.hidden = false;
}

// ---------- the luck test: is a pattern real, or luck in a costume? ----------
// Pick a slice of the record; the browser deals 1,000 random hands of the
// SAME SIZE from the whole eligible deck and shows where the slice lands in
// that luck distribution. This is a bootstrap significance test — the tool
// quant desks use to keep themselves honest — running live on the site's
// own published calls. The direction-aware edge means + is always "the
// call was right", so buy slices and sell slices are comparable.
const labState = { verdicts: new Set(["STRONG BUY", "BUY"]), sector: "ALL" };
let labSectors = null;

async function renderLuckLab(data) {
  const card = $("labCard");
  const era = currentEra(data);
  const isBuy = (v) => /BUY/.test(v ?? "");
  const isSell = (v) => /SELL/.test(v ?? "");
  const pool = data.entries.filter((e) => (e.formulaVersion ?? "v1") === era
    && e.excess != null && e.ageDays > 0 && e.basis === "tr"
    && (isBuy(e.verdict) || isSell(e.verdict)));
  if (pool.length < 60) { card.hidden = true; return; } // too small a deck to deal honest hands
  if (!labSectors) {
    try { labSectors = (await (await fetch("/api/universe-meta")).json()).sectors ?? {}; } catch { labSectors = {}; }
  }
  const edge = (e) => (isSell(e.verdict) ? -e.excess : e.excess) * 100;
  const sectors = [...new Set(Object.values(labSectors))].sort();
  const V = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];

  card.innerHTML = `
    <h2>The luck test — is a pattern real?</h2>
    <p class="sub">Pick a slice of the record. The browser deals <b>1,000 random hands of the same size</b> from all
      ${pool.length} aged directional calls and shows where your slice lands. If random hands beat it often,
      the pattern is luck wearing a costume. Edge is direction-aware: positive always means the call was right.</p>
    <div class="lab-controls">
      ${V.map((v) => `<button type="button" class="chip lab-v${labState.verdicts.has(v) ? " on" : ""}" data-lv="${esc(v)}" aria-pressed="${labState.verdicts.has(v)}">${esc(v)}</button>`).join("")}
      <select id="labSector" aria-label="Sector filter">
        <option value="ALL">All sectors</option>
        ${sectors.map((s) => `<option value="${esc(s)}"${labState.sector === s ? " selected" : ""}>${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div id="labOut" role="status"></div>`;
  card.hidden = false;

  const draw = () => {
    const out = document.getElementById("labOut");
    const sel = pool.filter((e) => labState.verdicts.has(e.verdict)
      && (labState.sector === "ALL" || labSectors[e.ticker] === labState.sector));
    if (!labState.verdicts.size) { out.innerHTML = `<p class="sub">Pick at least one verdict band.</p>`; return; }
    if (sel.length < 15) {
      out.innerHTML = `<p class="sub">Only ${sel.length} aged call${sel.length === 1 ? "" : "s"} match — fewer than 15 can't tell luck from anything.</p>`;
      return;
    }
    const k = sel.length;
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const realMean = mean(sel.map(edge));
    const edges = pool.map(edge);
    const B = 1000;
    const nulls = new Array(B);
    const idx = edges.map((_, i) => i);
    for (let b = 0; b < B; b++) {
      // partial Fisher–Yates: an honest k-sample WITHOUT replacement
      let sum = 0;
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(Math.random() * (idx.length - i));
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
        sum += edges[idx[i]];
      }
      nulls[b] = sum / k;
    }
    nulls.sort((a, b) => a - b);
    const below = nulls.filter((n) => n < realMean).length;
    const pctile = (below / B) * 100;
    // add-one smoothing so the p-value can never claim impossible certainty
    const pTwo = Math.min(1, (2 * (Math.min(below, B - below) + 1)) / (B + 1));
    const lo = nulls[Math.floor(B * 0.025)], hi = nulls[Math.ceil(B * 0.975) - 1];
    const readout = pctile >= 97.5
      ? `outside the luck band on the <b>good</b> side — random hands almost never did this well`
      : pctile <= 2.5
        ? `outside the luck band on the <b>bad</b> side — random hands almost always did better`
        : `inside the luck band — indistinguishable from dealing ${k} calls at random`;
    // histogram of the null means, the real mean as a marker
    const W = 720, H = 140, pad = { l: 10, r: 10, t: 12, b: 22 };
    const min = Math.min(nulls[0], realMean), max = Math.max(nulls[B - 1], realMean);
    const span = (max - min) || 1;
    const BINS = 36;
    const counts = new Array(BINS).fill(0);
    for (const n of nulls) counts[Math.min(BINS - 1, Math.floor(((n - min) / span) * BINS))]++;
    const maxC = Math.max(...counts, 1);
    const bw = (W - pad.l - pad.r) / BINS;
    const bars = counts.map((c, i) => c === 0 ? "" :
      `<rect class="lab-bar" x="${(pad.l + i * bw + 0.5).toFixed(1)}" y="${(H - pad.b - (c / maxC) * (H - pad.t - pad.b)).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${((c / maxC) * (H - pad.t - pad.b)).toFixed(1)}"><title>${c} of 1,000 luck-worlds</title></rect>`).join("");
    const xOf = (v) => pad.l + ((v - min) / span) * (W - pad.l - pad.r);
    out.innerHTML = `
      <p class="sub"><b>${k} calls</b> match · their average edge is <b>${realMean > 0 ? "+" : ""}${realMean.toFixed(2)}%</b> vs SPY ·
        1,000 random hands landed between ${lo.toFixed(2)}% and ${hi.toFixed(2)}% (95% of them) —
        your slice beat <b>${pctile.toFixed(0)}%</b> of them (p ≈ ${pTwo.toFixed(2)}), ${readout}.</p>
      <div class="ledger-table-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your slice against 1,000 random hands">
        ${bars}
        <line class="dist-mean" x1="${xOf(realMean).toFixed(1)}" x2="${xOf(realMean).toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"><title>your slice: ${realMean.toFixed(2)}%</title></line>
        <text class="hist-axis-text" x="${pad.l}" y="${H - 6}">${min.toFixed(1)}%</text>
        <text class="hist-axis-text" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${max.toFixed(1)}%</text>
      </svg></div>
      <p class="sub">Printed on purpose: if you chose this slice <b>after</b> looking at the tables above, the test flatters
        you — trying slices until one looks special is <b>data snooping</b>, and some slice always wins by chance.
        And these calls overlap in time under one market backdrop, so even a clean pass can be one regime in costume.
        A pattern counts when you name it first and it keeps working on calls that haven't happened yet.</p>`;
  };

  card.addEventListener("click", (e) => {
    const v = e.target.closest?.("[data-lv]")?.dataset?.lv;
    if (!v) return;
    if (labState.verdicts.has(v)) labState.verdicts.delete(v); else labState.verdicts.add(v);
    const b = e.target.closest("[data-lv]");
    b.classList.toggle("on", labState.verdicts.has(v));
    b.setAttribute("aria-pressed", String(labState.verdicts.has(v)));
    draw();
  });
  card.querySelector("#labSector").addEventListener("change", (e) => {
    labState.sector = e.target.value;
    draw();
  });
  draw();
}

// Every graded call as a dot: x = when the call was made, y = its excess
// vs SPY so far. The spread IS the honesty — wins and losses in one glance.
function renderCallsMap(data) {
  const card = $("mapCard");
  const era = currentEra(data);
  const rows = data.entries.filter((e) => (e.formulaVersion ?? "v1") === era && e.excess != null && e.ageDays > 0 && e.basis === "tr");
  if (rows.length < 5) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const W = 720;
  const H = 200;
  const pad = { l: 46, r: 12, t: 10, b: 24 };
  const ts = rows.map((r) => Date.parse(r.date));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts) || t0 + 1;
  const maxAbs = Math.max(0.02, ...rows.map((r) => Math.abs(r.excess)));
  const X = (t) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v + maxAbs) / (2 * maxAbs)) * (H - pad.t - pad.b);
  const dotClass = { "STRONG BUY": "dot-sb", BUY: "dot-b", HOLD: "dot-h", SELL: "dot-s", "STRONG SELL": "dot-ss" };
  const dots = rows.map((r) =>
    `<circle class="${dotClass[r.verdict] ?? "dot-h"}" cx="${X(Date.parse(r.date)).toFixed(1)}" cy="${Y(r.excess).toFixed(1)}" r="3.4">` +
    `<title>${esc(r.ticker)} ${esc(r.verdict)} · ${esc(r.date)} · ${(r.excess * 100).toFixed(1)}% vs SPY</title></circle>`
  ).join("");
  const yTick = (v) => `<line class="hist-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"></line>` +
    `<text class="hist-axis-text" x="${pad.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%</text>`;
  const xLabel = (f) => {
    const t = t0 + f * (t1 - t0);
    return `<text class="hist-axis-text" x="${X(t)}" y="${H - 6}" text-anchor="${f > 0.9 ? "end" : f < 0.1 ? "start" : "middle"}">${new Date(t).toISOString().slice(5, 10)}</text>`;
  };
  card.innerHTML = `
    <h2>Calls map</h2>
    <p class="sub">Every aged, total-return-graded call from the current formula era: when it was made vs how it
    stands against SPY. Color is the call itself — green buys want to finish <i>above</i> the line, red sells are
    right when they finish <i>below</i> it. Hover any dot.
    <span class="map-legend"><span class="swatch sw-sb"></span>STRONG BUY<span class="swatch sw-b"></span>BUY<span class="swatch sw-h"></span>HOLD<span class="swatch sw-s"></span>SELL<span class="swatch sw-ss"></span>STRONG SELL</span></p>
    <div class="ledger-table-wrap"><svg class="calls-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graded calls vs SPY over time">
      ${yTick(maxAbs * 0.66)}${yTick(0)}${yTick(-maxAbs * 0.66)}
      <line class="map-zero" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}"></line>
      ${t1 > t0 ? xLabel(0.02) + xLabel(0.5) + xLabel(0.98) : xLabel(0.5)}
      ${dots}
    </svg></div>`;
}

// Ask the data, record edition: the server builds this view's context from
// its own graded ledger, so the card sends only the question. Hidden when
// no AI is configured — the front page already carries the setup card.
function initAskRecord() {
  const card = document.getElementById("askRecordCard");
  if (!card || typeof CCAsk === "undefined") return;
  const mount = () => {
    if (!CCAsk.getStatus()?.enabled) { card.hidden = true; return; }
    if (card.dataset.ready) return; // keep the conversation across re-renders
    card.dataset.ready = "1";
    CCAsk.buildCard(card, {
      view: "record",
      scope: "the graded forward test on this page",
      chips: ["Which verdict band has done worst?", "Is this record skill or luck?"],
    });
  };
  if (CCAsk.getStatus()) mount();
  else CCAsk.loadStatus().then(mount);
}

async function load() {
  try {
    const [res, picksRes] = await Promise.all([fetch("/api/ledger"), fetch("/api/picks")]);
    const data = await res.json();
    try {
      renderMyPicks(await picksRes.json());
    } catch {
      $("myPicksCard").hidden = true;
    }
    $("status").hidden = true;
    if (!res.ok) {
      $("error").textContent = data?.error ?? `Request failed (${res.status}).`;
      $("error").hidden = false;
      return;
    }
    if (data.warning) {
      $("warning").textContent = data.warning;
      $("warning").hidden = false;
    }
    if (!data.entries.length) {
      $("summaryCard").innerHTML = `
        <h2>No calls logged yet</h2>
        <p class="sub" style="margin-bottom:0">Analyze real tickers on the <a href="/">analyzer page</a> —
        each first-of-the-day verdict lands here automatically, and time does the grading.</p>`;
      $("aggCard").hidden = true;
      $("callsCard").hidden = true;
      $("content").hidden = false;
      return;
    }
    renderSummary(data);
    renderCallsMap(data);
    renderDistribution(data);
    renderLuckLab(data);
    initAskRecord();
    renderAggregates(data);
    // Official-source viewers get the statistics, not 585 rows of scroll:
    // the row-level log is still fully public in the repo for anyone who
    // wants to audit it, and this app grades it locally either way.
    if (data.source === "official") {
      $("callsCard").innerHTML = `
        <h2>All calls</h2>
        <p class="sub" style="margin-bottom:0">Individual rows are omitted here — the aggregates above cover every
        call ever made, with nothing excluded. The complete row-level log is public in the repo
        (<code>docs/forward-test.json</code>), and this app graded it locally to produce the numbers above.
        Run <code>npm run batch</code> to build your own local ledger with full rows.</p>`;
    } else {
      renderCalls(data);
    }
    $("content").hidden = false;
  } catch {
    $("status").hidden = true;
    $("error").textContent = "Could not reach the server. Is it still running?";
    $("error").hidden = false;
  }
}

load();
