// Engine tuning defaults — the single source for both the server (config generation +
// settings fallbacks) and the web (UI fallbacks shown until settings load). Keeping them
// here is the contract: front and back can't silently drift to different defaults.

import type { ChannelPolicy } from "./schemas.js";

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

/** Seconds between panel polls of mihomo (latency/traffic refresh + engine health). */
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

/** The Default channel's policy on a fresh install (behaviour-preserving vs the old AUTO url-test). */
export const DEFAULT_SPEED_POLICY: ChannelPolicy = {
  kind: "speed",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: DEFAULT_AUTO_TEST_INTERVAL,
  toleranceMs: DEFAULT_AUTO_TOLERANCE,
  // The old `switchOnTimeout: true` meant mihomo `lazy: false` = always re-evaluate.
  reevaluateWhileHealthy: DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
};
