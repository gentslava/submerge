import { DEFAULT_POLL_INTERVAL } from "@submerge/shared";
import { getDelay, getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { log } from "../log.js";
import { registry } from "../modules/channels/instance.js";
import { policyProbe, readDefaultPolicy } from "../modules/channels/service.js";
import { applyConfig, collectProxies, proxyMeta, toNodeView } from "../modules/nodes/service.js";
import { LiveHub } from "./hub.js";
import { Prober } from "./prober.js";

// The internal pulse. Reading mihomo state must stay fast regardless of the
// user's check interval, so this is a constant, not a setting (spec §4.2).
const PULSE_MS = DEFAULT_POLL_INTERVAL * 1000;

// Keeps every node's measurement fresher than «Интервал проверки» (spec §4.1).
// Probes go through getDelay → mihomo records them → the normal view path
// (fetchView below) surfaces them; observe() feeds freshness back in.
export const prober = new Prober({
  probe: (name, url) => getDelay(name, url),
  getProbeConfig: () => policyProbe(readDefaultPolicy(db)),
  pulseMs: PULSE_MS,
});

export const liveHub = new LiveHub({
  fetchView: async () => {
    const raw = await getProxies();
    prober.observe(raw);
    // Overlay the panel's own last-known measurements: a reload wipes mihomo's
    // history, and without this every settings change blanked the list to «— ms».
    return prober.fillLastKnown(toNodeView(raw, proxyMeta(collectProxies(db))));
  },
  streamTraffic,
  getInterval: () => PULSE_MS,
  fetchTotals: getTotals,
  afterView: async () => {
    await registry.runOnce();
    // After the controllers so a policy switch this tick can't race the batch.
    await prober.tick();
  },
  // The hub reports once per outage streak, so this can't flood the log.
  onError: (scope, err) => log.warn({ scope, err }, "mihomo live %s failed", scope),
  // mihomo restarting under submerge (image update, crash) loses its config —
  // the boot-time apply only covers a submerge restart, so a genuine engine
  // reconnect also needs one. Best-effort: the hub already guards this call.
  onReconnect: async () => {
    await applyConfig(db);
  },
});
