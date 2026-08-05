// Personal accuracy tracker: the user's OWN calls, logged and graded exactly
// like the formula's ledger. Append-only, first call per ticker per day wins,
// same cross-process lock discipline as the verdict ledger — your track
// record should be as tamper-proof as the formula's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "my_picks.json");
const LOCK = `${FILE}.lock`;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const PICK_DIRECTIONS = ["buy", "avoid", "sell"];

export function readPicks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

export function logPick(entry) {
  if (!acquireLock()) throw new Error("could not lock the picks file");
  try {
    let existing = [];
    if (fs.existsSync(FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
        existing = Array.isArray(parsed) ? parsed : [];
      } catch {
        fs.copyFileSync(FILE, `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      }
    }
    if (existing.some((e) => e.ticker === entry.ticker && e.date === entry.date)) {
      return false; // first call of the day stands — no same-day revisions
    }
    const entries = [...existing, entry];
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
    fs.renameSync(tmp, FILE);
    return true;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}
