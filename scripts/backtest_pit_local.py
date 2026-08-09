"""Point-in-time backtest of the analyzer's testable categories, built ONLY
from the research project's local files (no fetching):

  - fundamentals: edgar_facts.parquet (revenue, net_income; `filed` dates ->
    no look-ahead, filing lag included)
  - prices: prices_v2.parquet (split/dividend-adjusted daily closes)
  - universe: sp500_history.csv (point-in-time index membership)
  - benchmark: benchmark_2003.parquet
  - sectors: campaign2/data/sector_map.json

What this tests: the verdict the app itself would emit when only
Profitability (net margin), Growth (revenue + earnings growth), and Momentum
(52-week position) have data — a real app state (3/6 categories, weights
renormalized 20/20/10, confidence "Medium"). Valuation/Health/Analyst are not
in the local cache. Earnings growth uses net-income TTM (split-safe), as in
scripts/pit_verdict.mjs.

Pre-committed design (BEFORE results were seen):
  - Quarterly as-of dates, 3-month forward returns (non-overlapping) AND
    annual as-of dates, 12-month forward returns (non-overlapping).
  - Results reported for 2011-2017 and 2018-2024 separately; a real effect
    must appear in both halves.
  - Buckets: app verdict bands and score quintiles. Excess vs benchmark.
READ-ONLY on the research folder. Gross of costs.
"""
import bisect
import json
import os
from collections import defaultdict
from datetime import date, timedelta

import numpy as np
import pandas as pd

try:
    from local_paths import RESEARCH_ROOT as ROOT  # author's machine, gitignored
except ImportError:
    ROOT = os.environ.get("CROSSCHECK_RESEARCH_ROOT", "")
if not ROOT:
    import sys
    sys.exit("Needs the research data root (price panel, membership history, benchmark): "
             "set CROSSCHECK_RESEARCH_ROOT. See EVIDENCE.md for which inputs are required.")
FACTS = os.path.join(ROOT, "experiments", "claude_tests", "edgar_facts.parquet")
PRICES = os.path.join(ROOT, "cache", "prices_v2.parquet")
MEMBERS = os.path.join(ROOT, "cache", "sp500_history.csv")
BENCH = os.path.join(ROOT, "cache", "benchmark_2003.parquet")
SECTORS = os.path.join(ROOT, "campaign2", "data", "sector_map.json")

# ---- scoring, ported from lib/scoring.js (v1 anchors, verbatim) ------------

ANCH = {
    "netMargin": [(-20, 0), (0, 20), (5, 42), (10, 58), (20, 80), (30, 95), (40, 100)],
    "revenueGrowth": [(-20, 0), (-5, 25), (0, 38), (5, 52), (15, 72), (30, 90), (50, 100)],
    "epsGrowth": [(-30, 0), (-10, 25), (0, 40), (10, 58), (25, 78), (50, 95), (80, 100)],
    "pricePosition": [(0, 5), (0.2, 25), (0.5, 52), (0.85, 88), (1, 100)],
}
BANDS = [(72, "STRONG BUY"), (58, "BUY"), (42, "HOLD"), (28, "SELL"), (-1e9, "STRONG SELL")]
W = {"profitability": 20, "growth": 20, "momentum": 10}


def piecewise(v, anchors):
    if v is None or not np.isfinite(v):
        return None
    if v <= anchors[0][0]:
        return anchors[0][1]
    if v >= anchors[-1][0]:
        return anchors[-1][1]
    for (x1, s1), (x2, s2) in zip(anchors, anchors[1:]):
        if v <= x2:
            return s1 + (s2 - s1) * (v - x1) / (x2 - x1)
    return anchors[-1][1]


def verdict_for(score):
    for lo, label in BANDS:
        if score >= lo:
            return label
    return "STRONG SELL"


# ---- fundamentals: filed-aware quarterly series ----------------------------

def build_series(facts_df, concept):
    """ticker -> list of (filed, end, start, val), sorted by filed."""
    sub = facts_df[facts_df["concept"] == concept]
    out = defaultdict(list)
    for t, e, v, f, s in zip(sub["ticker"], sub["end"], sub["val"], sub["filed"], sub.get("start", [None] * len(sub))):
        out[t].append((f, e, s, v))
    for t in out:
        out[t].sort()
    return out


def annual_pit(entries, asof):
    """The cache stores ANNUAL (fiscal-year) values from 10-Ks. Point-in-time:
    only entries FILED on or before asof, latest filing wins per fiscal-year
    end. Returns (latest_end, latest_val, prior_year_val) — latest fiscal year
    must have ended within 430 days of asof (12mo fiscal year + filing lag),
    prior year must sit 300-430 days behind it. Mirrors the live app's
    *Annual metric fallbacks."""
    by_end = {}
    for f, e, s, v in entries:
        if f is None or f > asof or e is None or v is None:
            continue
        if e not in by_end or f > by_end[e][0]:
            by_end[e] = (f, v)
    if not by_end:
        return None
    ends = sorted(by_end)
    latest = ends[-1]
    if (asof - latest).days > 430:
        return None
    prior_val = None
    for e in reversed(ends[:-1]):
        gap = (latest - e).days
        if 300 <= gap <= 430:
            prior_val = by_end[e][1]
            break
        if gap > 430:
            break
    return (latest, by_end[latest][1], prior_val)


def main():
    facts = pd.read_parquet(FACTS)
    facts["end"] = pd.to_datetime(facts["end"]).dt.date
    facts["filed"] = pd.to_datetime(facts["filed"]).dt.date
    rev = build_series(facts, "revenue")
    ni = build_series(facts, "net_income")

    px = pd.read_parquet(PRICES, columns=["Ticker", "Date", "Close"])
    px["Date"] = pd.to_datetime(px["Date"])
    panel = px.pivot_table(index="Date", columns="Ticker", values="Close").sort_index()

    bench = pd.read_parquet(BENCH)
    bench["Date"] = pd.to_datetime(bench["Date"])
    bench = bench.set_index("Date")["BenchClose"].sort_index()

    members_raw = pd.read_csv(MEMBERS)
    members_raw["date"] = pd.to_datetime(members_raw["date"]).dt.date
    mem_dates = members_raw["date"].tolist()
    mem_sets = [set(t.replace(".", "-") for t in row.split(",")) for row in members_raw["tickers"]]

    def members_on(d):
        i = bisect.bisect_right(mem_dates, d) - 1
        return mem_sets[i] if i >= 0 else set()

    sector_map = json.load(open(SECTORS))
    sector_of = lambda t: sector_map.get(t.replace("-", "."), sector_map.get(t, "UNKNOWN"))

    month_ends = panel.groupby([panel.index.year, panel.index.month]).tail(1).index

    def evaluate(asof_ts):
        """All point-in-time calls on one date. Returns list of dicts."""
        asof = asof_ts.date()
        mem = members_on(asof)
        adj = panel.loc[:asof_ts]
        if len(adj) < 260:
            return []
        rows = []
        window = adj.iloc[-252:]
        last = adj.iloc[-1]
        for t in mem:
            if t not in rev or t not in ni or t not in panel.columns:
                continue
            p = last.get(t)
            if not np.isfinite(p):
                continue
            rv = annual_pit(rev[t], asof)
            nv = annual_pit(ni[t], asof)
            if not rv or not nv:
                continue
            # Margin needs both figures from the SAME fiscal year.
            margin = nv[1] / rv[1] * 100 if rv[0] == nv[0] and rv[1] else None
            rev_g = (rv[1] - rv[2]) / rv[2] * 100 if rv[2] and rv[2] > 0 else None
            ni_g = (nv[1] - nv[2]) / nv[2] * 100 if nv[2] and nv[2] > 0 else None
            w = window[t].dropna()
            pos = None
            if len(w) >= 150:
                hi, lo = w.max(), w.min()
                if hi > lo:
                    pos = float(min(1, max(0, (p - lo) / (hi - lo))))
            cats = {}
            if margin is not None:
                cats["profitability"] = piecewise(margin, ANCH["netMargin"])
            g = [x for x in (piecewise(rev_g, ANCH["revenueGrowth"]), piecewise(ni_g, ANCH["epsGrowth"])) if x is not None]
            if g:
                cats["growth"] = sum(g) / len(g)
            if pos is not None:
                cats["momentum"] = piecewise(pos, ANCH["pricePosition"])
            if len(cats) < 2:
                continue
            wsum = sum(W[k] for k in cats)
            score = sum(v * W[k] for k, v in cats.items()) / wsum
            rows.append({"asof": asof, "ticker": t, "score": score, "verdict": verdict_for(score), "sector": sector_of(t)})
        return rows

    def forward(asof_ts, horizon_days):
        target = asof_ts + pd.Timedelta(days=horizon_days)
        future = panel.loc[asof_ts:target]
        b0 = bench.asof(asof_ts)
        b1 = bench.asof(target)
        if future.empty or pd.isna(b0) or pd.isna(b1) or bench.index[-1] < target:
            return None, None
        return future.iloc[-1] / future.iloc[0] - 1, b1 / b0 - 1

    def run(dates, horizon_days, label):
        per_date = []
        allrows = []
        for d in dates:
            rows = evaluate(d)
            fwd, bret = forward(d, horizon_days)
            if not rows or fwd is None:
                continue
            for r in rows:
                fr = fwd.get(r["ticker"])
                if fr is None or not np.isfinite(fr):
                    continue
                r["excess"] = fr - bret
                allrows.append(r)
            per_date.append(d)
        df = pd.DataFrame(allrows)
        if df.empty:
            print(f"{label}: no data")
            return df
        print(f"\n=== {label}: {len(per_date)} dates, {len(df)} graded calls, "
              f"median {int(df.groupby('asof').size().median())} names/date ===")

        def bucket_stats(df, key, order):
            g = df.groupby(["asof", key])["excess"].mean().unstack()
            for b in order:
                if b not in g.columns:
                    continue
                s = g[b].dropna()
                t = s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 and s.std(ddof=1) > 0 else np.nan
                print(f"  {str(b):<12} n={int(df[df[key] == b].shape[0]):>5}  "
                      f"avg excess {s.mean() * 100:+6.2f}%  t={t:+5.2f}")

        print("by verdict band:")
        bucket_stats(df, "verdict", ["STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"])
        df["quint"] = df.groupby("asof")["score"].transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))
        print("by score quintile (4=highest):")
        bucket_stats(df, "quint", [4, 3, 2, 1, 0])
        spread = (df[df["quint"] == 4].groupby("asof")["excess"].mean()
                  - df[df["quint"] == 0].groupby("asof")["excess"].mean()).dropna()
        t = spread.mean() / (spread.std(ddof=1) / np.sqrt(len(spread))) if len(spread) > 2 else np.nan
        print(f"  Q5-Q1 spread {spread.mean() * 100:+.2f}% per period, t={t:+.2f}, {len(spread)} periods, hit {(spread > 0).mean() * 100:.0f}%")
        return df

    q_dates = [d for d in month_ends if d.month in (3, 6, 9, 12) and 2011 <= d.year <= 2024]
    a_dates = [d for d in month_ends if d.month == 6 and 2011 <= d.year <= 2024]

    dfq = run(q_dates, 91, "QUARTERLY dates, 3-month forward")
    for lo, hi, tag in [(2011, 2017, "1st half"), (2018, 2024, "2nd half")]:
        if not dfq.empty:
            sub = dfq[(pd.to_datetime(dfq["asof"]).dt.year >= lo) & (pd.to_datetime(dfq["asof"]).dt.year <= hi)]
            print(f"\n--- {tag} ({lo}-{hi}) ---")
            if not sub.empty:
                s = (sub[sub["quint"] == 4].groupby("asof")["excess"].mean()
                     - sub[sub["quint"] == 0].groupby("asof")["excess"].mean()).dropna()
                t = s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 else np.nan
                print(f"  Q5-Q1: {s.mean() * 100:+.2f}%/qtr, t={t:+.2f} ({len(s)} qtrs)")

    run(a_dates, 365, "ANNUAL dates, 12-month forward")

    if not dfq.empty:
        print("\n=== sector lens (quarterly sample): avg score by sector — is scoring sector-biased? ===")
        sec = dfq.groupby("sector").agg(n=("score", "size"), avg_score=("score", "mean"), avg_excess=("excess", "mean"))
        sec = sec[sec["n"] >= 200].sort_values("avg_score", ascending=False)
        for s, r in sec.iterrows():
            print(f"  {s:<18} n={int(r['n']):>6}  avg score {r['avg_score']:5.1f}  avg excess {r['avg_excess'] * 100:+5.2f}%")

    if not dfq.empty:
        cov = dfq.groupby(dfq["asof"].map(lambda d: d.year))["ticker"].nunique()
        print("\ncoverage (unique tickers scored per year):")
        print("  " + ", ".join(f"{y}:{n}" for y, n in cov.items()))
    print("\nCaveats: 3 of 6 categories (50% of formula weight) — valuation/health/analyst not in local cache;")
    print("fundamentals limited to tickers resolvable in the cache (survivor-tilted in early years); gross of costs.")


if __name__ == "__main__":
    main()
