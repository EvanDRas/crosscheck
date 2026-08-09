// "Since you last looked": a compact snapshot of each analyzed ticker is
// kept locally (data/snapshots.json, gitignored) so the next visit can open
// with what actually CHANGED — score moved, a filing landed, insiders sold —
// instead of making the user re-read the whole page to find out.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "snapshots.json");

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Pure: reduce a full analyze payload to the fields worth diffing.
export function takeSnapshot(payload) {
  const s = payload.scoring ?? {};
  const m = payload.metrics ?? {};
  return {
    at: payload.asOf,
    score: s.score ?? null,
    verdict: s.verdict ?? null,
    pe: m.pe ?? null,
    netMargin: m.netMargin ?? null,
    revenueGrowth: m.revenueGrowth ?? null,
    latestFiling: payload.filings?.[0] ? { form: payload.filings[0].form, filed: payload.filings[0].filed } : null,
    insiderSells: payload.insiders?.sells?.count ?? null,
    insiderBuys: payload.insiders?.buys?.count ?? null,
    nextEarnings: payload.nextEarnings?.date ?? null,
  };
}

// Pure: human-readable changes between two snapshots. Exported for tests.
export function diffSnapshots(prev, curr) {
  if (!prev) return [];
  const out = [];
  const num = (v) => typeof v === "number" && Number.isFinite(v);

  if (num(prev.score) && num(curr.score) && Math.abs(curr.score - prev.score) >= 1) {
    const verdictBit = prev.verdict !== curr.verdict ? ` (${prev.verdict} → ${curr.verdict})` : "";
    out.push(`Score ${Math.round(prev.score)} → ${Math.round(curr.score)}${verdictBit}`);
  } else if (prev.verdict && curr.verdict && prev.verdict !== curr.verdict) {
    out.push(`Verdict ${prev.verdict} → ${curr.verdict}`);
  }
  if (num(prev.pe) && num(curr.pe) && Math.abs(curr.pe - prev.pe) / prev.pe >= 0.1) {
    out.push(`P/E ${prev.pe.toFixed(1)}× → ${curr.pe.toFixed(1)}×`);
  }
  if (num(prev.netMargin) && num(curr.netMargin) && Math.abs(curr.netMargin - prev.netMargin) >= 1) {
    out.push(`Net margin ${prev.netMargin.toFixed(1)}% → ${curr.netMargin.toFixed(1)}%`);
  }
  if (num(prev.revenueGrowth) && num(curr.revenueGrowth) && Math.abs(curr.revenueGrowth - prev.revenueGrowth) >= 2) {
    out.push(`Revenue growth ${prev.revenueGrowth.toFixed(1)}% → ${curr.revenueGrowth.toFixed(1)}%`);
  }
  if (curr.latestFiling && (!prev.latestFiling || curr.latestFiling.filed > prev.latestFiling.filed)) {
    out.push(`New SEC filing: ${curr.latestFiling.form} on ${curr.latestFiling.filed}`);
  }
  if (num(prev.insiderSells) && num(curr.insiderSells) && curr.insiderSells > prev.insiderSells) {
    out.push(`Insider sells in the last 3 months: ${prev.insiderSells} → ${curr.insiderSells}`);
  }
  if (num(prev.insiderBuys) && num(curr.insiderBuys) && curr.insiderBuys > prev.insiderBuys) {
    out.push(`Insider buys in the last 3 months: ${prev.insiderBuys} → ${curr.insiderBuys}`);
  }
  if (curr.nextEarnings && prev.nextEarnings !== curr.nextEarnings) {
    out.push(`Next earnings date: ${curr.nextEarnings}`);
  }
  return out;
}

// Update the stored snapshot and return the changes since the previous
// DIFFERENT-day visit (same-day revisits are noise, not news).
export function updateSnapshot(ticker, payload) {
  const all = readAll();
  const prev = all[ticker] ?? null;
  const curr = takeSnapshot(payload);
  let changes = [];
  let lastSeen = null;
  if (prev?.at && String(prev.at).slice(0, 10) !== String(curr.at).slice(0, 10)) {
    changes = diffSnapshots(prev, curr);
    lastSeen = String(prev.at).slice(0, 10);
  }
  // Same-day revisit: keep the OLDER snapshot as the baseline so tomorrow's
  // diff compares against the last different day, not five minutes ago.
  if (!prev || String(prev.at).slice(0, 10) !== String(curr.at).slice(0, 10)) {
    all[ticker] = curr;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(all, null, 1));
    } catch {}
  }
  return { changes, lastSeen };
}
