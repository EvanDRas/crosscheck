// The economy right now: five headline series straight from FRED, the
// St. Louis Fed's public data service. The fredgraph.csv endpoint is
// keyless and the underlying series are US-government data. These numbers
// change weekly or monthly, not minute to minute — cached 12 hours, and a
// failed series just drops its row.

const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

async function series(id) {
  const res = await fetch(FRED + id, {
    headers: { "User-Agent": "Crosscheck/1.0 (open-source stock research tool)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  return (await res.text())
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","))
    .map(([date, v]) => ({ date, value: Number(v) }))
    .filter((r) => Number.isFinite(r.value));
}

const monthOf = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long" });
const dayOf = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });

let cache = null;
const TTL_MS = 12 * 3_600_000;

export async function getEconomy() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const [cpi, unrate, dff, spread, mortgage] = await Promise.allSettled([
    series("CPIAUCSL"), series("UNRATE"), series("DFF"), series("T10Y3M"), series("MORTGAGE30US"),
  ]).then((rs) => rs.map((r) => (r.status === "fulfilled" ? r.value : null)));

  const rows = [];
  if (cpi && cpi.length >= 13) {
    const last = cpi[cpi.length - 1];
    const yearAgo = cpi[cpi.length - 13];
    const yoy = ((last.value - yearAgo.value) / yearAgo.value) * 100;
    rows.push({
      label: "Inflation",
      value: `${yoy.toFixed(1)}%`,
      sub: `CPI, year over year · ${monthOf(last.date)}`,
      hint: "How much faster prices are rising than a year ago. The Fed aims for about 2% — hotter than that keeps rates higher for longer.",
    });
  }
  if (unrate?.length) {
    const last = unrate[unrate.length - 1];
    rows.push({
      label: "Unemployment",
      value: `${last.value.toFixed(1)}%`,
      sub: `${monthOf(last.date)} jobs data`,
      hint: "Share of the labor force out of work and looking. Low is a strong economy; a fast RISE from the low is the classic recession tell.",
    });
  }
  if (dff?.length) {
    const last = dff[dff.length - 1];
    rows.push({
      label: "Fed funds rate",
      value: `${last.value.toFixed(2)}%`,
      sub: `effective · ${dayOf(last.date)}`,
      hint: "The overnight rate the Fed actually controls — the dial it turns to cool inflation (raise) or support growth (cut). Every other rate keys off it.",
    });
  }
  if (spread?.length) {
    const last = spread[spread.length - 1];
    const inverted = last.value < 0;
    rows.push({
      label: "10yr − 3mo spread",
      value: `${last.value > 0 ? "+" : ""}${last.value.toFixed(2)}`,
      sub: inverted ? "inverted — the classic recession warning" : "positive — no inversion signal",
      hint: "Long-term minus short-term Treasury yields. When it goes negative (inversion), a recession has followed within ~2 years nearly every time since the 1960s — the most-watched single indicator there is.",
      tone: inverted ? "bad" : "ok",
    });
  }
  if (mortgage?.length) {
    const last = mortgage[mortgage.length - 1];
    rows.push({
      label: "30-yr mortgage",
      value: `${last.value.toFixed(2)}%`,
      sub: `week of ${dayOf(last.date)}`,
      hint: "The average US 30-year fixed mortgage rate — where Fed policy meets real life, and the number that sets the housing market's temperature.",
    });
  }
  if (rows.length) cache = { at: Date.now(), rows };
  return rows;
}
