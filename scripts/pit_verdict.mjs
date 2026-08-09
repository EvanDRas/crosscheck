// CLI for the Time Machine (lib/timemachine.js): reconstruct what the
// formula would have said on a past date — only information knowable that
// day — then grade the frozen call against what happened since.
//
//   node scripts/pit_verdict.mjs META 2022-11-01 NVDA 2023-01-03 ...
//
// A handful of runs is an anecdote, not a backtest. The point is that each
// guess is frozen to a date and graded by reality — run enough across
// tickers and dates and it becomes an honest partial backtest of 5 of the
// formula's 6 categories (~85% of its weight). Methodology and honesty
// rules are documented in lib/timemachine.js.

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { pointInTimeCall } = await import("../lib/timemachine.js");
const { hasTiingoKey } = await import("../lib/tiingo.js");

const pct = (v) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error("usage: node scripts/pit_verdict.mjs TICKER YYYY-MM-DD [TICKER YYYY-MM-DD ...]");
  process.exit(1);
}
if (!hasTiingoKey()) {
  console.error("TIINGO_API_KEY required in .env");
  process.exit(1);
}

console.log("POINT-IN-TIME VERDICTS — only information filed/priced by each date; graded by what followed.");
console.log("Missing by necessity: analyst ratings + earnings estimates (no free history) -> weights renormalize.");
console.log("Split-safe deviations: P/E = mcap/NI-TTM; earnings growth = NI-TTM growth.\n");

let graded = 0;
for (let i = 0; i < args.length; i += 2) {
  const [ticker, D] = [args[i].toUpperCase(), args[i + 1]];
  try {
    const r = await pointInTimeCall(ticker, D);
    graded++;
    const s = r.scoring;
    const cats = s.categories.filter((c) => c.available).map((c) => `${c.label} ${c.score}`).join(", ");
    console.log(`${r.ticker} @ ${r.D}  (filings through ${r.edgarThrough})`);
    console.log(`  CALL: ${s.insufficientData ? "NOT ENOUGH DATA" : `${s.verdict} ${Math.round(s.score)}/100`} (${s.availableCount}/6 categories: ${cats})`);
    console.log(`  key inputs: P/E ${r.m.pe?.toFixed(1) ?? "n/a"} · P/S ${r.m.ps?.toFixed(1) ?? "n/a"} · margin ${r.m.netMargin?.toFixed(1) ?? "n/a"}% · revYoY ${r.m.revenueGrowth?.toFixed(1) ?? "n/a"}% · D/E ${r.m.debtEquity?.toFixed(2) ?? "n/a"} · 52w pos ${r.pricePosition == null ? "n/a" : Math.round(r.pricePosition * 100) + "%"}`);
    const excess = r.ret != null && r.spyRet != null ? r.ret - r.spyRet : null;
    console.log(`  SINCE (${r.years.toFixed(1)}y to ${r.latest}): stock ${pct(r.ret)} · SPY ${pct(r.spyRet)} · excess ${pct(excess)}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    console.log();
  } catch (err) {
    console.log(`${ticker} @ ${D}: SKIPPED — ${err.message}\n`);
  }
}

console.log(`${graded} calls graded. Reminder: this is ${graded} anecdotes, not a backtest — direction-vs-SPY only becomes evidence with hundreds of dated calls.`);
