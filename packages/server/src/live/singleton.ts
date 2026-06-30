import { getDelay, getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { readAutoConfig, toNodeView } from "../modules/nodes/service.js";
import { getSetting } from "../modules/settings/service.js";
import { LiveHub } from "./hub.js";

// mihomo built-in policies aren't real proxies — delay-testing them errors, so skip.
const PSEUDO_NODES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

// Poll cadence is settings-driven: read `pollInterval` (seconds), clamp to >= 1,
// fall back to 5 s. Returns milliseconds for the hub's scheduler.
function pollIntervalMs(): number {
  const raw = Number.parseInt(getSetting(db, "pollInterval") ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 1 ? raw : 5; // default 5 s
  return seconds * 1000;
}

// Process-wide hub wired to the real mihomo client + settings-driven cadence.
export const liveHub = new LiveHub({
  fetchView: async () => toNodeView(await getProxies()),
  streamTraffic,
  getInterval: pollIntervalMs,
  // Measure the active node each poll so its latency chart grows at the poll cadence.
  // Probe the same URL the AUTO group uses, so the chart matches its selection logic.
  probeActive: async (name) => {
    if (PSEUDO_NODES.has(name)) return;
    await getDelay(name, readAutoConfig(db).url);
  },
  fetchTotals: getTotals,
});
