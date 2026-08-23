"use strict";

// "Call it" — the learning game. A real company's real numbers on a real
// past date, with the ticker hidden. You call whether it beat the market
// from that day to now; then the truth, and the formula's own call, are
// revealed. Scores accumulate locally: you versus the formula. Every round
// is a point-in-time reconstruction (no hindsight), so it is also the most
// honest demonstration on the site of how hard prediction is.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STORE = "cc_callit";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const pct = (v, d = 1) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a");
  const ret = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%` : "n/a");
  const x = (v) => (isNum(v) ? `${v.toFixed(1)}×` : "n/a");

  function readScore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      return s && typeof s === "object" ? { you: s.you | 0, formula: s.formula | 0, rounds: s.rounds | 0 } : { you: 0, formula: 0, rounds: 0 };
    } catch {
      return { you: 0, formula: 0, rounds: 0 };
    }
  }
  function saveScore(s) {
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode */ }
  }

  // Weekdays between 2013 and mid-2024 — old enough to have aged, new enough
  // that every universe name was public and filing in XBRL.
  function randomDate() {
    const start = Date.parse("2013-01-02");
    const end = Date.parse("2024-06-28");
    const d = new Date(start + Math.random() * (end - start));
    const dow = d.getUTCDay();
    if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  // Variety guard: never re-serve a ticker the player has seen in the last
  // several rounds (a reviewer got TSLA twice in a row — that reads as
  // broken and lets players meta-guess).
  const RECENT_KEY = "cc_callit_recent";
  const readRecentTickers = () => {
    try {
      const a = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(a) ? a.filter((t) => typeof t === "string") : [];
    } catch {
      return [];
    }
  };
  const pushRecentTicker = (t) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...readRecentTickers().filter((x) => x !== t)].slice(0, 8))); } catch { /* private mode */ }
  };

  const verdictCall = (v) => (/BUY/.test(v ?? "") ? "beat" : /SELL/.test(v ?? "") ? "trail" : null);
  const verdictClass = (v) => ({ "STRONG BUY": "v-strongbuy", BUY: "v-buy", HOLD: "v-hold", SELL: "v-sell", "STRONG SELL": "v-strongsell" }[v] ?? "v-nodata");

  window.mountCallIt = function mountCallIt(root, { tickers = [], compact = false } = {}) {
    if (!root) return;
    let round = null;
    let busy = false;
    const score = readScore();

    const scoreLine = () => `
      <div class="callit-score">
        <span><b>You</b> ${score.you}/${score.rounds}</span>
        <span><b>Formula</b> ${score.formula}/${score.rounds}</span>
        ${score.rounds ? `<button type="button" class="callit-reset" data-act="reset">reset</button>` : ""}
      </div>`;

    const stat = (label, val) => `<div class="callit-stat"><div class="mkt-label">${esc(label)}</div><div class="callit-val">${esc(val)}</div></div>`;

    function renderIntro(msg) {
      root.innerHTML = `
        <p class="callit-lead">${compact
          ? "A real company, a real past date, ticker hidden. Did it beat the S&amp;P from that day to now? Call it — then see what the formula said."
          : "You get a real company's real numbers on a real past date — with the ticker hidden. Call whether it beat the S&amp;P 500 from that day to today. Then the truth is revealed, along with what the formula would have said with the same information. No hindsight on either side."}</p>
        ${msg ? `<p class="callit-msg">${esc(msg)}</p>` : ""}
        ${scoreLine()}
        <button type="button" class="callit-btn primary" data-act="start">${score.rounds ? "Next round" : "Start"}</button>`;
    }

    function renderRound() {
      const i = round.inputs ?? {};
      const stats = [
        ["52-week position", isNum(i.pricePosition) ? `${Math.round(i.pricePosition * 100)}% of range` : "n/a"],
        ["P/E", x(i.pe)],
        ["Revenue growth", pct(i.revenueGrowth)],
        ["Net margin", pct(i.netMargin)],
        ["EPS growth", pct(i.epsGrowth)],
        ["Current ratio", isNum(i.currentRatio) ? i.currentRatio.toFixed(2) : "n/a"],
        ["Debt / equity", isNum(i.debtEquity) ? i.debtEquity.toFixed(2) : "n/a"],
      ].filter(([, v]) => v !== "n/a").slice(0, compact ? 4 : 7);
      root.innerHTML = `
        <div class="callit-head"><b>Mystery stock</b> · ${esc(round.date)} · large-cap US company</div>
        <div class="callit-stats">${stats.map(([l, v]) => stat(l, v)).join("")}</div>
        <p class="callit-q">From ${esc(round.date)} to ${esc(round.outcome?.through ?? "today")} (${round.outcome?.years ? round.outcome.years.toFixed(1) : "?"} years) — did it beat the S&amp;P 500?</p>
        <div class="callit-btns">
          <button type="button" class="callit-btn" data-act="call" data-call="beat">Beats the market</button>
          <button type="button" class="callit-btn" data-act="call" data-call="trail">Trails the market</button>
        </div>
        ${scoreLine()}`;
    }

    function renderReveal(yourCall) {
      const o = round.outcome ?? {};
      const truth = isNum(o.excess) ? (o.excess > 0 ? "beat" : "trail") : null;
      const v = round.scoring?.verdict ?? "—";
      const fCall = verdictCall(v);
      const youRight = truth && yourCall === truth;
      const fRight = truth && fCall === truth;
      score.rounds += 1;
      if (youRight) score.you += 1;
      if (fRight) score.formula += 1;
      saveScore(score);
      // Daily count for the front page's today bar (its own streak logic).
      try {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const t = JSON.parse(localStorage.getItem("cc_callit_today")) ?? {};
        localStorage.setItem("cc_callit_today", JSON.stringify({ date: today, rounds: (t.date === today ? t.rounds : 0) + 1 }));
      } catch { /* private mode */ }
      root.innerHTML = `
        <div class="callit-head"><b>${esc(round.ticker)}</b> · ${esc(round.date)}</div>
        <div class="callit-reveal">
          <div class="callit-outcome ${truth === "beat" ? "pos" : "neg"}">
            ${truth ? `It <b>${truth === "beat" ? "beat" : "trailed"}</b> the market: stock ${ret(o.ret)} vs S&amp;P ${ret(o.spyRet)} (${ret(o.excess)} excess)` : "Outcome unavailable for this one."}
          </div>
          <div class="callit-verdicts">
            <div>You called <b>${yourCall === "beat" ? "beats" : "trails"}</b> — <span class="${youRight ? "pos" : "neg"}">${youRight ? "right" : "wrong"}</span></div>
            <div>Formula said <span class="pill-sm ${verdictClass(v)}">${esc(v)}</span> ${isNum(round.scoring?.score) ? `(${round.scoring.score}/100)` : ""} — <span class="${fRight ? "pos" : fCall ? "neg" : ""}">${fCall ? (fRight ? "right" : "wrong") : "no call"}</span></div>
          </div>
          <p class="callit-note">Reconstructed from filings filed by ${esc(round.date)} and prices through that close — the same information you just saw. <a href="/#${esc(round.ticker)}">Open ${esc(round.ticker)} today →</a></p>
        </div>
        ${scoreLine()}
        <button type="button" class="callit-btn primary" data-act="start">Next round</button>`;
    }

    async function newRound() {
      if (busy) return;
      busy = true;
      root.innerHTML = `<p class="callit-msg">Reconstructing a past day…</p>`;
      let lastErr = "Could not build a round right now.";
      const seen = readRecentTickers();
      const pool = tickers.filter((t) => !seen.includes(t));
      for (let attempt = 0; attempt < 4; attempt++) {
        const from = pool.length ? pool : tickers;
        const t = from[Math.floor(Math.random() * from.length)];
        const d = randomDate();
        try {
          const res = await fetch(`/api/timemachine?ticker=${encodeURIComponent(t)}&date=${d}`);
          const body = await res.json();
          if (!res.ok) {
            lastErr = body?.error ?? lastErr;
            if (res.status === 422 && /tiingo|key/i.test(lastErr)) break; // no point retrying without a key
            continue;
          }
          if (body.scoring?.insufficientData || !isNum(body.outcome?.excess)) continue;
          round = body;
          pushRecentTicker(t);
          busy = false;
          renderRound();
          return;
        } catch {
          /* try another */
        }
      }
      busy = false;
      renderIntro(lastErr);
    }

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "start") {
        if (!tickers.length) return renderIntro("No universe loaded — reload the page.");
        newRound();
      } else if (act === "call" && round) {
        renderReveal(b.dataset.call);
      } else if (act === "reset") {
        score.you = 0; score.formula = 0; score.rounds = 0;
        saveScore(score);
        renderIntro();
      }
    });

    renderIntro();
  };
})();
