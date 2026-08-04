// Shared short-TTL quote cache. Used for the SPY benchmark anchor at log time
// and for the ledger's raw-quote fallback grading, so N lookups cost at most
// N Finnhub calls per 2 minutes regardless of how often pages reload.

import { getQuote } from "./finnhub.js";

const quoteCache = new Map();
const TTL_MS = 120_000;

export async function getQuoteCached(symbol, apiKey) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;
  const quote = await getQuote(symbol, apiKey);
  quoteCache.set(symbol, { at: Date.now(), quote });
  return quote;
}
