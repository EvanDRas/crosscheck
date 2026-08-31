// "Since you last looked": a compact snapshot of each analyzed ticker is
// kept locally (data/snapshots.json, gitignored) so the next visit can open
// with what actually CHANGED — score moved, a filing landed, insiders sold —
// instead of making the user re-read the whole page to find out.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marketDate } from "./analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "snapshots.json");

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Pure: reduce a full analyze payload to the fields worth diffing.
export function takeSnapshot(payload) {
  const s = payload.scoring ?? {};
  const m = payload.metrics ?? {};
  return {
    at: payload.asOf,
    score: s.score ?? null,
    verdict: s.verdict ?? null,
    // Per-category scores so a score move can be ATTRIBUTED, not just noted.
    cats: Object.fromEntries((s.categories ?? [])
      .filter((c) => typeof c.score === "number" && Number.isFinite(c.score))
      .map((c) => [c.label, Math.round(c.score)])),
    // The raw inputs behind those categories, so an attribution can say what
    // HAPPENED in plain English instead of making the reader decode numbers.
    drivers: (() => {
      const pick = (k) => (typeof m[k] === "number" && Number.isFinite(m[k]) ? m[k] : null);
      return {
        pe: pick("pe"), ps: pick("ps"), peg: pick("peg"),
        netMargin: pick("netMargin"), roe: pick("roe"),
        revenueGrowth: pick("revenueGrowth"), epsGrowth: pick("epsGrowth"),
        currentRatio: pick("currentRatio"), debtEquity: pick("debtEquity"),
        pricePosition: pick("pricePosition"),
        analystTilt: (() => {
          const t = (s.categories ?? []).find((c) => c.key === "analyst")?.details?.find((d) => d.key === "analystTilt")?.value;
          return typeof t === "number" && Number.isFinite(t) ? t : null;
        })(),
      };
    })(),
    pe: m.pe ?? null,
    netMargin: m.netMargin ?? null,
    revenueGrowth: m.revenueGrowth ?? null,
    latestFiling: payload.filings?.[0] ? { form: payload.filings[0].form, filed: payload.filings[0].filed } : null,
    insiderSells: payload.insiders?.sells?.count ?? null,
    insiderBuys: payload.insiders?.buys?.count ?? null,
    nextEarnings: payload.nextEarnings?.date ?? null,
  };
}

// Turn a category's score move into one plain-English clause: which input
// moved the most, what that MEANS, and the numbers as evidence in brackets.
// Each entry: [driver key, formatter, story(up)] — first match wins.
const CATEGORY_STORIES = {
  Valuation: [
    ["pe", (v) => `${v.toFixed(1)}\u00d7`, (up) => (up ? "the price grew faster than earnings" : "earnings caught up to the price")],
    ["ps", (v) => `${v.toFixed(1)}\u00d7`, (up) => (up ? "the price grew faster than sales" : "sales caught up to the price")],
    ["peg", (v) => `${v.toFixed(1)}\u00d7`, (up) => (up ? "the price now costs more per unit of growth" : "growth caught up to the price")],
  ],
  Profitability: [
    ["netMargin", (v) => `${v.toFixed(1)}%`, (up) => (up ? "the company kept more of each sales dollar" : "the company kept less of each sales dollar")],
    ["roe", (v) => `${v.toFixed(1)}%`, (up) => (up ? "profit on the owners' capital improved" : "profit on the owners' capital fell")],
  ],
  Growth: [
    ["revenueGrowth", (v) => `${v.toFixed(1)}%`, (up) => (up ? "sales growth picked up" : "sales growth cooled")],
    ["epsGrowth", (v) => `${v.toFixed(1)}%`, (up) => (up ? "earnings growth picked up" : "earnings growth cooled")],
  ],
  "Financial health": [
    ["currentRatio", (v) => v.toFixed(2), (up) => (up ? "the short-term cash cushion got thicker" : "the short-term cash cushion thinned")],
    ["debtEquity", (v) => v.toFixed(2), (up) => (up ? "more of the company is now funded by debt" : "the debt load lightened relative to the owners' stake")],
  ],
  Momentum: [
    ["pricePosition", (v) => `${Math.round(v * 100)}% of range`, (up) => (up ? "the stock climbed toward its 52-week high" : "the stock slid toward its 52-week low")],
  ],
  "Analyst view": [
    ["analystTilt", (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} on \u22122\u2026+2`, (up) => (up ? "analysts leaned more bullish" : "analysts leaned less bullish")],
  ],
};

// Meaningful-change floor per driver, as a relative move (or absolute for
// the bounded ones), so tiny wiggles don't get narrated as events.
function driverMoved(key, a, b) {
  if (key === "pricePosition") return Math.abs(b - a) >= 0.05;
  if (key === "analystTilt") return Math.abs(b - a) >= 0.15;
  const base = Math.max(Math.abs(a), 1e-9);
  return Math.abs(b - a) / base >= 0.04;
}

// Drivers where UP is bad for the category score — the story must agree
// with the direction of the move it claims to explain.
const BAD_WHEN_UP = new Set(["pe", "ps", "peg", "debtEquity"]);

function explainCategoryMove(label, prevDrivers, currDrivers, catDelta) {
  const stories = CATEGORY_STORIES[label];
  if (!stories || !prevDrivers || !currDrivers) return "";
  let best = null;
  for (const [key, fmt, story] of stories) {
    const a = prevDrivers[key];
    const b = currDrivers[key];
    if (typeof a !== "number" || typeof b !== "number" || !driverMoved(key, a, b)) continue;
    if (typeof catDelta === "number" && catDelta !== 0) {
      const implied = BAD_WHEN_UP.has(key) ? b < a : b > a;
      if (implied !== catDelta > 0) continue; // this driver moved the OTHER way
    }
    const rel = Math.abs(b - a) / Math.max(Math.abs(a), 1e-9);
    if (!best || rel > best.rel) best = { rel, text: `${story(b > a)} (${fmt(a)} \u2192 ${fmt(b)})` };
  }
  return best ? ` \u2014 ${best.text}` : "";
}

// Pure: human-readable changes between two snapshots. Exported for tests.
export function diffSnapshots(prev, curr) {
  if (!prev) return [];
  const out = [];
  const num = (v) => typeof v === "number" && Number.isFinite(v);

  if (num(prev.score) && num(curr.score) && Math.abs(curr.score - prev.score) >= 1) {
    const verdictBit = prev.verdict !== curr.verdict ? ` (${prev.verdict} → ${curr.verdict})` : "";
    // Tell the story of the move, not just the arithmetic: name the moving
    // categories AND what happened in the world to move them.
    let why = "";
    if (prev.cats && curr.cats) {
      const movers = Object.keys(curr.cats)
        .filter((k) => num(prev.cats[k]) && Math.abs(curr.cats[k] - prev.cats[k]) >= 1)
        .sort((a, b) => Math.abs(curr.cats[b] - prev.cats[b]) - Math.abs(curr.cats[a] - prev.cats[a]))
        .slice(0, 2)
        .map((k) => `${k} ${prev.cats[k]} → ${curr.cats[k]}${explainCategoryMove(k, prev.drivers, curr.drivers, curr.cats[k] - prev.cats[k])}`);
      if (movers.length) why = `: ${movers.join("; ")}`;
    }
    if (!why) {
      // Migration path: snapshots saved before the app recorded categories
      // still carry three legacy metrics — narrate from those when one
      // moved in the same direction as the score, and say "likely" because
      // we can't see the full category picture.
      const scoreUp = curr.score > prev.score;
      const legacy = [
        ["pe", prev.pe, curr.drivers?.pe ?? curr.pe, "Valuation"],
        ["netMargin", prev.netMargin, curr.drivers?.netMargin ?? curr.netMargin, "Profitability"],
        ["revenueGrowth", prev.revenueGrowth, curr.drivers?.revenueGrowth ?? curr.revenueGrowth, "Growth"],
      ];
      let best = null;
      for (const [key, a, b, label] of legacy) {
        if (!num(a) || !num(b) || !driverMoved(key, a, b)) continue;
        const implied = BAD_WHEN_UP.has(key) ? b < a : b > a;
        if (implied !== scoreUp) continue;
        const rel = Math.abs(b - a) / Math.max(Math.abs(a), 1e-9);
        const [, fmt, story] = CATEGORY_STORIES[label].find(([k]) => k === key);
        if (!best || rel > best.rel) best = { rel, text: `${story(b > a)} (${fmt(a)} → ${fmt(b)})` };
      }
      if (best) why = ` — likely because ${best.text}`;
      else if (!prev.cats) why = " — the older snapshot didn't record why; from now on, changes get explained";
    }
    out.push(`Score ${Math.round(prev.score)} → ${Math.round(curr.score)}${verdictBit}${why}`);
  } else if (prev.verdict && curr.verdict && prev.verdict !== curr.verdict) {
    out.push(`Verdict ${prev.verdict} → ${curr.verdict}`);
  }
  // Positive P/Es only — a negative P/E isn't a meaningful ratio, and a
  // signed denominator would silently mute every move from one.
  if (num(prev.pe) && num(curr.pe) && prev.pe > 0 && curr.pe > 0 && Math.abs(curr.pe - prev.pe) / prev.pe >= 0.1) {
    out.push(`P/E ${prev.pe.toFixed(1)}× → ${curr.pe.toFixed(1)}×`);
  }
  if (num(prev.netMargin) && num(curr.netMargin) && Math.abs(curr.netMargin - prev.netMargin) >= 1) {
    out.push(`Net margin ${prev.netMargin.toFixed(1)}% → ${curr.netMargin.toFixed(1)}%`);
  }
  if (num(prev.revenueGrowth) && num(curr.revenueGrowth) && Math.abs(curr.revenueGrowth - prev.revenueGrowth) >= 2) {
    out.push(`Revenue growth ${prev.revenueGrowth.toFixed(1)}% → ${curr.revenueGrowth.toFixed(1)}%`);
  }
  if (curr.latestFiling && (!prev.latestFiling || curr.latestFiling.filed > prev.latestFiling.filed)) {
    out.push(`New SEC filing: ${curr.latestFiling.form} on ${curr.latestFiling.filed}`);
  }
  if (num(prev.insiderSells) && num(curr.insiderSells) && curr.insiderSells > prev.insiderSells) {
    out.push(`Insider sells in the last 3 months: ${prev.insiderSells} → ${curr.insiderSells}`);
  }
  if (num(prev.insiderBuys) && num(curr.insiderBuys) && curr.insiderBuys > prev.insiderBuys) {
    out.push(`Insider buys in the last 3 months: ${prev.insiderBuys} → ${curr.insiderBuys}`);
  }
  if (curr.nextEarnings && prev.nextEarnings !== curr.nextEarnings) {
    out.push(`Next earnings date: ${curr.nextEarnings}`);
  }
  return out;
}

// Update the stored snapshot and return the changes since the previous
// DIFFERENT-day visit (same-day revisits are noise, not news).
export function updateSnapshot(ticker, payload) {
  const all = readAll();
  const prev = all[ticker] ?? null;
  const curr = takeSnapshot(payload);
  // "Day" means the MARKET's day (America/New_York), same rule as the
  // ledger — a 9 PM ET revisit is the same day, not tomorrow-in-UTC.
  const dayOf = (snap) => (snap?.at ? marketDate(new Date(snap.at)) : null);
  const prevDay = dayOf(prev);
  const currDay = dayOf(curr);
  let changes = [];
  let lastSeen = null;
  if (prevDay && prevDay !== currDay) {
    changes = diffSnapshots(prev, curr);
    lastSeen = prevDay;
  }
  // Same-day revisit: keep the OLDER snapshot as the baseline so tomorrow's
  // diff compares against the last different day, not five minutes ago.
  if (!prev || prevDay !== currDay) {
    all[ticker] = curr;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(all, null, 1));
    } catch {}
  }
  return { changes, lastSeen };
}
