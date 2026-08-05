import fs from "node:fs";
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
import { readPicks, logPick, PICK_DIRECTIONS } from "./lib/picks.js";
import { getQuoteCached } from "./lib/quotes.js";
import { getSpyTrSeries, spyTrReturn } from "./lib/spy.js";
import { tiingoGrade, hasTiingoKey } from "./lib/tiingo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, ".env");
dotenv.config({ path: ENV_FILE });

const app = express();
const PORT = process.env.PORT || 3000;

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
    if (!/^[A-Za-z0-9]{20,60}$/.test(finnhub)) {
      return res.status(400).json({ error: "That doesn't look like a Finnhub API key. Copy it from the finnhub.io dashboard." });
    }
    const q = await getQuote("AAPL", finnhub);
    if (!q || (!q.c && !q.pc)) {
      return res.status(400).json({ error: "Finnhub did not accept that key. Double-check it and try again." });
    }
    const lines = [`FINNHUB_API_KEY=${finnhub}`];
    if (tiingo) lines.push(`TIINGO_API_KEY=${tiingo}`);
    if (contact) lines.push(`SEC_EDGAR_CONTACT=${contact}`);
    lines.push(`PORT=${PORT}`);
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
  if (!apiKey || !TICKER_RE.test(ticker) || ticker === "DEMO") {
    return res.status(400).end();
  }
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
      date: now.slice(0, 10),
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

app.listen(PORT, () => {
  console.log(`Candor running at http://localhost:${PORT}`);
  if (!process.env.FINNHUB_API_KEY) {
    console.log("NOTE: FINNHUB_API_KEY is not set — open the app in a browser to run first-time setup, or see .env.example.");
  }
});
