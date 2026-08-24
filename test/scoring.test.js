import { test } from "node:test";
import assert from "node:assert/strict";
import { piecewise, computeVerdict, computeHorizons, scoreEarningsExecution, verdictForScore, analystTilt, WEIGHTS } from "../lib/scoring.js";
import { titleTokens, isNearDuplicate, dedupeAndSort, coreCompanyName, relevanceTerms, isRelevant } from "../lib/news.js";

test("piecewise hits anchors exactly and interpolates between them", () => {
  const anchors = [[0, 0], [10, 50], [20, 100]];
  assert.equal(piecewise(0, anchors), 0);
  assert.equal(piecewise(10, anchors), 50);
  assert.equal(piecewise(5, anchors), 25);
  assert.equal(piecewise(15, anchors), 75);
});

test("piecewise clamps outside the anchor range and rejects non-numbers", () => {
  const anchors = [[0, 0], [10, 100]];
  assert.equal(piecewise(-5, anchors), 0);
  assert.equal(piecewise(50, anchors), 100);
  assert.equal(piecewise(null, anchors), null);
  assert.equal(piecewise(undefined, anchors), null);
  assert.equal(piecewise(NaN, anchors), null);
});

test("verdict band boundaries are exact (v2 percentile-calibrated)", () => {
  assert.equal(verdictForScore(74), "STRONG BUY");
  assert.equal(verdictForScore(73.9), "BUY");
  assert.equal(verdictForScore(66), "BUY");
  assert.equal(verdictForScore(65.9), "HOLD");
  assert.equal(verdictForScore(55), "HOLD");
  assert.equal(verdictForScore(54.9), "SELL");
  assert.equal(verdictForScore(47), "SELL");
  assert.equal(verdictForScore(46.9), "STRONG SELL");
});

test("analyst tilt: unanimous strong buy maps to 100, unanimous strong sell to 0", () => {
  const allBuy = computeVerdict({ analystTilt: analystTilt({ strongBuy: 10, buy: 0, hold: 0, sell: 0, strongSell: 0 }), netMargin: 10 });
  assert.equal(allBuy.categories.find((c) => c.key === "analyst").score, 100);
  const allSell = computeVerdict({ analystTilt: analystTilt({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 10 }), netMargin: 10 });
  assert.equal(allSell.categories.find((c) => c.key === "analyst").score, 0);
  assert.equal(analystTilt(null), null);
  assert.equal(analystTilt({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }), null);
});

const healthyLargeCap = {
  pe: 18, ps: 3, peg: 1.2,
  netMargin: 24, roe: 32,
  revenueGrowth: 14, epsGrowth: 20,
  currentRatio: 1.8, debtEquity: 0.5,
  pricePosition: 0.75,
  analystTilt: 1.2,
};

test("healthy large-cap sample lands in BUY territory with high confidence", () => {
  const r = computeVerdict(healthyLargeCap);
  assert.equal(r.insufficientData, false);
  assert.equal(r.availableCount, 6);
  assert.equal(r.confidence, "High");
  assert.ok(r.score >= 58 && r.score <= 90, `score ${r.score} should land in the upper bands`);
  assert.ok(["BUY", "STRONG BUY"].includes(r.verdict));
});

test("distressed sample lands in SELL territory", () => {
  const r = computeVerdict({
    pe: 65, ps: 12, peg: 4.5,
    netMargin: -8, roe: -15,
    revenueGrowth: -12, epsGrowth: -25,
    currentRatio: 0.7, debtEquity: 3.5,
    pricePosition: 0.05,
    analystTilt: -1.1,
  });
  assert.ok(r.score < 42, `score ${r.score} should land in the bottom bands`);
  assert.ok(["SELL", "STRONG SELL"].includes(r.verdict));
});

test("missing categories renormalize weights instead of dragging the score", () => {
  const r = computeVerdict({
    netMargin: 24, roe: 32,
    currentRatio: 1.8, debtEquity: 0.5,
    revenueGrowth: 10, epsGrowth: 12,
    pricePosition: 0.6,
  });
  assert.equal(r.availableCount, 4);
  assert.equal(r.confidence, "Medium");
  const score = (key) => r.categories.find((c) => c.key === key).score;
  const wsum = WEIGHTS.profitability + WEIGHTS.health + WEIGHTS.growth + WEIGHTS.momentum;
  const expected = (score("profitability") * WEIGHTS.profitability + score("health") * WEIGHTS.health
    + score("growth") * WEIGHTS.growth + score("momentum") * WEIGHTS.momentum) / wsum;
  assert.ok(Math.abs(r.score - expected) < 0.06, `renormalized mean ${expected} vs ${r.score}`);
});

test("fewer than four categories yields no verdict — the display floor matches the ledger's logging floor", () => {
  const r = computeVerdict({ netMargin: 24, roe: 32, currentRatio: 1.8, debtEquity: 0.5 });
  assert.equal(r.availableCount, 2);
  assert.equal(r.insufficientData, true);
  assert.equal(r.score, null);
});

test("negative P/E and PEG are excluded, not scored as cheap", () => {
  const r = computeVerdict({ pe: -12, peg: -0.5, ps: 2, netMargin: 5 });
  const val = r.categories.find((c) => c.key === "valuation");
  assert.equal(val.details.find((d) => d.key === "pe").score, null);
  assert.equal(val.details.find((d) => d.key === "peg").score, null);
  assert.notEqual(val.details.find((d) => d.key === "ps").score, null);
});

test("fewer than two categories means no verdict, not a fake one", () => {
  const r = computeVerdict({ pricePosition: 0.9 });
  assert.equal(r.insufficientData, true);
  assert.equal(r.score, null);
  assert.equal(r.verdict, null);
  const empty = computeVerdict({});
  assert.equal(empty.insufficientData, true);
});

test("news dedupe collapses near-identical headlines and keeps the newest first", () => {
  const items = [
    { headline: "Apple beats Q3 earnings expectations on iPhone strength", source: "Reuters", date: "2026-08-01T10:00:00Z", link: "a", summary: "" },
    { headline: "Apple beats earnings expectations on iPhone strength in Q3", source: "Yahoo Finance", date: "2026-08-01T09:00:00Z", link: "b", summary: "richer summary" },
    { headline: "Microsoft announces new datacenter region", source: "CNBC", date: "2026-08-02T10:00:00Z", link: "c", summary: "" },
  ];
  const out = dedupeAndSort(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].link, "c");
  assert.equal(out[1].link, "a");
  assert.equal(out[1].summary, "richer summary", "dupe's summary should be adopted");
});

test("earnings execution: perfect beats score high, misses score low, no data is null", () => {
  const q = (actual, estimate, surprisePercent) => ({ actual, estimate, surprisePercent });
  const strong = scoreEarningsExecution([q(2, 1.8, 8), q(2, 1.9, 5), q(2, 1.7, 10), q(2, 1.95, 3)]);
  assert.ok(strong.score >= 80, `4/4 beats with big surprises should score high, got ${strong.score}`);
  const weak = scoreEarningsExecution([q(1, 1.5, -30), q(1, 1.4, -25), q(1, 1.3, -20), q(1, 1.2, -15)]);
  assert.ok(weak.score <= 20, `0/4 beats should score low, got ${weak.score}`);
  assert.equal(scoreEarningsExecution([]), null);
  assert.equal(scoreEarningsExecution([{ actual: 1, estimate: null }]), null);
});

test("horizon views split a value-trap profile: long-term above near-term", () => {
  // Cheap, profitable, healthy — but momentum dead and analysts bearish.
  const r = computeVerdict({
    pe: 8, ps: 0.9, peg: 0.8,
    netMargin: 18, roe: 22,
    revenueGrowth: 4, epsGrowth: 6,
    currentRatio: 2.1, debtEquity: 0.4,
    pricePosition: 0.06,
    analystTilt: -0.8,
  });
  const [nt, lt] = computeHorizons(r.categories, scoreEarningsExecution([
    { actual: 1, estimate: 1.2, surprisePercent: -16 },
    { actual: 1, estimate: 1.1, surprisePercent: -9 },
  ]));
  assert.equal(nt.key, "nearTerm");
  assert.equal(lt.key, "longTerm");
  assert.ok(lt.score - nt.score >= 25, `LT ${lt.score} should sit far above NT ${nt.score}`);
  assert.ok(["BUY", "STRONG BUY"].includes(lt.verdict));
  assert.ok(["SELL", "STRONG SELL"].includes(nt.verdict));
});

test("horizon weights renormalize over available components", () => {
  // Only momentum available on the near-term side; no analyst, no earnings.
  const r = computeVerdict({ pricePosition: 0.85, netMargin: 20, roe: 25 });
  const [nt, lt] = computeHorizons(r.categories, null);
  const momentum = r.categories.find((c) => c.key === "momentum").score;
  assert.equal(nt.score, momentum, "single component = its own score");
  assert.equal(nt.confidence, "Low");
  const prof = r.categories.find((c) => c.key === "profitability").score;
  assert.equal(lt.score, prof, "LT has only profitability available");
});

test("horizons with nothing available return an insufficient state, not a verdict", () => {
  const r = computeVerdict({ netMargin: 20, roe: 25, currentRatio: 2 });
  const [nt] = computeHorizons(r.categories, null);
  assert.equal(nt.insufficientData, true);
  assert.equal(nt.verdict, null);
});

// Distinct headlines: each carries three tokens unique to it, so dedupe can
// never merge two of them (shared tokens stay under both similarity floors).
const mkItem = (i, source, prefix, date) => ({
  headline: `${prefix} story ${prefix}${i}a ${prefix}${i}b unique${i} briefing`,
  source,
  date,
  link: `${prefix}${i}`,
  summary: "",
});

test("one live-wire source cannot flood the feed when other sources have stories", () => {
  // 20 fresh Yahoo items (newest) + 12 older items from distinct publishers.
  const flood = Array.from({ length: 20 }, (_, i) => mkItem(i, "Yahoo Finance", "wire", new Date(Date.UTC(2026, 7, 3, 12, 59 - i)).toISOString()));
  const others = Array.from({ length: 12 }, (_, i) => mkItem(i, `Publisher ${i}`, "pub", new Date(Date.UTC(2026, 7, 2, 12, 30 - i)).toISOString()));
  const out = dedupeAndSort([...flood, ...others], 15, 5);
  assert.equal(out.length, 15);
  assert.equal(out.filter((n) => n.source === "Yahoo Finance").length, 5, "flood source capped at 5");
  assert.equal(out.filter((n) => n.source.startsWith("Publisher")).length, 10, "other sources fill the rest");
});

test("the cap relaxes via backfill when there are too few unique stories", () => {
  const flood = Array.from({ length: 8 }, (_, i) => mkItem(i, "Yahoo Finance", "wire", new Date(Date.UTC(2026, 7, 3, 12, 59 - i)).toISOString()));
  const one = mkItem(15, "Reuters", "reu", "2026-08-01T10:00:00Z");
  const out = dedupeAndSort([...flood, one], 15, 5);
  assert.equal(out.length, 9, "nothing wasted: all unique stories shown");
  assert.ok(out.some((n) => n.source === "Reuters"));
});

test("dissimilar headlines are not merged", () => {
  const a = titleTokens("Apple beats Q3 earnings expectations");
  const b = titleTokens("Apple sued over App Store policies in Europe");
  assert.equal(isNearDuplicate(a, b), false);
});

test("core company name strips legal suffixes down to the headline form", () => {
  assert.equal(coreCompanyName("Apple Inc"), "Apple");
  assert.equal(coreCompanyName("The Coca-Cola Co"), "Coca-Cola");
  assert.equal(coreCompanyName("Walt Disney Co"), "Walt Disney");
  assert.equal(coreCompanyName("Ford Motor Co"), "Ford Motor");
  assert.equal(coreCompanyName("Berkshire Hathaway Inc Class B"), "Berkshire Hathaway");
  assert.equal(coreCompanyName("General Electric Company"), "General Electric");
  assert.equal(coreCompanyName(""), "");
});

test("news relevance: items must actually mention the company or ticker", () => {
  const tsla = relevanceTerms("TSLA", "Tesla Inc");
  // The real case that motivated this: a SpaceX story filed under TSLA.
  assert.equal(isRelevant({ headline: "Elon Musk issues ominous warning as SpaceX short interest hits danger zone", summary: "Bearish bets spike ahead of the company's first earnings report (NASDAQ: SPCX)." }, tsla), false);
  assert.equal(isRelevant({ headline: "Tesla shares jump after delivery beat", summary: "" }, tsla), true);
  assert.equal(isRelevant({ headline: "Musk's pay package back in court", summary: "The ruling could affect Tesla's board." }, tsla), true);
  assert.equal(isRelevant({ headline: "EV startups struggle as $TSLA tightens its grip", summary: "" }, tsla), true);

  const ge = relevanceTerms("GE", "General Electric Company");
  // "General" and "Electric" alone are generic; the full name or the ticker must appear.
  assert.equal(isRelevant({ headline: "GE Aerospace lands record engine order", summary: "" }, ge), true);
  assert.equal(isRelevant({ headline: "General election polls tighten in electric-vehicle debate", summary: "" }, ge), false);
  assert.equal(isRelevant({ headline: "How to manage sales surges", summary: "" }, ge), false, "lowercase 'surGEs' must not match the GE ticker");

  const ford = relevanceTerms("F", "Ford Motor Co");
  assert.equal(isRelevant({ headline: "Ford recalls 100k trucks", summary: "" }, ford), true);
  assert.equal(isRelevant({ headline: "Fear and greed index flashes F for markets", summary: "" }, ford), false, "1-letter tickers never match as bare tokens");
});
