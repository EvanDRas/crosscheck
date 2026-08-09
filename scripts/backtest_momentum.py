"""Honest backtest of the ONE formula component that can be tested with
point-in-time data: the momentum score (52-week price position -> 0-100 via
the app's anchors). Prices are the only inputs whose history exists on this
machine; every other category (valuation, profitability, growth, health,
analyst) would require point-in-time fundamentals/ratings history that does
NOT exist here — applying today's fundamentals to old prices would be
look-ahead fiction, so it is deliberately not done.

Method: at each month-end, score every ticker in the local S&P panel by the
app's pricePosition anchors, bucket into quintiles, hold one month, measure
equal-weight forward returns vs the universe mean. Gross of costs.

Caveats (all bias the result FAVORABLY, so a null here is extra damning):
 - Panel contains past AND future index members incl. pre-membership history
   (inclusion bias) and drops tickers at delisting mid-month (final partial
   month unmeasured).
 - No trading costs, no slippage.

READ-ONLY on the research data. Usage:  python scripts/backtest_momentum.py
"""
import os
import sys

import numpy as np
import pandas as pd

try:
    from local_paths import RESEARCH_ROOT  # author's machine, gitignored
except ImportError:
    RESEARCH_ROOT = os.environ.get("CROSSCHECK_RESEARCH_ROOT", "")

PANEL = os.environ.get("HISTORY_PRICES_PARQUET") or (
    os.path.join(RESEARCH_ROOT, "cache", "prices_v2.parquet") if RESEARCH_ROOT else ""
)
if not PANEL or not os.path.exists(PANEL):
    sys.exit("Needs a daily S&P price panel (adjusted closes): set HISTORY_PRICES_PARQUET "
             "or CROSSCHECK_RESEARCH_ROOT. See EVIDENCE.md for the required shape.")

# lib/scoring.js ANCHORS.pricePosition, replicated exactly.
ANCHORS = [(0.0, 5.0), (0.2, 25.0), (0.5, 52.0), (0.85, 88.0), (1.0, 100.0)]


def piecewise(v):
    if v <= ANCHORS[0][0]:
        return ANCHORS[0][1]
    if v >= ANCHORS[-1][0]:
        return ANCHORS[-1][1]
    for (x1, s1), (x2, s2) in zip(ANCHORS, ANCHORS[1:]):
        if v <= x2:
            return s1 + (s2 - s1) * (v - x1) / (x2 - x1)
    return ANCHORS[-1][1]


def main():
    df = pd.read_parquet(PANEL, columns=["Ticker", "Date", "Close"])
    px = df.pivot_table(index="Date", columns="Ticker", values="Close").sort_index()
    print(f"panel: {px.shape[1]} tickers, {px.shape[0]} days, {px.index[0].date()} -> {px.index[-1].date()}")

    # 52-week rolling window stats on daily closes, sampled at month-ends.
    roll_min = px.rolling("366D", min_periods=200).min()
    roll_max = px.rolling("366D", min_periods=200).max()
    me = px.groupby([px.index.year, px.index.month]).tail(1).index  # last trading day per month

    pos = ((px - roll_min) / (roll_max - roll_min)).loc[me]
    score = pos.map(piecewise, na_action="ignore") if hasattr(pos, "map") else pos.applymap(piecewise)
    close_me = px.loc[me]
    fwd = close_me.shift(-1) / close_me - 1  # forward 1-month return

    rows = []
    spreads = []
    for i, t in enumerate(me[:-1]):
        s = score.loc[t]
        f = fwd.loc[t]
        ok = s.notna() & f.notna()
        if ok.sum() < 100:
            continue
        s, f = s[ok], f[ok]
        q = pd.qcut(s.rank(method="first"), 5, labels=False)  # 0=lowest score .. 4=highest
        m = f.groupby(q).mean()
        rows.append({"t": t, "n": int(ok.sum()), "univ": f.mean(), **{f"q{k}": m.get(k, np.nan) for k in range(5)}})
        spreads.append(m.get(4, np.nan) - m.get(0, np.nan))

    r = pd.DataFrame(rows).set_index("t")
    spreads = pd.Series(spreads, index=r.index).dropna()
    print(f"\n{len(r)} monthly cross-sections, median universe {int(r['n'].median())} tickers\n")

    print("avg forward 1-month return by momentum-score quintile (equal-weight, gross):")
    for k in range(5):
        ex = (r[f"q{k}"] - r["univ"]).mean()
        label = ["Q1 lowest", "Q2", "Q3", "Q4", "Q5 highest"][k]
        print(f"  {label:<11} {r[f'q{k}'].mean() * 100:+7.3f}%/mo   excess vs universe {ex * 100:+7.3f}%/mo  ({ex * 1200:+6.2f}%/yr)")

    t_stat = spreads.mean() / (spreads.std(ddof=1) / np.sqrt(len(spreads)))
    print(f"\nQ5-minus-Q1 spread: {spreads.mean() * 100:+.3f}%/mo ({spreads.mean() * 1200:+.2f}%/yr), "
          f"t = {t_stat:+.2f} over {len(spreads)} months, hit rate {(spreads > 0).mean() * 100:.0f}%")
    for era, lo in [("2003-2013", "2003"), ("2014-2026", "2014")]:
        sub = spreads[(spreads.index >= lo)] if lo == "2003" else spreads[spreads.index >= "2014"]
        if lo == "2003":
            sub = spreads[spreads.index < "2014"]
        if len(sub) > 12:
            t_s = sub.mean() / (sub.std(ddof=1) / np.sqrt(len(sub)))
            print(f"  {era}: {sub.mean() * 100:+.3f}%/mo, t = {t_s:+.2f} ({len(sub)} months)")

    print("\nGross of costs. Inclusion bias and delisting truncation both flatter the result.")
    print("This tests ONE component (10% of overall verdict weight). A null here does not")
    print("disprove the full formula; nothing here can validate it either — the other five")
    print("categories have no point-in-time history on this machine to test against.")


if __name__ == "__main__":
    sys.exit(main())
