import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreCompanyName, relevanceTerms, isRelevant,
  titleTokens, isNearDuplicate, dedupeAndSort, impactScore,
} from "../lib/news.js";

// ---------- company-name core ----------

test("coreCompanyName strips legal suffixes, keeps the identity", () => {
  assert.equal(coreCompanyName("Apple Inc"), "Apple");
  assert.equal(coreCompanyName("The Coca-Cola Company"), "Coca-Cola");
  assert.equal(coreCompanyName("Berkshire Hathaway Inc Class B"), "Berkshire Hathaway");
  assert.equal(coreCompanyName("Visa Inc."), "Visa");
});

// ---------- relevance: the Snapple rule ----------

const aapl = relevanceTerms("AAPL", "Apple Inc");

test("isRelevant refuses partial-word name hits (Snapple is not Apple)", () => {
  assert.equal(isRelevant({ headline: "Snapple sales jump on new flavors" }, aapl), false);
  assert.equal(isRelevant({ headline: "Pineapple imports hit record highs" }, aapl), false);
});

test("isRelevant accepts the name at word boundaries, possessives included", () => {
  assert.equal(isRelevant({ headline: "Apple's iPhone event set for Tuesday" }, aapl), true);
  assert.equal(isRelevant({ headline: "Analysts weigh in on Apple" }, aapl), true);
});

test("isRelevant treats the ticker as a token, case-sensitively", () => {
  assert.equal(isRelevant({ headline: "$AAPL climbs after upgrade" }, aapl), true);
  assert.equal(isRelevant({ headline: "Why AAPL is on watchlists" }, aapl), true);
  assert.equal(isRelevant({ headline: "the aapl of my eye" }, aapl), false); // lowercase is prose, not a symbol
});

// ---------- near-duplicate detection ----------

test("isNearDuplicate matches the same story reworded, not different stories", () => {
  const a = titleTokens("Fed holds interest rates steady in September decision");
  const b = titleTokens("Fed holds rates steady at September decision");
  const c = titleTokens("Oracle stock surges on cloud revenue outlook");
  assert.equal(isNearDuplicate(a, b), true);
  assert.equal(isNearDuplicate(a, c), false);
});

// ---------- dedupeAndSort: honest covered counting ----------

const D0 = "2026-09-10T12:00:00.000Z"; // fixture dates only — nothing reads the clock
const D0_SAME_DAY = "2026-09-10T15:00:00.000Z";
const D7_AGO = "2026-09-03T12:00:00.000Z";
const item = (headline, source, date, extra = {}) => ({ headline, source, date, link: `https://x.test/${encodeURIComponent(headline)}`, summary: "", ...extra });

test("one outlet's recurring template headline cannot inflate covered", () => {
  const out = dedupeAndSort([
    item("Daily market wrap: stocks end mixed", "TemplateWire", D0),
    item("Daily market wrap: stocks end mixed", "TemplateWire", D7_AGO),
  ], 10, 5);
  assert.equal(out.length, 1); // still collapsed — repeats never flood the feed
  assert.equal(out[0].covered ?? 1, 1); // but they don't count as breadth
});

test("two distinct outlets on the same day count as 2 covered", () => {
  const out = dedupeAndSort([
    item("Fed holds interest rates steady in September decision", "Reuters", D0),
    item("Fed holds rates steady at September decision", "CNBC", D0_SAME_DAY),
  ], 10, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].covered, 2);
});

test("a distinct outlet a week late still collapses but no longer counts", () => {
  const out = dedupeAndSort([
    item("Fed holds interest rates steady in September decision", "Reuters", D0),
    item("Fed holds rates steady at September decision", "SlowBlog", D7_AGO),
  ], 10, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].covered ?? 1, 1); // outside the 48h window
});

test("syndicated copies keep merging after the list fills", () => {
  const out = dedupeAndSort([
    item("Oracle stock surges on cloud revenue outlook", "MarketWatch", D0),
    item("Treasury yields tick higher ahead of auction", "CNBC", D0),
    item("Oracle shares surge on cloud revenue outlook", "Reuters", D0_SAME_DAY), // dupe of #1, arrives after fill
  ], 1, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].covered, 2); // the late copy merged instead of vanishing
});

test("no single source floods the list while others wait", () => {
  const out = dedupeAndSort([
    item("Story one about oil markets", "LoudWire", D0),
    item("Story two about bond yields", "LoudWire", "2026-09-10T11:00:00.000Z"),
    item("Story three about gold prices", "QuietWire", "2026-09-10T10:00:00.000Z"),
  ], 2, 1);
  assert.deepEqual(out.map((it) => it.source).sort(), ["LoudWire", "QuietWire"]);
});

test("dedupeAndSort strips '- Source' suffixes and internal bookkeeping", () => {
  const out = dedupeAndSort([item("Fed holds rates steady - Reuters", "Reuters", D0)], 10, 5);
  assert.equal(out[0].headline, "Fed holds rates steady");
  assert.ok(!("_tokens" in out[0]) && !("_srcs" in out[0])); // internals never reach the JSON payload
});

test("a summary that just repeats the headline is blanked", () => {
  const out = dedupeAndSort([item("Oil prices jump 3%", "CNBC", D0, { summary: "Oil prices jump 3%" })], 10, 5);
  assert.equal(out[0].summary, "");
});

// ---------- impact heuristic ----------

test("impactScore: 'default' only reads as market-moving in debt contexts", () => {
  assert.equal(impactScore({ headline: "Windows changes the default browser settings", source: "SomeBlog" }), 0);
  assert.ok(impactScore({ headline: "Argentina defaults on its debt", source: "SomeBlog" }) >= 2);
});

test("impactScore: mega-cap earnings rate a notch, macro topics rate two", () => {
  assert.equal(impactScore({ headline: "Nvidia earnings beat expectations", source: "SomeBlog" }), 1);
  assert.equal(impactScore({ headline: "CPI inflation cools to 2.9%", source: "SomeBlog" }), 2);
  assert.equal(impactScore({ headline: "CPI inflation cools to 2.9%", source: "Reuters", covered: 4 }), 4); // capped
});
