// News aggregation: Google News RSS + Yahoo Finance RSS (no keys needed) +
// Finnhub company-news. Parsed server-side, merged, near-duplicate headlines
// removed, newest first. Each source can fail independently — failures are
// reported, never thrown.

import { XMLParser } from "fast-xml-parser";
import { getCompanyNews } from "./finnhub.js";

const MAX_ITEMS = 15;

const parser = new XMLParser({ ignoreAttributes: false });

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Crosscheck/1.0",
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

async function fromGoogleNews(ticker, companyName, days = 30) {
  // Query by the core name headlines actually use — articles about Apple say
  // "Apple", almost never the legal "Apple Inc" the profile carries.
  const core = coreCompanyName(companyName ?? "");
  const q = core ? `"${core}" OR "${ticker} stock" when:${days}d` : `"${ticker} stock" when:${days}d`;
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
  // Clamp future stamps: wires occasionally post-date items by an hour, and
  // a newest-first sort would pin them to the top of the feed all day.
  return Number.isFinite(t) ? new Date(Math.min(t, Date.now())).toISOString() : null;
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
      // Keep the earlier-kept (newer) item, but adopt a summary or thumbnail
      // if it lacks one — and count the merge: how many outlets ran the same
      // story is the most honest available signal of its importance.
      if (!dupe.summary && it.summary) dupe.summary = it.summary;
      if (!dupe.image && it.image) dupe.image = it.image;
      dupe.covered = (dupe.covered ?? 1) + 1;
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

const SPAM_RE = /price today|quote\s*&\s*chart|live price|price prediction/i;

// Finnhub's general feed, normalized. An image URL shared by several stories
// is a publisher logo, not a photo (Reuters ships one logo on every item) —
// only unique per-story photos survive.
async function fromFinnhubGeneral(apiKey, n = 25) {
  const { getMarketNews } = await import("./finnhub.js");
  const items = await getMarketNews(apiKey);
  const raw = Array.isArray(items) ? items : [];
  const imgUses = new Map();
  for (const it of raw) if (it.image) imgUses.set(it.image, (imgUses.get(it.image) ?? 0) + 1);
  const photo = (img) =>
    /^https:\/\//i.test(String(img ?? "")) && imgUses.get(img) === 1 && !/logo/i.test(img) ? img : "";
  return raw.slice(0, n).map((it) => ({
    // Some wires suffix their own domain onto headlines ("... - reuters.com").
    headline: stripHtml(it.headline).replace(/\s[-|–]\s[a-z0-9-]+(\.[a-z]{2,})+\s*$/i, "").trim(),
    source: it.source || "Finnhub",
    date: it.datetime ? new Date(Math.min(it.datetime * 1000, Date.now())).toISOString() : null,
    link: it.url || "",
    summary: stripHtml(it.summary),
    image: photo(it.image),
    feed: "finnhub",
  }));
}

// Google News topic feeds (keyless): BUSINESS, WORLD, …
async function fromGoogleTopic(topic) {
  const url = `https://news.google.com/rss/headlines/section/topic/${topic}?hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchRssItems(url);
  return items.map((it) => {
    const source = stripHtml(text(it.source)) || "Google News";
    let headline = stripHtml(text(it.title));
    if (source && headline.toLowerCase().endsWith(`- ${source}`.toLowerCase())) {
      headline = headline.slice(0, headline.length - source.length - 2).trim();
    }
    return { headline, source, date: toIso(text(it.pubDate)), link: text(it.link), summary: "", feed: "google" };
  });
}

// Direct wires (keyless RSS): CNBC's finance sections, MarketWatch, and the
// Federal Reserve's own press releases — the primary source for the single
// most market-moving institution there is. Cached ten minutes; each feed
// fails independently and just contributes nothing.
const WIRES = {
  markets: [
    ["CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147"],
    ["CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069"],
    ["CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135"],
    ["CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910"],
    ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
    ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_marketpulse"],
    ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines"],
    ["The Wall Street Journal", "https://feeds.a.dj.com/rss/RSSMarketsMain.xml"],
    ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
    ["Seeking Alpha", "https://seekingalpha.com/market_currents.xml"],
    ["Investing.com", "https://www.investing.com/rss/news.rss"],
  ],
  economy: [
    ["CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"],
    ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"],
  ],
};
const wireCache = new Map();
async function fromWires(kind) {
  const hit = wireCache.get(kind);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.items;
  const settled = await Promise.allSettled(WIRES[kind].map(async ([sourceName, url]) => {
    const items = await fetchRssItems(url);
    return items.slice(0, 40).map((it) => {
      const media = Array.isArray(it["media:content"]) ? it["media:content"][0] : it["media:content"];
      const img = String(media?.["@_url"] ?? "");
      return {
        headline: stripHtml(text(it.title)),
        source: sourceName,
        date: toIso(stripHtml(text(it.pubDate))),
        link: stripHtml(text(it.link)),
        summary: stripHtml(text(it.description)).slice(0, 240),
        image: /^https:\/\//i.test(img) ? img : "",
        feed: "wire",
      };
    });
  }));
  const items = settled
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((it) => it.headline && it.link && !SPAM_RE.test(it.headline) && !FLUFF_RE.test(it.headline));
  if (items.length) wireCache.set(kind, { at: Date.now(), items });
  return items;
}

const MARKET_RE = /\b(stocks?|shares|markets?|wall street|nasdaq|s&p|dow|earnings|fed|rates?|investors?|ipo|bonds?|yields?|oil|crypto|bitcoin|etf|rally|selloff|sell-off|tariffs?|inflation)\b/i;

// Feed hygiene beyond SEO spam: nostalgia pieces, listicles, and "how to
// make money" content are noise in a stock-specific feed.
const FLUFF_RE = /\bhow to (still )?make money|\byears? ago\b|\b(top|best) \d+\b|stocks? to buy\b|\bbounty program\b|\bmillion years\b/i;

// Impact heuristic: which stories plausibly move markets. Inputs are honest
// and observable — macro topic keywords, how many outlets ran the story,
// and wire-tier sourcing. A guide to reading order, not a prediction.
const IMPACT_MAJOR = /\b(fed|federal reserve|powell|rate (cut|hike|decision)|interest rates?|inflation|cpi|ppi|jobs report|payrolls|unemployment|gdp|recession|tariffs?|trade war|opec|crude|oil price|treasur(y|ies)|yields?|debt ceiling|default|bank (failure|run)|(market|stock|flash) crash|selloff|sell-off|circuit breaker|war\b(?! (memorial|museum))|sanctions|government shutdown|stimulus)\b/i;
const IMPACT_MEGA = /\b(nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|berkshire)\b/i;
const IMPACT_EARNINGS = /\b(earnings|guidance|outlook|forecast|beats?|misses?)\b/i;
const TIER1_SOURCE = /^(reuters|associated press|bloomberg|the wall street journal|wsj|cnbc|financial times|barron|marketwatch|federal reserve)/i;
export function impactScore(it) {
  let s = 0;
  const covered = it.covered ?? 1;
  if (covered >= 4) s += 2;
  else if (covered >= 2) s += 1;
  if (IMPACT_MAJOR.test(it.headline)) s += 2;
  else if (IMPACT_MEGA.test(it.headline) && IMPACT_EARNINGS.test(it.headline)) s += 1;
  if (TIER1_SOURCE.test(it.source ?? "")) s += 1;
  return Math.min(4, s);
}
const withImpact = (it) => ({ ...it, impact: impactScore(it), covered: it.covered ?? 1 });

// Front-page feed tabs. top = the market mix; markets = Google's Business
// topic plus the market-flavored wire items; world = Google's World topic
// plus the non-market wire items; you = company news for the reader's own
// tickers (keyless via Google, relevance-filtered like ticker pages).
export async function feedNews({ tab, apiKey, limit = 10, tickers = [], names = {} }) {
  if (tab === "top") return marketNews(apiKey, limit);
  if (tab === "you") {
    // Fresh (7-day) per-ticker news, fluff filtered, and interleaved by
    // ticker so one hot name can't flood the whole feed.
    const settled = await Promise.allSettled(tickers.slice(0, 6).map(async ({ ticker, name }) => {
      const items = await fromGoogleNews(ticker, name ?? ticker, 7);
      const terms = relevanceTerms(ticker, name ?? "");
      const canFilter = terms.phrases.length || terms.tokens.length || terms.ticker.length >= 2;
      return (canFilter ? items.filter((it) => isRelevant(it, terms)) : items).slice(0, 16).map((it) => ({ ...it, tickers: [ticker] }));
    }));
    const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .filter((it) => it.headline && !SPAM_RE.test(it.headline) && !FLUFF_RE.test(it.headline));
    const merged = dedupeAndSort(items, limit * 2, 4).map(withImpact);
    const byTicker = new Map();
    for (const it of merged) {
      const k = it.tickers?.[0] ?? "?";
      if (!byTicker.has(k)) byTicker.set(k, []);
      byTicker.get(k).push(it);
    }
    const out = [];
    let took = true;
    while (out.length < limit && took) {
      took = false;
      for (const [, arr] of byTicker) {
        if (arr.length && out.length < limit) {
          out.push(arr.shift());
          took = true;
        }
      }
    }
    return out;
  }
  if (tab === "briefing") {
    // The skim tab: today's market-wide stories only, ranked by the impact
    // heuristic. Single-company items are skipped unless the headline
    // carries macro-grade weight — "read this, skip the ticker churn."
    const [g, f, w, wm, we] = await Promise.allSettled([
      fromGoogleTopic("BUSINESS"),
      apiKey ? fromFinnhubGeneral(apiKey, 60) : Promise.resolve([]),
      fromGoogleTopic("WORLD"),
      fromWires("markets"),
      fromWires("economy"),
    ]);
    const pool = [
      ...(g.status === "fulfilled" ? g.value : []),
      ...(f.status === "fulfilled" ? f.value : []),
      ...(w.status === "fulfilled" ? w.value : []),
      ...(wm.status === "fulfilled" ? wm.value : []),
      ...(we.status === "fulfilled" ? we.value : []),
    ].filter((it) => it.headline && !SPAM_RE.test(it.headline) && !FLUFF_RE.test(it.headline));
    const aliases = Object.values(names).flat();
    const companyMentions = (h) =>
      aliases.filter((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(h)).length;
    const scored = dedupeAndSort(pool, 60, 5).map(withImpact);
    const keep = scored.filter((it) => {
      const macro = IMPACT_MAJOR.test(it.headline);
      if (companyMentions(it.headline) === 1 && !macro) return false;
      return it.impact >= 2 || macro;
    });
    keep.sort((a, b) => (b.impact - a.impact) || ((Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0)));
    const cap = Math.min(limit, 16);
    const out = keep.slice(0, cap);
    // Thin news day: backfill with the remaining non-churn stories so the
    // column never sits half-empty. The impact RANKING still holds — the
    // heuristic orders the reading, it was never a promise to hide the rest.
    if (out.length < 10) {
      const seen = new Set(out.map((k) => k.link));
      for (const it of scored) {
        if (out.length >= cap) break;
        if (seen.has(it.link)) continue;
        if (companyMentions(it.headline) === 1 && !IMPACT_MAJOR.test(it.headline)) continue;
        out.push(it);
        seen.add(it.link);
      }
    }
    return out.map(({ feed, ...it }) => it);
  }
  const wantMarket = tab === "markets";
  const [g, f, wr] = await Promise.allSettled([
    fromGoogleTopic(wantMarket ? "BUSINESS" : "WORLD"),
    apiKey ? fromFinnhubGeneral(apiKey, 60) : Promise.resolve([]),
    wantMarket ? Promise.all([fromWires("markets"), fromWires("economy")]).then((a) => a.flat()) : Promise.resolve([]),
  ]);
  const items = [
    ...(g.status === "fulfilled" ? g.value : []),
    ...(f.status === "fulfilled" ? f.value.filter((it) => MARKET_RE.test(it.headline) === wantMarket) : []),
    ...(wr.status === "fulfilled" ? wr.value : []),
  ].filter((it) => it.headline && !SPAM_RE.test(it.headline));
  return dedupeAndSort(items, limit, Math.max(3, Math.ceil(limit / 4))).map(withImpact).map(({ feed, ...it }) => it);
}

// Market-wide headlines for the landing page: Google News (keyless) plus
// Finnhub's general feed when a key exists. Same dedupe/caps as ticker news.
export async function marketNews(apiKey, limit = 10) {
  const gQuery = async (q) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const items = await fetchRssItems(url);
    return items.map((it) => {
      const source = stripHtml(text(it.source)) || "Google News";
      let headline = stripHtml(text(it.title));
      if (source && headline.toLowerCase().endsWith(`- ${source}`.toLowerCase())) {
        headline = headline.slice(0, headline.length - source.length - 2).trim();
      }
      return { headline, source, date: toIso(text(it.pubDate)), link: text(it.link), summary: "", feed: "google" };
    });
  };
  const sources = [
    ["Google News", gQuery(`stock market OR "S&P 500" when:2d`)],
    ["Google News", gQuery(`earnings OR "wall street" OR nasdaq when:3d`)],
    ["Google News", gQuery(`"federal reserve" OR inflation OR economy when:3d`)],
  ];
  sources.push(["Direct wires", fromWires("markets")]);
  if (apiKey) sources.push(["Finnhub market news", fromFinnhubGeneral(apiKey, Math.max(25, limit * 2))]);
  const results = await Promise.allSettled(sources.map(([, p]) => p));
  const items = [];
  for (const r of results) if (r.status === "fulfilled") items.push(...r.value);
  // The general feeds carry SEO ticker-page spam ("XYZ Price Today ... |
  // Exchange") that no human would call news — drop it before deduping.
  const filtered = items.filter((it) => it.headline && !SPAM_RE.test(it.headline));
  // Pure recency lets Google's SEO-fresh churn crowd out the wire-service
  // tier (Reuters/CNBC via Finnhub, which also carries the thumbnails) —
  // photo stories in particular can be hours old and never surface. So:
  // photo stories get their own deduped lane and up to two reserved slots,
  // each feed is capped at 6 of the 10, and leftovers backfill so a
  // single-feed (keyless) run still fills the list.
  const merged = dedupeAndSort(filtered, Math.max(30, limit * 3), 3);
  const photos = dedupeAndSort(filtered.filter((it) => it.image), 6, 2);
  const LIMIT = limit;
  const FEED_CAP = Math.ceil(limit * 0.6);
  const out = [];
  const perFeed = new Map();
  const isDupe = (it) =>
    out.some((k) => k.link === it.link || isNearDuplicate(titleTokens(k.headline), titleTokens(it.headline)));
  const take = (it) => {
    perFeed.set(it.feed, (perFeed.get(it.feed) ?? 0) + 1);
    out.push(it);
  };
  for (const it of photos) {
    if (out.length >= 2) break;
    take(it);
  }
  for (const it of merged) {
    if (out.length >= LIMIT) break;
    if (isDupe(it)) continue;
    if ((perFeed.get(it.feed) ?? 0) >= FEED_CAP) continue;
    take(it);
  }
  for (const it of merged) {
    if (out.length >= LIMIT) break;
    if (!isDupe(it)) out.push(it);
  }
  out.sort((a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0));
  return out.map(withImpact).map(({ feed, ...it }) => it);
}

// Standalone smoke test: node lib/news.js AAPL "Apple Inc"
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const [ticker = "AAPL", name = ""] = process.argv.slice(2);
  aggregateNews({ ticker, companyName: name, apiKey: process.env.FINNHUB_API_KEY }).then(({ items, failures }) => {
    console.log(`${items.length} items, failures: ${failures.length ? failures.join("; ") : "none"}`);
    for (const it of items) console.log(`- [${it.source}] ${it.date?.slice(0, 10)} ${it.headline.slice(0, 90)}`);
  });
}
