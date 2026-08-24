// Publish the forward test: strip the local ledger down to license-clean
// facts — the formula's OWN output only (ticker, date, score, verdict) —
// and write docs/forward-test.json, which is committed to the public repo.
// No prices, no vendor data: a fresh install grades these calls itself,
// by date, with its own keys. Run standalone (npm run publish-forward) or
// automatically at the end of the daily batch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LEDGER = path.join(ROOT, "data", "verdict_ledger.json");
const OUT = path.join(ROOT, "docs", "forward-test.json");

export function publishForwardTest() {
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return { written: false, reason: "no ledger" };
  }
  if (!Array.isArray(entries) || !entries.length) return { written: false, reason: "empty ledger" };
  const out = {
    what: "Crosscheck's official forward test: every verdict the formula logged on the project machine, frozen before outcomes were known. Facts about the formula's own output only — no market data. Installations grade these calls themselves, by date, against the S&P with their own keys.",
    publishedAt: new Date().toISOString(),
    entries: entries.map((e) => ({
      date: e.date,
      ticker: e.ticker,
      score: e.score,
      verdict: e.verdict,
      confidence: e.confidence ?? null,
      nt: e.ntVerdict ?? null,
      lt: e.ltVerdict ?? null,
      v: e.formulaVersion ?? "v1",
    })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
  return { written: true, count: out.entries.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = publishForwardTest();
  console.log(r.written ? `published ${r.count} calls -> docs/forward-test.json` : `nothing published (${r.reason})`);
}
