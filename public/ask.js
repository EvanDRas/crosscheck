// Ask the data — shared card component. One implementation serves every
// page: the front page (market view), ticker pages (page brief + that
// stock's own record), and the Track record page (server-built ledger
// context). Loaded before app.js / ledger.js; exposes window.CCAsk.
"use strict";

window.CCAsk = (() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let status = null; // null until /api/ask/status answers

  async function loadStatus(fresh = false) {
    try {
      const r = await fetch(`/api/ask/status${fresh ? "?fresh=1" : ""}`);
      status = r.ok ? await r.json() : { enabled: false };
    } catch {
      status = { enabled: false };
    }
    return status;
  }

  const getStatus = () => status;

  function providerLabel() {
    if (!status?.enabled) return "";
    return status.provider === "anthropic" ? `Claude (${status.model})` : `${status.model} via Ollama, local`;
  }

  function privacyLine() {
    return status?.provider === "anthropic"
      ? "Each question sends this page's data to Anthropic under your key — nothing is sent until you ask."
      : "Everything stays on this PC — the model runs locally.";
  }

  // opts: { view, scope, chips, getContext?, getTicker? }
  // getContext returns the page's own brief (ticker view) or null when the
  // server builds the context itself (market, record).
  function buildCard(card, opts) {
    card.innerHTML = `
      <h2>Ask the data</h2>
      <p class="sub">Answers come only from ${opts.scope} — the AI is told to refuse predictions and advice, and it can still be wrong. ${privacyLine()} Model: ${esc(providerLabel())}.</p>
      <div class="ask-log" aria-live="polite"></div>
      <div class="ask-chips">${opts.chips.map((q) => `<button type="button" class="ask-chip">${esc(q)}</button>`).join("")}</div>
      <form class="ask-form">
        <input type="text" maxlength="1500" placeholder="Ask about what's on this page…" aria-label="Ask about the data on this page" />
        <button type="submit">Ask</button>
      </form>`;
    const log = card.querySelector(".ask-log");
    const form = card.querySelector(".ask-form");
    const input = form.querySelector("input");
    const btn = form.querySelector("button");
    const history = [];
    let busy = false;

    const push = (role, text, cls = "") => {
      const div = document.createElement("div");
      div.className = `ask-msg ${role}${cls ? ` ${cls}` : ""}`;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    };

    async function submit(q) {
      if (busy) return;
      const question = String(q ?? "").trim();
      if (!question) return;
      const context = opts.getContext ? opts.getContext() : null;
      if (opts.getContext && !context) return; // page data not ready yet
      busy = true;
      btn.disabled = true;
      input.value = "";
      push("user", question);
      const bubble = push("ai", "Thinking…", "pending");
      // A local model's first question includes loading it into the GPU —
      // honest waiting beats a silent stall.
      const slow = setTimeout(() => {
        if (bubble.classList.contains("pending")) {
          bubble.textContent = "Thinking… (the first question loads the model — up to half a minute; after that it's seconds)";
        }
      }, 6000);
      try {
        const body = { question, view: opts.view, history: history.slice(-6) };
        if (context) body.context = context;
        const ticker = opts.getTicker ? opts.getTicker() : null;
        if (ticker) body.ticker = ticker;
        const r = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `The explainer failed (${r.status}).`);
        bubble.classList.remove("pending");
        bubble.textContent = data.answer;
        history.push({ role: "user", text: question.slice(0, 500) },
                      { role: "assistant", text: String(data.answer).slice(0, 500) });
      } catch (err) {
        bubble.classList.remove("pending");
        bubble.classList.add("ask-err");
        bubble.textContent = err.message || "The explainer failed — try again.";
      } finally {
        clearTimeout(slow);
        busy = false;
        btn.disabled = false;
      }
    }

    form.addEventListener("submit", (e) => { e.preventDefault(); submit(input.value); });
    card.querySelectorAll(".ask-chip").forEach((b) => b.addEventListener("click", () => submit(b.textContent)));
    card.hidden = false;
  }

  // The disabled state: how to give the feature a brain. `onReady` re-mounts
  // the page's cards after a successful recheck.
  function setupHint(card, onReady) {
    const notRunning = status?.installed
      ? `<p class="sub"><b>Ollama is installed on this PC but not running.</b> Reopen Crosscheck from its
         desktop icon (it starts Ollama too), or launch Ollama from the Start menu — then hit Check again.</p>`
      : "";
    card.innerHTML = `
      <h2>Ask the data</h2>
      <p class="sub">An optional AI explainer can answer questions about whatever page you're reading —
      grounded in the app's own data, told to refuse predictions and advice. It's off until you give
      it a brain (your key, your machine, your choice):</p>
      ${notRunning}
      <ul class="ask-setup">
        <li><b>Ollama</b> (free, recommended) — nothing ever leaves your PC. Install from ollama.com, then run
          <code>ollama pull qwen2.5:14b</code> in a terminal (that model wants a gaming GPU with 12GB VRAM —
          on lighter machines pull <code>llama3.1:8b</code> or <code>llama3.2:3b</code> instead).
          Crosscheck finds it on its own.</li>
        <li><b>Anthropic API key</b> — the strongest answers; a question costs a fraction of a cent, and each
          question sends that page's data to Anthropic under your key. Get a key at
          console.anthropic.com, add <code>ANTHROPIC_API_KEY=sk-ant-…</code> to the <code>.env</code> file
          next to server.js, and restart the app.</li>
      </ul>
      <p class="sub" style="margin-bottom:0"><button type="button" class="ask-recheck">Check again</button></p>`;
    card.querySelector(".ask-recheck").addEventListener("click", async () => {
      await loadStatus(true);
      onReady();
    });
    card.hidden = false;
  }

  return { loadStatus, getStatus, buildCard, setupHint, providerLabel };
})();
