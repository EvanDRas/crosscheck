// Optional AI explainer — the only feature in Crosscheck that calls a model
// instead of an API of record. Two providers, checked in order:
//   1. ANTHROPIC_API_KEY in .env  → Anthropic Messages API (paid, per-call)
//   2. a local Ollama server      → free, private, auto-detected
// No key and no Ollama → the feature reports itself disabled and the UI
// shows setup instructions instead of a broken form. The model never gets
// tools, never fetches anything, and only sees text this app assembled —
// its worst failure mode is a wrong sentence, which the UI labels possible.

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ollamaBase = () => process.env.OLLAMA_URL || "http://127.0.0.1:11434";

export class LlmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Provider detection is cached: the front page asks on every load, and
// probing a non-running Ollama costs a connection timeout each time.
let statusCache = { at: 0, value: null };
const STATUS_TTL_MS = 5 * 60_000;

export async function llmStatus(force = false) {
  if (!force && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }
  let value = { provider: null, model: null };
  if (process.env.ANTHROPIC_API_KEY) {
    value = { provider: "anthropic", model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL };
  } else {
    try {
      const r = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const data = await r.json();
        const names = (data?.models ?? []).map((m) => m?.name).filter(Boolean);
        const model = process.env.OLLAMA_MODEL || names[0];
        if (model) value = { provider: "ollama", model };
      }
    } catch { /* not running — stays disabled */ }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// Chat history arrives from the browser and is untrusted input: clamp
// lengths, coerce roles, merge consecutive same-role turns (the Anthropic
// API wants alternation), and never let the transcript start with the
// assistant. Pure — unit tested.
export function shapeHistory(raw, { maxMessages = 7, maxChars = 1500 } = {}) {
  const arr = Array.isArray(raw) ? raw : [];
  const shaped = [];
  for (const h of arr.slice(-maxMessages)) {
    const role = h?.role === "assistant" ? "assistant" : "user";
    const content = String(h?.text ?? "").trim().slice(0, maxChars);
    if (!content) continue;
    const prev = shaped[shaped.length - 1];
    if (prev && prev.role === role) prev.content += "\n\n" + content;
    else shaped.push({ role, content });
  }
  while (shaped.length && shaped[0].role === "assistant") shaped.shift();
  return shaped;
}

// A local model name the browser may pick (Ollama only — never the paid
// provider): letters, digits, and the punctuation Ollama tags use.
const OLLAMA_MODEL_RE = /^[\w][\w.:\/-]{0,80}$/;

export async function askLLM({ system, messages, maxTokens = 700, model }) {
  let st = await llmStatus();
  if (!st.provider) {
    throw new LlmError("No AI is configured — run Ollama locally, or add ANTHROPIC_API_KEY to .env.", 503);
  }
  if (st.provider === "ollama" && typeof model === "string" && OLLAMA_MODEL_RE.test(model)) {
    st = { ...st, model };
  }

  if (st.provider === "anthropic") {
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: st.model, max_tokens: maxTokens, system, messages }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new LlmError("Couldn't reach the Anthropic API — check your internet connection.", 502);
    }
    if (r.status === 401 || r.status === 403) {
      throw new LlmError("Anthropic rejected the key — check ANTHROPIC_API_KEY in .env.", 502);
    }
    if (r.status === 429) throw new LlmError("Anthropic rate limit hit — wait a moment and ask again.", 429);
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.json())?.error?.message ?? ""; } catch { /* body wasn't JSON */ }
      throw new LlmError(`Anthropic API error ${r.status}${detail ? ` — ${detail}` : ""}.`, 502);
    }
    const data = await r.json();
    const text = (data?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
    if (!text) throw new LlmError("The model returned an empty answer.", 502);
    return { text, provider: "anthropic", model: st.model };
  }

  // Ollama. Local models can be slow on modest hardware — generous timeout.
  let r;
  try {
    r = await fetch(`${ollamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: st.model,
        stream: false,
        messages: [{ role: "system", content: system }, ...messages],
        // Low temperature: this is grounded explanation, not creative
        // writing — small models wander off the data as temperature rises.
        options: { num_predict: maxTokens, temperature: 0.2 },
        // The first question pays the model-load (tens of seconds); keep it
        // warm for a conversation, then release the VRAM for games.
        keep_alive: "30m",
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    statusCache = { at: 0, value: null }; // it may have just been closed — re-probe next time
    throw new LlmError("Ollama stopped answering — is it still running?", 502);
  }
  if (!r.ok) {
    throw new LlmError(`Ollama error ${r.status} — try "ollama pull ${st.model}", or set OLLAMA_MODEL in .env to a model you have.`, 502);
  }
  const data = await r.json();
  const text = String(data?.message?.content ?? "").trim();
  if (!text) throw new LlmError("The local model returned an empty answer.", 502);
  return { text, provider: "ollama", model: st.model };
}
