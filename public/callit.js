"use strict";

// "Right or Wrong?" — the daily game, built from the forward test's own
// graded calls. Each round is a REAL call the formula already made
// (ticker, date, verdict, score); the player judges whether it turned out
// right or wrong against the S&P. The whole day's rounds arrive in one
// request and play instantly — no API calls during play, nothing to fail.
//
// Strategy is the thesis: the formula runs near a coin flip, so "wrong"
// is the statistically smart default — and the reveals teach direction-
// aware grading (a SELL is right when the stock TRAILS the market).
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

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

  const verdictClass = (v) => ({ "STRONG BUY": "v-strongbuy", BUY: "v-buy", HOLD: "v-hold", SELL: "v-sell", "STRONG SELL": "v-strongsell" }[v] ?? "v-nodata");
  const exc = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : "—");

  // One pack per day, one fetch, cached locally.
  let dailyPack = null;
  async function getDailyPack() {
    const day = localDay();
    if (dailyPack?.day === day) return dailyPack;
    const cached = readJSON("cc_daily5_pack", null);
    if (cached?.day === day && Array.isArray(cached.rounds) && cached.rounds.length === 5) {
      dailyPack = cached;
      return cached;
    }
    const res = await fetch("/api/daily5");
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? "Could not load today's five.");
    dailyPack = body;
    writeJSON("cc_daily5_pack", body);
    return body;
  }

  window.mountCallIt = function mountCallIt(root, { compact = false } = {}) {
    if (!root) return;
    let mode = "daily";
    let round = null;
    let busy = false;
    const usedPractice = new Set();
    const score = readScore();

    const dailyState = () => {
      const d = readJSON("cc_callit_daily", null);
      if (d?.date !== localDay()) return { date: localDay(), rounds: [] };
      d.rounds = (Array.isArray(d.rounds) ? d.rounds : []).filter((r) => /^[A-Z]{1,6}(\.[AB])?$/.test(r?.t ?? "")).slice(0, 5);
      return d;
    };

    // Playing the daily is what keeps the streak alive.
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
        <span><b>All-time</b> you're right ${score.you} of ${score.rounds}</span>
        ${score.rounds ? `<button type="button" class="callit-reset" data-act="reset">reset</button>` : ""}
      </div>`;

    function renderHome(msg) {
      const d = dailyState();
      if (d.rounds.length >= 5) return renderSummary(msg);
      root.innerHTML = `
        <div class="callit-daily-head"><b>Right or wrong?</b> · call ${d.rounds.length + 1} of 5 · the same five for everyone today</div>
        <p class="callit-lead">Five real calls the formula already made — you judge each one: did it turn out
        <b>right</b> or <b>wrong</b> against the S&amp;P? A buy is right when the stock beat the market; a sell
        is right when it trailed.</p>
        ${compact ? "" : `<p class="callit-note">Strategy hint: the formula's live record runs near a coin flip —
        "wrong" is the statistically smart default, and knowing that is the whole lesson.</p>`}
        ${msg ? `<p class="callit-msg">${esc(msg)}</p>` : ""}
        ${scoreLine()}
        <div class="callit-btns">
          <button type="button" class="callit-btn primary" data-act="daily">${d.rounds.length ? "Next call" : "Play today's five"}</button>
          <button type="button" class="callit-btn" data-act="practice">Practice</button>
        </div>`;
    }

    function renderSummary(msg) {
      const d = dailyState();
      const you = d.rounds.filter((r) => r.you).length;
      const f = d.rounds.filter((r) => r.fr).length;
      root.innerHTML = `
        <div class="callit-daily-head"><b>Today's five — done.</b> You judged ${you}/5 correctly.</div>
        <p class="callit-note">The formula itself was right on ${f} of these ${d.rounds.length} calls${f <= 2 ? " — that's the point: today's numbers don't know the future" : ""}.</p>
        <div class="callit-daily-rows">
          ${d.rounds.map((r, i) => `<span class="callit-day-row">${i + 1}. ${esc(r.t)} <b class="${r.you ? "pos" : "neg"}">${r.you ? "✓" : "✗"}</b></span>`).join("")}
        </div>
        ${msg ? `<p class="callit-msg">${esc(msg)}</p>` : ""}
        <div class="callit-btns">
          <button type="button" class="callit-btn primary" data-act="copy">Copy result</button>
          <button type="button" class="callit-btn" data-act="practice">Practice</button>
        </div>
        ${scoreLine()}
        <p class="callit-note">A new five drops tomorrow.</p>`;
    }

    function renderRound() {
      const d = dailyState();
      root.innerHTML = `
        <div class="callit-head"><b>${mode === "daily" ? `Call ${Math.min(d.rounds.length + 1, 5)} of 5` : "Practice call"}</b></div>
        <div class="callit-call">
          <div class="callit-call-line">On <b>${esc(round.date)}</b> the formula scored <b class="callit-tkr">${esc(round.ticker)}</b>
            ${isNum(round.score) ? `<b>${Math.round(round.score)}/100</b>` : ""} and said</div>
          <div class="callit-call-verdict"><span class="verdict-pill ${verdictClass(round.verdict)}">${esc(round.verdict)}</span></div>
          <div class="callit-call-line">${round.ageDays} days later — did that call turn out right?</div>
        </div>
        <div class="callit-btns">
          <button type="button" class="callit-btn" data-act="call" data-call="right">Right</button>
          <button type="button" class="callit-btn" data-act="call" data-call="wrong">Wrong</button>
        </div>`;
    }

    function renderReveal(yourCall) {
      const youRight = (yourCall === "right") === Boolean(round.right);
      score.rounds += 1;
      if (youRight) score.you += 1;
      saveScore(score);
      let nextLabel = "Next practice call";
      if (mode === "daily") {
        const d = dailyState();
        d.rounds.push({ t: round.ticker, d: round.date, you: youRight, fr: Boolean(round.right) });
        writeJSON("cc_callit_daily", d);
        bumpPlayStreak();
        nextLabel = d.rounds.length >= 5 ? "See today's result" : "Next call";
      }
      const sell = /SELL/.test(round.verdict ?? "");
      const moved = `${esc(round.ticker)} went <b>${exc(round.excessPct)}</b> vs the S&amp;P over those ${round.ageDays} days`;
      const why = round.right
        ? (sell ? "it trailed the market, so the sell call was RIGHT" : "it beat the market, so the buy call was RIGHT")
        : (sell ? "it beat the market, so the sell call was WRONG" : "it trailed the market, so the buy call was WRONG");
      root.innerHTML = `
        <div class="callit-head"><b>${esc(round.ticker)}</b> · called ${esc(round.verdict)} on ${esc(round.date)}</div>
        <div class="callit-reveal">
          <div class="callit-outcome ${youRight ? "pos" : "neg"}">You were <b>${youRight ? "right" : "wrong"}</b>.</div>
          <p class="callit-note">${moved} — ${why}. <a href="/#${esc(round.ticker)}">Open ${esc(round.ticker)} today →</a></p>
        </div>
        <button type="button" class="callit-btn primary" data-act="${mode === "daily" ? "daily" : "practice"}">${esc(nextLabel)}</button>`;
    }

    async function play(m) {
      if (busy) return;
      mode = m;
      busy = true;
      root.innerHTML = `<p class="callit-msg">Loading…</p>`;
      try {
        const pack = await getDailyPack();
        if (m === "daily") {
          const d = dailyState();
          round = pack.rounds[d.rounds.length];
          busy = false;
          if (!round) return renderSummary();
          return renderRound();
        }
        const pool = (pack.practice ?? []).filter((r) => !usedPractice.has(r.ticker + r.date));
        if (!pool.length) {
          busy = false;
          return renderHome("You've been through every graded practice call — impressive. More age in tomorrow.");
        }
        round = pool[Math.floor(Math.random() * pool.length)];
        usedPractice.add(round.ticker + round.date);
        busy = false;
        renderRound();
      } catch (err) {
        busy = false;
        renderHome(err.message);
      }
    }

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "daily") {
        const d = dailyState();
        if (d.rounds.length >= 5) renderSummary();
        else play("daily");
      } else if (act === "practice") {
        play("practice");
      } else if (act === "call" && round) {
        renderReveal(b.dataset.call);
      } else if (act === "copy") {
        const d = dailyState();
        const you = d.rounds.filter((r) => r.you).length;
        const f = d.rounds.filter((r) => r.fr).length;
        const text = `Crosscheck daily (${d.date}) — I judged the formula's calls ${you}/5. The formula itself was right on ${f}/5. Same five for everyone: github.com/EvanDRas/crosscheck`;
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
