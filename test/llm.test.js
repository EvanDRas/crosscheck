import test from "node:test";
import assert from "node:assert/strict";
import { shapeHistory, llmStatus } from "../lib/llm.js";

test("shapeHistory coerces roles, drops empties, keeps order", () => {
  const out = shapeHistory([
    { role: "user", text: "first" },
    { role: "hacker", text: "second" }, // unknown role → user
    { role: "assistant", text: "   " }, // whitespace → dropped
    { role: "assistant", text: "answer" },
  ]);
  // the two user turns are consecutive after the drop → coalesced
  assert.deepEqual(out, [
    { role: "user", content: "first\n\nsecond" },
    { role: "assistant", content: "answer" },
  ]);
});

test("shapeHistory never lets the transcript start with the assistant", () => {
  const out = shapeHistory([
    { role: "assistant", text: "orphaned answer" },
    { role: "user", text: "question" },
  ]);
  assert.deepEqual(out, [{ role: "user", content: "question" }]);
});

test("shapeHistory clamps message count from the tail so the newest question survives", () => {
  const raw = [];
  for (let i = 0; i < 20; i++) raw.push({ role: i % 2 ? "assistant" : "user", text: `m${i}` });
  raw.push({ role: "user", text: "the actual question" });
  const out = shapeHistory(raw, { maxMessages: 7 });
  assert.ok(out.length <= 7);
  assert.equal(out[out.length - 1].content.includes("the actual question"), true);
  assert.equal(out[0].role, "user");
});

test("shapeHistory clamps content length and survives junk input", () => {
  const out = shapeHistory([{ role: "user", text: "x".repeat(5000) }], { maxChars: 100 });
  assert.equal(out[0].content.length, 100);
  assert.deepEqual(shapeHistory(null), []);
  assert.deepEqual(shapeHistory([{ role: "user" }, { text: 42, role: "user" }]), [{ role: "user", content: "42" }]);
});

test("llmStatus prefers the Anthropic key and honors the model override", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedModel = process.env.ANTHROPIC_MODEL;
  try {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    delete process.env.ANTHROPIC_MODEL;
    let st = await llmStatus(true);
    assert.equal(st.provider, "anthropic");
    assert.ok(st.model.startsWith("claude-"));
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    st = await llmStatus(true);
    assert.equal(st.model, "claude-sonnet-5");
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = savedModel;
  }
});

test("llmStatus reports disabled when there is no key and no Ollama", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedUrl = process.env.OLLAMA_URL;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    // Point the probe at a port nothing listens on so the test can't be
    // flipped by a real Ollama install on the machine running it.
    process.env.OLLAMA_URL = "http://127.0.0.1:9";
    const st = await llmStatus(true);
    assert.equal(st.provider, null);
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = savedUrl;
  }
});
