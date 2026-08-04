"""Slice one ticker's price history out of the local research parquet files.

Called by lib/history.js as: python read_history.py TICKER PRICES_PARQUET TIINGO_DIR
Prints one JSON object to stdout:
  {source, through, updatesDaily, last: {date, close},
   local52: {high, low, position} | null,
   series: [[YYYY-MM-DD, close], ...]}   # daily <1y, weekly <5y, monthly beyond
or {"notFound": true} when the ticker is in neither dataset.

Grade mode, for the verdict ledger:
  python read_history.py --grade PRICES_PARQUET   (pairs JSON on stdin)
  stdin:  {"pairs": [{"ticker": "AAPL", "date": "2026-08-03"}, ...]}
  stdout: {"latestPanelDate": "...", "grades": {"AAPL|2026-08-03": {
            "anchorDate", "anchorClose", "latestDate", "latestClose"}, ...}}
The panel's Close is split- AND dividend-adjusted (verified against NVDA's
2024 10:1 split and AAPL's dividend history), so anchor->latest is a
total-return measure — the honest way to grade a call across splits/payouts.
A pair is omitted from "grades" when the ticker isn't in the panel or has no
close on/before the anchor date. Ticker dots map to panel dashes (BRK.B->BRK-B).

READ-ONLY: this script never writes to the research folder.
"""
import json
import os
import sys
from datetime import timedelta

import pyarrow.parquet as pq


def downsample(dates, closes):
    """Daily for the last year, weekly to 5 years, monthly beyond."""
    if not dates:
        return []
    last = dates[-1]
    daily_from = last - timedelta(days=370)
    weekly_from = last - timedelta(days=int(5.2 * 365))
    out = []
    prev_week = prev_month = None
    for d, c in zip(dates, closes):
        if c is None:
            continue
        if d >= daily_from:
            out.append((d, c))
        elif d >= weekly_from:
            wk = d.isocalendar()[:2]
            if wk != prev_week:
                out.append((d, c))
                prev_week = wk
        else:
            mo = (d.year, d.month)
            if mo != prev_month:
                out.append((d, c))
                prev_month = mo
    out.sort(key=lambda x: x[0])
    return out


def load(path, ticker_col, date_col, close_col, ticker):
    tb = pq.read_table(path, filters=[(ticker_col, "=", ticker)], columns=[date_col, close_col])
    if tb.num_rows == 0:
        return None
    rows = sorted(zip(tb.column(date_col).to_pylist(), tb.column(close_col).to_pylist()))
    dates = [r[0].date() if hasattr(r[0], "date") else r[0] for r in rows]
    closes = [r[1] for r in rows]
    return dates, closes


def grade():
    """Grade ledger entries from the panel: adjusted close on/before the entry
    date vs the ticker's latest adjusted close. Reads the parquet once."""
    from datetime import date

    prices_parquet = sys.argv[2]
    pairs = json.loads(sys.stdin.buffer.read().decode("utf-8-sig")).get("pairs", [])
    out = {"latestPanelDate": None, "grades": {}}
    if not pairs or not os.path.exists(prices_parquet):
        print(json.dumps(out))
        return

    # Finnhub writes BRK.B; the panel stores BRK-B. Try both spellings.
    requested = {p["ticker"].upper() for p in pairs}
    candidates = {}
    for t in requested:
        candidates[t] = t
        candidates[t.replace(".", "-")] = t

    tb = pq.read_table(
        prices_parquet,
        filters=[("Ticker", "in", list(candidates))],
        columns=["Ticker", "Date", "Close"],
    )
    series = {}  # requested ticker -> sorted [(date, close)]
    for panel_t, d, c in zip(
        tb.column("Ticker").to_pylist(), tb.column("Date").to_pylist(), tb.column("Close").to_pylist()
    ):
        if c is None:
            continue
        t = candidates[panel_t]
        series.setdefault(t, []).append((d.date() if hasattr(d, "date") else d, c))
    for rows in series.values():
        rows.sort()

    latest_overall = max((rows[-1][0] for rows in series.values()), default=None)
    if latest_overall:
        out["latestPanelDate"] = latest_overall.isoformat()

    for p in pairs:
        t = p["ticker"].upper()
        rows = series.get(t)
        if not rows:
            continue
        anchor_date = date.fromisoformat(p["date"])
        anchor = None
        for d, c in rows:  # last close on/before the entry date
            if d <= anchor_date:
                anchor = (d, c)
            else:
                break
        if anchor is None:
            continue
        latest = rows[-1]
        out["grades"][f"{t}|{p['date']}"] = {
            "anchorDate": anchor[0].isoformat(),
            "anchorClose": round(anchor[1], 6),
            "latestDate": latest[0].isoformat(),
            "latestClose": round(latest[1], 6),
        }
    print(json.dumps(out))


def main():
    from datetime import date

    if sys.argv[1] == "--grade":
        grade()
        return

    ticker, prices_parquet, tiingo_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    ticker = ticker.upper()
    today = date.today()

    # The S&P panel — small, refreshed daily by the research project's routine.
    # CAVEAT: it also contains ex-members whose history FREEZES the day they
    # left the index, so a hit there is only trustworthy if it's recent.
    panel = None
    if os.path.exists(prices_parquet):
        panel = load(prices_parquet, "Ticker", "Date", "Close", ticker)

    result = None
    if panel and (today - panel[0][-1]).days <= 30:
        result = (panel, "sp500-panel")
    else:
        # The Tiingo research archive — ~15k US tickers incl. delisted, static snapshot.
        tiingo = None
        if os.path.isdir(tiingo_dir):
            first = ticker[0] if ticker[0].isalpha() else "-"
            shard = os.path.join(tiingo_dir, f"part_{first}.parquet")
            if os.path.exists(shard):
                tiingo = load(shard, "Ticker", "Date", "AdjClose", ticker)
        # Prefer whichever source runs later (a stale panel loses to the archive).
        candidates = [(g, s) for g, s in [(panel, "sp500-panel"), (tiingo, "tiingo-archive")] if g]
        if candidates:
            result = max(candidates, key=lambda x: x[0][0][-1])

    if result is None:
        print(json.dumps({"notFound": True}))
        return

    (dates, closes), source = result
    updates_daily = source == "sp500-panel" and (today - dates[-1]).days <= 7
    valid = [(d, c) for d, c in zip(dates, closes) if c is not None]
    dates = [d for d, _ in valid]
    closes = [c for _, c in valid]
    if not dates:
        print(json.dumps({"notFound": True}))
        return

    last_date, last_close = dates[-1], closes[-1]
    year_ago = last_date - timedelta(days=366)
    yr = [c for d, c in zip(dates, closes) if d >= year_ago]
    local52 = None
    if len(yr) >= 30:
        hi, lo = max(yr), min(yr)
        local52 = {
            "high": round(hi, 4),
            "low": round(lo, 4),
            "position": round((last_close - lo) / (hi - lo), 4) if hi > lo else None,
        }

    series = [[d.isoformat(), round(c, 4)] for d, c in downsample(dates, closes)]
    print(json.dumps({
        "source": source,
        "through": last_date.isoformat(),
        "updatesDaily": updates_daily,
        "last": {"date": last_date.isoformat(), "close": round(last_close, 4)},
        "local52": local52,
        "series": series,
    }))


if __name__ == "__main__":
    main()
