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
  if (!profile?.name && !hasQuote && !history) {
    throw new NotFoundError(
      apiKey
        ? `No data found for "${ticker}". Double-check the symbol (US-listed tickers work best on the free tier).`
        : `"${ticker}" not found in the local price datasets. Double-check the symbol — or add a Finnhub key to .env for full coverage.`
    );
  }

  const warnings = [];
  if (!apiKey) {
    warnings.push("No FINNHUB_API_KEY on the server — showing price history, free news, and SEC-filing fundamentals only. Add your free finnhub.io key to .env (then restart) for live quote, analysts, and earnings.");
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
  // percent). Values above 20 are implausible as a ratio — treat as percent.
  const normalizeDE = (v) => (v == null ? null : v > 20 ? v / 100 : v);

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
    earnings,
    peers,
    news: newsResult?.items ?? [],
    scoring,
    warnings,
  };

  // Forward test: log the call (append-only, first per ticker per day).
  // Only real, fully-priced verdicts enter the ledger.
  payload.logged = false;
  if (log && apiKey && scoring.verdict && hasQuote) {
    try {
      const nt = scoring.horizons.find((h) => h.key === "nearTerm");
      const lt = scoring.horizons.find((h) => h.key === "longTerm");
      payload.logged = logVerdict({
        t: payload.asOf,
        date: payload.asOf.slice(0, 10),
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
