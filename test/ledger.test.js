import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertFirstPerDay, aggregateLedger } from "../lib/ledger.js";

const entry = (over = {}) => ({
  t: "2026-08-03T20:00:00.000Z",
  date: "2026-08-03",
  ticker: "AAPL",
  price: 300,
  spy: 640,
  score: 67,
  verdict: "BUY",
  confidence: "High",
  formulaVersion: "v1",
  ...over,
});

test("first call per ticker per day wins; repeats are rejected", () => {
  let state = upsertFirstPerDay([], entry({ price: 300 }));
  assert.equal(state.added, true);
  state = upsertFirstPerDay(state.entries, entry({ price: 999, score: 12, verdict: "SELL" }));
  assert.equal(state.added, false, "same ticker+day must not re-log");
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].price, 300, "original call is never revised");
});

test("different day or different ticker logs normally", () => {
  let state = upsertFirstPerDay([], entry());
  state = upsertFirstPerDay(state.entries, entry({ ticker: "MSFT" }));
  state = upsertFirstPerDay(state.entries, entry({ date: "2026-08-04" }));
  assert.equal(state.entries.length, 3);
});

test("aggregates bucket by verdict in band order and skip ungraded rows", () => {
  const rows = [
    { verdict: "BUY", ret: 0.10, excess: 0.04 },
    { verdict: "BUY", ret: 0.02, excess: -0.02 },
    { verdict: "SELL", ret: -0.05, excess: -0.08 },
    { verdict: "STRONG BUY", ret: 0.2, excess: 0.1 },
    { verdict: "HOLD", ret: null, excess: null }, // not re-priced yet
  ];
  const agg = aggregateLedger(rows);
  assert.deepEqual(agg.map((a) => a.verdict), ["STRONG BUY", "BUY", "SELL"], "band order, HOLD skipped (ungraded)");
  const buy = agg.find((a) => a.verdict === "BUY");
  assert.equal(buy.n, 2);
  assert.ok(Math.abs(buy.avgReturn - 0.06) < 1e-12);
  assert.ok(Math.abs(buy.avgExcess - 0.01) < 1e-12);
  assert.equal(buy.winRateVsSpy, 0.5);
});

test("empty ledger aggregates to an empty list", () => {
  assert.deepEqual(aggregateLedger([]), []);
});

test("aggregateLedger excludes same-day and raw-basis rows from the published stats", () => {
  const rows = [
    { verdict: "BUY", ret: 0.05, excess: 0.05, ageDays: 0, basis: "tr" },   // same day — no time has passed
    { verdict: "BUY", ret: 0.09, excess: 0.09, ageDays: 10, basis: "raw" }, // price-only — breaks across splits
    { verdict: "BUY", ret: 0.01, excess: 0.01, ageDays: 10, basis: "tr" },  // the only honest row
  ];
  const agg = aggregateLedger(rows);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].verdict, "BUY");
  assert.equal(agg[0].n, 1); // the excluded rows never inflate the count
  assert.equal(agg[0].avgExcess, 0.01);
  assert.equal(agg[0].winRateVsSpy, 1);
});
