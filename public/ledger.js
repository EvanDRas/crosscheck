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
  const graded = data.entries.filter((e) => e.excess != null);
  const dates = data.entries.map((e) => e.date).sort();
  const avgExcess = graded.length ? graded.reduce((a, e) => a + e.excess, 0) / graded.length : null;
  const wins = graded.length ? graded.filter((e) => e.excess > 0).length : 0;
  const tiles = [
    ["Calls logged", String(data.entries.length)],
    ["First call", dates[0] ?? "—"],
    ["Graded (re-priced)", String(graded.length)],
    ["Avg vs SPY (graded calls)", graded.length ? pct(avgExcess) : "—"],
    ["Beat SPY", graded.length ? `${wins} of ${graded.length}` : "—"],
    ["Formula", data.entries[0]?.formulaVersion ?? "—"],
  ];
  $("summaryCard").innerHTML = `
    <h2>Summary</h2>
    <p class="sub">As of ${new Date(data.asOf).toLocaleString("en-US")}. Total-return grading: split- and
    dividend-adjusted closes (call date &rarr; latest) from the local research panel, SPY measured the same
    way over the same window. Costs excluded.</p>
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
    <p class="sub">The test the formula has to pass over time: buys above SPY, sells below.</p>
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

async function load() {
  try {
    const res = await fetch("/api/ledger");
    const data = await res.json();
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
