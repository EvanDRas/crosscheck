"use strict";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const pillClass = (v) =>
  ({ "STRONG BUY": "v-strongbuy", BUY: "v-buy", HOLD: "v-hold", SELL: "v-sell", "STRONG SELL": "v-strongsell" }[v] ?? "");

const money = (v) => (isNum(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—");

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
  const era = data.entries.some((e) => e.formulaVersion === "v2") ? "v2" : "v1";
  const graded = data.entries.filter((e) => (e.formulaVersion ?? "v1") === era && e.excess != null && e.ageDays > 0 && e.basis === "tr");
  const dates = data.entries.map((e) => e.date).sort();
  const avgExcess = graded.length ? graded.reduce((a, e) => a + e.excess, 0) / graded.length : null;
  const wins = graded.length ? graded.filter((e) => e.excess > 0).length : 0;
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
    ["Avg vs SPY (graded)", graded.length ? pct(avgExcess) : "—"],
    ["Beat SPY", graded.length ? `${wins} of ${graded.length}` : "—"],
    ["Formula eras", eras || "—"],
  ];
  $("summaryCard").innerHTML = `
    <h2>Summary</h2>
    <p class="sub">As of ${new Date(data.asOf).toLocaleString("en-US")}. Total-return grading: split- and
    dividend-adjusted closes (call date &rarr; latest), SPY measured the same way over the same window.
    SPY is an S&amp;P 500 index fund — shorthand for "the market." Costs excluded.</p>
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
    Current formula era only; aged, total-return-graded rows only.</p>
    <div class="ledger-table-wrap">
      <table class="ledger-table">
        <thead><tr>
          <th>Verdict</th><th class="num">Calls</th><th class="num">Avg return</th>
          <th class="num">Avg vs SPY</th><th class="num">Beat SPY</th>
        </tr></thead>
        <tbody>
          ${data.aggregates.map((a) => `
            <tr>
              <td><span class="pill-sm ${pillClass(a.verdict)}">${esc(a.verdict)}</span></td>
              <td class="num">${a.n}</td>
              <td class="num">${deltaCell(a.avgReturn)}</td>
              <td class="num">${deltaCell(a.avgExcess)}</td>
              <td class="num">${Math.round(a.winRateVsSpy * 100)}%</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderCalls(data) {
  const anyRaw = data.entries.some((e) => e.basis === "raw");
  const anyFrozen = data.entries.some((e) => e.frozen);
  const notes = [];
  if (anyRaw) notes.push("* graded from raw live quotes (ticker outside the local panel) — not split/dividend-adjusted.");
  if (anyFrozen) notes.push("† price series stopped updating (left the index); graded through its last close, SPY over the same window.");
  $("callsCard").innerHTML = `
    <h2>All calls — newest first</h2>
    <p class="sub">Each row froze the moment it was logged; only the "now" columns move.</p>
    ${notes.length ? `<p class="sub">${esc(notes.join(" "))}</p>` : ""}
    <div class="ledger-table-wrap">
      <table class="ledger-table">
        <thead><tr>
          <th>Date</th><th>Ticker</th><th>Verdict</th><th class="num">Score</th>
          <th>Near-term</th><th>Long-term</th>
          <th class="num">Price then</th><th class="num">Now</th>
          <th class="num">Return</th><th class="num">vs SPY</th><th class="num">Age</th>
        </tr></thead>
        <tbody>
          ${data.entries.map((e) => `
            <tr>
              <td>${esc(e.date)}</td>
              <td><a href="/#${esc(e.ticker)}">${esc(e.ticker)}</a></td>
              <td><span class="pill-sm ${pillClass(e.verdict)}">${esc(e.verdict)}</span></td>
              <td class="num">${isNum(e.score) ? Math.round(e.score) : "—"}</td>
              <td>${e.ntVerdict ? `<span class="pill-sm ${pillClass(e.ntVerdict)}">${esc(e.ntVerdict)}</span>` : "—"}</td>
              <td>${e.ltVerdict ? `<span class="pill-sm ${pillClass(e.ltVerdict)}">${esc(e.ltVerdict)}</span>` : "—"}</td>
              <td class="num">${money(e.price)}</td>
              <td class="num">${money(e.nowPrice)}${e.basis === "raw" ? "*" : ""}${e.frozen ? "†" : ""}</td>
              <td class="num">${deltaCell(e.ret)}</td>
              <td class="num">${deltaCell(e.excess)}</td>
              <td class="num">${e.ageDays === 0 ? "today" : `${e.ageDays}d`}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
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
  const acc = s ? `${s.correct} of ${s.graded} right (${Math.round(s.accuracy * 100)}%)` : "— (calls need at least a day of age)";
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
          <th class="num">Price then</th><th class="num">Now</th>
          <th class="num">Return</th><th class="num">vs SPY</th><th>Right?</th>
        </tr></thead>
        <tbody>
          ${data.entries.map((e) => {
            const graded = e.excess != null && e.ageDays > 0;
            const right = !graded ? "—" : (e.direction === "buy" ? e.excess > 0 : e.excess < 0) ? "✓" : "✗";
            return `
            <tr>
              <td>${esc(e.date)}</td>
              <td><a href="/#${esc(e.ticker)}">${esc(e.ticker)}</a></td>
              <td><span class="pill-sm ${dirClass[e.direction] ?? ""}">${esc(dirLabel[e.direction] ?? e.direction)}</span></td>
              <td class="pick-note">${esc(e.note ?? "")}</td>
              <td class="num">${money(e.price)}</td>
              <td class="num">${money(e.nowPrice)}</td>
              <td class="num">${deltaCell(e.ret)}</td>
              <td class="num">${deltaCell(e.excess)}</td>
              <td>${right}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

// Every graded call as a dot: x = when the call was made, y = its excess
// vs SPY so far. The spread IS the honesty — wins and losses in one glance.
function renderCallsMap(data) {
  const card = $("mapCard");
  const rows = data.entries.filter((e) => e.excess != null && e.ageDays > 0 && e.basis === "tr");
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
    <p class="sub">Every aged, total-return-graded call: when it was made vs how it stands against SPY today.
    Dots above the line beat the index. Hover any dot.</p>
    <div class="ledger-table-wrap"><svg class="calls-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graded calls vs SPY over time">
      ${yTick(maxAbs * 0.66)}${yTick(0)}${yTick(-maxAbs * 0.66)}
      <line class="map-zero" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}"></line>
      ${t1 > t0 ? xLabel(0.02) + xLabel(0.5) + xLabel(0.98) : xLabel(0.5)}
      ${dots}
    </svg></div>`;
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
    renderAggregates(data);
    renderCalls(data);
    $("content").hidden = false;
  } catch {
    $("status").hidden = true;
    $("error").textContent = "Could not reach the server. Is it still running?";
    $("error").hidden = false;
  }
}

load();
