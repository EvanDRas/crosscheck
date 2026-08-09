// The Time Machine: reconstruct what the formula would have said about a
// ticker on a past date using ONLY information knowable that day, then grade
// the frozen call against everything that happened since. Powers both the
// in-app feature (/api/timemachine) and scripts/pit_verdict.mjs.
//
// Honesty rules:
//  - Fundamentals: SEC EDGAR facts filtered to filings SUBMITTED on or
//    before the date (filing lag included — no look-ahead).
//  - Prices: through the date only (Tiingo). Market cap uses the latest
//    filed share count, split-scaled via the unadjusted/adjusted ratio.
//  - Analyst ratings + earnings estimates have no free historical source:
//    those categories are MISSING and weights renormalize, same as live.
//  - Split-safety deviations, disclosed: P/E = marketCap / NI-TTM, and
//    earnings growth = NI-TTM growth (as-filed per-share figures change
//    units across splits).
//  - Grading is total-return (adjusted closes) vs SPY over the same window.

import { getCompanyFacts, filterFactsAsOf, computeEdgarMetrics, quarterlySeries, ttm, latestInstant } from "./edgar.js";
import { getTiingoDaily } from "./tiingo.js";
import { getSpyTrSeries, spyTrReturn } from "./spy.js";
import { computeVerdict } from "./scoring.js";

const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
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

export async function pointInTimeCall(ticker, D) {
  const notes = [];
  const rows = await getTiingoDaily(ticker, iso(Date.parse(D) - 500 * DAY));
  if (!rows || rows.length < 150) throw new Error("not enough price history for that ticker/date");
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
  // unadjusted/adjusted ratio (dividend drift pollutes ~1%/yr — acceptable).
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
    notes.push("no share count on file by that date — valuation category degraded");
  }

  const edgar = computeEdgarMetrics(pit, { marketCapUsd, asOf: Date.parse(D) });
  if (!edgar) throw new Error(`filings too stale/absent as of ${D} (SEC XBRL coverage starts ~2010)`);
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
