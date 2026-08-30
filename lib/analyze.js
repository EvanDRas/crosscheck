// The full analysis pipeline for one ticker, extracted from the server route
// so both the web server and the batch logger (scripts/batch_log.js) run the
// exact same code path — same data, same scoring, same ledger logging rules.

import {
  getQuote,
  getProfile,
  getMetrics,
  getRecommendations,
  getEarnings,
  getPeers,
  getInsiderTransactions,
  getEarningsCalendar,
  FinnhubError,
} from "./finnhub.js";
import { aggregateNews } from "./news.js";
import { computeVerdict, computeHorizons, scoreEarningsExecution, analystTilt, SCORING_VERSION } from "./scoring.js";
import { getHistory } from "./history.js";
import { getCompanyFacts, computeEdgarMetrics, mergeMetrics, computeTrajectory, getRecentFilings } from "./edgar.js";
import { getTiingoHistory, hasTiingoKey } from "./tiingo.js";
import { logVerdict } from "./ledger.js";
import { getQuoteCached } from "./quotes.js";

// Thrown when neither Finnhub nor the local datasets know the ticker.
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
  }
}

// The ledger's day is the MARKET's day (America/New_York), not UTC — a call
// made Thursday 8:30 PM ET must not be stamped Friday and graded against a
// close the caller never saw. en-CA formatting yields YYYY-MM-DD.
export const marketDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

// Returns the full payload the frontend renders. Throws FinnhubError when the
// key/rate-limit state makes the whole request pointless, NotFoundError when
// the ticker doesn't exist anywhere. `log: false` skips the verdict ledger;
// `includeNews: false` skips the RSS/news fetches entirely (scoring never uses
// news — the batch logger runs 50 tickers and shouldn't hit Google/Yahoo 50×).
export async function analyzeTicker(ticker, { apiKey, log = true, includeNews = true } = {}) {
  // Phase 1 — identity. Quote + profile (Finnhub, if a key exists) and the
  // local price history decide whether the ticker exists and whether the
  // key/rate-limit state makes the whole request pointless. Without a key
  // the app still serves the local chart + keyless news sources.
  const noKey = Promise.reject(new Error("no key"));
  noKey.catch(() => {});
  const [quoteR, profileR, historyR] = await Promise.allSettled([
    apiKey ? getQuote(ticker, apiKey) : noKey,
    apiKey ? getProfile(ticker, apiKey) : noKey,
    getHistory(ticker),
  ]);
  if (apiKey) {
    for (const r of [quoteR, profileR]) {
      if (r.status === "rejected" && r.reason instanceof FinnhubError && [401, 403, 429].includes(r.reason.status)) {
        throw r.reason;
      }
    }
  }
  const quote = quoteR.status === "fulfilled" ? quoteR.value : null;
  const profile = profileR.status === "fulfilled" ? profileR.value : null;
  let history = historyR.status === "fulfilled" ? historyR.value : null;

  // Local data covers S&P names with a daily-updated panel; everything else
  // falls to a static archive or nothing. Tiingo's live adjusted closes fill
  // that gap when a token is configured. Failures keep whatever we had.
  if (!history?.updatesDaily && hasTiingoKey()) {
    try {
      const th = await getTiingoHistory(ticker);
      if (th) history = th;
    } catch {
      /* keep local result; Tiingo free-tier limits must never break the page */
    }
  }

  const hasQuote = quote && (quote.c || quote.pc);
  // With a key, no quote/profile/history means the symbol is bogus. WITHOUT
  // a key, SEC EDGAR alone can still produce fundamentals + a verdict, so
  // the not-found decision waits until after phase 2 checks EDGAR.
  const identityMissing = !profile?.name && !hasQuote && !history;
  if (identityMissing && apiKey) {
    throw new NotFoundError(`No data found for "${ticker}". Double-check the symbol (US-listed tickers work best on the free tier).`);
  }

  const warnings = [];
  if (!apiKey) {
    warnings.push("No Finnhub key yet — showing SEC-filing fundamentals, price history, and free news only. Paste a free finnhub.io key into the setup card at the top of the front page for live quotes, analysts, and earnings.");
  } else {
    if (quoteR.status === "rejected") warnings.push(`Live quote unavailable (${quoteR.reason?.message ?? "error"})`);
    if (profileR.status === "rejected") warnings.push(`Company profile unavailable (${profileR.reason?.message ?? "error"})`);
  }
  if (historyR.status === "rejected") warnings.push(`Local price history unavailable (${historyR.reason?.message ?? "error"})`);

  // Phase 2 — everything else in parallel; each source may fail alone.
  // EDGAR needs no key at all, so keyless mode now gets real fundamentals too.
  const tasks = [
    ["SEC EDGAR fundamentals", getCompanyFacts(ticker)],
    ["SEC filings feed", getRecentFilings(ticker)],
  ];
  if (includeNews) {
    tasks.push(["news", aggregateNews({ ticker, companyName: profile?.name, apiKey })]);
  }
  if (apiKey) {
    tasks.push(
      ["fundamentals", getMetrics(ticker, apiKey)],
      ["analyst ratings", getRecommendations(ticker, apiKey)],
      ["earnings history", getEarnings(ticker, apiKey)],
      ["peer list", getPeers(ticker, apiKey)],
      ["SPY benchmark quote", getQuoteCached("SPY", apiKey)],
    );
    // Display extras ride the includeNews flag: interactive analyses get
    // them, the batch logger skips them (scoring never uses them, and the
    // batch must stay under the rate limit at ~7 calls/ticker).
    if (includeNews) {
      tasks.push(
        ["insider transactions", getInsiderTransactions(ticker, apiKey)],
        ["earnings calendar", getEarningsCalendar(ticker, apiKey)],
      );
    }
  }
  const settled = await Promise.allSettled(tasks.map(([, p]) => p));
  const results = {};
  tasks.forEach(([label], i) => {
    if (settled[i].status === "fulfilled") results[label] = settled[i].value;
    else warnings.push(`${label} unavailable (${settled[i].reason?.message ?? "error"})`);
  });

  const metricRaw = results["fundamentals"]?.metric ?? {};
  const recs = results["analyst ratings"] ?? null;
  const earningsRaw = results["earnings history"] ?? null;
  const peersRaw = results["peer list"] ?? null;
  const newsResult = results["news"] ?? null;
  if (newsResult?.failures?.length) warnings.push(...newsResult.failures);

  const pick = (...keys) => {
    for (const k of keys) {
      const v = metricRaw[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  };

  // Finnhub reports debt/equity inconsistently across listings (ratio vs
  // percent), and values above 20 are genuinely ambiguous: they can be a
  // percent (1.5 reported as 150) OR a real extreme ratio (buyback-shrunken
  // equity — AZO-style D/E of 30+ is real). Guessing rewrote true leverage
  // as healthy, so ambiguous values become null and the EDGAR cross-check
  // (a true as-filed ratio) fills the gap with provenance "SEC".
  const normalizeDE = (v) => (v == null || v > 20 ? null : v);

  const metrics = {
    pe: pick("peTTM", "peBasicExclExtraTTM", "peNormalizedAnnual", "peAnnual"),
    ps: pick("psTTM", "psAnnual"),
    pb: pick("pbQuarterly", "pbAnnual"),
    peg: pick("pegTTM", "pegRatio", "peg"),
    netMargin: pick("netProfitMarginTTM", "netProfitMarginAnnual", "netProfitMargin5Y"),
    roe: pick("roeTTM", "roeRfy", "roeAnnual", "roe5Y"),
    roa: pick("roaTTM", "roaRfy", "roaAnnual", "roa5Y"),
    revenueGrowth: pick("revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy", "revenueGrowth3Y"),
    epsGrowth: pick("epsGrowthTTMYoy", "epsGrowthQuarterlyYoy", "epsGrowth3Y"),
    currentRatio: pick("currentRatioQuarterly", "currentRatioAnnual"),
    debtEquity: normalizeDE(pick("totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual", "longTermDebt/equityQuarterly", "longTermDebt/equityAnnual")),
    dividendYield: pick("currentDividendYieldTTM", "dividendYieldIndicatedAnnual"),
    beta: pick("beta"),
    high52: pick("52WeekHigh"),
    low52: pick("52WeekLow"),
    high52Date: metricRaw["52WeekHighDate"] ?? null,
    low52Date: metricRaw["52WeekLowDate"] ?? null,
    pricePosition: null,
  };
  // Local research data fills 52-week gaps Finnhub leaves (or, with no key,
  // provides them entirely).
  if (history?.local52) {
    if (metrics.high52 == null) metrics.high52 = history.local52.high;
    if (metrics.low52 == null) metrics.low52 = history.local52.low;
  }
  const price = hasQuote ? quote.c : history?.last?.close ?? null;
  if (price && metrics.high52 != null && metrics.low52 != null && metrics.high52 > metrics.low52) {
    metrics.pricePosition = Math.min(1, Math.max(0, (price - metrics.low52) / (metrics.high52 - metrics.low52)));
  }

  // Merge EDGAR-derived fundamentals: fill Finnhub's gaps, flag disagreements.
  let metricProvenance = {};
  let edgarThrough = null;
  let trajectory = null;
  const factsDoc = results["SEC EDGAR fundamentals"] ?? null;
  if (identityMissing && !factsDoc) {
    throw new NotFoundError(`"${ticker}" wasn't found in SEC filings or the local price data. Double-check the symbol — or add a free Finnhub key (setup screen) for full coverage.`);
  }
  if (factsDoc) {
    trajectory = computeTrajectory(factsDoc);
  }
  if (factsDoc) {
    const edgar = computeEdgarMetrics(factsDoc, {
      price,
      marketCapUsd: profile?.marketCapitalization != null ? profile.marketCapitalization * 1e6 : null,
    });
    if (edgar) {
      const { merged, provenance } = mergeMetrics(metrics, edgar.metrics, warnings);
      Object.assign(metrics, merged);
      metricProvenance = provenance;
      edgarThrough = edgar.dataThrough;
    }
  }

  // Ratings LEVEL is permanently buy-skewed (measured — see EVIDENCE.md),
  // but the DRIFT carries information: we keep the last 6 monthly snapshots
  // Finnhub already sends instead of discarding all but the latest.
  const analystHistory = (Array.isArray(recs) ? recs.slice(0, 6) : [])
    .map((r) => ({
      period: r.period ?? null,
      strongBuy: r.strongBuy ?? 0,
      buy: r.buy ?? 0,
      hold: r.hold ?? 0,
      sell: r.sell ?? 0,
      strongSell: r.strongSell ?? 0,
      tilt: analystTilt(r),
    }))
    .reverse(); // oldest first for display

  const latestRec = Array.isArray(recs) && recs.length ? recs[0] : null;
  const analystTrends = latestRec
    ? {
        period: latestRec.period,
        strongBuy: latestRec.strongBuy ?? 0,
        buy: latestRec.buy ?? 0,
        hold: latestRec.hold ?? 0,
        sell: latestRec.sell ?? 0,
        strongSell: latestRec.strongSell ?? 0,
        total: (latestRec.strongBuy ?? 0) + (latestRec.buy ?? 0) + (latestRec.hold ?? 0) + (latestRec.sell ?? 0) + (latestRec.strongSell ?? 0),
      }
    : null;

  const earnings = (Array.isArray(earningsRaw) ? earningsRaw : [])
    .slice(0, 4)
    .map((e) => ({
      period: e.period ?? null,
      quarter: e.quarter ?? null,
      year: e.year ?? null,
      actual: e.actual ?? null,
      estimate: e.estimate ?? null,
      surprisePercent: e.surprisePercent ?? null,
      beat: e.actual != null && e.estimate != null ? e.actual >= e.estimate : null,
    }));

  const peers = (Array.isArray(peersRaw) ? peersRaw : [])
    .filter((p) => typeof p === "string" && p && p !== ticker)
    .slice(0, 8);

  // Insider activity: open-market purchases (P) and sales (S) only — gifts,
  // option exercises, and tax withholding aren't conviction signals.
  const insiderRaw = results["insider transactions"]?.data;
  let insiders = null;
  if (Array.isArray(insiderRaw)) {
    const open = insiderRaw.filter((t) => !t.isDerivative
      && (t.transactionCode === "P" || t.transactionCode === "S")
      && typeof t.change === "number" && t.change !== 0);
    const agg = (list) => ({
      count: list.length,
      shares: list.reduce((a, t) => a + Math.abs(t.change), 0),
      value: list.reduce((a, t) => a + Math.abs(t.change) * (t.transactionPrice || 0), 0),
    });
    insiders = {
      windowDays: 92,
      buys: agg(open.filter((t) => t.transactionCode === "P")),
      sells: agg(open.filter((t) => t.transactionCode === "S")),
      recent: open
        .sort((a, b) => (b.transactionDate ?? "").localeCompare(a.transactionDate ?? ""))
        .slice(0, 6)
        .map((t) => ({
          name: t.name,
          action: t.transactionCode === "P" ? "BUY" : "SELL",
          shares: Math.abs(t.change),
          price: t.transactionPrice || null,
          date: t.transactionDate,
        })),
    };
  }

  // Next scheduled earnings report — a known volatility event worth seeing
  // BEFORE money moves, not after. Undated entries are dropped (they'd sort
  // first and null the whole card) and past dates are excluded.
  const calRaw = results["earnings calendar"]?.earningsCalendar;
  let nextEarnings = null;
  if (Array.isArray(calRaw) && calRaw.length) {
    const todayNy = marketDate();
    const next = calRaw
      .filter((e) => e?.date && e.date >= todayNy)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next?.date) {
      nextEarnings = {
        date: next.date,
        hour: next.hour || null,
        epsEstimate: next.epsEstimate ?? null,
        revenueEstimate: next.revenueEstimate ?? null,
      };
    }
  }

  const scoring = computeVerdict({
    pe: metrics.pe,
    ps: metrics.ps,
    peg: metrics.peg,
    netMargin: metrics.netMargin,
    roe: metrics.roe,
    revenueGrowth: metrics.revenueGrowth,
    epsGrowth: metrics.epsGrowth,
    currentRatio: metrics.currentRatio,
    debtEquity: metrics.debtEquity,
    pricePosition: metrics.pricePosition,
    analystTilt: analystTilt(analystTrends),
  });
  scoring.horizons = computeHorizons(scoring.categories, scoreEarningsExecution(earnings));

  // Share-class sanity: a quote orders of magnitude outside the vendor's own
  // 52-week range means the fundamentals feed is for a different share class
  // (BRK.B vs BRK.A). The formula stays frozen — this is a labeling warning.
  const okNum = (v) => typeof v === "number" && Number.isFinite(v);
  if (okNum(price) && okNum(metrics.low52) && okNum(metrics.high52) && metrics.low52 > 0
      && (price < metrics.low52 / 5 || price > metrics.high52 * 5)) {
    warnings.push("The quoted price sits far outside the vendor's 52-week range — this looks like data for a different share class; range, momentum, and EPS-estimate figures may be unreliable for this ticker.");
  }

  const payload = {
    demo: false,
    ticker,
    asOf: new Date().toISOString(),
    quote: hasQuote
      ? { price: quote.c, change: quote.d, changePercent: quote.dp, previousClose: quote.pc, open: quote.o, high: quote.h, low: quote.l }
      : null,
    profile: profile?.name
      ? {
          name: profile.name,
          logo: profile.logo || "",
          exchange: profile.exchange || "",
          industry: profile.finnhubIndustry || "",
          marketCap: profile.marketCapitalization ?? null, // millions USD
          ipo: profile.ipo || "",
          website: profile.weburl || "",
          currency: profile.currency || "USD",
        }
      : null,
    metrics,
    metricProvenance,
    edgarThrough,
    trajectory,
    filings: results["SEC filings feed"] ?? null,
    history,
    analystTrends,
    analystHistory,
    earnings,
    nextEarnings,
    insiders,
    peers,
    news: newsResult?.items ?? [],
    scoring,
    warnings,
  };

  // A half-failed analysis (fundamentals 429'd, quote failed) must not be
  // cached as truth or frozen into the ledger as the day's permanent call.
  payload.degraded = Boolean(apiKey && (quoteR.status === "rejected" || !results["fundamentals"]));

  // Forward test: log the call (append-only, first per ticker per day).
  // Only real, fully-priced, non-degraded verdicts with at least 4 scored
  // categories enter the ledger — a rate-limited moment shouldn't get to
  // write history.
  payload.logged = false;
  if (log && apiKey && scoring.verdict && hasQuote && !payload.degraded && scoring.availableCount >= 4) {
    try {
      const nt = scoring.horizons.find((h) => h.key === "nearTerm");
      const lt = scoring.horizons.find((h) => h.key === "longTerm");
      payload.logged = logVerdict({
        t: payload.asOf,
        date: marketDate(),
        ticker,
        price: quote.c,
        spy: results["SPY benchmark quote"]?.c ?? null,
        score: scoring.score,
        verdict: scoring.verdict,
        confidence: scoring.confidence,
        ntVerdict: nt?.verdict ?? null,
        ntScore: nt?.score ?? null,
        ltVerdict: lt?.verdict ?? null,
        ltScore: lt?.score ?? null,
        formulaVersion: SCORING_VERSION,
      });
    } catch (err) {
      warnings.push(`verdict ledger write failed (${err.message})`);
    }
  }

  return payload;
}
