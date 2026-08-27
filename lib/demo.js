// Ticker "DEMO" returns this canned payload so the UI can be previewed with no
// API key. Everything is fictional ("Democo Systems") and flagged demo:true —
// the frontend shows a banner. The verdict is still computed by the real
// scoring engine, so DEMO doubles as an end-to-end check of that pipeline.

import { computeVerdict, computeHorizons, scoreEarningsExecution, analystTilt } from "./scoring.js";

// Deterministic fake price walk: 3 years, weekly early on, daily for the last
// year, scaled so the final close matches the demo quote exactly.
function demoHistory(finalClose) {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const now = new Date();
  const start = new Date(now.getTime() - 3 * 365 * 86_400_000);
  const raw = [];
  let price = 120;
  for (const d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    price *= 1 + (rand() - 0.482) * 0.022;
    const ageDays = (now - d) / 86_400_000;
    if (ageDays > 370 && dow !== 5) continue; // weekly beyond a year
    raw.push([d.toISOString().slice(0, 10), price]);
  }
  const scale = finalClose / raw[raw.length - 1][1];
  const series = raw.map(([ds, c]) => [ds, Math.round(c * scale * 100) / 100]);
  const yearAgo = new Date(now.getTime() - 366 * 86_400_000).toISOString().slice(0, 10);
  const yr = series.filter(([ds]) => ds >= yearAgo).map(([, c]) => c);
  const hi = Math.max(...yr);
  const lo = Math.min(...yr);
  const last = series[series.length - 1];
  return {
    source: "demo",
    through: last[0],
    updatesDaily: false,
    last: { date: last[0], close: last[1] },
    local52: { high: hi, low: lo, position: hi > lo ? (last[1] - lo) / (hi - lo) : null },
    series,
  };
}

export function demoPayload() {
  const quote = { price: 187.42, change: 2.31, changePercent: 1.25, previousClose: 185.11, open: 185.6, high: 188.9, low: 184.75 };
  const metrics = {
    pe: 24.6, ps: 5.8, pb: 11.2, peg: 1.6,
    netMargin: 23.4, roe: 38.1, roa: 16.2,
    revenueGrowth: 12.7, epsGrowth: 17.9,
    currentRatio: 1.4, debtEquity: 0.9,
    dividendYield: 0.6, beta: 1.18,
    high52: 199.62, low52: 141.35, high52Date: "2026-06-12", low52Date: "2025-09-03",
    pricePosition: (187.42 - 141.35) / (199.62 - 141.35),
  };
  const analystTrends = { period: "2026-07-01", strongBuy: 14, buy: 18, hold: 9, sell: 2, strongSell: 1, total: 44 };
  const earnings = [
    { period: "2026-06-30", quarter: 2, year: 2026, actual: 1.62, estimate: 1.55, surprisePercent: 4.5, beat: true },
    { period: "2026-03-31", quarter: 1, year: 2026, actual: 1.48, estimate: 1.5, surprisePercent: -1.3, beat: false },
    { period: "2025-12-31", quarter: 4, year: 2025, actual: 2.11, estimate: 1.98, surprisePercent: 6.6, beat: true },
    { period: "2025-09-30", quarter: 3, year: 2025, actual: 1.39, estimate: 1.36, surprisePercent: 2.2, beat: true },
  ];

  const scoring = computeVerdict({
    pe: metrics.pe, ps: metrics.ps, peg: metrics.peg,
    netMargin: metrics.netMargin, roe: metrics.roe,
    revenueGrowth: metrics.revenueGrowth, epsGrowth: metrics.epsGrowth,
    currentRatio: metrics.currentRatio, debtEquity: metrics.debtEquity,
    pricePosition: metrics.pricePosition,
    analystTilt: analystTilt(analystTrends),
  });
  scoring.horizons = computeHorizons(scoring.categories, scoreEarningsExecution(earnings));

  const day = 86_400_000;
  const ago = (d) => new Date(Date.now() - d * day).toISOString();

  return {
    demo: true,
    ticker: "DEMO",
    asOf: new Date().toISOString(),
    quote,
    profile: {
      name: "Democo Systems (sample data)",
      logo: "",
      exchange: "DEMO EXCHANGE",
      industry: "Technology",
      marketCap: 2_870_000, // Finnhub convention: millions of USD
      ipo: "2004-08-19",
      website: "",
      currency: "USD",
    },
    metrics,
    history: demoHistory(quote.price),
    analystTrends,
    earnings,
    peers: ["AAPL", "MSFT", "GOOGL", "NVDA", "META"],
    news: [
      { headline: "Democo Systems beats Q2 estimates on cloud strength", source: "Demo Wire", date: ago(0.2), link: "#", summary: "Fictional sample story: revenue grew 12.7% year over year, led by the cloud segment." },
      { headline: "Analysts raise Democo price targets after earnings", source: "Sample Post", date: ago(1.1), link: "#", summary: "Fictional sample story: several banks lifted targets citing margin expansion." },
      { headline: "Democo announces $5B buyback program", source: "Placeholder Times", date: ago(2.4), link: "#", summary: "Fictional sample story: the board authorized a new repurchase program." },
      { headline: "What Democo's AI roadmap means for the sector", source: "Demo Wire", date: ago(4.0), link: "#", summary: "Fictional sample story: an opinion piece on the product pipeline." },
      { headline: "Democo faces new competition in enterprise software", source: "Sample Post", date: ago(6.5), link: "#", summary: "Fictional sample story: rivals are cutting prices in the mid-market." },
    ],
    // Trajectory / filings / insiders were the only cards DEMO lacked — a
    // keyless evaluator never learned they existed. All fictional.
    trajectory: {
      quarters: [
        { end: "2024-09-28", revenue: 21_400_000_000, revYoY: null, margin: 21.2 },
        { end: "2024-12-28", revenue: 23_800_000_000, revYoY: null, margin: 22.0 },
        { end: "2025-03-29", revenue: 22_600_000_000, revYoY: null, margin: 21.6 },
        { end: "2025-06-28", revenue: 24_900_000_000, revYoY: null, margin: 22.4 },
        { end: "2025-09-27", revenue: 24_100_000_000, revYoY: 12.6, margin: 22.8 },
        { end: "2025-12-27", revenue: 26_700_000_000, revYoY: 12.2, margin: 23.1 },
        { end: "2026-03-28", revenue: 25_400_000_000, revYoY: 12.4, margin: 23.0 },
        { end: "2026-06-27", revenue: 28_100_000_000, revYoY: 12.9, margin: 23.4 },
      ],
      dilution: {
        annualPct: -1.8,
        from: "2024-06-29",
        to: "2026-06-27",
        fromShares: 5_210_000_000,
        toShares: 5_025_000_000,
      },
    },
    filings: [
      { form: "10-Q", label: "Quarterly report", filed: "2026-07-28", url: "" },
      { form: "8-K", label: "Current report — something happened", filed: "2026-07-28", url: "" },
      { form: "4", label: "Insider trade", filed: "2026-07-15", url: "" },
      { form: "DEF 14A", label: "Proxy statement", filed: "2026-05-02", url: "" },
      { form: "10-K", label: "Annual report", filed: "2026-02-06", url: "" },
    ],
    insiders: {
      windowDays: 92,
      buys: { count: 1, shares: 6_000, value: 1_090_000 },
      sells: { count: 4, shares: 121_500, value: 22_400_000 },
      recent: [
        { name: "SAMPLE CFO JANE", action: "SELL", shares: 45_000, price: 183.1, date: "2026-08-05" },
        { name: "SAMPLE DIRECTOR RAJ", action: "BUY", shares: 6_000, price: 181.7, date: "2026-07-30" },
        { name: "SAMPLE CEO ALEX", action: "SELL", shares: 40_000, price: 179.9, date: "2026-07-21" },
        { name: "SAMPLE VP DANA", action: "SELL", shares: 22_500, price: 176.4, date: "2026-07-08" },
      ],
    },
    scoring,
    warnings: [],
  };
}
