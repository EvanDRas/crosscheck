import { test } from "node:test";
import assert from "node:assert/strict";
import { quarterlySeries, ttm, latestInstant, computeEdgarMetrics, mergeMetrics } from "../lib/edgar.js";

const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

// 8 quarters ending ~30 days ago, oldest first: 4 prior at `prior`, 4 recent
// stepping up to `recent`, as 10-Q duration entries.
function quarters(vals) {
  return vals.map((val, i) => {
    const end = 30 + (vals.length - 1 - i) * 91;
    return { start: iso(end + 90), end: iso(end), val, form: "10-Q", filed: iso(end - 5) };
  });
}
const instant = (val, daysAgo, priorVal = null) => {
  const out = [{ end: iso(daysAgo), val, form: "10-Q", filed: iso(daysAgo - 5) }];
  if (priorVal != null) out.push({ end: iso(daysAgo + 364), val: priorVal, form: "10-K", filed: iso(daysAgo + 350) });
  return out;
};
const usd = (arr) => ({ units: { USD: arr } });

function syntheticFacts() {
  return {
    facts: {
      "us-gaap": {
        Revenues: usd(quarters([250, 250, 250, 250, 260, 270, 280, 290])), // prior TTM 1000 -> TTM 1100
        NetIncomeLoss: usd(quarters([25, 25, 25, 25, 26, 27, 28, 29])), // TTM 110
        EarningsPerShareDiluted: { units: { "USD/shares": quarters([0.4, 0.4, 0.4, 0.4, 0.5, 0.5, 0.5, 0.5]) } },
        StockholdersEquity: usd(instant(1000, 30, 900)),
        AssetsCurrent: usd(instant(500, 30)),
        LiabilitiesCurrent: usd(instant(250, 30)),
        LongTermDebtNoncurrent: usd(instant(300, 30)),
        LongTermDebtCurrent: usd(instant(50, 30)),
      },
    },
  };
}

test("quarterlySeries synthesizes Q4 from a 10-K annual minus its three 10-Qs", () => {
  const q3 = quarters([100, 110, 120]);
  const annual = [{ start: q3[0].start, end: iso(30 - 91), val: 480, form: "10-K", filed: iso(0) }];
  // annual FY = 480, quarters sum 330 -> synthesized Q4 = 150
  const out = quarterlySeries([...q3, ...annual]);
  assert.equal(out.length, 4);
  const q4 = out[out.length - 1];
  assert.equal(q4.val, 150);
  assert.equal(q4.synthesized, true);
});

test("ttm sums the last four quarters and refuses gapped records", () => {
  const q = quarters([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ttm(q).val, 26); // 5+6+7+8
  const gapped = [...q.slice(0, 2), ...q.slice(6)]; // only 2 recent quarters after a hole
  assert.equal(ttm(gapped), null);
});

test("latestInstant returns the newest value plus the ~1y-prior value", () => {
  const r = latestInstant(instant(1000, 30, 900));
  assert.equal(r.val, 1000);
  assert.equal(r.priorVal, 900);
});

test("computeEdgarMetrics derives the app's metric set from filings", () => {
  const m = computeEdgarMetrics(syntheticFacts(), { price: 40, marketCapUsd: 22_000 }).metrics;
  assert.ok(Math.abs(m.netMargin - 10) < 0.01, `netMargin ${m.netMargin}`);
  assert.ok(Math.abs(m.roe - (110 / 950) * 100) < 0.01, `roe ${m.roe}`);
  assert.ok(Math.abs(m.revenueGrowth - 10) < 0.01, `revenueGrowth ${m.revenueGrowth}`);
  assert.ok(Math.abs(m.epsGrowth - 25) < 0.01, `epsGrowth ${m.epsGrowth}`);
  assert.ok(Math.abs(m.currentRatio - 2) < 0.01, `currentRatio ${m.currentRatio}`);
  assert.ok(Math.abs(m.debtEquity - 0.35) < 0.01, `debtEquity ${m.debtEquity}`);
  assert.ok(Math.abs(m.pe - 20) < 0.01, `pe ${m.pe}`);
  assert.ok(Math.abs(m.ps - 20) < 0.01, `ps ${m.ps}`);
});

test("computeEdgarMetrics returns null for stale filers", () => {
  const facts = syntheticFacts();
  // Shift every duration entry back ~2 years.
  for (const c of Object.values(facts.facts["us-gaap"])) {
    for (const arr of Object.values(c.units)) {
      for (const e of arr) {
        if (e.start) e.start = iso(800 + (30 - Number(0)));
        e.end = iso(760);
      }
    }
  }
  assert.equal(computeEdgarMetrics(facts, {}), null);
});

test("mergeMetrics fills gaps from EDGAR, confirms agreement, flags conflicts", () => {
  const warnings = [];
  const { merged, provenance } = mergeMetrics(
    { pe: 20, ps: null, netMargin: 10, roe: 30 },
    { pe: 21, ps: 5.5, netMargin: 25, roe: null },
    warnings
  );
  assert.equal(provenance.pe.src, "both"); // within tolerance
  assert.equal(provenance.ps.src, "edgar");
  assert.equal(merged.ps, 5.5); // gap filled
  assert.equal(provenance.netMargin.src, "conflict"); // 10 vs 25
  assert.equal(merged.netMargin, 10, "Finnhub value kept on conflict");
  assert.equal(provenance.roe.src, "finnhub");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /netMargin/);
});
