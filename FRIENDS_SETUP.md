# Verdict — setup for friends

Ten minutes, all free, runs on your own computer with your own free API keys.
Nothing is shared with anyone — your lookups, your keys, your machine.

## Setup

1. Install [Node.js](https://nodejs.org) (the LTS version, default options).
2. Get the code (green **Code** button → Download ZIP, or `git clone` if you
   know git) and unzip it somewhere.
3. Get a **free Finnhub key**: sign up at [finnhub.io](https://finnhub.io),
   copy the API key from the dashboard.
4. Optional but recommended — a **free Tiingo key** from
   [tiingo.com](https://www.tiingo.com) (Account → API): powers price charts
   and 52-week data for most US tickers.
5. In the project folder, copy `.env.example` to a file named `.env`, open it
   in Notepad, and paste your key(s):

   ```
   FINNHUB_API_KEY=your_key_here
   TIINGO_API_KEY=your_key_here
   SEC_EDGAR_CONTACT=your_email_here
   ```

6. In a terminal in that folder:

   ```
   npm install
   npm start
   ```

7. Open http://localhost:3000 and type a ticker.

You can ignore anything in the README about a "local research panel" or the
"batch logger" — those use datasets on the owner's PC. Without them the app
simply uses your Tiingo key for charts, and your Verdict Ledger starts fresh
from your own first lookup.

## Read this before you trade off it — seriously

This app is a **research dashboard**, not a stock picker. Straight facts:

- The 0–100 verdict is a transparent, hand-tuned formula over public data
  (P/E, margins, growth, debt, momentum, analyst ratings). Every input is
  information the entire market already has — a good score means "this
  company currently looks healthy by conventional rules of thumb," **not**
  "this stock will go up."
- The formula has been backtested honestly — 23 years of momentum data plus
  16,497 full-formula point-in-time calls over 2011–2024: **zero predictive
  power**, and its most confident calls historically leaned *behind* the
  index. Two candidate "fixes" were also tested and rejected for lack of
  evidence. Full numbers and methods: `EVIDENCE.md` in this repo.
- The Verdict Ledger page is the app being honest about this: it freezes
  every call and lets time grade it against the S&P. Until that page shows
  BUYs beating SELLs over many months and hundreds of calls, the verdicts
  are unproven — and simple public-data formulas historically test out at
  "no edge after costs."
- Single stocks move 30–50% a year on noise. No formula output — this one or
  anyone else's — is a reason to trade by itself.

**Not financial advice. Nobody involved is a licensed advisor. If you trade,
you're trading on your own judgment and your own risk.** Use the app to get
the numbers organized in one place, use the "Copy AI brief" button to dig
deeper, and make your own calls.
