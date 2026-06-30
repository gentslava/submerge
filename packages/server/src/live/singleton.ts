import { DEFAULT_POLL_INTERVAL } from "@submerge/shared";
import { getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { toNodeView } from "../modules/nodes/service.js";
import { getSetting } from "../modules/settings/service.js";
import { LiveHub } from "./hub.js";

// Poll cadence is settings-driven: read `pollInterval` (seconds), clamp to >= 1,
// fall back to the default. Returns milliseconds for the hub's scheduler.
function pollIntervalMs(): number {
  const raw = Number.parseInt(getSetting(db, "pollInterval") ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_POLL_INTERVAL;
  return seconds * 1000;
}

// Process-wide hub wired to the real mihomo client + settings-driven cadence. The panel
// only READS mihomo's state each poll — it does NOT probe the active node itself. Node
// latency is measured by mihomo's url-test at the configured check interval, so a node is
// never re-tested every poll (which would ignore the "Интервал проверки" setting).
export const liveHub = new LiveHub({
  fetchView: async () => toNodeView(await getProxies()),
  streamTraffic,
  getInterval: pollIntervalMs,
  fetchTotals: getTotals,
});
