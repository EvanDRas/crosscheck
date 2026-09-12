// Cross-process file lock shared by the verdict ledger and the picks file —
// both are written by the server and the batch logger, possibly at once.
//
// The lock is an exclusive-create of <file>.lock holding a unique owner
// token; one older than 10s is presumed dead and stolen. Acquisition is
// ASYNC: the old Atomics.wait spin froze the entire event loop for up to 2
// seconds whenever two writers contended, stalling every other request.
//
// INVARIANT: the critical section fn must be fully SYNCHRONOUS and complete
// well under the 10s staleness threshold (today it is a few ms of file
// I/O). A sync body plus the lock file is what keeps the read-modify-write
// atomic in-process AND across processes; a slow body would get its live
// lock stolen. The thenable guard below makes an async body a loud error
// instead of a silent unprotected write.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STALE_MS = 10_000;

export async function withFileLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  let held = false;
  // ~15s of attempts — strictly longer than the staleness threshold, so a
  // waiter arriving right after a crash outlives the abandoned lock instead
  // of erroring at 2s the way the old spin did.
  for (let i = 0; i < 600 && !held; i++) {
    try {
      fs.writeFileSync(lockPath, token, { flag: "wx" });
      held = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) {
          // Steal by RENAME, not rm: rename is atomic, so exactly one
          // stealer wins; a loser gets ENOENT and just retries. If the
          // stat→rename gap let us grab a lock that had meanwhile been
          // stolen and RE-CREATED by someone alive, the second check below
          // notices it is fresh and puts it back.
          const grave = `${lockPath}.stale-${token.replace(/[^a-zA-Z0-9]/g, "")}`;
          fs.renameSync(lockPath, grave);
          if (Date.now() - fs.statSync(grave).mtimeMs > STALE_MS) {
            fs.rmSync(grave, { force: true }); // confirmed dead — bury it
          } else {
            try { fs.renameSync(grave, lockPath); } catch { fs.rmSync(grave, { force: true }); }
          }
        }
      } catch { /* raced another stealer — retry */ }
      await sleep(25);
    }
  }
  if (!held) throw new Error(`could not acquire the file lock (${lockPath})`);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("withFileLock body must be synchronous — an async body would keep writing after the lock is released");
    }
    return result;
  } finally {
    // Release only what we own: if our lock was somehow stolen mid-hold,
    // deleting blindly would evict the CURRENT holder and cascade the race.
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
    } catch { /* already gone */ }
  }
}
