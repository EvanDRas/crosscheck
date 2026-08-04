// Transparent scoring engine. Pure functions, no I/O — see test/scoring.test.js.
//
// Each metric maps to a 0-100 score through piecewise-linear anchor points
// (listed below, so the "why" of every score is inspectable). Metrics average
// into six categories; categories combine by weight, renormalized over
// whichever categories actually have data.

// Stamped onto every verdict-ledger entry. BUMP THIS if weights, anchors, or
// bands ever change, so ledger eras made by different formulas stay separable.
export const SCORING_VERSION = "v1";

export const WEIGHTS = {
  valuation: 20,
  profitability: 20,
  growth: 20,
  health: 15,
  momentum: 10,
  analyst: 15,
};

export const VERDICT_BANDS = [
  [72, "STRONG BUY"],
  [58, "BUY"],
  [42, "HOLD"],
  [28, "SELL"],
  [-Infinity, "STRONG SELL"],
];

// Linear interpolation across [value, score] anchors; clamps outside the ends.
export function piecewise(value, anchors) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= anchors[0][0]) return anchors[0][1];
  const [lastX, lastS] = anchors[anchors.length - 1];
  if (value >= lastX) return lastS;
  for (let i = 1; i < anchors.length; i++) {
    const [x1, s1] = anchors[i - 1];
    const [x2, s2] = anchors[i];
    if (value <= x2) return s1 + ((s2 - s1) * (value - x1)) / (x2 - x1);
  }
  return lastS;
}

// Ratio metrics are meaningless when negative (loss-making P/E, negative PEG):
// they get excluded rather than scored, and profitability/growth carry the hit.
const positiveOnly = (v) => (v != null && Number.isFinite(v) && v > 0 ? v : null);

const ANCHORS = {
  pe:   [[5, 100], [12, 85], [18, 65], [25, 50], [35, 30], [50, 12], [70, 0]],
  ps:   [[0.5, 100], [1, 90], [2, 75], [4, 55], [8, 35], [15, 12], [25, 0]],
  peg:  [[0.5, 100], [1, 85], [1.5, 68], [2, 50], [3, 28], [4, 12], [6, 0]],
  netMargin: [[-20, 0], [0, 20], [5, 42], [10, 58], [20, 80], [30, 95], [40, 100]],
  roe:  [[-10, 0], [0, 15], [8, 45], [15, 65], [25, 85], [40, 100]],
  revenueGrowth: [[-20, 0], [-5, 25], [0, 38], [5, 52], [15, 72], [30, 90], [50, 100]],
  epsGrowth: [[-30, 0], [-10, 25], [0, 40], [10, 58], [25, 78], [50, 95], [80, 100]],
  currentRatio: [[0.4, 0], [0.8, 30], [1, 45], [1.5, 70], [2, 85], [3, 100]],
  debtEquity: [[0, 100], [0.3, 88], [0.6, 72], [1, 55], [1.5, 40], [2.5, 20], [4, 5], [6, 0]],
  pricePosition: [[0, 5], [0.2, 25], [0.5, 52], [0.85, 88], [1, 100]],
};

const CATEGORY_DEFS = [
  {
    key: "valuation",
    label: "Valuation",
    metrics: [
      { key: "pe", label: "P/E", fmt: "x", value: (i) => positiveOnly(i.pe), anchors: ANCHORS.pe },
      { key: "ps", label: "P/S", fmt: "x", value: (i) => positiveOnly(i.ps), anchors: ANCHORS.ps },
      { key: "peg", label: "PEG", fmt: "x", value: (i) => positiveOnly(i.peg), anchors: ANCHORS.peg },
    ],
  },
  {
    key: "profitability",
    label: "Profitability",
    metrics: [
      { key: "netMargin", label: "Net margin", fmt: "%", value: (i) => i.netMargin, anchors: ANCHORS.netMargin },
      { key: "roe", label: "ROE", fmt: "%", value: (i) => i.roe, anchors: ANCHORS.roe },
    ],
  },
  {
    key: "growth",
    label: "Growth",
    metrics: [
      { key: "revenueGrowth", label: "Revenue YoY", fmt: "%", value: (i) => i.revenueGrowth, anchors: ANCHORS.revenueGrowth },
      { key: "epsGrowth", label: "EPS YoY", fmt: "%", value: (i) => i.epsGrowth, anchors: ANCHORS.epsGrowth },
    ],
  },
  {
    key: "health",
    label: "Financial health",
    metrics: [
      { key: "currentRatio", label: "Current ratio", fmt: "x", value: (i) => i.currentRatio, anchors: ANCHORS.currentRatio },
      { key: "debtEquity", label: "Debt/equity", fmt: "x", value: (i) => (i.debtEquity != null && i.debtEquity >= 0 ? i.debtEquity : null), anchors: ANCHORS.debtEquity },
    ],
  },
  {
    key: "momentum",
    label: "Momentum",
    metrics: [
      { key: "pricePosition", label: "52-week position", fmt: "pos", value: (i) => i.pricePosition, anchors: ANCHORS.pricePosition },
    ],
  },
  {
    key: "analyst",
    label: "Analyst view",
    metrics: [
      // analystTilt in [-2, 2]: (2*strongBuy + buy - sell - 2*strongSell) / total
      { key: "analystTilt", label: "Rating tilt", fmt: "tilt", value: (i) => i.analystTilt, anchors: [[-2, 0], [2, 100]] },
    ],
  },
];

export function analystTilt(trend) {
  if (!trend) return null;
  const sb = trend.strongBuy ?? 0;
  const b = trend.buy ?? 0;
  const h = trend.hold ?? 0;
  const s = trend.sell ?? 0;
  const ss = trend.strongSell ?? 0;
  const total = sb + b + h + s + ss;
  if (total <= 0) return null;
  return (2 * sb + b - s - 2 * ss) / total;
}

export function verdictForScore(score) {
  for (const [min, label] of VERDICT_BANDS) {
    if (score >= min) return label;
  }
  return "STRONG SELL";
}

// ---- earnings execution: did the company beat its own bar? --------------
// Scored from the last ≤4 quarters (actual vs estimate) — used only by the
// near-term horizon view below, NOT by the overall verdict (which stays v1).

const EARN_ANCHORS = {
  beatRate: [[0, 10], [0.25, 30], [0.5, 50], [0.75, 72], [1, 90]],
  avgSurprise: [[-8, 10], [-2, 35], [0, 50], [3, 70], [8, 90], [15, 100]],
};

export function scoreEarningsExecution(earnings = []) {
  const graded = (earnings ?? []).filter((e) => e && e.actual != null && e.estimate != null);
  if (!graded.length) return null;
  const beats = graded.filter((e) => e.actual >= e.estimate).length;
  const beatRate = beats / graded.length;
  const details = [
    {
      key: "beatRate",
      label: `Beats (${beats}/${graded.length})`,
      fmt: "pct01",
      value: beatRate,
      score: Math.round(piecewise(beatRate, EARN_ANCHORS.beatRate)),
    },
  ];
  const surprises = graded.map((e) => e.surprisePercent).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (surprises.length) {
    const avg = surprises.reduce((a, b) => a + b, 0) / surprises.length;
    details.push({
      key: "avgSurprise",
      label: "Avg surprise",
      fmt: "%",
      value: Math.round(avg * 100) / 100,
      score: Math.round(piecewise(avg, EARN_ANCHORS.avgSurprise)),
    });
  }
  const score = Math.round(details.reduce((a, d) => a + d.score, 0) / details.length);
  return { key: "earningsExec", label: "Earnings execution", score, details };
}

// ---- horizon views: the same inputs, regrouped by the horizon they're
// conventionally informative about. NOT independent forecasts — a lens
// decomposition of the one dataset, and the UI must say so.

export const HORIZON_DEFS = [
  { key: "nearTerm", label: "Near-term", hint: "weeks–months", weights: { momentum: 40, analyst: 35, earningsExec: 25 } },
  { key: "longTerm", label: "Long-term", hint: "years", weights: { valuation: 30, profitability: 30, growth: 25, health: 15 } },
];

export function computeHorizons(categories, earningsExec = null) {
  const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
  if (earningsExec) byKey.earningsExec = { ...earningsExec, available: earningsExec.score != null };
  return HORIZON_DEFS.map((def) => {
    const components = Object.entries(def.weights).map(([k, weight]) => {
      const c = byKey[k];
      return {
        key: k,
        label: c?.label ?? k,
        weight,
        available: Boolean(c?.available),
        score: c?.available ? c.score : null,
        details: c?.details ?? [],
      };
    });
    const present = components.filter((c) => c.available);
    if (!present.length) {
      return { key: def.key, label: def.label, hint: def.hint, components, score: null, verdict: null, confidence: null, insufficientData: true };
    }
    const weightSum = present.reduce((a, c) => a + c.weight, 0);
    const score = Math.round((present.reduce((a, c) => a + c.score * c.weight, 0) / weightSum) * 10) / 10;
    const confidence = present.length === components.length ? "High" : present.length >= 2 ? "Medium" : "Low";
    return { key: def.key, label: def.label, hint: def.hint, components, score, verdict: verdictForScore(score), confidence, insufficientData: false };
  });
}

// inputs: { pe, ps, peg, netMargin (%), roe (%), revenueGrowth (%), epsGrowth (%),
//           currentRatio, debtEquity (ratio), pricePosition (0..1), analystTilt (-2..2) }
// Any field may be null/undefined; the result degrades honestly.
export function computeVerdict(inputs = {}) {
  const categories = CATEGORY_DEFS.map((def) => {
    const details = def.metrics.map((m) => {
      const value = m.value(inputs);
      const score = piecewise(value, m.anchors);
      return { key: m.key, label: m.label, fmt: m.fmt, value: value ?? null, score: score == null ? null : Math.round(score) };
    });
    const scored = details.filter((d) => d.score != null);
    const score = scored.length
      ? scored.reduce((acc, d) => acc + d.score, 0) / scored.length
      : null;
    return {
      key: def.key,
      label: def.label,
      weight: WEIGHTS[def.key],
      available: score != null,
      score: score == null ? null : Math.round(score),
      details,
    };
  });

  const present = categories.filter((c) => c.available);
  const availableCount = present.length;

  if (availableCount < 2) {
    return {
      insufficientData: true,
      score: null,
      verdict: null,
      confidence: null,
      availableCount,
      totalCategories: categories.length,
      categories,
    };
  }

  const weightSum = present.reduce((acc, c) => acc + c.weight, 0);
  const overall = present.reduce((acc, c) => acc + c.score * c.weight, 0) / weightSum;
  const score = Math.round(overall * 10) / 10;

  const confidence = availableCount >= 5 ? "High" : availableCount >= 3 ? "Medium" : "Low";

  return {
    insufficientData: false,
    score,
    verdict: verdictForScore(score),
    confidence,
    availableCount,
    totalCategories: categories.length,
    categories,
  };
}
