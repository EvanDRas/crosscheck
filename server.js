import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import { FinnhubError, getQuote, getMetrics, getPeers, searchSymbols } from "./lib/finnhub.js";
import { addViewer, viewerCount, streamingSupported } from "./lib/stream.js";
import { analyzeTicker, NotFoundError, marketDate } from "./lib/analyze.js";
import { demoPayload } from "./lib/demo.js";
import { gradeFromPanel } from "./lib/history.js";
import { readLedger, aggregateLedger } from "./lib/ledger.js";
import { SCORING_VERSION } from "./lib/scoring.js";
import { readPicks, logPick, PICK_DIRECTIONS } from "./lib/picks.js";
import { updateSnapshot } from "./lib/snapshots.js";
import { getQuoteCached } from "./lib/quotes.js";
import { getSpyTrSeries, spyTrReturn } from "./lib/spy.js";
import { tiingoGrade, hasTiingoKey } from "./lib/tiingo.js";
import { pointInTimeCall } from "./lib/timemachine.js";
import { marketNews } from "./lib/news.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, ".env");
dotenv.config({ path: ENV_FILE });

// A copied-but-unedited .env.example leaves placeholder "keys" that would
// hide the in-app setup while every API call 401s — treat them as no key.
for (const k of ["FINNHUB_API_KEY", "TIINGO_API_KEY"]) {
  if (process.env[k] && /your_.*_here/i.test(process.env[k])) delete process.env[k];
}

const app = express();
const PORT = process.env.PORT || 3000;
// Localhost by default — this is a personal tool; nothing on your Wi-Fi
// should be able to spend your API quota or write to your ledgers. Set
// HOST=0.0.0.0 explicitly if you truly want LAN access.
const HOST = process.env.HOST || "127.0.0.1";

// DNS-rebinding guard: a hostile website can point its own domain at
// 127.0.0.1 and become same-origin with this app; requiring a localhost
// Host header shuts that down.
app.use((req, res, next) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  if (HOST === "127.0.0.1" && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    return res.status(403).send("Forbidden");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "16kb" }));

const TICKER_RE = /^[A-Z0-9.\-^]{1,10}$/;

// Short cache so repeated lookups (peer clicks, refreshes) don't burn the
// 60 calls/min free-tier budget.
const cache = new Map();
const CACHE_TTL_MS = 90_000;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.FINNHUB_API_KEY), hasTiingo: hasTiingoKey() });
});

// First-run onboarding: accept keys from the setup screen, validate the
// Finnhub key live, persist to .env, and apply without a restart. Refuses to
// run once a key exists — after that, .env is edited by hand on purpose.
app.post("/api/setup", async (req, res) => {
  try {
    if (process.env.FINNHUB_API_KEY) {
      return res.status(409).json({ error: "A key is already configured. Edit the .env file directly to change it." });
    }
    const finnhub = String(req.body?.finnhubKey ?? "").trim();
    const tiingo = String(req.body?.tiingoKey ?? "").trim();
    const contact = String(req.body?.contact ?? "").trim();
    // Every field is validated before it touches .env — values are written
    // verbatim as env lines, so control characters would be line injection.
    if (!/^[A-Za-z0-9]{20,60}$/.test(finnhub)) {
      return res.status(400).json({ error: "That doesn't look like a Finnhub API key. Copy it from the finnhub.io dashboard." });
    }
    if (tiingo && !/^[A-Za-z0-9]{10,80}$/.test(tiingo)) {
      return res.status(400).json({ error: "That doesn't look like a Tiingo API key — leave the field empty if you don't have one." });
    }
    if (/[\x00-\x1f\x7f]/.test(finnhub + tiingo + contact)) {
      return res.status(400).json({ error: "Control characters aren't allowed in any field." });
    }
    if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
      return res.status(400).json({ error: "That doesn't look like an email address — leave the field empty if you'd rather not give one." });
    }
    let q;
    try {
      q = await getQuote("AAPL", finnhub);
    } catch (err) {
      if (err instanceof FinnhubError && [401, 403].includes(err.status)) {
        return res.status(400).json({ error: "Finnhub did not accept that key. Double-check it and try again." });
      }
      throw err;
    }
    if (!q || (!q.c && !q.pc)) {
      return res.status(400).json({ error: "Finnhub did not accept that key. Double-check it and try again." });
    }
    const lines = [`FINNHUB_API_KEY=${finnhub}`];
    if (tiingo) lines.push(`TIINGO_API_KEY=${tiingo}`);
    if (contact) lines.push(`SEC_EDGAR_CONTACT=${contact}`);
    if (String(PORT) !== "3000") lines.push(`PORT=${PORT}`);
    fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
    process.env.FINNHUB_API_KEY = finnhub;
    if (tiingo) process.env.TIINGO_API_KEY = tiingo;
    if (contact) process.env.SEC_EDGAR_CONTACT = contact;
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof FinnhubError) return res.status(400).json({ error: err.message });
    console.error("setup failed:", err);
    res.status(500).json({ error: "Could not save the configuration." });
  }
});

// Company-name search: "apple" -> AAPL. Cached per query; common stocks first.
const searchCache = new Map();
app.get("/api/search", async (req, res) => {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    const q = String(req.query.q ?? "").trim().slice(0, 60);
    if (!apiKey || q.length < 2) return res.json({ results: [] });
    const hit = searchCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 3_600_000) return res.json({ results: hit.results });
    // US-listed shapes only (AAPL, BRK.A) — foreign suffixes like .SN/.T and
    // exchange-prefixed symbols are beyond the free tier's useful coverage.
    // Dotted suffixes are class shares only (BRK.A) — .L/.T/.SN etc. are
    // foreign listings the free tier can't really serve.
    const usListed = (doc) => (Array.isArray(doc?.result) ? doc.result : [])
      .filter((r) => r.symbol && /^[A-Z]{1,6}(\.[AB])?$/.test(r.symbol) && (r.type === "Common Stock" || r.type === ""))
      .slice(0, 6)
      .map((r) => ({ symbol: r.symbol, name: r.description ?? "" }));
    // Finnhub's matching is literal about spaces: "coca cola" misses KO but
    // "coca-cola" hits, "jp morgan" misses but "jpmorgan" hits. Try variants;
    // a rate-limited variant is skipped rather than aborting the search.
    let results = [];
    for (const variant of [...new Set([q, q.replace(/\s+/g, "-"), q.replace(/\s+/g, "")])]) {
      try {
        results = usListed(await searchSymbols(variant, apiKey));
        if (results.length) break;
      } catch {
        /* try the next variant */
      }
    }
    // Empty can mean "rate limited right now" — never cache that for an hour.
    if (results.length) {
      searchCache.set(q.toLowerCase(), { at: Date.now(), results });
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    }
    res.json({ results });
  } catch {
    res.json({ results: [] }); // search is best-effort, never an error page
  }
});

// Peer comparison, on demand only (a click, never automatic — it costs one
// API call per peer). Answers the question a lone number can't: is this P/E
// high FOR ITS GROUP, or just high?
const compareCache = new Map();
app.get("/api/compare", async (req, res) => {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    const ticker = String(req.query.ticker ?? "").trim().toUpperCase();
    if (!apiKey || !TICKER_RE.test(ticker) || ticker === "DEMO") {
      return res.status(400).json({ error: "Peer comparison needs an API key and a real ticker." });
    }
    const hit = compareCache.get(ticker);
    if (hit && Date.now() - hit.at < 600_000) return res.json({ rows: hit.rows });

    const peersRaw = await getPeers(ticker, apiKey);
    const symbols = [ticker, ...(Array.isArray(peersRaw) ? peersRaw : [])
      .filter((p) => typeof p === "string" && p && p !== ticker).slice(0, 7)];
    const settled = await Promise.allSettled(symbols.map((s) => getMetrics(s, apiKey)));

    const pick = (m, ...keys) => {
      for (const k of keys) {
        const v = m?.[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return null;
    };
    const rows = symbols.map((s, i) => {
      const m = settled[i].status === "fulfilled" ? settled[i].value?.metric ?? {} : {};
      const de = pick(m, "totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual");
      return {
        symbol: s,
        marketCap: pick(m, "marketCapitalization"),
        pe: pick(m, "peTTM", "peBasicExclExtraTTM", "peAnnual"),
        ps: pick(m, "psTTM", "psAnnual"),
        netMargin: pick(m, "netProfitMarginTTM", "netProfitMarginAnnual"),
        roe: pick(m, "roeTTM", "roeRfy", "roeAnnual"),
        revenueGrowth: pick(m, "revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"),
        debtEquity: de == null || de > 20 ? null : de, // >20 is unit-ambiguous — same policy as the analyzer

      };
    }).filter((r) => Object.values(r).some((v) => v != null && v !== r.symbol));
    compareCache.set(ticker, { at: Date.now(), rows });
    if (compareCache.size > 50) compareCache.delete(compareCache.keys().next().value);
    res.json({ rows });
  } catch (err) {
    if (err instanceof FinnhubError) return res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
    console.error("compare failed:", err);
    res.status(500).json({ error: "Could not build the peer comparison." });
  }
});

// Landing-page market overview: index levels, a clickable mega-cap board,
// and market headlines. One shared cache serves every visitor for 2 minutes,
// so the front page costs ~11 API calls per interval — not per page load.
// Keyless: quotes are unavailable, headlines still flow (RSS needs no key).
const INDICES = [
  ["SPY", "S&P 500"],
  ["QQQ", "Nasdaq 100"],
  ["DIA", "Dow"],
  ["IWM", "Russell 2000"],
];
const BOARD = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"];

// Browsable verdict screen: the daily batch already logs the whole fixed
// 50-stock universe, so the landing page can rank it from disk — zero API
// calls. Current-formula (v2) entries only; the newest entry per ticker wins.
function buildScreen() {
  try {
    const uni = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "universe.json"), "utf8"));
    const universe = new Set(uni.tickers ?? []);
    const latest = new Map();
    for (const e of readLedger()) {
      if (universe.has(e.ticker) && e.formulaVersion === SCORING_VERSION) latest.set(e.ticker, e);
    }
    return [...latest.values()]
      .filter((e) => Number.isFinite(e.score))
      .sort((a, b) => b.score - a.score)
      .map((e) => ({
        ticker: e.ticker,
        score: e.score,
        verdict: e.verdict,
        confidence: e.confidence ?? null,
        nt: e.ntVerdict ?? null,
        lt: e.ltVerdict ?? null,
        date: e.date,
      }));
  } catch {
    return [];
  }
}

let marketCache = null;
app.get("/api/market", async (_req, res) => {
  try {
    if (marketCache && Date.now() - marketCache.at < 120_000) return res.json(marketCache.payload);
    const apiKey = process.env.FINNHUB_API_KEY;
    const quoteRow = async ([symbol, label]) => {
      try {
        const q = await getQuoteCached(symbol, apiKey);
        if (!q?.c) return null;
        return { symbol, label: label ?? symbol, price: q.c, change: q.d ?? null, changePercent: q.dp ?? null };
      } catch {
        return null;
      }
    };
    const [indices, board, news] = await Promise.all([
      apiKey ? Promise.all(INDICES.map(quoteRow)) : [],
      apiKey ? Promise.all(BOARD.map((s) => quoteRow([s, s]))) : [],
      marketNews(apiKey).catch(() => []),
    ]);
    const payload = {
      asOf: new Date().toISOString(),
      hasKey: Boolean(apiKey),
      indices: indices.filter(Boolean),
      board: board.filter(Boolean),
      news,
      screen: buildScreen(),
    };
    marketCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    console.error("market failed:", err);
    res.status(500).json({ error: "Could not load the market overview." });
  }
});

// The Time Machine: what the formula would have said on a past date, using
// only information filed and priced by that day, graded against everything
// since. The feature that makes the honesty claim interactive.
const tmCache = new Map();
app.get("/api/timemachine", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "").trim().toUpperCase();
    const date = String(req.query.date ?? "").trim();
    if (!TICKER_RE.test(ticker) || ticker === "DEMO") {
      return res.status(400).json({ error: "Enter a real ticker symbol." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "2010-01-01" || date > marketDate(new Date(Date.now() - 7 * 86_400_000))) {
      return res.status(400).json({ error: "Pick a date between 2010-01-01 (when SEC XBRL data starts) and about a week ago." });
    }
    if (!hasTiingoKey()) {
      return res.status(400).json({ error: "The Time Machine needs a (free) Tiingo API key for historical prices — add one via the setup screen or .env." });
    }
    const ck = `${ticker}|${date}`;
    const hit = tmCache.get(ck);
    if (hit && Date.now() - hit.at < 3_600_000) return res.json(hit.payload);

    const r = await pointInTimeCall(ticker, date);
    const payload = {
      ticker: r.ticker,
      date: r.D,
      requestedDate: date,
      scoring: r.scoring,
      inputs: {
        pe: r.m.pe ?? null,
        ps: r.m.ps ?? null,
        netMargin: r.m.netMargin ?? null,
        revenueGrowth: r.m.revenueGrowth ?? null,
        epsGrowth: r.m.epsGrowth ?? null,
        currentRatio: r.m.currentRatio ?? null,
        debtEquity: r.m.debtEquity ?? null,
        pricePosition: r.pricePosition,
      },
      edgarThrough: r.edgarThrough,
      outcome: {
        ret: r.ret,
        spyRet: r.spyRet,
        excess: r.ret != null && r.spyRet != null ? r.ret - r.spyRet : null,
        through: r.latest,
        years: r.years,
      },
      notes: r.notes,
    };
    tmCache.set(ck, { at: Date.now(), payload });
    if (tmCache.size > 100) tmCache.delete(tmCache.keys().next().value);
    res.json(payload);
  } catch (err) {
    res.status(422).json({ error: `Time Machine couldn't grade that one: ${err.message}` });
  }
});

// The evidence, served in-app so the product carries its own test results.
app.get("/api/evidence", (_req, res) => {
  res.type("text/plain").send(fs.readFileSync(path.join(__dirname, "EVIDENCE.md"), "utf8"));
});

app.get("/api/analyze", async (req, res) => {
  const ticker = String(req.query.ticker ?? "").trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    return res.status(400).json({ error: "Enter a ticker symbol like AAPL, MSFT, or BRK.B." });
  }
  if (ticker === "DEMO") return res.json(demoPayload());

  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // The heavy payload is cached, but the price shouldn't be: refresh just
    // the quote (1 call instead of ~7) so the number on screen is current.
    // Scoring stays as computed — a 90-second price drift doesn't move it.
    const apiKey = process.env.FINNHUB_API_KEY;
    if (apiKey && cached.payload.quote) {
      try {
        const q = await getQuote(ticker, apiKey);
        if (q && (q.c || q.pc)) {
          cached.payload.quote = { price: q.c, change: q.d, changePercent: q.dp, previousClose: q.pc, open: q.o, high: q.h, low: q.l };
          cached.payload.asOf = new Date().toISOString();
        }
      } catch {
        /* serve the cached quote rather than fail the request */
      }
    }
    return res.json(cached.payload);
  }

  try {
    const payload = await analyzeTicker(ticker, { apiKey: process.env.FINNHUB_API_KEY });

    // "Since you last looked": diff against the previous different-day
    // snapshot of this ticker. Degraded payloads don't update the baseline.
    if (!payload.degraded) {
      try {
        const { changes, lastSeen } = updateSnapshot(ticker, payload);
        payload.changes = changes;
        payload.lastSeen = lastSeen;
      } catch {}
    }

    // Never cache a degraded (partially rate-limited) payload — a retry
    // should get a fresh shot at the full data, not 90s of the gutted page.
    if (!payload.degraded) {
      cache.set(ticker, { at: Date.now(), payload });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
    }

    res.json(payload);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof FinnhubError) {
      return res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
    }
    console.error("analyze failed:", err);
    res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  }
});

// Live price ticks for the currently-viewed ticker, relayed from Finnhub's
// real-time trade websocket (free tier) as server-sent events. Quiet outside
// market hours — no trades, no events, the page just shows the last quote.
app.get("/api/stream", (req, res) => {
  const apiKey = process.env.FINNHUB_API_KEY;
  const ticker = String(req.query.ticker ?? "").trim().toUpperCase();
  if (!apiKey || !TICKER_RE.test(ticker) || ticker === "DEMO") {
    return res.status(400).end();
  }
  if (!streamingSupported()) return res.status(501).end(); // Node < 21: no live stream, page stays static
  if (viewerCount() >= 25) return res.status(503).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  addViewer(ticker, res, apiKey);
});

// ---- grading (shared by the formula's ledger and the user's own picks) ----
//
// Basis, in order of preference per entry:
//  1. "tr"  — total return from the local research panel's split/dividend-
//     adjusted closes (last close on/before the call date -> latest close),
//     benchmarked against SPY's adjusted closes over the SAME window.
//  2. "tr" via Tiingo's adjusted closes for tickers the panel doesn't cover.
//  3. "raw" — live quote vs the logged price/SPY level. Breaks across splits,
//     excludes dividends — rows carry basis so the page can say which.
async function gradeEntries(entries) {
  const apiKey = process.env.FINNHUB_API_KEY;
  const warnings = [];

  const [panelR, spySeries] = await Promise.all([
    gradeFromPanel(entries.map((e) => ({ ticker: e.ticker, date: e.date }))).catch((err) => {
      warnings.push(`Panel grading unavailable (${err.message}) — falling back to raw quotes.`);
      return null;
    }),
    getSpyTrSeries(),
  ]);
  const grades = panelR?.grades ?? {};
  const latestPanelDate = panelR?.latestPanelDate ?? null;
  if (!spySeries) warnings.push("SPY total-return series unavailable — benchmark graded price-only (dividends excluded) this load.");

  const tGrades = {};
  if (hasTiingoKey()) {
    const missingPairs = [...new Set(
      entries.filter((e) => !grades[`${e.ticker}|${e.date}`]).map((e) => `${e.ticker}|${e.date}`)
    )].slice(-25);
    const settled = await Promise.allSettled(missingPairs.map((k) => tiingoGrade(...k.split("|"))));
    let tiingoFailed = 0;
    missingPairs.forEach((k, i) => {
      if (settled[i].status === "fulfilled" && settled[i].value) tGrades[k] = settled[i].value;
      else if (settled[i].status === "rejected") tiingoFailed++;
    });
    if (tiingoFailed) warnings.push(`Tiingo grading failed for ${tiingoFailed} ticker(s) this load.`);
  }

  const MAX_QUOTES = 50;
  const needsQuote = [...new Set(
    [...entries].reverse()
      .filter((e) => !grades[`${e.ticker}|${e.date}`] && !tGrades[`${e.ticker}|${e.date}`])
      .map((e) => e.ticker)
  )];
  const toQuote = needsQuote.slice(0, MAX_QUOTES);
  const quotes = {};
  let spyNow = null;
  if (apiKey && (toQuote.length || !spySeries)) {
    const settled = await Promise.allSettled([
      getQuoteCached("SPY", apiKey),
      ...toQuote.map((t) => getQuoteCached(t, apiKey)),
    ]);
    if (settled[0].status === "fulfilled" && settled[0].value?.c) spyNow = settled[0].value.c;
    toQuote.forEach((t, i) => {
      const r = settled[i + 1];
      if (r.status === "fulfilled" && r.value?.c) quotes[t] = r.value.c;
    });
    const failed = toQuote.filter((t) => quotes[t] == null).length;
    if (needsQuote.length > MAX_QUOTES) {
      warnings.push(`Only the ${MAX_QUOTES} most recent panel-less tickers were re-priced this load (rate-limit protection).`);
    } else if (failed) {
      warnings.push(`${failed} ticker(s) could not be graded right now — shown ungraded.`);
    }
  } else if (!apiKey && needsQuote.length) {
    warnings.push(`No FINNHUB_API_KEY — ${needsQuote.length} ticker(s) outside the local panel can't be graded without live quotes.`);
  }

  const rows = [...entries].reverse().map((e) => {
    const gp = grades[`${e.ticker}|${e.date}`];
    const g = gp ?? tGrades[`${e.ticker}|${e.date}`];
    let ret = null;
    let spyRet = null;
    let nowPrice = null;
    let basis = null;
    let frozen = false;
    if (g) {
      basis = "tr";
      ret = (g.latestClose - g.anchorClose) / g.anchorClose;
      nowPrice = Math.round(g.latestClose * 100) / 100;
      // "Left the index" is a PANEL concept — a Tiingo-graded ticker lagging
      // the panel's calendar by a session is alive, not frozen.
      frozen = Boolean(gp && latestPanelDate && g.latestDate < latestPanelDate);
      // Matched window: the stock leg ends at its last panel/Tiingo close, so
      // SPY must end there too — Yahoo's series includes today's intraday
      // bar, which would otherwise give SPY a head start on every row.
      spyRet = spySeries
        ? spyTrReturn(spySeries, g.anchorDate, g.latestDate)
        : spyNow != null && e.spy ? (spyNow - e.spy) / e.spy : null;
    } else if (quotes[e.ticker] != null) {
      basis = "raw";
      nowPrice = quotes[e.ticker];
      ret = e.price ? (nowPrice - e.price) / e.price : null;
      // Raw rows are price-only on the stock leg, so the SPY leg must be
      // price-only too (logged level vs live quote). No TR fallback: a
      // mixed-basis excess is worse than an ungraded row.
      spyRet = spyNow != null && e.spy ? (spyNow - e.spy) / e.spy : null;
    }
    return {
      ...e,
      nowPrice,
      ret,
      spyRet,
      excess: ret != null && spyRet != null ? ret - spyRet : null,
      basis,
      frozen,
      gradedThrough: g?.latestDate ?? null,
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(e.date)) / 86_400_000)),
    };
  });

  return { rows, warnings };
}

// The ledger page: every logged formula call graded against what actually
// happened since. History is never rewritten, entries are never edited.
app.get("/api/ledger", async (_req, res) => {
  try {
    const entries = readLedger();
    if (!entries.length) {
      return res.json({ entries: [], aggregates: [], asOf: new Date().toISOString(), warning: null });
    }
    const { rows, warnings } = await gradeEntries(entries);
    const eras = [...new Set(entries.map((e) => e.formulaVersion ?? "v1"))];
    if (eras.length > 1) {
      warnings.push(`Ledger spans formula eras (${eras.join(", ")}) — v2 recalibrated the verdict bands, so the By-verdict table covers the current era (${SCORING_VERSION}) only; older rows remain listed below with their stamps.`);
    }
    // Aggregates: current-era rows only — v1 "BUY" and v2 "BUY" are
    // different claims and must not share a bucket.
    const currentEra = rows.filter((r) => (r.formulaVersion ?? "v1") === SCORING_VERSION);
    res.json({
      entries: rows,
      aggregates: aggregateLedger(currentEra),
      asOf: new Date().toISOString(),
      warning: warnings.length ? warnings.join(" ") : null,
    });
  } catch (err) {
    console.error("ledger failed:", err);
    res.status(500).json({ error: "Could not load the verdict ledger." });
  }
});

// ---- personal accuracy tracker: the user's own calls, same grading --------

app.post("/api/picks", async (req, res) => {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "Add your API key first — picks are logged with a live price." });
    const ticker = String(req.body?.ticker ?? "").trim().toUpperCase();
    const direction = String(req.body?.direction ?? "").trim().toLowerCase();
    const note = String(req.body?.note ?? "").trim().slice(0, 280);
    if (!TICKER_RE.test(ticker) || ticker === "DEMO") {
      return res.status(400).json({ error: "Invalid ticker." });
    }
    if (!PICK_DIRECTIONS.includes(direction)) {
      return res.status(400).json({ error: "Direction must be buy, avoid, or sell." });
    }
    const [q, spy] = await Promise.all([
      getQuote(ticker, apiKey),
      getQuoteCached("SPY", apiKey).catch(() => null),
    ]);
    if (!q?.c) return res.status(502).json({ error: "Could not get a live price to freeze the pick at." });
    const now = new Date().toISOString();
    const added = logPick({
      t: now,
      date: marketDate(),
      ticker,
      direction,
      note,
      price: q.c,
      spy: spy?.c ?? null,
    });
    res.json({ added, message: added ? "Logged. Time will grade it." : "You already made a call on this ticker today — the first one stands." });
  } catch (err) {
    if (err instanceof FinnhubError) return res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
    console.error("pick failed:", err);
    res.status(500).json({ error: "Could not log the pick." });
  }
});

app.get("/api/picks", async (_req, res) => {
  try {
    const entries = readPicks();
    if (!entries.length) {
      return res.json({ entries: [], summary: null, asOf: new Date().toISOString(), warning: null });
    }
    const { rows, warnings } = await gradeEntries(entries);
    // Accuracy the honest way: a buy is right if it beat SPY, a sell/avoid is
    // right if the stock trailed SPY. Same-day rows are excluded (no time has
    // passed to grade).
    const graded = rows.filter((r) => r.excess != null && r.ageDays > 0);
    const correct = graded.filter((r) => (r.direction === "buy" ? r.excess > 0 : r.excess < 0)).length;
    res.json({
      entries: rows,
      summary: graded.length ? { graded: graded.length, correct, accuracy: correct / graded.length } : null,
      asOf: new Date().toISOString(),
      warning: warnings.length ? warnings.join(" ") : null,
    });
  } catch (err) {
    console.error("picks failed:", err);
    res.status(500).json({ error: "Could not load your picks." });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Crosscheck running at http://localhost:${PORT}`);
  if (!process.env.FINNHUB_API_KEY) {
    console.log("NOTE: no API key yet — open the app in a browser and the setup screen will walk you through it (or try the DEMO ticker).");
  }
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use (something else is running there).`);
    console.error(`Fix: close the other program, or add a line like PORT=3010 to the .env file and start Crosscheck again (then open http://localhost:3010).\n`);
    process.exit(1);
  }
  throw err;
});
