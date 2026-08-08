# Crosscheck — the honest stock analyzer

![tests](https://github.com/evandras/crosscheck/actions/workflows/test.yml/badge.svg)

Type a ticker, get the whole picture: live quote, company profile, fundamentals
cross-checked against SEC filings, analyst ratings, earnings history, peers,
relevance-filtered news — and a transparent 0–100 verdict (STRONG BUY → STRONG
SELL) you can pick apart category by category, from the only analyzer that
publishes its own backtests ([EVIDENCE.md](EVIDENCE.md) — including the ones
that came back null).

Free and MIT-licensed; runs on your machine with your own free API keys.
Non-programmer setup guide: [FRIENDS_SETUP.md](FRIENDS_SETUP.md).

**Not financial advice.** Research/education only. Data can be delayed,
incomplete, or wrong; the verdict is a mechanical formula, not a recommendation.

## How it works

- **Backend** (Node.js + Express) owns all API keys — nothing sensitive ever
  reaches the browser. One endpoint does the work:
  `GET /api/analyze?ticker=SYMBOL` returns a single JSON payload.
- **Financial data** comes from [Finnhub](https://finnhub.io) (free tier):
  quote, profile, `/stock/metric?metric=all` fundamentals, recommendation
  trends, earnings, peers.
- **SEC EDGAR cross-check** (no key, public-domain): fundamentals are also
  computed from as-filed XBRL company facts (TTM assembled from quarterlies,
  incl. the synthesized Q4 = 10-K minus three 10-Qs). EDGAR values fill
  Finnhub's gaps (marked `SEC` on the tile), agreements get a `✓`, and
  disagreements get a `⚠` with both values on hover plus a warning — bad
  vendor data can't silently drive a verdict anymore. Keyless mode now shows
  real fundamentals too.
- **Tiingo** (optional free key): fresh split/dividend-adjusted closes for
  tickers the local panel doesn't cover — live chart + 52-week stats for any
  US name, and total-return ledger grading instead of the raw-quote fallback.
- **News** is aggregated server-side from Google News RSS (spans hundreds of
  publishers), Yahoo Finance RSS, and Finnhub company-news — parsed, filtered
  for relevance (every item must mention the company's core name, a distinctive
  name word, or the ticker as a real token — entity-tagged feeds drift, e.g.
  SpaceX stories filed under TSLA), near-duplicate headlines removed, newest
  first, top 15. The RSS sources need no key.
- **Scoring** (`lib/scoring.js`) is fully transparent: each metric maps to 0–100
  through visible piecewise-linear anchors, metrics average into six weighted
  categories (Valuation 20 / Profitability 20 / Growth 20 / Health 15 /
  Momentum 10 / Analyst 15), weights renormalize over whatever data exists, and
  the UI shows every sub-score. Fewer than two scorable categories → an honest
  "NOT ENOUGH DATA" instead of a fake verdict.
- **Live prices, not delayed:** the quote refreshes on every request even when
  the heavy payload is served from cache (1 API call instead of ~7), and while
  a result is on screen the price block streams real-time trades from
  Finnhub's free websocket (relayed server-side over SSE, throttled to 1
  update/sec, auto-quiet outside market hours). Charts and ledger grading
  stay end-of-day on purpose — grading is close-to-close by design.
- Sources are fetched in parallel; any single source failing degrades that
  section to N/A and adds a warning — it never breaks the page.
- **Price history chart** comes from local research datasets when available
  (see `.env.example`): an S&P 500 daily panel (kept current by a separate
  research project on this PC) with a ~15k-ticker Tiingo archive as fallback
  (static snapshot — the chart label says which source and how fresh it is).
  This also lets the app run keyless in a useful mode: chart + news + an honest
  "not enough data" verdict. On a cloud deploy without these files the chart
  section simply doesn't render.
- **Horizon views** — alongside the overall verdict, the same categories are
  regrouped by the horizon they usually speak to: *Near-term (weeks–months)* =
  momentum + analyst tilt + earnings execution (beat rate and average surprise
  over the last 4 quarters); *Long-term (years)* = valuation + profitability +
  growth + financial health. This is a decomposition of the one dataset, not
  two independent forecasts — a stock can honestly read "near-term SELL,
  long-term BUY" (classic value-trap shape) and the UI says exactly which
  numbers drive each side. Both horizon calls are logged to the Verdict Ledger
  so time can grade them separately.
- **Verdict Ledger** (`/ledger.html`) — a *forward* test of the verdicts.
  Every real analysis logs its call (verdict, score, price, and SPY's level at
  that moment) to `data/verdict_ledger.json`: first call per ticker per day,
  append-only, never edited, stamped with the scoring-formula version. The
  ledger page grades those frozen calls — do the BUYs actually beat SPY, and
  by more than the SELLs? This is deliberately *not* a historical backtest:
  backtesting a hand-tuned formula on data you can re-run until it looks good
  is how people fool themselves. Logging calls first and letting time grade
  them is the version that can't cheat. Expect months, not days, before the
  numbers mean anything.
- **Grading is total-return and split-safe.** Calls are graded from the local
  research panel's split- and dividend-adjusted closes (last close on/before
  the call date → latest close), with SPY's adjusted series (Yahoo, keyless)
  measured over the same window — so a stock split or a dividend can't fake a
  gain or a loss. Tickers outside the panel fall back to raw live-quote
  grading and are marked `*` on the ledger page; tickers whose panel series
  stopped (left the index) are graded through their last close, marked `†`.
- **Daily batch logging** (`npm run batch`) — analyzes a fixed, pre-committed
  universe (`data/universe.json`: 50 liquid US large caps across all 11
  sectors, chosen 2026-08-04 before any results existed) through the exact
  same pipeline as the web app, so the ledger accumulates ~50 systematic
  calls per trading day instead of only whatever gets typed in by hand. Paced
  for the free-tier rate limit (~8.5s/ticker ≈ 7 minutes per run), news
  fetches skipped (scoring never uses news), re-runs harmless (first call per
  ticker per day wins), every run appends a summary to `data/batch_runs.log`.
  A Windows scheduled task ("Stock Analyzer batch log") runs it each weekday
  morning; edit or remove it in Task Scheduler.
  Don't tune the anchors while the test runs — if the formula changes, bump
  `SCORING_VERSION` in `lib/scoring.js` so eras stay separable.
- **Copy AI brief** (button, top of results) formats the entire analysis —
  profile, quote, verdict breakdown, fundamentals, analysts, earnings, peers,
  and the news feed with summaries and links — as markdown, ready to paste into
  an AI chat (Claude, etc.) as context for a deeper discussion. The same data is
  available raw at `/api/analyze?ticker=SYMBOL` for programmatic use.

## Setup

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Get a free API key: sign up at [finnhub.io](https://finnhub.io), copy the key
   from the dashboard.
3. In this folder:

   ```
   copy .env.example .env
   ```

   Open `.env` and paste your key into `FINNHUB_API_KEY`.
4. Install and run — either double-click **Start Crosscheck.bat** (Windows) /
   **start-crosscheck.command** (Mac), or from a terminal:

   ```
   npm install
   npm start
   ```

5. Open http://localhost:3000 and type a ticker — or a company name;
   Crosscheck will find the symbol. First run with no key shows a guided
   in-app setup instead of asking you to edit files.

No key yet? The ticker `DEMO` renders the full UI with clearly-labeled fake
sample data.

## Tests

```
npm test
```

Runs the scoring-engine suite (anchor interpolation, verdict band boundaries,
weight renormalization, negative-P/E exclusion, not-enough-data state) plus the
news dedupe logic. There's also a live smoke test for the news aggregator:

```
node lib/news.js AAPL "Apple Inc"
```

## Deploying (free hosts)

The app is a single Node process serving both API and frontend — any Node host
works.

**Render** (free web service):
1. Push this folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Add environment variable `FINNHUB_API_KEY` = your key.
5. Deploy. (Free instances sleep when idle; the first request after a while
   takes ~30s to wake.)

**Railway**: New Project → Deploy from GitHub repo → add `FINNHUB_API_KEY`
under Variables. Railway detects `npm start` automatically.

Both hosts set `PORT` themselves; the server reads it.

## Notes & limits

- Finnhub free tier = 60 API calls/min; one analysis uses ~7 calls. The server
  caches each ticker for 90 seconds, so repeated lookups and peer-clicking are
  cheap. If you hit the limit anyway, the app says so plainly — wait a minute.
- Free-tier fundamentals are best for US-listed stocks; some fields are simply
  missing for smaller/foreign names. Those show as N/A and the verdict's
  confidence drops accordingly.
- The scoring anchors encode conventional rules of thumb (e.g. P/E 18 ≈ neutral,
  current ratio 2 ≈ healthy). They are opinions frozen in code — read
  `lib/scoring.js` and disagree with them; that's the point of transparent
  scoring.
- **The formula has been tested, and the results ship with the app** — see
  [EVIDENCE.md](EVIDENCE.md): 23 years of momentum data, five graded
  point-in-time case studies, and 18,150 point-in-time calls over 2011–2024.
  Short version: the testable components showed no predictive power, so the
  verdict is presented as a description of current fundamentals, never a
  forecast. The Verdict Ledger is the ongoing out-of-sample test.
