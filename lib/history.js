// Optional local price-history source: reads the research parquet files on
// this PC (S&P daily panel + Tiingo archive) via a small Python helper.
// Finnhub's free tier has no historical candles, so this is what powers the
// price chart. Everything degrades gracefully: no Python, no files, or an
// unknown ticker simply means history: null.

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "read_history.py");

const RESEARCH_ROOT = "C:\\Users\\evand\\OneDrive\\Desktop\\systematic cross-sectional equity strategy";
const PRICES_PARQUET = process.env.HISTORY_PRICES_PARQUET || path.join(RESEARCH_ROOT, "cache", "prices_v2.parquet");
const TIINGO_DIR = process.env.HISTORY_TIINGO_DIR || path.join(RESEARCH_ROOT, "cache", "tiingo_universe");
const PYTHON = process.env.PYTHON_BIN || "python";

export function historyAvailable() {
  return fs.existsSync(PRICES_PARQUET) || fs.existsSync(TIINGO_DIR);
}

// Grade ledger entries against the panel's split/dividend-adjusted closes in
// ONE python invocation. pairs: [{ticker, date}]. Resolves to
// {latestPanelDate, grades: {"TICKER|YYYY-MM-DD": {anchorDate, anchorClose,
// latestDate, latestClose}}} or null when the panel isn't on this machine.
export function gradeFromPanel(pairs) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PRICES_PARQUET) || !pairs.length) return resolve(null);
    const child = spawn(PYTHON, [SCRIPT, "--grade", PRICES_PARQUET], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 25_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`panel grader failed to start (${err.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`panel grader failed (exit ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""})`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("panel grader returned unparseable output"));
      }
    });
    child.stdin.write(JSON.stringify({ pairs }));
    child.stdin.end();
  });
}

export function getHistory(ticker) {
  return new Promise((resolve, reject) => {
    if (!historyAvailable()) return resolve(null);
    execFile(
      PYTHON,
      [SCRIPT, ticker, PRICES_PARQUET, TIINGO_DIR],
      { timeout: 25_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`local history reader failed (${err.code ?? err.message})`));
        try {
          const data = JSON.parse(stdout);
          resolve(data.notFound ? null : data);
        } catch {
          reject(new Error("local history reader returned unparseable output"));
        }
      }
    );
  });
}
