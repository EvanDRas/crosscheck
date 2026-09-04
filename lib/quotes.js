// Shared short-TTL quote cache. Used for the SPY benchmark anchor at log time
// and for the ledger's raw-quote fallback grading, so N lookups cost at most
// N Finnhub calls per 2 minutes regardless of how often pages reload.

import { getQuote } from "./finnhub.js";

const quoteCache = new Map();
const TTL_MS = 120_000;

// One upstream fetch per symbol at a time: watch, portfolio, and alert lists
// often share tickers and expire together, and without this each caller paid
// for its own identical call within milliseconds.
const inflight = new Map();

// True when a quote no older than maxAgeMs is already on hand — lets routes
// serve warm symbols instantly and pace only the ones that will spend budget.
export function hasFreshQuote(symbol, maxAgeMs = TTL_MS) {
  const hit = quoteCache.get(symbol);
  return Boolean(hit && Date.now() - hit.at < maxAgeMs);
}

// maxAgeMs lets an explicit user refresh demand fresher data than the
// default 2-minute TTL; callers guard the API budget before lowering it.
export async function getQuoteCached(symbol, apiKey, maxAgeMs = TTL_MS) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.quote;
  // An in-flight fetch is by definition fresher than any maxAgeMs — join it.
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const p = getQuote(symbol, apiKey)
    .then((quote) => {
      quoteCache.set(symbol, { at: Date.now(), quote });
      if (quoteCache.size > 300) quoteCache.delete(quoteCache.keys().next().value);
      return quote;
    })
    .finally(() => inflight.delete(symbol));
  inflight.set(symbol, p);
  return p;
}
