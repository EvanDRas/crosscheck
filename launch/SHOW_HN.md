# Show HN launch kit

## Title (pick one — 80-char HN limit)

1. `Show HN: I backtested my stock analyzer on 16k dated calls. It's a coin flip`
2. `Show HN: Verdict – a stock analyzer that publishes its own failed backtests`
3. `Show HN: My stock scorer is 46% accurate. I shipped the evidence inside it`

Recommendation: #1 — the confession is the hook; "Show HN" posts that admit
the interesting failure outperform ones that claim success.

## URL

The GitHub repo (once pushed, public). HN strongly prefers a repo over a
landing page for Show HN.

## Post text (first comment, posted by you immediately after submitting)

---

I built a stock analyzer — type a ticker, get quote, fundamentals, analyst
ratings, earnings, news, and a transparent 0–100 verdict computed from
readable piecewise anchors (P/E 18 ≈ neutral, etc.).

Then I did the thing you're not supposed to do to your own product: I
backtested it honestly. Point-in-time — only SEC filings *submitted* by each
date (filing lag included), point-in-time S&P membership, split/dividend-
adjusted grading, non-overlapping windows, results split across two eras.
16,497 dated calls, 2011–2024.

Result: when it says STRONG BUY, the stock beats the index 46% of the time
over 3 months (base rate for a random pick: 48%). Its most confident calls
*underperformed* — the classic glamour effect. I also tested two candidate
"fixes" (adding valuation/health brakes; sector-aware scoring). Both failed
to earn their keep, so I shipped neither.

Instead of quietly deleting all that, I made it the product:

- Every fundamental is cross-checked against SEC EDGAR's XBRL API, with
  agree/conflict flags — it caught my paid-tier-quality vendor claiming a
  fintech grew revenue 205% when the filings say 15%.
- The verdict card states, on every result, that the formula has no
  demonstrated predictive power. EVIDENCE.md in the repo has all the
  backtests, including the embarrassing ones.
- An append-only "verdict ledger" logs every call the formula makes and
  grades it against SPY on adjusted closes, publicly accumulating its real
  out-of-sample accuracy.
- You can log your OWN calls ("I'd buy this here") and it grades you the
  same way. Turns out most of us would rather not know; I think knowing is
  the whole point.

It's free and MIT-licensed; you run it locally with your own free API keys
(Finnhub + optionally Tiingo — the data licenses don't allow me to host it
for you, which I document). There's a supporter license if you want to fund
it.

Things I'd love feedback on: the point-in-time methodology (scripts are in
the repo), and whether an "honesty-first" research tool is something people
actually want, or whether the market for implied prediction is simply too
strong.

---

## Prep checklist (before submitting)

- [ ] Repo pushed PUBLIC on GitHub with README, EVIDENCE.md, FRIENDS_SETUP.md
- [ ] Gumroad/Lemon Squeezy "supporter license" product live ($19) — link in README, NOT spammed in the post
- [ ] Run `npm install && npm start` from a FRESH clone on a machine without your .env to prove first-run setup works
- [ ] Screenshots in README use the DEMO ticker only (fictional data — no license exposure)
- [ ] Best posting window: weekday morning US time; reply to every comment fast for the first 3 hours

## Rules of engagement for comments

- Never claim or imply predictive value — the nulls are the story.
- "Why not just use Finviz?" → agree Finviz is great for screening; Verdict's
  lane is verified data + honest evidence + personal track record.
- Someone will find a bug within an hour. Thank them, fix it live, reply
  with the commit link. That IS the marketing.
