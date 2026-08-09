// Live price streaming: one upstream Finnhub trade websocket (free tier
// includes real-time US trades), fanned out to browser viewers over SSE.
// The upstream socket exists only while someone is watching; each symbol is
// subscribed on its first viewer and unsubscribed on its last. Ticks are
// throttled to one DOM update per second per symbol.

const viewers = new Map(); // symbol -> Set<res>
const lastTick = new Map(); // symbol -> { price, time }
const pending = new Map(); // symbol -> throttle timer
let ws = null;
let idleTimer = null;
let reconnectTimer = null;

const OPEN = 1;
const CONNECTING = 0;

// Native WebSocket landed in Node 21 — on older Node the live stream is
// simply unavailable and the page stays on the (already fresh) static quote.
export const streamingSupported = () => typeof WebSocket !== "undefined";

function sendUpstream(msg) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
}

function ensureSocket(apiKey) {
  if (!streamingSupported()) return;
  clearTimeout(idleTimer);
  if (ws && (ws.readyState === CONNECTING || ws.readyState === OPEN)) return;
  ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);
  ws.onopen = () => {
    for (const sym of viewers.keys()) sendUpstream({ type: "subscribe", symbol: sym });
  };
  ws.onmessage = (ev) => {
    let doc;
    try {
      doc = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (doc?.type !== "trade" || !Array.isArray(doc.data)) return;
    for (const t of doc.data) {
      if (typeof t?.p !== "number" || !t.s) continue;
      lastTick.set(t.s, { price: t.p, time: t.t ?? Date.now() });
      scheduleFlush(t.s);
    }
  };
  ws.onclose = ws.onerror = () => {
    // Auto-reconnect while anyone is still watching.
    if (viewers.size && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (viewers.size) ensureSocket(apiKey);
      }, 10_000);
    }
  };
}

function scheduleFlush(symbol) {
  if (pending.has(symbol)) return;
  pending.set(symbol, setTimeout(() => {
    pending.delete(symbol);
    const tick = lastTick.get(symbol);
    const set = viewers.get(symbol);
    if (!tick || !set) return;
    const line = `data: ${JSON.stringify(tick)}\n\n`;
    for (const res of set) {
      try {
        res.write(line);
      } catch {}
    }
  }, 1000));
}

// Wire one SSE response up as a viewer of `symbol`. Caller has already sent
// the event-stream headers.
export function addViewer(symbol, res, apiKey) {
  if (!viewers.has(symbol)) {
    viewers.set(symbol, new Set());
    sendUpstream({ type: "subscribe", symbol });
  }
  viewers.get(symbol).add(res);
  ensureSocket(apiKey);

  const ka = setInterval(() => {
    try {
      res.write(":ka\n\n");
    } catch {}
  }, 20_000);

  res.on("close", () => {
    clearInterval(ka);
    const set = viewers.get(symbol);
    if (!set) return;
    set.delete(res);
    if (!set.size) {
      viewers.delete(symbol);
      lastTick.delete(symbol);
      clearTimeout(pending.get(symbol));
      pending.delete(symbol);
      sendUpstream({ type: "unsubscribe", symbol });
    }
    if (!viewers.size) {
      // Nobody watching anything: close the upstream socket after a grace
      // period so page reloads don't churn connections.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!viewers.size && ws) {
          try {
            ws.close();
          } catch {}
          ws = null;
        }
      }, 60_000);
    }
  });
}

export function viewerCount() {
  let n = 0;
  for (const set of viewers.values()) n += set.size;
  return n;
}
