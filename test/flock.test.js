import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../lib/flock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "flock-"));

test("withFileLock waits for a live lock instead of barging in", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "held", { flag: "wx" });
  let ran = false;
  const p = withFileLock(lock, () => { ran = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran, false); // the holder is alive — the waiter keeps waiting (without blocking this event loop)
  fs.rmSync(lock);
  await p;
  assert.equal(ran, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLock releases the lock even when the body throws", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  await assert.rejects(withFileLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lock), false); // a crashed writer must not wedge the next one
  let ran = false;
  await withFileLock(lock, () => { ran = true; });
  assert.equal(ran, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLock steals a lock whose holder looks dead", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "dead", { flag: "wx" });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, past, past); // 60s-old lock: presumed a crashed process
  let ran = false;
  await withFileLock(lock, () => { ran = true; });
  assert.equal(ran, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLock returns the body's value and serializes counters correctly", async () => {
  const dir = tmp();
  const file = path.join(dir, "counter.txt");
  const lock = `${file}.lock`;
  fs.writeFileSync(file, "0");
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    withFileLock(lock, () => {
      const n = Number(fs.readFileSync(file, "utf8")) + 1;
      fs.writeFileSync(file, String(n));
      return n;
    })
  ));
  assert.equal(fs.readFileSync(file, "utf8"), "12"); // no lost updates
  assert.equal(new Set(results).size, 12); // every writer saw a distinct state
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLock refuses an async body loudly instead of unprotecting it", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  await assert.rejects(withFileLock(lock, async () => 1), /must be synchronous/);
  assert.equal(fs.existsSync(lock), false); // and still releases
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stale steal is atomic: losers retry instead of deleting the winner's fresh lock", async () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "dead", { flag: "wx" });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, past, past);
  // Two waiters race for the same stale lock: exactly one critical section
  // at a time, both eventually run, no lost update.
  const file = path.join(dir, "n.txt");
  fs.writeFileSync(file, "0");
  await Promise.all([
    withFileLock(lock, () => fs.writeFileSync(file, String(Number(fs.readFileSync(file, "utf8")) + 1))),
    withFileLock(lock, () => fs.writeFileSync(file, String(Number(fs.readFileSync(file, "utf8")) + 1))),
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), "2");
  fs.rmSync(dir, { recursive: true, force: true });
});
