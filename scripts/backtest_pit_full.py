"""Full-formula point-in-time backtest (Hypotheses A and B, pre-registered
in EVIDENCE.md's spirit BEFORE results were seen):

  A. Does adding Valuation + Health (the untested 35% that brakes glamour)
     remove the negative tilt in the top band that the margin+growth+momentum
     composite showed?  ->  compare, on the IDENTICAL call sample:
       (i) 3-category composite  (ii) full 5-category v1
  B. Sector fairness: v2 candidate = Finance/RE health category excluded
     (bank balance sheets make current-ratio/D-E meaningless). Measured on
     score distributions; adopted only as a MEASUREMENT fix.

Data: research cache (annual as-filed rev/NI, PIT membership, adjusted panel,
unadjusted monthly closes, benchmark, sectors) + data/edgar_topup.parquet
(balance-sheet instants + share counts, filed-dated, public domain).
Valuation uses annual earnings (P/E = mcap / latest filed annual NI), so it
is staler than the live app's TTM — a fair proxy for the category, not an
exact replica. Gross of costs. READ-ONLY on the research folder.
"""
import json
import os
from collections import defaultdict
from datetime import timedelta

import numpy as np
import pandas as pd

from backtest_pit_local import (ROOT, FACTS, PRICES, MEMBERS, BENCH, SECTORS,
                                piecewise, verdict_for, build_series, annual_pit)
import bisect

TOPUP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "edgar_topup.parquet")
UNIVERSE = os.path.join(ROOT, "campaign2", "data", "universe_panel.parquet")

ANCH = {
    "pe": [(5, 100), (12, 85), (18, 65), (25, 50), (35, 30), (50, 12), (70, 0)],
    "ps": [(0.5, 100), (1, 90), (2, 75), (4, 55), (8, 35), (15, 12), (25, 0)],
    "netMargin": [(-20, 0), (0, 20), (5, 42), (10, 58), (20, 80), (30, 95), (40, 100)],
    "revenueGrowth": [(-20, 0), (-5, 25), (0, 38), (5, 52), (15, 72), (30, 90), (50, 100)],
    "epsGrowth": [(-30, 0), (-10, 25), (0, 40), (10, 58), (25, 78), (50, 95), (80, 100)],
    "currentRatio": [(0.4, 0), (0.8, 30), (1, 45), (1.5, 70), (2, 85), (3, 100)],
    "debtEquity": [(0, 100), (0.3, 88), (0.6, 72), (1, 55), (1.5, 40), (2.5, 20), (4, 5), (6, 0)],
    "pricePosition": [(0, 5), (0.2, 25), (0.5, 52), (0.85, 88), (1, 100)],
}
W = {"valuation": 20, "profitability": 20, "growth": 20, "health": 15, "momentum": 10}


def instant_pit(entries, asof, max_age=430):
    by_end = {}
    for f, e, v in entries:
        if f is None or f > asof or e is None or v is None:
            continue
        if e not in by_end or f > by_end[e][0]:
            by_end[e] = (f, v)
    if not by_end:
        return None
    latest = max(by_end)
    if (asof - latest).days > max_age:
        return None
    return (latest, by_end[latest][1])


def tstat(s):
    s = s.dropna()
    return s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 and s.std(ddof=1) > 0 else np.nan


def main():
    facts = pd.read_parquet(FACTS)
    facts["end"] = pd.to_datetime(facts["end"]).dt.date
    facts["filed"] = pd.to_datetime(facts["filed"]).dt.date
    rev = build_series(facts, "revenue")
    ni = build_series(facts, "net_income")

    top = pd.read_parquet(TOPUP)
    top["end"] = pd.to_datetime(top["end"]).dt.date
    top["filed"] = pd.to_datetime(top["filed"]).dt.date
    inst = defaultdict(lambda: defaultdict(list))  # concept -> ticker -> [(filed, end, val)]
    for t, c, e, v, f in zip(top["ticker"], top["concept"], top["end"], top["val"], top["filed"]):
        inst[c][t].append((f, e, v))
    for c in inst:
        for t in inst[c]:
            inst[c][t].sort()

    px = pd.read_parquet(PRICES, columns=["Ticker", "Date", "Close"])
    px["Date"] = pd.to_datetime(px["Date"])
    panel = px.pivot_table(index="Date", columns="Ticker", values="Close").sort_index()
    month_ends = panel.groupby([panel.index.year, panel.index.month]).tail(1).index

    up = pd.read_parquet(UNIVERSE, columns=["ym", "ticker", "close_raw"])
    raw_close = {(r.ticker, r.ym): r.close_raw for r in up.itertuples() if r.close_raw is not None}

    bench = pd.read_parquet(BENCH)
    bench["Date"] = pd.to_datetime(bench["Date"])
    bench = bench.set_index("Date")["BenchClose"].sort_index()

    members_raw = pd.read_csv(MEMBERS)
    members_raw["date"] = pd.to_datetime(members_raw["date"]).dt.date
    mem_dates = members_raw["date"].tolist()
    mem_sets = [set(x.replace(".", "-") for x in row.split(",")) for row in members_raw["tickers"]]

    def members_on(d):
        i = bisect.bisect_right(mem_dates, d) - 1
        return mem_sets[i] if i >= 0 else set()

    sector_map = json.load(open(SECTORS))
    sector_of = lambda t: sector_map.get(t.replace("-", "."), sector_map.get(t, "UNKNOWN"))

    me_list = list(month_ends)

    def adj_factor(t, d):
        """unadjusted/adjusted ratio at the last month-end <= d."""
        i = bisect.bisect_right(me_list, pd.Timestamp(d)) - 1
        if i < 0:
            return None
        ts = me_list[i]
        adj = panel.at[ts, t] if t in panel.columns else None
        rc = raw_close.get((t, f"{ts.year}-{ts.month:02d}"))
        if adj is None or not np.isfinite(adj) or rc is None or adj == 0:
            return None
        return rc / adj

    def evaluate(asof_ts):
        asof = asof_ts.date()
        mem = members_on(asof)
        adj = panel.loc[:asof_ts]
        if len(adj) < 260:
            return []
        window = adj.iloc[-252:]
        last = adj.iloc[-1]
        ym = f"{asof_ts.year}-{asof_ts.month:02d}"
        rows = []
        for t in mem:
            if t not in rev or t not in ni or t not in panel.columns:
                continue
            p_adj = last.get(t)
            if not np.isfinite(p_adj):
                continue
            rv = annual_pit(rev[t], asof)
            nv = annual_pit(ni[t], asof)
            if not rv or not nv:
                continue
            margin = nv[1] / rv[1] * 100 if rv[0] == nv[0] and rv[1] else None
            rev_g = (rv[1] - rv[2]) / rv[2] * 100 if rv[2] and rv[2] > 0 else None
            ni_g = (nv[1] - nv[2]) / nv[2] * 100 if nv[2] and nv[2] > 0 else None
            w = window[t].dropna()
            pos = None
            if len(w) >= 150:
                hi, lo = w.max(), w.min()
                if hi > lo:
                    pos = float(min(1, max(0, (p_adj - lo) / (hi - lo))))

            # Valuation: mcap from filed shares split-scaled to D, times raw close.
            pe = ps = None
            sh = instant_pit(inst["shares"].get(t, []), asof)
            rc_d = raw_close.get((t, ym))
            if sh and rc_d:
                fF = adj_factor(t, sh[0])
                fD = adj_factor(t, asof)
                if fF and fD:
                    mcap = sh[1] * (fF / fD) * rc_d
                    if nv[1] and nv[1] > 0:
                        pe = mcap / nv[1]
                    if rv[1] and rv[1] > 0:
                        ps = mcap / rv[1]

            # Health.
            eq = instant_pit(inst["equity"].get(t, []), asof) or instant_pit(inst["equity_incl_nci"].get(t, []), asof)
            ac = instant_pit(inst["assets_current"].get(t, []), asof)
            lc = instant_pit(inst["liabilities_current"].get(t, []), asof)
            cr = ac[1] / lc[1] if ac and lc and lc[1] > 0 and abs((ac[0] - lc[0]).days) <= 100 else None
            ltdnc = instant_pit(inst["ltd_noncurrent"].get(t, []), asof)
            ltdc = instant_pit(inst["ltd_current"].get(t, []), asof)
            ltdt = instant_pit(inst["ltd_total"].get(t, []), asof)
            std = instant_pit(inst["short_debt"].get(t, []), asof) or instant_pit(inst["commercial_paper"].get(t, []), asof)
            debt = None
            if ltdnc:
                debt = ltdnc[1] + (ltdc[1] if ltdc else 0) + (std[1] if std else 0)
            elif ltdt:
                debt = ltdt[1] + (std[1] if std else 0)
            de = debt / eq[1] if debt is not None and eq and eq[1] > 0 else None

            def cat_scores(drop_health=False):
                cats = {}
                val = [x for x in (piecewise(pe, ANCH["pe"]) if pe and pe > 0 else None,
                                   piecewise(ps, ANCH["ps"]) if ps and ps > 0 else None) if x is not None]
                if val:
                    cats["valuation"] = sum(val) / len(val)
                if margin is not None:
                    cats["profitability"] = piecewise(margin, ANCH["netMargin"])
                g = [x for x in (piecewise(rev_g, ANCH["revenueGrowth"]), piecewise(ni_g, ANCH["epsGrowth"])) if x is not None]
                if g:
                    cats["growth"] = sum(g) / len(g)
                if not drop_health:
                    h = [x for x in (piecewise(cr, ANCH["currentRatio"]),
                                     piecewise(de, ANCH["debtEquity"]) if de is not None and de >= 0 else None) if x is not None]
                    if h:
                        cats["health"] = sum(h) / len(h)
                if pos is not None:
                    cats["momentum"] = piecewise(pos, ANCH["pricePosition"])
                return cats

            cats = cat_scores()
            if "valuation" not in cats or len(cats) < 4:
                continue
            sector = sector_of(t)

            def total(c):
                wsum = sum(W[k] for k in c)
                return sum(v * W[k] for k, v in c.items()) / wsum

            full = total(cats)
            c3 = {k: v for k, v in cats.items() if k in ("profitability", "growth", "momentum")}
            comp3 = total(c3) if len(c3) >= 2 else None
            v2cats = cat_scores(drop_health=(sector == "Finance/RE"))
            v2 = total(v2cats)
            rows.append({"asof": asof, "ticker": t, "sector": sector,
                         "full": full, "comp3": comp3, "v2": v2,
                         "vf": verdict_for(full), "v3": verdict_for(comp3) if comp3 is not None else None,
                         "vv2": verdict_for(v2)})
        return rows

    def forward(asof_ts, horizon_days):
        target = asof_ts + pd.Timedelta(days=horizon_days)
        future = panel.loc[asof_ts:target]
        b0, b1 = bench.asof(asof_ts), bench.asof(target)
        if future.empty or pd.isna(b0) or pd.isna(b1) or bench.index[-1] < target:
            return None, None
        return future.iloc[-1] / future.iloc[0] - 1, b1 / b0 - 1

    def run(dates, horizon_days, label):
        allrows = []
        for d in dates:
            rows = evaluate(d)
            fwd, bret = forward(d, horizon_days)
            if not rows or fwd is None:
                continue
            for r in rows:
                fr = fwd.get(r["ticker"])
                if fr is not None and np.isfinite(fr):
                    r["excess"] = fr - bret
                    allrows.append(r)
        df = pd.DataFrame(allrows)
        if df.empty:
            print(f"{label}: no data")
            return df
        print(f"\n=== {label}: {df['asof'].nunique()} dates, {len(df)} calls (identical sample for all variants) ===")
        for scol, vcol, name in [("comp3", "v3", "3-cat composite (prior test)"),
                                 ("full", "vf", "FULL v1 (val+health added)"),
                                 ("v2", "vv2", "v2 candidate (fin. health off)")]:
            sub = df.dropna(subset=[scol])
            sb = sub[sub[vcol] == "STRONG BUY"]
            g = sb.groupby("asof")["excess"].mean()
            q = sub.copy()
            q["quint"] = q.groupby("asof")[scol].transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))
            spread = (q[q["quint"] == 4].groupby("asof")["excess"].mean()
                      - q[q["quint"] == 0].groupby("asof")["excess"].mean())
            top = q[q["quint"] == 4].groupby("asof")["excess"].mean()
            print(f"  {name:<32} STRONG-BUY n={len(sb):>5} excess {g.mean() * 100:+6.2f}% t={tstat(g):+5.2f} | "
                  f"topQ {top.mean() * 100:+6.2f}% t={tstat(top):+5.2f} | Q5-Q1 {spread.mean() * 100:+6.2f}% t={tstat(spread):+5.2f}")
        # Accuracy, the intuitive way: when the FULL formula makes a call, how
        # often is the stock's forward move "right"? Base rates included —
        # accuracy only means something relative to picking at random.
        sub = df.dropna(subset=["full"]).copy()
        sub["ret_abs"] = sub["excess"]  # excess is vs bench; recover absolute below
        base_beat = (sub["excess"] > 0).mean()
        print(f"\n  ACCURACY (full formula) — base rate: a random pick beat the benchmark {base_beat * 100:.0f}% of the time")
        print(f"  {'band':<12} {'n':>6} {'beat bench':>11} {'avg excess':>11}")
        for band in ["STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"]:
            b = sub[sub["vf"] == band]
            if len(b) < 30:
                continue
            beat = (b["excess"] > 0).mean()
            # For SELL bands, the "correct" call is trailing the benchmark.
            correct = 1 - beat if band in ("SELL", "STRONG SELL") else beat
            tag = "correct=trail" if band in ("SELL", "STRONG SELL") else ""
            print(f"  {band:<12} {len(b):>6} {beat * 100:>10.0f}% {b['excess'].mean() * 100:>+10.2f}%   {'accuracy ' + format(correct * 100, '.0f') + '%' if band != 'HOLD' else ''} {tag}")

        for lo, hi in [(2011, 2017), (2018, 2024)]:
            sub = df[(pd.to_datetime(df["asof"]).dt.year >= lo) & (pd.to_datetime(df["asof"]).dt.year <= hi)]
            if sub.empty:
                continue
            line = [f"  {lo}-{hi}:"]
            for scol in ("comp3", "full", "v2"):
                q = sub.dropna(subset=[scol]).copy()
                q["quint"] = q.groupby("asof")[scol].transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))
                spread = (q[q["quint"] == 4].groupby("asof")["excess"].mean()
                          - q[q["quint"] == 0].groupby("asof")["excess"].mean())
                line.append(f"{scol} Q5-Q1 {spread.mean() * 100:+5.2f}% (t={tstat(spread):+4.2f})")
            print("  ".join(line))
        return df

    q_dates = [d for d in month_ends if d.month in (3, 6, 9, 12) and 2011 <= d.year <= 2024]
    a_dates = [d for d in month_ends if d.month == 6 and 2011 <= d.year <= 2024]
    dfq = run(q_dates, 91, "QUARTERLY, 3-month forward")
    run(a_dates, 365, "ANNUAL, 12-month forward")

    if not dfq.empty:
        print("\n=== Hypothesis B: sector fairness (avg score, quarterly sample) ===")
        sec = dfq.groupby("sector").agg(n=("full", "size"), v1_full=("full", "mean"), v2=("v2", "mean")).query("n >= 200")
        overall1, overall2 = dfq["full"].mean(), dfq["v2"].mean()
        print(f"  {'sector':<18} {'n':>6}  {'v1 score':>8}  {'v2 score':>8}   (overall v1 {overall1:.1f}, v2 {overall2:.1f})")
        for s, r in sec.sort_values("v1_full", ascending=False).iterrows():
            print(f"  {s:<18} {int(r['n']):>6}  {r['v1_full']:8.1f}  {r['v2']:8.1f}")
        spread1 = sec["v1_full"].max() - sec["v1_full"].min()
        spread2 = sec["v2"].max() - sec["v2"].min()
        print(f"  cross-sector score spread: v1 {spread1:.1f} pts -> v2 {spread2:.1f} pts")


if __name__ == "__main__":
    main()
