// SPY total-return series for ledger grading. The local panel has no SPY, so
// this pulls dividend/split-adjusted daily closes from Yahoo's chart endpoint
// (keyless). Cached for an hour; any failure resolves to null and the caller
// falls back to price-only SPY grading with a visible warning — the benchmark
// should be measured the same way as the stocks (total return) whenever
// possible, but a broken feed must never break the ledger page.

const urlFor = (range) => `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=${range}&interval=1d`;

const cache = new Map(); // range -> { at, series: { dates: [...], adj: [...] } }
const TTL_MS = 3_600_000;

export async function getSpyTrSeries(range = "5y") {
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;
  try {
    const res = await fetch(urlFor(range), {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VerdictAnalyzer/1.0" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const doc = await res.json();
    const r = doc?.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const dates = [];
    const closes = [];
    for (let i = 0; i < ts.length; i++) {
      if (typeof adj[i] === "number" && Number.isFinite(adj[i])) {
        dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
        closes.push(adj[i]);
      }
    }
    if (dates.length < 2) return null;
    const series = { dates, adj: closes };
    cache.set(range, { at: Date.now(), series });
    return series;
  } catch {
    return null;
  }
}

// Total return from the last close on/before anchorDate to the last close
// on/before endDate (default: the latest close). Passing an endDate keeps the
// benchmark window matched when a ticker's own series stops updating.
export function spyTrReturn(series, anchorDate, endDate = null) {
  if (!series || !anchorDate) return null;
  let anchor = null;
  let end = null;
  for (let i = 0; i < series.dates.length; i++) {
    if (series.dates[i] <= anchorDate) anchor = series.adj[i];
    if (endDate == null || series.dates[i] <= endDate) end = series.adj[i];
    if (series.dates[i] > anchorDate && endDate != null && series.dates[i] > endDate) break;
  }
  if (anchor == null || end == null) return null;
  return (end - anchor) / anchor;
}
