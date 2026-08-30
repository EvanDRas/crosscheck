// The rest of the market: VIX, the 10-year yield, oil, gold, Bitcoin, and
// the dollar — the six numbers that explain most "why is everything red"
// days. Pulled from Yahoo's chart endpoint (keyless, same precedent and
// disclosure as the SPY benchmark series), cached five minutes, and any
// failure just drops that tile — the strip renders whatever it has.

const SYMBOLS = [
  { sym: "^VIX", label: "VIX", kind: "level", hint: "fear gauge — expected 30-day volatility" },
  { sym: "^TNX", label: "10Y yield", kind: "yield", hint: "10-year Treasury — the rate everything is priced against" },
  { sym: "CL=F", label: "Oil (WTI)", kind: "usd", hint: "crude futures" },
  { sym: "GC=F", label: "Gold", kind: "usd", hint: "gold futures" },
  { sym: "BTC-USD", label: "Bitcoin", kind: "usd", hint: "spot BTC" },
  { sym: "EURUSD=X", label: "EUR/USD", kind: "fx", hint: "dollar strength (inverted)" },
];

let cache = null;
const TTL_MS = 5 * 60_000;

async function quoteOne({ sym, label, kind, hint }) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Crosscheck/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    let price = meta?.regularMarketPrice;
    const prev = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    const chgPct = typeof prev === "number" && prev !== 0 ? ((price - prev) / prev) * 100 : null;
    // ^TNX has been quoted both as the percent (4.7) and as 10x it (47.0)
    // depending on the feed era — normalize either way.
    if (kind === "yield" && price > 20) price = price / 10;
    return { label, kind, hint, value: price, chgPct };
  } catch {
    return null;
  }
}

export async function getMacro() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const settled = await Promise.allSettled(SYMBOLS.map(quoteOne));
  const rows = settled.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
  if (rows.length) cache = { at: Date.now(), rows };
  return rows;
}

// World markets: US index futures (which trade nearly around the clock and
// set the tone when New York is closed) plus the four overseas benchmarks
// most quoted in market wraps. Same keyless Yahoo endpoint and tolerance.
const WORLD = [
  { sym: "ES=F", label: "S&P 500 futures", kind: "level", hint: "where traders price the S&P right now — moves while the market is closed" },
  { sym: "NQ=F", label: "Nasdaq futures", kind: "level", hint: "tech-heavy index futures" },
  { sym: "^N225", label: "Nikkei 225", kind: "level", hint: "Japan — the first major market to trade each day" },
  { sym: "^HSI", label: "Hang Seng", kind: "level", hint: "Hong Kong — the market's read on China" },
  { sym: "^GDAXI", label: "DAX", kind: "level", hint: "Germany — Europe's bellwether" },
  { sym: "^FTSE", label: "FTSE 100", kind: "level", hint: "United Kingdom" },
];

let worldCache = null;

export async function getWorld() {
  if (worldCache && Date.now() - worldCache.at < TTL_MS) return worldCache.rows;
  const settled = await Promise.allSettled(WORLD.map(quoteOne));
  const rows = settled.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
  if (rows.length) worldCache = { at: Date.now(), rows };
  return rows;
}

// ---- economic calendar -----------------------------------------------------
// Only events with dependable dates: the Fed's published 2026 FOMC schedule
// (decision day), the monthly jobs report (first Friday), and quarterly
// triple-witching expirations (third Friday of Mar/Jun/Sep/Dec). No
// guessed dates — a wrong date on an honesty site is worse than no date.

const FOMC = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

function firstFriday(year, month) {
  const d = new Date(Date.UTC(year, month, 1));
  d.setUTCDate(1 + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}
function thirdFriday(year, month) {
  const d = new Date(Date.UTC(year, month, 1));
  d.setUTCDate(1 + ((5 - d.getUTCDay() + 7) % 7) + 14);
  return d.toISOString().slice(0, 10);
}

export function nextEvents(n = 4) {
  const today = new Date().toISOString().slice(0, 10);
  const events = [];
  for (const d of FOMC) events.push({ date: d, name: "Fed rate decision (FOMC)" });
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    events.push({ date: firstFriday(m.getUTCFullYear(), m.getUTCMonth()), name: "Jobs report (nonfarm payrolls)" });
    if ([2, 5, 8, 11].includes(m.getUTCMonth())) {
      events.push({ date: thirdFriday(m.getUTCFullYear(), m.getUTCMonth()), name: "Triple witching (options expiry)" });
    }
  }
  return events
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, n);
}

// The 11 sector SPDR ETFs — the market's actual sector scoreboard. One
// month of daily closes per ETF (same keyless Yahoo endpoint) yields both
// the day move and the month trend. Day change comes from the last two
// closes so it stays honest on weekends. Cached ten minutes.
const SECTORS = [
  ["XLK", "Technology"], ["XLF", "Financials"], ["XLV", "Health care"],
  ["XLY", "Consumer disc."], ["XLP", "Staples"], ["XLE", "Energy"],
  ["XLI", "Industrials"], ["XLU", "Utilities"], ["XLB", "Materials"],
  ["XLRE", "Real estate"], ["XLC", "Communications"],
];

let sectorCache = null;

async function sectorOne([sym, label]) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1mo&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Crosscheck/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const r = (await res.json())?.chart?.result?.[0];
    const adj = (r?.indicators?.adjclose?.[0]?.adjclose ?? []).filter((v) => Number.isFinite(v));
    if (adj.length < 3) return null;
    const last = adj[adj.length - 1];
    const prev = adj[adj.length - 2];
    return {
      sym,
      label,
      dayPct: ((last - prev) / prev) * 100,
      monthPct: ((last - adj[0]) / adj[0]) * 100,
    };
  } catch {
    return null;
  }
}

export async function getSectors() {
  if (sectorCache && Date.now() - sectorCache.at < 10 * 60_000) return sectorCache.rows;
  const settled = await Promise.allSettled(SECTORS.map(sectorOne));
  const rows = settled.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean)
    .sort((a, b) => b.dayPct - a.dayPct);
  if (rows.length) sectorCache = { at: Date.now(), rows };
  return rows;
}
