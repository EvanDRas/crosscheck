"""Empirical score distributions for v2 band calibration.

v1 bands (72/58/42/28) were hand-set opinions; against real S&P data the
average large cap scores ~60, so 'BUY' fired for two-thirds of companies —
a label that doesn't discriminate. v2 bands are percentile cutoffs of the
observed score distributions, so a verdict states where a stock RANKS among
large caps on these metrics (top decile, bottom quintile, ...). Calibration
targets the score distribution, not returns — a measurement fix, not a
prediction claim. See EVIDENCE.md.

Prints the live ledger's score percentiles. The historical distribution
comes from backtest_pit_full.py (run with PRINT_PERCENTILES=1).
"""
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ledger = json.load(open(os.path.join(ROOT, "data", "verdict_ledger.json")))
scores = sorted(e["score"] for e in ledger if isinstance(e.get("score"), (int, float)))
arr = np.array(scores)
print(f"live ledger (full formula incl. analyst): n={len(arr)}, mean={arr.mean():.1f}, min={arr.min():.1f}, max={arr.max():.1f}")
print("percentiles:", {p: round(float(np.percentile(arr, p)), 1) for p in (5, 10, 30, 50, 70, 90, 95)})
