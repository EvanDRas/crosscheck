"""One-time EDGAR top-up for the point-in-time harness: balance-sheet
concepts + share counts (with FILING dates) for every ticker in the research
cache's edgar_facts.parquet. Public-domain data, ~600 requests, sequential
and polite (SEC fair-access: declared UA, well under 10 req/s).

Writes stock-analyzer/data/edgar_topup.parquet (gitignored). Re-runs skip
tickers already fetched, so an interrupted run just resumes.
"""
import json
import os
import sys
import time
import urllib.request

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "edgar_topup.parquet")
FACTS = r"C:\Users\evand\OneDrive\Desktop\systematic cross-sectional equity strategy\experiments\claude_tests\edgar_facts.parquet"

CONTACT = os.environ.get("SEC_EDGAR_CONTACT", "your-email@example.com")
UA = {"User-Agent": f"Candor research (personal; {CONTACT})", "Accept-Encoding": "gzip"}

CONCEPTS = {
    "us-gaap": {
        "StockholdersEquity": "equity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest": "equity_incl_nci",
        "LongTermDebtNoncurrent": "ltd_noncurrent",
        "LongTermDebtCurrent": "ltd_current",
        "LongTermDebt": "ltd_total",
        "ShortTermBorrowings": "short_debt",
        "CommercialPaper": "commercial_paper",
        "AssetsCurrent": "assets_current",
        "LiabilitiesCurrent": "liabilities_current",
    },
    "dei": {"EntityCommonStockSharesOutstanding": "shares"},
}
UNIT_FOR = {"dei": "shares"}


def get_json(url, retries=3):
    import gzip
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw)
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def main():
    tickers = sorted(set(pd.read_parquet(FACTS, columns=["ticker"])["ticker"]))
    done = set()
    rows = []
    if os.path.exists(OUT):
        prev = pd.read_parquet(OUT)
        rows = prev.to_dict("records")
        done = set(prev["ticker"])
        print(f"resuming: {len(done)} tickers already cached")

    cikmap = {}
    for row in get_json("https://www.sec.gov/files/company_tickers.json").values():
        cikmap[row["ticker"].upper()] = row["cik_str"]

    todo = [t for t in tickers if t not in done]
    print(f"{len(todo)} tickers to fetch")
    unresolved = 0
    for i, t in enumerate(todo):
        cik = cikmap.get(t) or cikmap.get(t.replace("-", "."))
        if cik is None:
            unresolved += 1
            continue
        try:
            doc = get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
        except Exception as e:
            print(f"  {t}: FAILED {e}")
            continue
        n0 = len(rows)
        for tax, wanted in CONCEPTS.items():
            unit = UNIT_FOR.get(tax, "USD")
            for concept, short in wanted.items():
                for e in doc.get("facts", {}).get(tax, {}).get(concept, {}).get("units", {}).get(unit, []):
                    if e.get("start"):  # instants only
                        continue
                    if e.get("end") and e.get("val") is not None and e.get("filed"):
                        rows.append({"ticker": t, "concept": short, "end": e["end"], "val": float(e["val"]), "filed": e["filed"]})
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(todo)} ({t}: +{len(rows) - n0} rows)")
            pd.DataFrame(rows).to_parquet(OUT, index=False)  # checkpoint
        time.sleep(0.13)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    pd.DataFrame(rows).to_parquet(OUT, index=False)
    print(f"DONE: {len(rows)} rows, {len(set(r['ticker'] for r in rows))} tickers, {unresolved} unresolved (renamed/delisted)")


if __name__ == "__main__":
    sys.exit(main())
