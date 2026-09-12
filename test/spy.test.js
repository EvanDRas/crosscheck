import { test } from "node:test";
import assert from "node:assert/strict";
import { spyTrReturn } from "../lib/spy.js";

// The benchmark leg of every ledger excess. Fixture: four closes, one gap
// weekend between the 2nd and 3rd.
const series = {
  dates: ["2026-01-05", "2026-01-06", "2026-01-09", "2026-01-10"],
  adj: [100, 106, 103, 104],
};

test("spyTrReturn anchors on the last close on/before the anchor date", () => {
  assert.equal(spyTrReturn(series, "2026-01-06"), (104 - 106) / 106); // -> latest close by default
});

test("spyTrReturn rolls a weekend anchor back to the prior close", () => {
  // Jan 7-8 have no rows; the anchor is Jan 6's close.
  assert.equal(spyTrReturn(series, "2026-01-07"), (104 - 106) / 106);
  // Anchoring on the first row measures the full window.
  assert.equal(spyTrReturn(series, "2026-01-05"), (104 - 100) / 100);
});

test("spyTrReturn clamps the end to the matched window, not the latest close", () => {
  // A ticker graded through Jan 9 must be benchmarked through Jan 9 too.
  assert.equal(spyTrReturn(series, "2026-01-05", "2026-01-09"), (103 - 100) / 100);
  assert.equal(spyTrReturn(series, "2026-01-06", "2026-01-09"), (103 - 106) / 106);
});

test("spyTrReturn returns null when it cannot answer honestly", () => {
  assert.equal(spyTrReturn(series, "2026-01-02"), null); // anchor predates the series
  assert.equal(spyTrReturn(null, "2026-01-06"), null); // no series
  assert.equal(spyTrReturn(series, null), null); // no anchor
});
