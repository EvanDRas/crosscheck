// SEC EDGAR XBRL client + fundamentals computation. Public-domain data,
// no API key — the same filings every paid vendor resells. Used to fill
// gaps in Finnhub's metrics and to cross-check the ones it does return.
//
// SEC fair-access policy: declare who you are in the User-Agent and stay
// under 10 req/s (we make at most 2 per analysis, cached).

const UA = () =>
  `StockAnalyzer/1.0 (personal research; ${process.env.SEC_EDGAR_CONTACT || "no-contact-configured@example.com"})`;

const DAY = 86_400_000;

async function fetchJson(url, timeoutMs = 15_000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA(), "Accept-Encoding": "gzip, deflate" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

// ---- ticker -> CIK ---------------------------------------------------------

let cikMap = null;
let cikMapAt = 0;

async function getCikMap() {
  if (cikMap && Date.now() - cikMapAt < 24 * 3_600_000) return cikMap;
  const doc = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const map = {};
  for (const row of Object.values(doc)) {
    if (row?.ticker) map[String(row.ticker).toUpperCase()] = { cik: row.cik_str, name: row.title };
  }
  cikMap = map;
  cikMapAt = Date.now();
  return map;
}

// ---- company facts ---------------------------------------------------------

const factsCache = new Map(); // ticker -> { at, facts }
const FACTS_TTL_MS = 12 * 3_600_000;

// Resolves the ticker (SEC uses dashes: BRK.B -> BRK-B) and returns the raw
// companyfacts document, or null when the ticker isn't an SEC filer.
export async function getCompanyFacts(ticker) {
  const t = String(ticker).toUpperCase();
  const hit = factsCache.get(t);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;
  const map = await getCikMap();
  const row = map[t] ?? map[t.replace(/\./g, "-")];
  if (!row) return null;
  const cik = String(row.cik).padStart(10, "0");
  const facts = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  factsCache.set(t, { at: Date.now(), facts });
  if (factsCache.size > 60) factsCache.delete(factsCache.keys().next().value);
  return facts;
}

// ---- pure computation (exported for tests) ---------------------------------

const toT = (s) => Date.parse(s);

// Deduplicate by a key, keeping the latest-filed entry.
function dedupe(entries, keyFn) {
  const best = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    const prev = best.get(k);
    if (!prev || (e.filed ?? "") > (prev.filed ?? "")) best.set(k, e);
  }
  return [...best.values()];
}

// Quarterly duration series from raw XBRL entries. 10-Ks report Q4 as a
// full-year duration, so missing fourth quarters are synthesized as
// FY value minus the three quarterlies inside that fiscal year.
export function quarterlySeries(entries) {
  const q = [];
  const annual = [];
  for (const e of entries ?? []) {
    if (!e?.start || !e?.end || typeof e.val !== "number") continue;
    const days = (toT(e.end) - toT(e.start)) / DAY;
    if (days >= 70 && days <= 100) q.push(e);
    else if (days >= 340 && days <= 380) annual.push(e);
  }
  let quarters = dedupe(q, (e) => e.end).sort((a, b) => toT(a.end) - toT(b.end));
  for (const ann of dedupe(annual, (e) => e.end).sort((a, b) => toT(a.end) - toT(b.end))) {
    if (quarters.some((x) => x.end === ann.end)) continue;
    const inside = quarters.filter((x) => toT(x.end) > toT(ann.start) && toT(x.end) < toT(ann.end));
    if (inside.length === 3) {
      quarters.push({
        start: inside[2].end,
        end: ann.end,
        val: ann.val - inside.reduce((a, x) => a + x.val, 0),
        filed: ann.filed,
        synthesized: true,
      });
    }
  }
  return quarters.sort((a, b) => toT(a.end) - toT(b.end));
}

// Sum of the 4 quarters ending at endBefore (default: latest). Returns null
// unless 4 quarters exist spanning a plausible year.
export function ttm(quarters, endBefore = null) {
  const usable = endBefore == null ? quarters : quarters.filter((x) => toT(x.end) <= endBefore);
  if (usable.length < 4) return null;
  const last4 = usable.slice(-4);
  const span = (toT(last4[3].end) - toT(last4[0].end)) / DAY;
  if (span > 300) return null; // gap in the quarterly record
  return { val: last4.reduce((a, x) => a + x.val, 0), end: last4[3].end };
}

// Latest instant (balance-sheet) value, plus the value ~a year earlier.
export function latestInstant(entries) {
  const inst = dedupe(
    (entries ?? []).filter((e) => !e.start && e.end && typeof e.val === "number"),
    (e) => e.end
  ).sort((a, b) => toT(a.end) - toT(b.end));
  if (!inst.length) return null;
  const latest = inst[inst.length - 1];
  const prior = [...inst].reverse().find((e) => toT(latest.end) - toT(e.end) >= 350 * DAY) ?? null;
  return { val: latest.val, end: latest.end, priorVal: prior?.val ?? null };
}

function unitEntries(facts, taxonomy, names, unit) {
  for (const n of names) {
    const u = facts?.facts?.[taxonomy]?.[n]?.units?.[unit];
    if (Array.isArray(u) && u.length) return u;
  }
  return null;
}

const pctChange = (now, prior) =>
  now != null && prior != null && prior > 0 ? ((now - prior) / prior) * 100 : null;

// Computes the app's metric set from as-filed figures. price and marketCapUsd
// (both optional) enable the price-linked ratios. Returns null when the
// company's filings are too stale to trust (delisted / foreign filer).
export function computeEdgarMetrics(facts, { price = null, marketCapUsd = null } = {}) {
  if (!facts?.facts) return null;

  const revQ = quarterlySeries(unitEntries(facts, "us-gaap", [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ], "USD"));
  const niQ = quarterlySeries(unitEntries(facts, "us-gaap", ["NetIncomeLoss", "ProfitLoss"], "USD"));
  const epsQ = quarterlySeries(unitEntries(facts, "us-gaap", [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
  ], "USD/shares"));

  const revTtm = ttm(revQ);
  const niTtm = ttm(niQ);
  const epsTtm = ttm(epsQ);

  const newest = [revTtm?.end, niTtm?.end].filter(Boolean).map(toT).sort().pop() ?? null;
  if (!newest || Date.now() - newest > 400 * DAY) return null;

  const yearBefore = (t) => (t?.end ? toT(t.end) - 350 * DAY : null);
  const revPrior = revTtm ? ttm(revQ, yearBefore(revTtm)) : null;
  const epsPrior = epsTtm ? ttm(epsQ, yearBefore(epsTtm)) : null;

  const equity = latestInstant(unitEntries(facts, "us-gaap", [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ], "USD"));
  const assetsCur = latestInstant(unitEntries(facts, "us-gaap", ["AssetsCurrent"], "USD"));
  const liabCur = latestInstant(unitEntries(facts, "us-gaap", ["LiabilitiesCurrent"], "USD"));

  const ltdNoncur = latestInstant(unitEntries(facts, "us-gaap", ["LongTermDebtNoncurrent"], "USD"));
  const ltdCur = latestInstant(unitEntries(facts, "us-gaap", ["LongTermDebtCurrent"], "USD"));
  const ltdTotal = latestInstant(unitEntries(facts, "us-gaap", ["LongTermDebt"], "USD"));
  const shortDebt = latestInstant(unitEntries(facts, "us-gaap", ["ShortTermBorrowings", "CommercialPaper"], "USD"));
  let totalDebt = null;
  if (ltdNoncur) totalDebt = ltdNoncur.val + (ltdCur?.val ?? 0) + (shortDebt?.val ?? 0);
  else if (ltdTotal) totalDebt = ltdTotal.val + (shortDebt?.val ?? 0);

  const avgEquity =
    equity?.val != null && equity.priorVal != null ? (equity.val + equity.priorVal) / 2 : equity?.val ?? null;

  const metrics = {
    netMargin: revTtm && niTtm && revTtm.val !== 0 ? (niTtm.val / revTtm.val) * 100 : null,
    roe: niTtm && avgEquity != null && avgEquity > 0 ? (niTtm.val / avgEquity) * 100 : null,
    revenueGrowth: pctChange(revTtm?.val, revPrior?.val),
    epsGrowth: pctChange(epsTtm?.val, epsPrior?.val),
    currentRatio: assetsCur && liabCur && liabCur.val > 0 ? assetsCur.val / liabCur.val : null,
    debtEquity: totalDebt != null && equity?.val > 0 ? totalDebt / equity.val : null,
    pe: price != null && epsTtm && epsTtm.val > 0 ? price / epsTtm.val : null,
    ps: marketCapUsd != null && revTtm && revTtm.val > 0 ? marketCapUsd / revTtm.val : null,
  };
  const hasAny = Object.values(metrics).some((v) => v != null);
  return hasAny ? { metrics, dataThrough: new Date(newest).toISOString().slice(0, 10) } : null;
}

// ---- merge with Finnhub (exported for tests) -------------------------------

// Absolute tolerance per metric; sources also agree within 25% relative.
const ABS_TOL = { pe: 2, ps: 0.5, netMargin: 3, roe: 4, revenueGrowth: 5, epsGrowth: 10, currentRatio: 0.25, debtEquity: 0.25 };

export function mergeMetrics(finnhub, edgar, warnings = []) {
  const provenance = {};
  const merged = { ...finnhub };
  for (const key of Object.keys(ABS_TOL)) {
    const fh = finnhub[key];
    const ed = edgar?.[key] ?? null;
    if (fh == null && ed == null) continue;
    if (fh == null) {
      merged[key] = Math.round(ed * 100) / 100;
      provenance[key] = { src: "edgar", edgar: ed };
    } else if (ed == null) {
      provenance[key] = { src: "finnhub", finnhub: fh };
    } else {
      const agree = Math.abs(fh - ed) <= Math.max(0.25 * Math.max(Math.abs(fh), Math.abs(ed)), ABS_TOL[key]);
      provenance[key] = { src: agree ? "both" : "conflict", finnhub: fh, edgar: Math.round(ed * 100) / 100 };
      if (!agree) warnings.push(`${key}: Finnhub says ${fh.toFixed(2)}, SEC filings imply ${ed.toFixed(2)} — shown value is Finnhub's; treat with care`);
    }
  }
  return { merged, provenance };
}
