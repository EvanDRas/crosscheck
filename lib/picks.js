// Personal accuracy tracker: the user's OWN calls, logged and graded exactly
// like the formula's ledger. Append-only, first call per ticker per day wins,
// same cross-process lock discipline as the verdict ledger — your track
// record should be as tamper-proof as the formula's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./flock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "my_picks.json");
const LOCK = `${FILE}.lock`;

export const PICK_DIRECTIONS = ["buy", "avoid", "sell"];

export function readPicks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function logPick(entry) {
  return withFileLock(LOCK, () => {
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
  });
}
