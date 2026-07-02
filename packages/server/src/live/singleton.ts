import { DEFAULT_POLL_INTERVAL } from "@submerge/shared";
import { getDelay, getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { log } from "../log.js";
import { channelController } from "../modules/channels/instance.js";
import { policyProbe, readDefaultPolicy } from "../modules/channels/service.js";
import { collectProxies, proxyMeta, toNodeView } from "../modules/nodes/service.js";
import { getSetting } from "../modules/settings/service.js";
import { LiveHub } from "./hub.js";

// mihomo built-in policies aren't real proxies — delay-testing them errors, so skip.
const PSEUDO_NODES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

// Poll cadence is settings-driven: read `pollInterval` (seconds), clamp to >= 1,
// fall back to the default. Returns milliseconds for the hub's scheduler.
function pollIntervalMs(): number {
  const raw = Number.parseInt(getSetting(db, "pollInterval") ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_POLL_INTERVAL;
  return seconds * 1000;
}

// Throttle the active-node probe to the configured CHECK interval (NOT the poll cadence):
// the hub calls probeActive every poll, but we only re-test the node once per «Интервал
// проверки», so the latency chart grows at that interval — no faster (the old re-test
// every 5 s bug), and not dependent on mihomo's own url-test (which the panel may not
// control, e.g. an external engine). The 1 s slack absorbs poll-timing jitter when the
// check interval equals the poll interval.
let lastProbe = 0;

export const liveHub = new LiveHub({
  fetchView: async () => toNodeView(await getProxies(), proxyMeta(collectProxies(db))),
  streamTraffic,
  getInterval: pollIntervalMs,
  probeActive: async (name) => {
    if (PSEUDO_NODES.has(name)) return;
    const { url, intervalSec } = policyProbe(readDefaultPolicy(db));
    const now = Date.now();
    if (now - lastProbe < intervalSec * 1000 - 1000) return;
    lastProbe = now;
    await getDelay(name, url);
  },
  fetchTotals: getTotals,
  afterView: (view) => channelController.tick(view),
  // The hub reports once per outage streak, so this can't flood the log.
  onError: (scope, err) => log.warn({ scope, err }, "mihomo live %s failed", scope),
});
