// Engine tuning defaults — the single source for both the server (config generation +
// settings fallbacks) and the web (UI fallbacks shown until settings load). Keeping them
// here is the contract: front and back can't silently drift to different defaults.

import type { ChannelMatcher, ChannelPolicy } from "./schemas.js";

/** AUTO group policy when nothing is set (mihomo group type). */
export const DEFAULT_AUTO_STRATEGY = "url-test" as const;
/** Endpoint mihomo health-checks nodes against (and the panel probes). */
export const DEFAULT_AUTO_TEST_URL = "https://www.gstatic.com/generate_204";
/** Seconds between mihomo re-tests of the AUTO group. */
export const DEFAULT_AUTO_TEST_INTERVAL = 300;
/** Latency hysteresis (ms) before switching — url-test strategy only. */
export const DEFAULT_AUTO_TOLERANCE = 50;
/** Proactively re-test + switch when the active node times out (mihomo lazy: false). */
export const DEFAULT_AUTO_SWITCH_ON_TIMEOUT = true;

/** INTERNAL pulse (seconds): how often the server reads mihomo state and runs a
 *  prober batch. Not user-configurable — the one user knob is the policy's
 *  «Интервал проверки» (see docs/specs/2026-07-03-background-prober-design.md). */
export const DEFAULT_POLL_INTERVAL = 5;

// ---------------------------------------------------------------------------
// Pseudo node names — the single source of truth for "is this a real exit
// node?" checks. Previously five hand-copied lists across server and web had
// already drifted apart; add new mihomo built-ins HERE only.

/** mihomo's built-in policies: always present in the engine, error on delay-test,
 *  never selectable/pinnable exit nodes. */
export const MIHOMO_BUILTIN_POLICIES = [
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
] as const;

/** Routing groups: AUTO/PROXY are written by our config generator, GLOBAL is
 *  mihomo's own selector, PROBE is the hidden speed-test group. Groups, not exit nodes. */
export const ROUTING_GROUP_NAMES = ["AUTO", "PROXY", "GLOBAL", "PROBE"] as const;

// ---------------------------------------------------------------------------
// On-demand speed test (Phase 4c). A hidden `PROBE` select group (default DIRECT,
// so normal traffic to the test host is unaffected) lets the server route a
// fixed-size download through one chosen node: set PROBE → node, GET the payload
// through mihomo's proxy port, measure bytes/sec, restore PROBE → DIRECT. A single
// rule (`DOMAIN,<host>,PROBE`) sends only the test host through the group.

/** The hidden speed-test proxy-group name. */
export const PROBE_GROUP = "PROBE";
/** Host of the speed-test payload — the one host routed through PROBE. */
export const SPEED_TEST_HOST = "speed.cloudflare.com";
/** Fixed-size download URL for the throughput probe (Cloudflare's public endpoint). */
export const SPEED_TEST_URL = "https://speed.cloudflare.com/__down?bytes=25000000";
/** Byte cap for a single probe (~25 MB) — stop reading once reached. */
export const SPEED_TEST_MAX_BYTES = 25_000_000;
/** Hard timeout for a single probe. On timeout we still report throughput from the
 *  bytes read so far, so a slow (<10 Mbps) node yields a real number, not an error. */
export const SPEED_TEST_TIMEOUT_MS = 20_000;
/** How long a cached bandwidth reading counts toward the `highest-bandwidth`
 *  criterion. Older readings are treated as absent (→ fall back to fastest), so a
 *  stale peak can't pin a node forever. Passive samples also reset the peak past this. */
export const BANDWIDTH_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 h

/** Every name that denotes a group/policy rather than a selectable exit node. */
export const PSEUDO_NODE_NAMES = [...ROUTING_GROUP_NAMES, ...MIHOMO_BUILTIN_POLICIES] as const;

/** Ready-made membership set so consumers don't each rebuild `new Set(...)`. */
export const PSEUDO_NODE_SET: ReadonlySet<string> = new Set(PSEUDO_NODE_NAMES);

/** An empty channel matcher — the single source for "matches nothing extra" so
 *  literals don't drift as the matcher schema grows (Phase 4a added keywords +
 *  ruleProviders). Returned as a fresh object each call: the arrays are mutable
 *  and callers must not share references. */
export function emptyChannelMatcher(): ChannelMatcher {
  return { presets: [], domains: [], keywords: [], ruleProviders: [], geosite: [], geoip: [] };
}

/** The Default channel's policy on a fresh install (behaviour-preserving vs the old AUTO url-test). */
export const DEFAULT_SPEED_POLICY: ChannelPolicy = {
  kind: "speed",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: DEFAULT_AUTO_TEST_INTERVAL,
  toleranceMs: DEFAULT_AUTO_TOLERANCE,
  // The old `switchOnTimeout: true` meant mihomo `lazy: false` = always re-evaluate.
  reevaluateWhileHealthy: DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
};

/** «Оптимальный» policy defaults — windowed speed-vs-liveness selection. The switch
 *  margin is RELATIVE (a % of the current node's score, see OPTIMAL_SWITCH_MARGIN_PCT),
 *  not a fixed ms, so it scales with how fast the fleet is — hence no `toleranceMs`. */
export const DEFAULT_OPTIMAL_POLICY: ChannelPolicy = {
  kind: "optimal",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: 60,
};

/** EWMA half-life for the optimal policy, measured in MEASUREMENTS (not seconds) so the
 *  window is the same regardless of «Интервал проверки» (a 300 s window meant 30 samples
 *  at a 10 s interval but only 1 at 5 min). ~8 samples half-life ≈ a rolling window of the
 *  last ~15–20 measurements: responsive enough to react to a real spike/degradation, still
 *  smoothed enough not to chase single-sample noise. α = 1 − 2^(−1/N). Tune on real fleets. */
export const OPTIMAL_EWMA_HALF_LIFE_SAMPLES = 8;
/** Success-rate floor in the effective-latency denominator, so a fully-dead node
 *  (ewmaSuccess → 0) can't divide-by-zero and simply sorts last. */
export const OPTIMAL_SUCCESS_EPSILON = 0.05;
/** Proactive switch margin as a FRACTION of the current node's effective latency: switch
 *  to the best reachable node when it's at least this much faster. Relative (not fixed ms)
 *  so a fast fleet (~300 ms) switches on ~30 ms while a slow one (~1 s) needs ~100 ms — a
 *  fixed 50 ms either flapped the slow fleet or froze the fast one. */
export const OPTIMAL_SWITCH_MARGIN_PCT = 0.1;
/** Missed probes of the ACTIVE node before failing over to the best reachable node.
 *  1 = flee on the FIRST timeout (never hold a dead node while a live alternative exists). */
export const OPTIMAL_ACTIVE_FAILURE_THRESHOLD = 1;
/** «Slow but alive» escape: the active node counts as slow this tick when its RAW current
 *  latency exceeds the best reachable node's effective latency by more than this fraction.
 *  Catches an acute spike/degradation the smoothed EWMA would absorb too slowly — a stable
 *  node that "got lucky once" shouldn't hold priority once it's clearly worse right now. */
export const OPTIMAL_SLOW_FACTOR = 0.5;
/** Consecutive «slow» ticks before the slow-but-alive escape fires — a short streak so a
 *  single-sample blip doesn't cause a switch (the current node isn't dead, just spiking). */
export const OPTIMAL_SLOW_TICKS = 2;
