// News aggregation: Google News RSS + Yahoo Finance RSS (no keys needed) +
// Finnhub company-news. Parsed server-side, merged, near-duplicate headlines
// removed, newest first. Each source can fail independently — failures are
// reported, never thrown.

import { XMLParser } from "fast-xml-parser";
import { getCompanyNews } from "./finnhub.js";

const MAX_ITEMS = 15;

const parser = new XMLParser({ ignoreAttributes: false });

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VerdictAnalyzer/1.0",
  Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
};

// fast-xml-parser gives plain strings for text-only nodes but objects
// ({"#text": ...}) when attributes are present — flatten either shape.
const text = (node) => {
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "");
  return String(node);
};

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRssItems(url) {
  const res = await fetch(url, { headers: RSS_HEADERS, signal: AbortSignal.timeout(9000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = parser.parse(await res.text());
  let items = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return items;
}

// --- Relevance -------------------------------------------------------------
// Entity-tagged feeds drift (Yahoo files SpaceX stories under TSLA because
// Musk) and search queries match loosely, so every item must actually mention
// the company — by core name, a distinctive name word, or the ticker itself —
// in its headline or summary before it reaches the feed.

// "The Coca-Cola Co" -> "Coca-Cola", "Apple Inc" -> "Apple" — the form
// headlines actually use. Legal suffixes are stripped from the end repeatedly.
export function coreCompanyName(name) {
  let s = String(name ?? "").trim();
  s = s.replace(/^the\s+/i, "");
  const suffix = /\s+(incorporated|inc|corp(oration)?|co(mpany)?|ltd|limited|plc|s\.?a\.?|n\.?v\.?|ag|se|holdings?|group|class\s+[a-c])\.?$/i;
  let prev;
  do {
    prev = s;
    s = s.replace(suffix, "");
  } while (s !== prev);
  s = s.replace(/[,.]+$/, "").trim();
  return s || String(name ?? "").trim();
}

// Name words too common to identify a company on their own.
const GENERIC_NAME_WORDS = new Set([
  "american", "america", "international", "general", "national", "united", "first",
  "global", "group", "holdings", "industries", "systems", "technologies", "technology",
  "financial", "services", "service", "energy", "health", "capital", "motor", "motors", "electric",
  "home", "bank", "gold", "star", "city", "auto", "food", "life", "care", "media",
  "micro", "digital", "data", "airlines", "brands", "products", "solutions",
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function relevanceTerms(ticker, companyName) {
  const core = coreCompanyName(companyName ?? "");
  const phrases = core ? [core.toLowerCase()] : [];
  const tokens = [];
  for (const w of core.split(/\s+/)) {
    const clean = w.replace(/[^a-z0-9&-]/gi, "");
    if (clean.length >= 4 && !GENERIC_NAME_WORDS.has(clean.toLowerCase())) tokens.push(clean);
  }
  return { ticker: String(ticker ?? "").toUpperCase(), phrases, tokens };
}

export function isRelevant(item, terms) {
  const text = `${item.headline ?? ""} ${item.summary ?? ""}`;
  const lower = text.toLowerCase();
  if (terms.phrases.some((p) => lower.includes(p))) return true;
  if (terms.tokens.some((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(text))) return true;
  // The ticker counts only as its own token ($AAPL, (AAPL), "AAPL stock") and
  // only case-sensitively for 2+ letters — "ge" inside a word must not match GE.
  if (terms.ticker.length >= 2 && new RegExp(`(^|[^A-Za-z0-9$])\\$?${escapeRe(terms.ticker)}([^A-Za-z0-9]|$)`).test(text)) return true;
  return false;
}

async function fromGoogleNews(ticker, companyName) {
  // Query by the core name headlines actually use — articles about Apple say
  // "Apple", almost never the legal "Apple Inc" the profile carries.
  const core = coreCompanyName(companyName ?? "");
  const q = core ? `"${core}" OR "${ticker} stock" when:30d` : `"${ticker} stock" when:30d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchRssItems(url);
  return items.map((it) => {
    const source = stripHtml(text(it.source)) || "Google News";
    let headline = stripHtml(text(it.title));
    // Google appends " - Publisher" to titles; drop it when it matches <source>.
    if (source && headline.toLowerCase().endsWith(`- ${source}`.toLowerCase())) {
      headline = headline.slice(0, headline.length - source.length - 2).trim();
    }
    return {
      headline,
      source,
      date: toIso(text(it.pubDate)),
      link: text(it.link),
      summary: "", // Google's description is just a link-wrapped copy of the title
    };
  });
}

async function fromYahooFinance(ticker) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  const items = await fetchRssItems(url);
  return items.map((it) => ({
    headline: stripHtml(text(it.title)),
    source: "Yahoo Finance",
    date: toIso(text(it.pubDate)),
    link: text(it.link),
    summary: stripHtml(text(it.description)),
  }));
}

async function fromFinnhub(ticker, apiKey) {
  const items = await getCompanyNews(ticker, apiKey);
  return (Array.isArray(items) ? items : []).slice(0, 25).map((it) => ({
    headline: stripHtml(it.headline),
    source: it.source || "Finnhub",
    date: it.datetime ? new Date(it.datetime * 1000).toISOString() : null,
    link: it.url || "",
    summary: stripHtml(it.summary),
  }));
}

function toIso(dateStr) {
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// --- Near-duplicate detection ----------------------------------------------

const STOP = new Set([
  "the", "and", "for", "with", "its", "has", "are", "was", "will", "this", "that",
  "from", "after", "into", "over", "amid", "says", "stock", "stocks", "shares",
  "inc", "corp", "company", "news",
]);

export function titleTokens(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function isNearDuplicate(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return false;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  const jaccard = overlap / (tokensA.size + tokensB.size - overlap);
  const containment = overlap / Math.min(tokensA.size, tokensB.size);
  return jaccard >= 0.55 || containment >= 0.85;
}

// Newest first, near-duplicates collapsed, and no single source label allowed
// to flood the feed: a live wire like Yahoo stamps everything "minutes ago"
// and would otherwise fill all 15 slots. Capped-out items backfill at the end
// if the other sources can't fill the limit.
export function dedupeAndSort(items, limit = MAX_ITEMS, perSourceCap = 5) {
  const usable = items.filter((it) => it.headline && it.link);
  usable.sort((a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0));
  const kept = [];
  const overflow = [];
  const perSource = new Map();
  for (const it of usable) {
    const tokens = titleTokens(it.headline);
    const dupe = kept.find((k) => isNearDuplicate(k._tokens, tokens)) ?? overflow.find((k) => isNearDuplicate(k._tokens, tokens));
    if (dupe) {
      // Keep the earlier-kept (newer) item, but adopt a summary if it lacks one.
      if (!dupe.summary && it.summary) dupe.summary = it.summary;
      continue;
    }
    const entry = { ...it, _tokens: tokens };
    const count = perSource.get(it.source) ?? 0;
    if (count >= perSourceCap) {
      overflow.push(entry);
      continue;
    }
    perSource.set(it.source, count + 1);
    kept.push(entry);
    if (kept.length >= limit) break;
  }
  while (kept.length < limit && overflow.length) kept.push(overflow.shift());
  kept.sort((a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0));
  return kept.map(({ _tokens, ...it }) => it);
}

// Returns { items, failures } — a failed source becomes a failures entry.
// Every source's items pass the relevance test before merging; the only
// exception is a 1-letter ticker with no known company name, where there is
// nothing reliable to match against.
export async function aggregateNews({ ticker, companyName, apiKey }) {
  const sources = [
    ["Google News", fromGoogleNews(ticker, companyName)],
    ["Yahoo Finance RSS", fromYahooFinance(ticker)],
  ];
  if (apiKey) sources.push(["Finnhub news", fromFinnhub(ticker, apiKey)]);

  const results = await Promise.allSettled(sources.map(([, p]) => p));
  const terms = relevanceTerms(ticker, companyName);
  const canFilter = terms.phrases.length || terms.tokens.length || terms.ticker.length >= 2;
  const items = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...(canFilter ? r.value.filter((it) => isRelevant(it, terms)) : r.value));
    else failures.push(`${sources[i][0]} unavailable (${r.reason?.message ?? "error"})`);
  });
  return { items: dedupeAndSort(items), failures };
}

// Standalone smoke test: node lib/news.js AAPL "Apple Inc"
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const [ticker = "AAPL", name = ""] = process.argv.slice(2);
  aggregateNews({ ticker, companyName: name, apiKey: process.env.FINNHUB_API_KEY }).then(({ items, failures }) => {
    console.log(`${items.length} items, failures: ${failures.length ? failures.join("; ") : "none"}`);
    for (const it of items) console.log(`- [${it.source}] ${it.date?.slice(0, 10)} ${it.headline.slice(0, 90)}`);
  });
}
