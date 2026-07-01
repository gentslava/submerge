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

/** The Default channel's policy on a fresh install (behaviour-preserving vs the old AUTO url-test). */
export const DEFAULT_SPEED_POLICY: ChannelPolicy = {
  kind: "speed",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: DEFAULT_AUTO_TEST_INTERVAL,
  toleranceMs: DEFAULT_AUTO_TOLERANCE,
  // The old `switchOnTimeout: true` meant mihomo `lazy: false` = always re-evaluate.
  reevaluateWhileHealthy: DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
};
