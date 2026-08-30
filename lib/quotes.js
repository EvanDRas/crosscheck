// Shared short-TTL quote cache. Used for the SPY benchmark anchor at log time
// and for the ledger's raw-quote fallback grading, so N lookups cost at most
// N Finnhub calls per 2 minutes regardless of how often pages reload.

import { getQuote } from "./finnhub.js";

const quoteCache = new Map();
const TTL_MS = 120_000;

// maxAgeMs lets an explicit user refresh demand fresher data than the
// default 2-minute TTL; callers guard the API budget before lowering it.
export async function getQuoteCached(symbol, apiKey, maxAgeMs = TTL_MS) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.quote;
  const quote = await getQuote(symbol, apiKey);
  quoteCache.set(symbol, { at: Date.now(), quote });
  if (quoteCache.size > 300) quoteCache.delete(quoteCache.keys().next().value);
  return quote;
}
