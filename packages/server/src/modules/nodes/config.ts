// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import {
  type ChannelPolicy,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_AUTO_TOLERANCE,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import { sameProxy } from "../../lib/proxy-identity.js";

export type TopLevelEntry =
  | { kind: "single"; proxy: ProxyConfig }
  | { kind: "group"; base: string; members: ProxyConfig[] };

// Group raw proxies by exact name (pre-dedupe). Within a same-name set, drop
// true duplicates with an identical full config. A name with ≥2 distinct profiles
// becomes a collapsed group; otherwise it stays a single proxy. Order follows
// each name's first appearance.
export function groupProxies(proxies: ProxyConfig[]): TopLevelEntry[] {
  const order: string[] = [];
  const byName = new Map<string, ProxyConfig[]>();
  for (const p of proxies) {
    const bucket = byName.get(p.name);
    if (!bucket) {
      byName.set(p.name, [p]);
      order.push(p.name);
    } else if (!bucket.some((q) => sameProxy(q, p))) {
      bucket.push(p);
    }
  }
  return order.map((name) => {
    const members = byName.get(name) as ProxyConfig[];
    return members.length > 1
      ? { kind: "group" as const, base: name, members }
      : { kind: "single" as const, proxy: members[0] as ProxyConfig };
  });
}

// Ensure unique proxy names (mihomo requires it). Deterministic suffix so the
// generated config is stable across reloads and testable (PoC used Math.random).
// Tracks the full set of emitted names — including generated suffixes — so a
// pre-existing "A-2" can't collide with a renamed duplicate of "A". `reserved`
// seeds that set with names from another namespace (proxy-group names) so a
// proxy can never be assigned a name mihomo already uses for a group — the two
// namespaces must be jointly unique (see multiConfig.ts's collision guard).
export function dedupeNames(
  proxies: ProxyConfig[],
  reserved: Iterable<string> = [],
): ProxyConfig[] {
  const used = new Set<string>(reserved);
  return proxies.map((p) => {
    if (!used.has(p.name)) {
      used.add(p.name);
      return p;
    }
    let n = 2;
    while (used.has(`${p.name}-${n}`)) n++;
    const name = `${p.name}-${n}`;
    used.add(name);
    return { ...p, name };
  });
}

// The mihomo tuning a `speed` policy contributes to url-test groups (AUTO + any
// collapsed same-name subgroup). Non-speed policies make AUTO a plain `select`
// that the server controller pins, so they contribute nothing here.
export interface UrlTestTuning {
  url: string;
  interval: number;
  tolerance: number;
  lazy: boolean;
}
export function urlTestTuning(policy: ChannelPolicy): UrlTestTuning {
  // Use each policy's OWN probe settings when it has them (speed: url + interval +
  // tolerance; optimal + sticky: url + interval, tolerance falls back to the default).
  // Only `manual` — which has no probe knobs — falls back entirely to the built-in
  // defaults. Previously every non-`speed` policy
  // fell back to DEFAULT_SPEED_POLICY, pinning collapsed url-test subgroups to the 300 s
  // default even when the channel asked for e.g. 10 s — so under `optimal`/`sticky` the
  // subgroup members were measured far too rarely for the controller's ranking / the
  // panel's charts. The single-default `speed` case is byte-identical to before.
  const url = "testUrl" in policy ? policy.testUrl : DEFAULT_AUTO_TEST_URL;
  const interval = "intervalSec" in policy ? policy.intervalSec : DEFAULT_AUTO_TEST_INTERVAL;
  const tolerance = "toleranceMs" in policy ? policy.toleranceMs : DEFAULT_AUTO_TOLERANCE;
  // Only `speed` exposes the lazy knob; every other policy re-tests each interval
  // (lazy = false) so members stay freshly measured for ranking + the charts.
  const lazy = policy.kind === "speed" ? !policy.reevaluateWhileHealthy : false;
  return { url, interval, tolerance, lazy };
}
