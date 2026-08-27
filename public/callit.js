"use strict";

// "Call it" — the learning game. A real company's real numbers on a real
// past date, with the ticker hidden. You call whether it beat the market
// from that day to now; then the truth, and the formula's own call, are
// revealed.
//
// The centerpiece is the DAILY 5: five mysteries per day, seeded by the
// date, so every player gets the SAME five and scores are comparable
// between friends — scarcity and comparability are what turn a game into
// a morning ritual. Practice mode stays unlimited. Every round is a
// point-in-time reconstruction (no hindsight on either side).
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const pct = (v, d = 1) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a");
  const ret = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%` : "n/a");
  const x = (v) => (isNum(v) ? `${v.toFixed(1)}×` : "n/a");

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
  const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const readScore = () => {
    const s = readJSON("cc_callit", {});
    return { you: s.you | 0, formula: s.formula | 0, rounds: s.rounds | 0 };
  };
  const saveScore = (s) => writeJSON("cc_callit", s);

  // Deterministic PRNG: the daily seed must produce the identical (ticker,
  // date) sequence for every player, including the retry sequence when a
  // candidate round has insufficient data (data failures are the same for
  // everyone, so everyone lands on the same playable five).
  const hashStr = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const mulberry32 = (a) => () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const DATE_START = Date.parse("2013-01-02");
  const DATE_END = Date.parse("2024-06-28");
  const clampWeekday = (d) => {
    const dow = d.getUTCDay();
    if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().slice(0, 10);
  };
  const seededPick = (tickers, day, round, attempt) => {
    const rnd = mulberry32(hashStr(`${day}|${round}|${attempt}`));
    return {
      t: tickers[Math.floor(rnd() * tickers.length)],
      d: clampWeekday(new Date(DATE_START + rnd() * (DATE_END - DATE_START))),
    };
  };
  const randomPick = (tickers) => {
    // Practice mode: random, with a variety guard so nobody sees the same
    // ticker twice in a short stretch.
    const seen = readJSON("cc_callit_recent", []);
    const pool = tickers.filter((t) => !seen.includes(t));
    const from = pool.length ? pool : tickers;
    return {
      t: from[Math.floor(Math.random() * from.length)],
      d: clampWeekday(new Date(DATE_START + Math.random() * (DATE_END - DATE_START))),
    };
  };
  const pushRecentTicker = (t) =>
    writeJSON("cc_callit_recent", [t, ...readJSON("cc_callit_recent", []).filter((x) => x !== t)].slice(0, 8));

  const verdictCall = (v) => (/BUY/.test(v ?? "") ? "beat" : /SELL/.test(v ?? "") ? "trail" : null);
  const verdictClass = (v) => ({ "STRONG BUY": "v-strongbuy", BUY: "v-buy", HOLD: "v-hold", SELL: "v-sell", "STRONG SELL": "v-strongsell" }[v] ?? "v-nodata");

  window.mountCallIt = function mountCallIt(root, { tickers = [], compact = false } = {}) {
    if (!root) return;
    let mode = "daily";
    let round = null;
    let busy = false;
    const score = readScore();

    const dailyState = () => {
      const d = readJSON("cc_callit_daily", null);
      if (d?.date !== localDay()) return { date: localDay(), rounds: [] };
      // Trust nothing from storage verbatim — a bad write should not wedge
      // the day (and stray test rows should never render).
      d.rounds = (Array.isArray(d.rounds) ? d.rounds : []).filter((r) => /^[A-Z]{1,6}(\.[AB])?$/.test(r?.t ?? "")).slice(0, 5);
      return d;
    };

    // Playing the Daily 5 is what keeps the streak alive — first daily
    // reveal of the day bumps it (merely loading the page does not).
    const bumpPlayStreak = () => {
      const today = localDay();
      const s = readJSON("cc_streak", { last: null, count: 0, best: 0 });
      if (s.last === today) return;
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      const count = s.last === yesterday ? s.count + 1 : 1;
      writeJSON("cc_streak", { last: today, count, best: Math.max(s.best ?? 0, s.count ?? 0, count) });
    };

    const scoreLine = () => `
      <div class="callit-score">
        <span><b>All-time</b> you ${score.you}/${score.rounds} · formula ${score.formula}/${score.rounds}</span>
        ${score.rounds ? `<button type="button" class="callit-reset" data-act="reset">reset</button>` : ""}
      </div>`;

    const stat = (label, val) => `<div class="callit-stat"><div class="mkt-label">${esc(label)}</div><div class="callit-val">${esc(val)}</div></div>`;

    function renderHome(msg) {
      const d = dailyState();
      if (d.rounds.length >= 5) return renderSummary(msg);
      const how = compact
        ? `<p class="callit-note">Not pure guessing: most single stocks trail the index over long stretches, and extreme numbers (a triple-digit P/E, a price at 2% of its range) usually mean something. The date matters as much as the numbers.</p>`
        : `<div class="callit-how">
            <div class="mkt-label">How do you beat a coin flip?</div>
            <p class="callit-note">Base rates and extremes. Over long stretches most individual stocks <b>trail</b> the index — a few giant winners drag the average up — so "trails" is the statistically safer default. Extreme numbers carry information: a triple-digit P/E in a frothy year usually ends badly; fat margins and steady growth at a sane price sometimes compound for a decade. And the date matters as much as the numbers — the same figures mean different things in 2013 and mid-2021. If it still feels like half-guessing, that is the lesson: you have the same information the formula has, and you'll both hover near a coin flip.</p>
          </div>`;
      root.innerHTML = `
        <div class="callit-daily-head"><b>Daily 5</b> · mystery ${d.rounds.length + 1} of 5 · the same five for everyone today</div>
        <p class="callit-lead">A real company on a real past date, ticker hidden. Did it beat the S&amp;P from that day to now? Call it — then see what the formula said with the same numbers.</p>
        ${how}
        <p class="callit-note">Mysteries come from the same fixed 50 large caps (all 11 sectors) the daily forward test grades — a list committed before any results existed, so neither the game nor the track record can cherry-pick.</p>
        ${msg ? `<p class="callit-msg">${esc(msg)}</p>` : ""}
        ${scoreLine()}
        <div class="callit-btns">
          <button type="button" class="callit-btn primary" data-act="daily">${d.rounds.length ? "Next mystery" : "Play the Daily 5"}</button>
          <button type="button" class="callit-btn" data-act="practice">Practice</button>
        </div>`;
    }

    function renderSummary(msg) {
      const d = dailyState();
      const you = d.rounds.filter((r) => r.you).length;
      const f = d.rounds.filter((r) => r.formula).length;
      const called = d.rounds.filter((r) => r.fc !== false).length;
      const fLine = called < d.rounds.length ? `${f}/${called} (${d.rounds.length - called} no-call)` : `${f}/${d.rounds.length}`;
      root.innerHTML = `
        <div class="callit-daily-head"><b>Daily 5 — done.</b> You ${you}/5 · Formula ${fLine}</div>
        <div class="callit-daily-rows">
          ${d.rounds.map((r, i) => `<span class="callit-day-row">${i + 1}. ${esc(r.t)} <b class="${r.you ? "pos" : "neg"}">${r.you ? "✓" : "✗"}</b></span>`).join("")}
        </div>
        ${msg ? `<p class="callit-msg">${esc(msg)}</p>` : ""}
        <div class="callit-btns">
          <button type="button" class="callit-btn primary" data-act="copy">Copy result</button>
          <button type="button" class="callit-btn" data-act="practice">Practice rounds</button>
        </div>
        ${scoreLine()}
        <p class="callit-note">The formula made its calls from the same numbers${f <= you ? " — and you matched or beat it. That's the point: today's numbers don't know the future" : ""}. A new five drops tomorrow.</p>`;
    }

    function renderRound() {
      const d = dailyState();
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
        <div class="callit-head"><b>${mode === "daily" ? `Daily mystery ${Math.min(d.rounds.length + 1, 5)} of 5` : "Mystery stock"}</b> · ${esc(round.date)} · large-cap US company</div>
        <div class="callit-stats">${stats.map(([l, v]) => stat(l, v)).join("")}</div>
        <p class="callit-q">From ${esc(round.date)} to ${esc(round.outcome?.through ?? "today")} (${round.outcome?.years ? round.outcome.years.toFixed(1) : "?"} years) — did it beat the S&amp;P 500?</p>
        <div class="callit-btns">
          <button type="button" class="callit-btn" data-act="call" data-call="beat">Beats the market</button>
          <button type="button" class="callit-btn" data-act="call" data-call="trail">Trails the market</button>
        </div>`;
    }

    function renderReveal(yourCall) {
      const o = round.outcome ?? {};
      const truth = isNum(o.excess) ? (o.excess > 0 ? "beat" : "trail") : null;
      const v = round.scoring?.verdict ?? "—";
      const fCall = verdictCall(v);
      const youRight = Boolean(truth && yourCall === truth);
      const fRight = Boolean(truth && fCall === truth);
      score.rounds += 1;
      if (youRight) score.you += 1;
      if (fRight) score.formula += 1;
      saveScore(score);
      let nextLabel = "Next round";
      if (mode === "daily") {
        const d = dailyState();
        // fc = whether the formula actually made a call (HOLD abstains) —
        // an abstention must not count as a miss in the head-to-head.
        d.rounds.push({ t: round.ticker, d: round.date, you: youRight, formula: fRight, fc: Boolean(fCall) });
        writeJSON("cc_callit_daily", d);
        bumpPlayStreak();
        nextLabel = d.rounds.length >= 5 ? "See today's result" : "Next mystery";
      }
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
          <p class="callit-note">Reconstructed from filings filed by ${esc(round.date)} and prices through that close. <a href="/#${esc(round.ticker)}">Open ${esc(round.ticker)} today →</a></p>
        </div>
        <button type="button" class="callit-btn primary" data-act="${mode === "daily" ? "daily" : "practice-next"}">${esc(nextLabel)}</button>`;
    }

    async function newRound(m) {
      if (busy) return;
      mode = m;
      busy = true;
      root.innerHTML = `<p class="callit-msg">Reconstructing a past day…</p>`;
      let lastErr = "Could not build a round right now.";
      const d = dailyState();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 0; attempt < 12; attempt++) {
        const pick = m === "daily" ? seededPick(tickers, d.date, d.rounds.length, attempt) : randomPick(tickers);
        // No repeats within a day's five. Deterministic: earlier rounds are
        // identical for every player, so this skip is identical too.
        if (m === "daily" && d.rounds.some((r) => r.t === pick.t)) continue;
        // Determinism rule for the daily: only DATA verdicts (this candidate
        // has no usable point-in-time round — same for every player) advance
        // the seeded attempt counter. Transient failures (rate limits,
        // network) retry the SAME candidate, so two friends' sequences
        // can't diverge just because one server hit a 429.
        let played = false;
        for (let tries = 0; tries < 3; tries++) {
          try {
            const res = await fetch(`/api/timemachine?ticker=${encodeURIComponent(pick.t)}&date=${pick.d}`);
            const body = await res.json();
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              // Validation rejections (bad date, missing key) are permanent —
              // no key means stop immediately, anything else means the next
              // candidate. Retrying these burned ~36s before showing the
              // "needs a Tiingo key" message.
              lastErr = body?.error ?? lastErr;
              if (/tiingo|key/i.test(lastErr)) { busy = false; return renderHome(lastErr); }
              break; // deterministic rejection — next candidate
            }
            if (!res.ok) {
              lastErr = body?.error ?? lastErr;
              await sleep(1500); // transient (rate limit / server) — same candidate again
              continue;
            }
            if (body.scoring?.insufficientData || !isNum(body.outcome?.excess)) break; // deterministic — next candidate
            round = body;
            played = true;
            break;
          } catch {
            await sleep(1500); // network hiccup — same candidate again
          }
        }
        if (played) {
          if (m !== "daily") pushRecentTicker(pick.t);
          busy = false;
          renderRound();
          return;
        }
      }
      busy = false;
      renderHome(lastErr);
    }

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (!tickers.length && act !== "reset") return renderHome("No universe loaded — reload the page.");
      if (act === "daily") {
        const d = dailyState();
        if (d.rounds.length >= 5) renderSummary();
        else newRound("daily");
      } else if (act === "practice" || act === "practice-next") {
        newRound("practice");
      } else if (act === "call" && round) {
        renderReveal(b.dataset.call);
      } else if (act === "copy") {
        const d = dailyState();
        const you = d.rounds.filter((r) => r.you).length;
        const f = d.rounds.filter((r) => r.formula).length;
        const called = d.rounds.filter((r) => r.fc !== false).length;
        const fPart = called < d.rounds.length ? `${f}/${called} called` : `${f}/${d.rounds.length}`;
        const text = `Crosscheck Daily 5 (${d.date}) — Me ${you}/5 · Formula ${fPart}. Same five mysteries for everyone: github.com/EvanDRas/crosscheck`;
        try {
          navigator.clipboard.writeText(text);
          b.textContent = "Copied";
          setTimeout(() => { b.textContent = "Copy result"; }, 1500);
        } catch {
          window.prompt("Copy your result:", text);
        }
      } else if (act === "reset") {
        score.you = 0; score.formula = 0; score.rounds = 0;
        saveScore(score);
        renderHome();
      }
    });

    renderHome();
  };
})();
