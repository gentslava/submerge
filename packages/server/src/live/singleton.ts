import { DEFAULT_POLL_INTERVAL } from "@submerge/shared";
import { getDelay, getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { log } from "../log.js";
import { registry } from "../modules/channels/instance.js";
import { policyProbe, readDefaultPolicy } from "../modules/channels/service.js";
import { recordPassiveBandwidth } from "../modules/nodes/passiveBandwidth.js";
import {
  applyConfig,
  collectProxies,
  getExcludedSet,
  mergeDbInventory,
  proxyMeta,
  toNodeView,
} from "../modules/nodes/service.js";
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
    const dbProxies = collectProxies(db);
    const meta = proxyMeta(dbProxies);
    // Overlay the panel's own last-known measurements: a reload wipes mihomo's
    // history, and without this every settings change blanked the list to «— ms».
    // Then union the full DB inventory so pooled-out nodes stay visible (they'd
    // otherwise vanish from the live view on the next poll and clobber the merged
    // nodes.list). Merge last: idle DB-only nodes have no measurement to fill.
    // Report latency for the URL the active (Default) policy decides on, not the
    // last probe by any URL — same as the tRPC list path (nodes/service.listNodes).
    const { url: testUrl } = policyProbe(readDefaultPolicy(db));
    const view = prober.fillLastKnown(toNodeView(raw, meta, testUrl));
    return mergeDbInventory(view, dbProxies, meta, getExcludedSet(db));
  },
  streamTraffic,
  getInterval: () => PULSE_MS,
  fetchTotals: getTotals,
  afterView: async () => {
    await registry.runOnce();
    // After the controllers so a policy switch this tick can't race the batch.
    await prober.tick();
    // Passive per-node throughput sampling (Phase 4c b) — best-effort, own errors.
    await recordPassiveBandwidth(db, Date.now());
  },
  // The hub reports once per outage streak, so this can't flood the log.
  onError: (scope, err) => log.warn({ scope, err }, "mihomo live %s failed", scope),
  // mihomo restarting under submerge (image update, crash) loses its config —
  // the boot-time apply only covers a submerge restart, so a genuine engine
  // reconnect also needs one. Best-effort: the hub already guards this call.
  onReconnect: async () => {
    // A reconnected/restarted mihomo may have lost our config even though the DB
    // didn't change, so force the reload past the "skip when unchanged" guard.
    await applyConfig(db, undefined, undefined, { force: true });
  },
});
