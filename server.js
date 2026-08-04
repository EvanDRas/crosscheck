import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import { FinnhubError, getQuote } from "./lib/finnhub.js";
import { addViewer, viewerCount } from "./lib/stream.js";
import { analyzeTicker, NotFoundError } from "./lib/analyze.js";
import { demoPayload } from "./lib/demo.js";
import { gradeFromPanel } from "./lib/history.js";
import { readLedger, aggregateLedger } from "./lib/ledger.js";
import { getQuoteCached } from "./lib/quotes.js";
import { getSpyTrSeries, spyTrReturn } from "./lib/spy.js";
import { tiingoGrade, hasTiingoKey } from "./lib/tiingo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Short cache so repeated lookups (peer clicks, refreshes) don't burn the
// 60 calls/min free-tier budget.
const cache = new Map();
const CACHE_TTL_MS = 90_000;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.FINNHUB_API_KEY) });
});

app.get("/api/analyze", async (req, res) => {
  const ticker = String(req.query.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,10}$/.test(ticker)) {
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

    cache.set(ticker, { at: Date.now(), payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

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
  if (!apiKey || !/^[A-Z0-9.\-^]{1,10}$/.test(ticker) || ticker === "DEMO") {
    return res.status(400).end();
  }
  if (viewerCount() >= 25) return res.status(503).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  addViewer(ticker, res, apiKey);
});

// The ledger page: every logged call graded against what actually happened
// since. History is never rewritten, entries are never edited.
//
// Grading basis, in order of preference per ticker:
//  1. "tr"  — total return from the local research panel's split/dividend-
//     adjusted closes (last close on/before the call date -> latest close),
//     benchmarked against SPY's adjusted closes over the SAME window. Immune
//     to splits; includes dividends on both legs.
//  2. "raw" — live quote vs the logged price (and logged SPY level), for
//     tickers the panel doesn't cover. Breaks across splits, excludes
//     dividends — rows carry basis so the page can say which is which.
app.get("/api/ledger", async (_req, res) => {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    const entries = readLedger();
    if (!entries.length) {
      return res.json({ entries: [], aggregates: [], asOf: new Date().toISOString(), warning: null });
    }

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

    // Entries outside the panel: Tiingo's adjusted closes grade them on the
    // same total-return basis (capped per load for the free tier). Only what
    // Tiingo can't cover falls to raw live quotes.
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

    // Raw-quote fallback only for entries neither source can grade,
    // newest-first, capped to protect the free-tier rate limit.
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
      const g = grades[`${e.ticker}|${e.date}`] ?? tGrades[`${e.ticker}|${e.date}`];
      let ret = null;
      let spyRet = null;
      let nowPrice = null;
      let basis = null;
      let frozen = false;
      if (g) {
        basis = "tr";
        ret = (g.latestClose - g.anchorClose) / g.anchorClose;
        nowPrice = Math.round(g.latestClose * 100) / 100;
        frozen = Boolean(latestPanelDate && g.latestDate < latestPanelDate);
        // Matched window: the stock leg ends at its last PANEL close, so SPY
        // must end there too — Yahoo's series includes today's intraday bar,
        // which would otherwise give SPY a head start on every row.
        spyRet = spySeries
          ? spyTrReturn(spySeries, g.anchorDate, g.latestDate)
          : spyNow != null && e.spy ? (spyNow - e.spy) / e.spy : null;
      } else if (quotes[e.ticker] != null) {
        basis = "raw";
        nowPrice = quotes[e.ticker];
        ret = e.price ? (nowPrice - e.price) / e.price : null;
        spyRet = spySeries
          ? spyTrReturn(spySeries, e.date)
          : spyNow != null && e.spy ? (spyNow - e.spy) / e.spy : null;
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

    res.json({
      entries: rows,
      aggregates: aggregateLedger(rows),
      asOf: new Date().toISOString(),
      warning: warnings.length ? warnings.join(" ") : null,
    });
  } catch (err) {
    console.error("ledger failed:", err);
    res.status(500).json({ error: "Could not load the verdict ledger." });
  }
});

app.listen(PORT, () => {
  console.log(`Stock Analyzer running at http://localhost:${PORT}`);
  if (!process.env.FINNHUB_API_KEY) {
    console.log("NOTE: FINNHUB_API_KEY is not set — only the DEMO ticker will work. See .env.example.");
  }
});
