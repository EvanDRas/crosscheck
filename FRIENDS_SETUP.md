# Crosscheck — setup for friends

Ten minutes, all free, runs on your own computer with your own free API keys.
Nothing is shared with anyone — your lookups, your keys, your machine.

## Setup — four steps, no file editing, no terminal

1. Install [Node.js](https://nodejs.org) (the LTS version, default options,
   just keep clicking Next).
2. Get the code: green **Code** button → **Download ZIP**, then **extract
   it** (right-click → Extract All) — don't run things from inside the ZIP
   preview window.
3. In the extracted folder, double-click **`Start Crosscheck.bat`**
   (Windows) or **`start-crosscheck.command`** (Mac — if macOS blocks it,
   right-click it and choose Open; if it says "permission denied", open
   Terminal in that folder and run `chmod +x start-crosscheck.command`
   once). Windows may show a security warning for a downloaded script —
   choose "Run anyway"; it's the code you just downloaded.
4. Your browser opens to the app. Try the **DEMO** ticker first — it works
   with no keys at all. When you're ready for real stocks, the blue setup
   screen walks you through it: create a free account at
   [finnhub.io](https://finnhub.io), copy the API key from its dashboard,
   paste it in, done. (A second free key from
   [tiingo.com](https://www.tiingo.com) is optional — it powers the price
   charts and the Time Machine.)

That's it. Keep the black window open while you use the app; close it to
stop. Your keys and your lookups never leave your computer.

<details>
<summary>Prefer doing it by hand? (optional)</summary>

Copy `.env.example` to a file named exactly `.env` (careful: Notepad likes
to save it as `.env.txt`, which won't work), paste your keys into it, then
run `npm install` and `npm start` in a terminal in that folder.
</details>

You can ignore anything in the README about a "local research panel" —
that's an optional data source on the maintainer's PC. Your charts come from
your Tiingo key, and your Verdict Ledger starts fresh from your own first
lookup.

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
