// Point-in-time verdict: reconstruct what the formula would have said on a
// past date using ONLY information knowable that day, then grade the call
// against what actually happened since.
//
//   node scripts/pit_verdict.mjs META 2022-11-01 NVDA 2023-01-03 ...
//
// Honesty rules:
//  - Fundamentals come from SEC EDGAR filtered to filings SUBMITTED on or
//    before the as-of date (filing lag included — no look-ahead).
//  - Prices through the as-of date only (Tiingo). Market cap at D uses the
//    latest filed share count, scaled by the split factor implied by the
//    unadjusted/adjusted price ratio between filing and D.
//  - Analyst ratings and earnings estimates have no free historical source:
//    those categories are MISSING and the formula renormalizes, same as live.
//  - Two split-safety deviations from the live formula, disclosed: P/E is
//    computed as marketCap / net-income-TTM, and EPS growth as net-income-TTM
//    growth (as-filed per-share figures change units across splits).
//  - Grading is total-return (adjusted closes) vs SPY over the same window.
//
// A handful of runs is an anecdote, not a backtest. The point of this tool is
// that each guess is frozen to a date and graded by reality — run enough of
// them across tickers and dates and it becomes an honest partial backtest of
// 5 of the formula's 6 categories (~85% of its weight).

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { getCompanyFacts, filterFactsAsOf, computeEdgarMetrics, quarterlySeries, ttm, latestInstant } = await import("../lib/edgar.js");
const { getTiingoDaily, hasTiingoKey } = await import("../lib/tiingo.js");
const { getSpyTrSeries, spyTrReturn } = await import("../lib/spy.js");
const { computeVerdict } = await import("../lib/scoring.js");

const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const pct = (v) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const rowOn = (rows, date) => {
  let best = null;
  for (const r of rows) {
    if (r.date <= date) best = r;
    else break;
  }
  return best;
};
const unitEntries = (facts, tax, names, unit) => {
  for (const n of names) {
    const u = facts?.facts?.[tax]?.[n]?.units?.[unit];
    if (Array.isArray(u) && u.length) return u;
  }
  return null;
};

async function pointInTimeCall(ticker, D) {
  const notes = [];
  const rows = await getTiingoDaily(ticker, iso(Date.parse(D) - 500 * DAY));
  if (!rows || rows.length < 150) throw new Error("not enough Tiingo price history");
  const dRow = rowOn(rows, D);
  if (!dRow) throw new Error(`no price on/before ${D}`);

  // 52-week position from adjusted closes ending at D.
  const windowStart = iso(Date.parse(dRow.date) - 366 * DAY);
  const win = rows.filter((r) => r.date > windowStart && r.date <= dRow.date).map((r) => r.adj);
  let pricePosition = null;
  if (win.length >= 150) {
    const hi = Math.max(...win);
    const lo = Math.min(...win);
    if (hi > lo) pricePosition = Math.min(1, Math.max(0, (dRow.adj - lo) / (hi - lo)));
  }

  // Fundamentals knowable on D.
  const factsAll = await getCompanyFacts(ticker);
  if (!factsAll) throw new Error("not an SEC filer");
  const pit = filterFactsAsOf(factsAll, D);

  // Market cap at D: latest filed share count, split-scaled to D via the
  // unadjusted/adjusted ratio (dividend drift pollutes this by ~1%/yr — fine).
  let marketCapUsd = null;
  const sharesInst = latestInstant(unitEntries(pit, "dei", ["EntityCommonStockSharesOutstanding"], "shares"));
  if (sharesInst && dRow.close != null) {
    const fRow = rowOn(rows, sharesInst.end) ?? dRow;
    let factor = 1;
    if (fRow.close != null && fRow.adj && dRow.adj) {
      factor = (fRow.close / fRow.adj) / (dRow.close / dRow.adj);
      if (!Number.isFinite(factor) || factor <= 0) factor = 1;
    }
    marketCapUsd = sharesInst.val * factor * dRow.close;
  } else {
    notes.push("no share count on file by D — valuation category degraded");
  }

  const edgar = computeEdgarMetrics(pit, { marketCapUsd, asOf: Date.parse(D) });
  if (!edgar) throw new Error(`filings too stale/absent as of ${D} (XBRL era starts ~2010)`);
  const m = { ...edgar.metrics };

  // Split-safe overrides (disclosed): P/E and earnings growth via NI dollars.
  const niQ = quarterlySeries(unitEntries(pit, "us-gaap", ["NetIncomeLoss", "ProfitLoss"], "USD"));
  const niTtm = ttm(niQ);
  if (marketCapUsd != null && niTtm && niTtm.val > 0) m.pe = marketCapUsd / niTtm.val;
  const niPrior = niTtm ? ttm(niQ, Date.parse(niTtm.end) - 350 * DAY) : null;
  m.epsGrowth = niTtm && niPrior && niPrior.val > 0 ? ((niTtm.val - niPrior.val) / niPrior.val) * 100 : null;

  const scoring = computeVerdict({
    pe: m.pe,
    ps: m.ps,
    peg: null,
    netMargin: m.netMargin,
    roe: m.roe,
    revenueGrowth: m.revenueGrowth,
    epsGrowth: m.epsGrowth,
    currentRatio: m.currentRatio,
    debtEquity: m.debtEquity,
    pricePosition,
    analystTilt: null,
  });

  // Grade: total return D -> latest, vs SPY over the same window.
  const latest = rows[rows.length - 1];
  const ret = (latest.adj - dRow.adj) / dRow.adj;
  const spy = await getSpyTrSeries("max");
  const spyRet = spy ? spyTrReturn(spy, dRow.date, latest.date) : null;
  const years = (Date.parse(latest.date) - Date.parse(dRow.date)) / (365.25 * DAY);

  return { ticker, D: dRow.date, scoring, m, pricePosition, ret, spyRet, latest: latest.date, years, edgarThrough: edgar.dataThrough, notes };
}

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error("usage: node scripts/pit_verdict.mjs TICKER YYYY-MM-DD [TICKER YYYY-MM-DD ...]");
  process.exit(1);
}
if (!hasTiingoKey()) {
  console.error("TIINGO_API_KEY required in .env");
  process.exit(1);
}

console.log("POINT-IN-TIME VERDICTS — only information filed/priced by each date; graded by what followed.");
console.log("Missing by necessity: analyst ratings + earnings estimates (no free history) -> weights renormalize.");
console.log("Split-safe deviations: P/E = mcap/NI-TTM; earnings growth = NI-TTM growth.\n");

const results = [];
for (let i = 0; i < args.length; i += 2) {
  const [ticker, D] = [args[i].toUpperCase(), args[i + 1]];
  try {
    const r = await pointInTimeCall(ticker, D);
    results.push(r);
    const s = r.scoring;
    const cats = s.categories.filter((c) => c.available).map((c) => `${c.label} ${c.score}`).join(", ");
    console.log(`${r.ticker} @ ${r.D}  (filings through ${r.edgarThrough})`);
    console.log(`  CALL: ${s.insufficientData ? "NOT ENOUGH DATA" : `${s.verdict} ${Math.round(s.score)}/100`} (${s.availableCount}/6 categories: ${cats})`);
    console.log(`  key inputs: P/E ${r.m.pe?.toFixed(1) ?? "n/a"} · P/S ${r.m.ps?.toFixed(1) ?? "n/a"} · margin ${r.m.netMargin?.toFixed(1) ?? "n/a"}% · revYoY ${r.m.revenueGrowth?.toFixed(1) ?? "n/a"}% · D/E ${r.m.debtEquity?.toFixed(2) ?? "n/a"} · 52w pos ${r.pricePosition == null ? "n/a" : Math.round(r.pricePosition * 100) + "%"}`);
    const excess = r.ret != null && r.spyRet != null ? r.ret - r.spyRet : null;
    console.log(`  SINCE (${r.years.toFixed(1)}y to ${r.latest}): stock ${pct(r.ret)} · SPY ${pct(r.spyRet)} · excess ${pct(excess)}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    console.log();
  } catch (err) {
    console.log(`${ticker} @ ${D}: SKIPPED — ${err.message}\n`);
  }
}

console.log(`${results.length} calls graded. Reminder: this is ${results.length} anecdotes, not a backtest — direction-vs-SPY only becomes evidence with hundreds of dated calls.`);
