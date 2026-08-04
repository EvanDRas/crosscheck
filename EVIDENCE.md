# Evidence: what testing this formula actually found

Every claim here is reproducible from scripts in this repo plus free data.
Last updated 2026-08-04. If the formula (lib/scoring.js) ever changes, these
results describe formula v1 only.

## Study 1 — momentum component, 23 years (scripts/backtest_momentum.py)

The 52-week-position score (the whole Momentum category), computed monthly
2003–2026 over ~474 S&P names/month, held one month, gross of costs:

- Top-vs-bottom quintile spread: **−0.89%/yr, t = −0.24, hit rate 54%.**
- Verdict: **no predictive power.** Null in both halves of the sample.

## Study 2 — five famous dates, full point-in-time (scripts/pit_verdict.mjs)

Only filings submitted and prices printed by each date (filing lag included);
graded vs SPY total-return through 2026-08-04:

| Call | Outcome vs SPY |
|---|---|
| META 2022-11: HOLD 57 | +424% (missed the bottom; momentum scored 6) |
| NVDA 2023-01: HOLD 44 | +1,285% (called it expensive and shrinking) |
| TSLA 2022-01: BUY 66 | −100% (momentum 96 outvoted valuation 0 at the peak) |
| INTC 2021-04: STRONG BUY 75 | −27% (the only STRONG BUY — a value trap) |
| KO 2020-06: BUY 62 | −49% |

**0 for 5** — anecdotes, not statistics, but the *pattern* matters: the
formula rewards "great numbers after the run-up" and shrugs at "great
business temporarily hated," which is where the big future returns lived.

## Study 3 — 18,150 point-in-time calls, 2011–2024 (scripts/backtest_pit_local.py)

The testable composite (Profitability net margin + Growth + Momentum = 50% of
formula weight; annual as-filed EDGAR fundamentals, point-in-time S&P
membership, quarterly dates, non-overlapping forward windows, gross of costs):

- **STRONG BUY band: −0.69%/qtr excess (t = −2.17); −2.35%/yr on the annual
  view (t = −3.00).**
- Top score quintile: −0.79%/qtr (t = −2.62). Bottom quintile: ≈ 0.
- Q5−Q1 spread: −0.92%/qtr, t = −1.23, hit rate 43%; negative in BOTH halves
  (2011-17: −1.41%/qtr t=−1.72; 2018-24: −0.44%/qtr t=−0.35).
- Sector lens: the score is structurally sector-relative — Finance/RE averages
  62.5 while Mining/Energy averages 51.8 on the same formula. A cross-sector
  score comparison is partly a sector comparison.

**Verdict: no positive predictive power anywhere in the tested half; weak,
consistently-signed evidence that the HIGHEST scores slightly underperform**
(the classic glamour effect — high margin + growth + momentum is what
"already fully priced" looks like).

## What we deliberately do NOT conclude

- We do not trade the inverse. The negative tilt is suggestive (spread
  t = −1.23), not proven, and flipping a signal after seeing the data is the
  overfitting trap this project exists to avoid.
- Valuation, Health, and Analyst categories (50% of weight) remain untested —
  no free point-in-time source. The owner's separate, more rigorous research
  on fundamental cross-sectional signals in large caps ended in a full null
  after costs.

## The ongoing test

The Verdict Ledger (/ledger.html) forward-logs ~50 calls per trading day and
grades them against SPY on split/dividend-adjusted closes. That is the only
test that can vindicate this formula, and it runs continuously. Until it
shows BUYs beating SELLs over hundreds of aged calls, treat every verdict as
a *description of current fundamentals*, not a forecast.
