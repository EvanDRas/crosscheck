// Thin Finnhub REST client. Every call goes through fh() so key handling,
// timeouts, and error mapping live in one place. The API key never leaves the
// server.

const BASE = "https://finnhub.io/api/v1";

export class FinnhubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FinnhubError";
    this.status = status;
  }
}

async function fh(path, params, apiKey) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", apiKey);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  } catch (err) {
    throw new FinnhubError(`Could not reach Finnhub (${err.name === "TimeoutError" ? "timed out" : "network error"}).`, 0);
  }
  if (res.status === 401 || res.status === 403) {
    throw new FinnhubError("Finnhub rejected the API key. Check FINNHUB_API_KEY in your .env file.", res.status);
  }
  if (res.status === 429) {
    throw new FinnhubError("Finnhub rate limit reached (free tier = 60 calls/min). Wait a minute and try again.", 429);
  }
  if (!res.ok) {
    throw new FinnhubError(`Finnhub returned ${res.status} for ${path}.`, res.status);
  }
  return res.json();
}

export const getQuote = (symbol, key) => fh("/quote", { symbol }, key);
export const getProfile = (symbol, key) => fh("/stock/profile2", { symbol }, key);
export const getMetrics = (symbol, key) => fh("/stock/metric", { symbol, metric: "all" }, key);
export const getRecommendations = (symbol, key) => fh("/stock/recommendation", { symbol }, key);
export const getEarnings = (symbol, key) => fh("/stock/earnings", { symbol }, key);
export const getPeers = (symbol, key) => fh("/stock/peers", { symbol }, key);

export function getCompanyNews(symbol, key, days = 30) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const d = (x) => x.toISOString().slice(0, 10);
  return fh("/company-news", { symbol, from: d(from), to: d(to) }, key);
}
