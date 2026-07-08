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
 *  mihomo's own selector. Groups, not exit nodes. */
export const ROUTING_GROUP_NAMES = ["AUTO", "PROXY", "GLOBAL"] as const;

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

/** «Оптимальный» policy defaults — windowed speed-vs-liveness selection. Shorter
 *  interval than speed's 300 s so the EWMA reflects recent conditions; same tolerance
 *  as the switch margin on effective latency. */
export const DEFAULT_OPTIMAL_POLICY: ChannelPolicy = {
  kind: "optimal",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: 60,
  toleranceMs: DEFAULT_AUTO_TOLERANCE,
};

/** EWMA half-life (seconds) for the optimal policy — how fast old samples decay.
 *  Constant in v1 (not a per-policy knob) to keep the UI to three fields. */
export const OPTIMAL_EWMA_HALF_LIFE_SEC = 300;
/** Success-rate floor in the effective-latency denominator, so a fully-dead node
 *  (ewmaSuccess → 0) can't divide-by-zero and simply sorts last. */
export const OPTIMAL_SUCCESS_EPSILON = 0.05;
/** Missed probes of the ACTIVE node before the optimal policy fails over to the best
 *  reachable node. 1 = flee on the FIRST timeout: never hold a node that just went
 *  unreachable while a live alternative exists, then let the EWMA ranking pick the
 *  long-run leader among the healthy nodes. Guards the slow-abandonment trap (a dead
 *  node's EWMA effective latency crawls up over minutes at a long half-life). */
export const OPTIMAL_ACTIVE_FAILURE_THRESHOLD = 1;
