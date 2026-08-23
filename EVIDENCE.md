# Evidence: what testing this formula actually found

Last updated 2026-08-09. Studies 1, 3, and 4 were run on formula **v1**
scores; the **v2** update (2026-08-08) changed the verdict bands only, so
those statistical results carry over to v2's scores as-is. Study 2 below is
**refreshed to the current engine** (2026-08-09): a post-audit correctness
fix to EDGAR revenue-concept selection shifted some point-in-time scores
slightly, and labels now use the v2 bands — the in-app Time Machine
reproduces this table exactly. The conclusions did not move.

Reproducibility, honestly stated: Study 2 (point-in-time case studies) runs
anywhere — `scripts/pit_verdict.mjs` needs only free EDGAR + Tiingo data.
Studies 1, 3, and 4 additionally need a daily adjusted-close S&P price panel
(and index-membership history) that lives on the author's machine and is not
redistributable; the scripts are in the repo (`scripts/backtest_*.py`) and
run against any equivalent panel you supply (set `CROSSCHECK_RESEARCH_ROOT`).
The EDGAR fundamentals input is rebuilt from scratch by
`scripts/fetch_edgar_topup.py` (public-domain data).

## Study 1 — momentum component, 23 years (scripts/backtest_momentum.py)

The 52-week-position score (the whole Momentum category), computed monthly
2003–2026 over ~474 S&P names/month, held one month, gross of costs:

- Top-vs-bottom quintile spread: **−0.89%/yr, t = −0.24, hit rate 54%** (hit
  rate = share of months the top quintile beat the bottom; above 50% while
  the average spread is negative just means the losing months lost bigger).
- Verdict: **no predictive power.** Null in both halves of the sample.

## Study 2 — five famous dates, full point-in-time (scripts/pit_verdict.mjs)

Only filings submitted and prices printed by each date (filing lag included);
graded vs SPY total-return, current engine + v2 band labels (refreshed
2026-08-09 — reproduce any row with the in-app Time Machine or
`node scripts/pit_verdict.mjs`):

| Call | Outcome vs SPY |
|---|---|
| META 2022-11: HOLD 57 | +428% (missed the bottom; momentum scored 6) |
| NVDA 2023-01: SELL 50 | +1,369% (called it expensive with dead momentum) |
| TSLA 2022-01: HOLD 63 | −100% (momentum 96 and growth 100 masked valuation 0 at the peak) |
| INTC 2021-04: STRONG BUY 75 | −26% (the only STRONG BUY — a value trap) |
| KO 2020-06: HOLD 62 | −49% |

**0 for 5** — anecdotes, not statistics, but the *pattern* matters: the
formula rewards "great numbers after the run-up" and shrugs at (or now
outright SELLs) "great business temporarily hated," which is where the big
future returns lived.

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

## Study 4 — the FULL formula, 16,497 point-in-time calls (scripts/backtest_pit_full.py)

After Study 3, two hypotheses were pre-registered and then tested (EDGAR
balance-sheet top-up: 466k filed-dated facts, 614 tickers — see
scripts/fetch_edgar_topup.py):

**Hypothesis A — "adding Valuation + Health (the glamour brakes) removes the
negative tilt in the top band": REJECTED.** On the identical call sample
(identical between the two variants in this table — not the same sample as
Study 3's 18,150 calls, which is why the spreads differ slightly)
(5 of 6 categories, ~85% of formula weight; only Analyst untestable):

| variant | STRONG BUY excess (qtr) | annual view |
|---|---|---|
| 3-category composite | −0.87%/qtr (t = −2.74) | −3.38%/yr (t = −4.06) |
| **full v1 formula** | **−0.92%/qtr (t = −1.98)** | **−2.57%/yr (t = −2.86)** |

The tilt is concentrated in 2011–2017; 2018–2024 is statistical zero for
every variant. No version of this formula showed positive predictive power
anywhere.

**Hypothesis B — "excluding the health category for financials fixes sector
skew": NEGLIGIBLE.** It moves Finance/RE's average score by 0.7 points
(cross-sector spread 8.1 → 7.4). The full formula's sector skew is real but
moderate (Finance/RE 61.9 vs Utilities 53.8).

**Decision: v1 stands — no formula change shipped.** Both candidate "fixes"
were tested honestly and neither earned its keep. A formula change without
evidence would be cosmetics pretending to be improvement; the discipline is
the feature.

**Accuracy, in plain terms** (same 16,497 calls; "accurate" = the stock beat
the benchmark after a BUY-family call, or trailed it after a SELL-family
call; base rate = accuracy of a random pick):

| call | 3-month accuracy (base 48%) | 12-month accuracy (base 45%) |
|---|---|---|
| STRONG BUY | 46% | 42% |
| BUY | 49% | 46% |
| SELL | 54% | 59% (n=264, not significant) |

A coin flip, minus a few points at the formula's most confident. A real edge
would look like 53–55% sustained across eras on thousands of calls, net of
costs. The Verdict Ledger accumulates this same table live, out of sample.

## Calibration update — formula v2 (2026-08-08)

Live usage exposed a calibration flaw: the median S&P large cap scores ~60-62
on these anchors, and v1's hand-set BUY threshold was 58 — so "BUY" fired for
roughly two-thirds of all companies. The label described "is a normal healthy
large cap," which discriminates nothing (161 live ledger calls: ~68%
BUY-or-better, ~2% SELL).

**v2 changes the verdict BANDS only — scores, anchors, and weights are
untouched.** New cutoffs are percentile-calibrated against the empirical
score distribution (16,497 point-in-time calls above, cross-checked against
live ledger scores): STRONG BUY ≥74 (top ~10% of large caps on these
metrics), BUY ≥66 (top ~30%), HOLD ≥55 (middle ~40%), SELL ≥47,
STRONG SELL <47 (bottom ~10%). A verdict now states *rank among large caps*,
which is also how professional relative-grade systems produce their SELLs.

This is a measurement fix, not a prediction claim — ranking companies by
these metrics still carries no demonstrated forward-return power (see the
studies above; the quintile results ARE the v2 bands' predictive test, and
they were null). Ledger entries are stamped v1/v2 so eras stay separable.

## What we deliberately do NOT conclude

- We do not trade the inverse. The negative tilt failed to appear in
  2018–2024, and flipping a signal after seeing the data is the overfitting
  trap this project exists to avoid.
- The Analyst category (15% of weight) remains untested — no free
  point-in-time ratings history. The owner's separate, more rigorous research
  on fundamental cross-sectional signals in large caps ended in a full null
  after costs.

## The ongoing test

The Verdict Ledger (/ledger.html) forward-logs ~50 calls per trading day and
grades them against SPY on split/dividend-adjusted closes. That is the only
test that can vindicate this formula, and it runs continuously. Until it
shows BUYs beating SELLs over hundreds of aged calls, treat every verdict as
a *description of current fundamentals*, not a forecast.
