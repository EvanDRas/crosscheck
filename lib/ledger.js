// Verdict Ledger: a forward test of the app's verdicts. Every real analysis
// logs its call (verdict, score, price, SPY price) at the moment it was made.
// The record is append-only — the first call per ticker per day wins, and
// nothing is ever edited afterward — so later performance numbers are
// out-of-sample by construction. This is the honest alternative to
// backtesting the formula on history it was never exposed to.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "verdict_ledger.json");

export function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Pure: first call of the day per ticker wins; repeats are ignored so the
// record can never be revised within a day either.
export function upsertFirstPerDay(entries, entry) {
  if (entries.some((e) => e.ticker === entry.ticker && e.date === entry.date)) {
    return { entries, added: false };
  }
  return { entries: [...entries, entry], added: true };
}

// The ledger is written by both the server and the batch logger, possibly at
// the same time. A file lock makes the read-modify-write atomic across
// processes; a lock older than 10s is presumed dead and stolen.
const LOCK = `${FILE}.lock`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function acquireLock() {
  for (let i = 0; i < 80; i++) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 10_000) fs.rmSync(LOCK, { force: true });
      } catch {}
      sleep(25);
    }
  }
  return false;
}

export function logVerdict(entry) {
  if (!acquireLock()) throw new Error("could not lock the ledger file");
  try {
    // A corrupt ledger must never be silently replaced by a fresh one — park
    // it under a recovery name first, then start clean.
    let existing = [];
    if (fs.existsSync(FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
        existing = Array.isArray(parsed) ? parsed : [];
      } catch {
        const park = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(FILE, park);
      }
    }
    const { entries, added } = upsertFirstPerDay(existing, entry);
    if (!added) return false;
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
    fs.renameSync(tmp, FILE);
    return true;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

const VERDICT_ORDER = ["STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"];

// Pure: bucket graded rows by verdict. Excluded from aggregates: rows with
// no computable excess, same-day rows (no time has passed — a forced 0%
// would count as a loss), and raw-basis rows (price-only grading breaks
// across splits; they stay visible in the table, marked *).
export function aggregateLedger(rows) {
  const buckets = new Map();
  for (const r of rows) {
    if (r.excess == null) continue;
    if (r.ageDays === 0) continue;
    if (r.basis === "raw") continue;
    if (!buckets.has(r.verdict)) buckets.set(r.verdict, []);
    buckets.get(r.verdict).push(r);
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return VERDICT_ORDER.filter((v) => buckets.has(v)).map((v) => {
    const rs = buckets.get(v);
    return {
      verdict: v,
      n: rs.length,
      avgReturn: avg(rs.map((r) => r.ret)),
      avgExcess: avg(rs.map((r) => r.excess)),
      winRateVsSpy: rs.filter((r) => r.excess > 0).length / rs.length,
    };
  });
}
