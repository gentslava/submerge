// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import {
  type ChannelPolicy,
  DEFAULT_SPEED_POLICY,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import { env } from "../../config/env.js";
import { buildMultiConfig } from "./multiConfig.js";

export type TopLevelEntry =
  | { kind: "single"; proxy: ProxyConfig }
  | { kind: "group"; base: string; members: ProxyConfig[] };

// Group raw proxies by exact name (pre-dedupe). Within a same-name set, drop
// true duplicates sharing a server:port. A name with ≥2 distinct endpoints
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
    } else if (!bucket.some((q) => q.server === p.server && q.port === p.port)) {
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
  const p =
    policy.kind === "speed"
      ? policy
      : (DEFAULT_SPEED_POLICY as Extract<ChannelPolicy, { kind: "speed" }>);
  return {
    url: p.testUrl,
    interval: p.intervalSec,
    tolerance: p.toleranceMs,
    lazy: !p.reevaluateWhileHealthy,
  };
}

// Thin wrapper over the multi-channel generator: a single Default channel keeps
// the "AUTO" group and no domain rules, reproducing the original single-pool
// config byte-for-byte (see multiConfig.ts + config.test.ts, the byte-identity gate).
export function buildConfig(
  proxies: ProxyConfig[],
  policy: ChannelPolicy = DEFAULT_SPEED_POLICY,
  secret: string = env.MIHOMO_SECRET,
): string {
  return buildMultiConfig(
    [{ id: "default", groupName: "AUTO", isDefault: true, policy, domains: [], proxies }],
    secret,
  );
}
