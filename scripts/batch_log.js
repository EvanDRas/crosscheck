// Daily batch logger: analyze the fixed universe (data/universe.json) and let
// each verdict land in the ledger via the exact same pipeline the web app
// uses. First call per ticker per day wins, so re-runs are harmless.
//
//   npm run batch                 the whole universe, rate-limit paced
//   node scripts/batch_log.js --only AAPL,MSFT --delay 1000
//
// Pacing: one analysis is ~7 Finnhub calls; the free tier allows 60/min. The
// default 8.5s spacing keeps the run under ~50 calls/min with headroom. A 429
// pauses 65s and retries the ticker once. Every run appends one summary line
// to data/batch_runs.log so scheduled runs leave a visible trace.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { FinnhubError } from "../lib/finnhub.js";
import { execSync } from "node:child_process";
import { analyzeTicker, NotFoundError, marketDate } from "../lib/analyze.js";
import { publishForwardTest } from "./publish_forward_test.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const UNIVERSE_FILE = path.join(ROOT, "data", "universe.json");
const RUN_LOG = path.join(ROOT, "data", "batch_runs.log");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const DELAY_MS = Number(argVal("--delay")) || 8500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logRun(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
    fs.appendFileSync(RUN_LOG, stamped + "\n");
  } catch {}
}

async function main() {
  // No session, no calls: a weekend run would freeze Friday's closes as a
  // Saturday-dated batch — 50 correlated duplicates padding the ledger.
  const nyDay = new Date(`${marketDate()}T12:00:00Z`).getUTCDay();
  if (nyDay === 0 || nyDay === 6) {
    logRun("SKIP batch: weekend in New York — no trading session to log.");
    return;
  }
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    logRun("ABORT: no FINNHUB_API_KEY in .env — nothing can be logged without live quotes.");
    process.exit(1);
  }

  const only = argVal("--only");
  const tickers = only
    ? only.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : JSON.parse(fs.readFileSync(UNIVERSE_FILE, "utf8")).tickers;

  logRun(`START batch: ${tickers.length} tickers, ${DELAY_MS}ms spacing`);

  let logged = 0;
  let already = 0;
  let noVerdict = 0;
  const failures = [];

  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    if (i > 0) await sleep(DELAY_MS);

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const payload = await analyzeTicker(t, { apiKey, includeNews: false });
        if (payload.logged) {
          logged++;
          console.log(`  ${t}: logged ${payload.scoring.verdict} ${payload.scoring.score}`);
        } else if (payload.scoring?.verdict) {
          already++;
          console.log(`  ${t}: already logged today (${payload.scoring.verdict} ${payload.scoring.score})`);
        } else {
          noVerdict++;
          console.log(`  ${t}: no verdict (insufficient data) — nothing logged`);
        }
        break;
      } catch (err) {
        if (err instanceof FinnhubError && err.status === 429 && attempt === 1) {
          console.log(`  ${t}: rate limited — waiting 65s, then retrying once`);
          await sleep(65_000);
          continue;
        }
        failures.push(`${t} (${err instanceof NotFoundError ? "not found" : err.message})`);
        console.log(`  ${t}: FAILED — ${err.message}`);
        break;
      }
    }
  }

  logRun(`DONE batch: ${logged} logged, ${already} already-today, ${noVerdict} no-verdict, ${failures.length} failed${failures.length ? ` [${failures.join("; ")}]` : ""}`);

  // Publish the official forward test: refresh docs/forward-test.json and
  // push it, so every installation's screens show today's calls without
  // running an experiment of their own. Every step is best-effort — a
  // failed push never breaks the batch.
  try {
    const pub = publishForwardTest();
    if (pub.written) {
      logRun(`PUBLISH: forward-test.json refreshed (${pub.count} calls)`);
      try {
        execSync("git add docs/forward-test.json", { cwd: ROOT, stdio: "pipe" });
        execSync(`git commit -m "Forward test: ${marketDate()}" -- docs/forward-test.json`, { cwd: ROOT, stdio: "pipe" });
        execSync("git push origin main", { cwd: ROOT, stdio: "pipe", timeout: 60_000 });
        logRun("PUBLISH: pushed to GitHub");
      } catch (err) {
        logRun(`PUBLISH: commit/push skipped (${String(err.message ?? err).split("\n")[0]})`);
      }
    }
  } catch (err) {
    logRun(`PUBLISH: failed (${err.message})`);
  }
  process.exit(failures.length === tickers.length ? 1 : 0);
}

main().catch((err) => {
  logRun(`CRASH: ${err.stack ?? err.message}`);
  process.exit(1);
});
