// Tiingo EOD client (free tier). Two jobs:
//  1. Fresh adjusted price history for tickers the local S&P panel doesn't
//     cover (the on-disk Tiingo archive is a static snapshot) — powers the
//     chart and 52-week stats.
//  2. Split/dividend-adjusted closes for grading non-panel ledger entries,
//     so the raw-quote fallback is only ever used with no token at all.
// Free-tier limits are real (per-day/per-hour caps); every failure degrades
// gracefully to the previous behavior and is reported as a warning.

const DAY = 86_400_000;

const cache = new Map(); // ticker -> { at, rows }
const TTL_MS = 3_600_000;

const tiingoSymbol = (t) => String(t).toUpperCase().replace(/\./g, "-");

export function hasTiingoKey() {
  return Boolean(process.env.TIINGO_API_KEY);
}

// Daily rows [{date: "YYYY-MM-DD", adj: number}] since startDate, ascending.
export async function getTiingoDaily(ticker, startDate) {
  const key = process.env.TIINGO_API_KEY;
  if (!key) return null;
  const t = tiingoSymbol(ticker);
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(t)}/prices?startDate=${startDate}&format=json&token=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (res.status === 404) return null; // unknown ticker
  if (!res.ok) throw new Error(`Tiingo ${res.status}${res.status === 429 ? " (free-tier limit)" : ""}`);
  const doc = await res.json();
  const rows = (Array.isArray(doc) ? doc : [])
    .filter((r) => typeof r?.adjClose === "number" && r.date)
    .map((r) => ({ date: String(r.date).slice(0, 10), adj: r.adjClose }));
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return null;
  cache.set(t, { at: Date.now(), rows });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return rows;
}

// Downsampled like read_history.py: daily <1y, weekly <5y, monthly beyond.
function downsample(rows) {
  const last = Date.parse(rows[rows.length - 1].date);
  const dailyFrom = last - 370 * DAY;
  const weeklyFrom = last - 5.2 * 365 * DAY;
  const out = [];
  let prevWeek = null;
  let prevMonth = null;
  for (const r of rows) {
    const t = Date.parse(r.date);
    const d = new Date(t);
    if (t >= dailyFrom) out.push(r);
    else if (t >= weeklyFrom) {
      const wk = `${d.getUTCFullYear()}-${Math.floor((t - Date.parse(`${d.getUTCFullYear()}-01-01`)) / (7 * DAY))}`;
      if (wk !== prevWeek) {
        out.push(r);
        prevWeek = wk;
      }
    } else {
      const mo = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (mo !== prevMonth) {
        out.push(r);
        prevMonth = mo;
      }
    }
  }
  return out;
}

// history-payload shape matching lib/history.js output, from live Tiingo data.
export async function getTiingoHistory(ticker) {
  const from = new Date(Date.now() - 6 * 365 * DAY).toISOString().slice(0, 10);
  const rows = await getTiingoDaily(ticker, from);
  if (!rows || rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const yearAgo = Date.parse(last.date) - 366 * DAY;
  const yr = rows.filter((r) => Date.parse(r.date) >= yearAgo).map((r) => r.adj);
  let local52 = null;
  if (yr.length >= 30) {
    const hi = Math.max(...yr);
    const lo = Math.min(...yr);
    local52 = {
      high: Math.round(hi * 10000) / 10000,
      low: Math.round(lo * 10000) / 10000,
      position: hi > lo ? Math.round(((last.adj - lo) / (hi - lo)) * 10000) / 10000 : null,
    };
  }
  return {
    source: "tiingo-api",
    through: last.date,
    updatesDaily: true,
    last: { date: last.date, close: Math.round(last.adj * 10000) / 10000 },
    local52,
    series: downsample(rows).map((r) => [r.date, Math.round(r.adj * 10000) / 10000]),
  };
}

// Grading legs for the ledger: adjusted close on/before anchorDate + latest.
export async function tiingoGrade(ticker, anchorDate) {
  const from = new Date(Date.parse(anchorDate) - 14 * DAY).toISOString().slice(0, 10);
  const rows = await getTiingoDaily(ticker, from);
  if (!rows) return null;
  let anchor = null;
  for (const r of rows) {
    if (r.date <= anchorDate) anchor = r;
    else break;
  }
  if (!anchor) return null;
  const latest = rows[rows.length - 1];
  return {
    anchorDate: anchor.date,
    anchorClose: anchor.adj,
    latestDate: latest.date,
    latestClose: latest.adj,
  };
}
