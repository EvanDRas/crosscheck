import { test } from "node:test";
import assert from "node:assert/strict";
import { marketDate } from "../lib/analyze.js";

// The ET-day stamp behind every ledger entry. A silent revert to UTC dating
// would mis-date every call made after 8 PM ET and pass the rest of the
// suite — these pin the rollover in both EST and EDT.

test("marketDate stamps a late-evening ET call with the ET day, not the UTC day", () => {
  // 01:30 UTC Jan 2 = 8:30 PM EST Jan 1 — the ledger's own rule: a call made
  // Thursday evening must not be stamped Friday.
  assert.equal(marketDate(new Date("2026-01-02T01:30:00.000Z")), "2026-01-01");
  // Same rollover under daylight time: 01:30 UTC Jul 2 = 9:30 PM EDT Jul 1.
  assert.equal(marketDate(new Date("2026-07-02T01:30:00.000Z")), "2026-07-01");
});

test("marketDate agrees with UTC once New York's day has begun", () => {
  // 12:00 UTC Jul 2 = 8:00 AM EDT Jul 2.
  assert.equal(marketDate(new Date("2026-07-02T12:00:00.000Z")), "2026-07-02");
});
