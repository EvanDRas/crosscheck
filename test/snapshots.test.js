import { test } from "node:test";
import assert from "node:assert/strict";
import { takeSnapshot, diffSnapshots } from "../lib/snapshots.js";

const payload = (over = {}) => ({
  asOf: "2026-08-08T14:00:00.000Z",
  scoring: { score: 67.3, verdict: "BUY" },
  metrics: { pe: 35.0, netMargin: 27.6, revenueGrowth: 14.2 },
  filings: [{ form: "10-Q", filed: "2026-07-31", label: "", url: "" }],
  insiders: { sells: { count: 1 }, buys: { count: 0 } },
  nextEarnings: { date: "2026-10-28" },
  ...over,
});

test("takeSnapshot reduces a payload to the diffable fields", () => {
  const s = takeSnapshot(payload());
  assert.equal(s.score, 67.3);
  assert.equal(s.verdict, "BUY");
  assert.equal(s.latestFiling.filed, "2026-07-31");
  assert.equal(s.insiderSells, 1);
  assert.equal(s.nextEarnings, "2026-10-28");
});

test("diffSnapshots reports score/verdict moves, new filings, insider changes", () => {
  const prev = takeSnapshot(payload());
  const curr = takeSnapshot(payload({
    scoring: { score: 58.1, verdict: "HOLD" },
    filings: [{ form: "8-K", filed: "2026-08-07", label: "", url: "" }],
    insiders: { sells: { count: 4 }, buys: { count: 0 } },
  }));
  const changes = diffSnapshots(prev, curr);
  assert.ok(changes.some((c) => c.includes("Score 67 → 58") && c.includes("BUY → HOLD")), changes.join("|"));
  assert.ok(changes.some((c) => c.includes("New SEC filing: 8-K on 2026-08-07")), changes.join("|"));
  assert.ok(changes.some((c) => c.includes("Insider sells") && c.includes("1 → 4")), changes.join("|"));
});

test("diffSnapshots tells the story of a score move, not just the numbers", () => {
  const prev = takeSnapshot(payload({
    scoring: { score: 67.3, verdict: "BUY", categories: [
      { label: "Valuation", score: 62 }, { label: "Growth", score: 80 }, { label: "Momentum", score: 55 },
    ] },
    metrics: { pe: 35.0, netMargin: 27.6, revenueGrowth: 14.2 },
  }));
  const curr = takeSnapshot(payload({
    scoring: { score: 61.0, verdict: "BUY", categories: [
      { label: "Valuation", score: 44 }, { label: "Growth", score: 79 }, { label: "Momentum", score: 55 },
    ] },
    metrics: { pe: 44.0, netMargin: 27.6, revenueGrowth: 14.2 },
  }));
  const changes = diffSnapshots(prev, curr);
  const line = changes.find((c) => c.startsWith("Score"));
  assert.ok(line.includes("Valuation 62 → 44"), line);
  assert.ok(line.includes("the price grew faster than earnings"), line);
  assert.ok(line.includes("35.0") && line.includes("44.0"), line);
  assert.ok(!line.includes("Momentum"), line); // unmoved categories stay out
});

test("diffSnapshots narrates from legacy metrics when the old snapshot has no categories", () => {
  // A pre-upgrade snapshot: score + the three legacy metrics, no cats/drivers.
  const prev = { at: "2026-08-24T14:00:00.000Z", score: 75, verdict: "STRONG BUY", pe: 33.0, netMargin: 35.0, revenueGrowth: 14.0 };
  const curr = takeSnapshot(payload({
    scoring: { score: 76.2, verdict: "STRONG BUY", categories: [{ label: "Valuation", score: 48 }] },
    metrics: { pe: 30.5, netMargin: 35.0, revenueGrowth: 14.0 },
  }));
  const line = diffSnapshots(prev, curr).find((c) => c.startsWith("Score"));
  assert.ok(line.includes("likely because earnings caught up to the price"), line);
});

test("diffSnapshots admits when the older snapshot recorded no cause", () => {
  const prev = { at: "2026-08-24T14:00:00.000Z", score: 75, verdict: "STRONG BUY" };
  const curr = takeSnapshot(payload({ scoring: { score: 76.2, verdict: "STRONG BUY", categories: [] } }));
  const line = diffSnapshots(prev, curr).find((c) => c.startsWith("Score"));
  assert.ok(line.includes("older snapshot didn't record why"), line);
});

test("diffSnapshots stays quiet when nothing meaningful moved", () => {
  const prev = takeSnapshot(payload());
  const curr = takeSnapshot(payload({ scoring: { score: 67.8, verdict: "BUY" } })); // +0.5 < threshold
  assert.deepEqual(diffSnapshots(prev, curr), []);
  assert.deepEqual(diffSnapshots(null, curr), []);
});
