// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import {
  DEFAULT_AUTO_STRATEGY,
  DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_AUTO_TOLERANCE,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import * as yaml from "js-yaml";
import { env } from "../../config/env.js";

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
// pre-existing "A-2" can't collide with a renamed duplicate of "A".
export function dedupeNames(proxies: ProxyConfig[]): ProxyConfig[] {
  const used = new Set<string>();
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

// AUTO group policy — the mihomo group type that picks the active node.
export type AutoStrategy = "url-test" | "fallback" | "load-balance";
export const AUTO_STRATEGIES: AutoStrategy[] = ["url-test", "fallback", "load-balance"];

// AUTO group tuning — editable via Settings; defaults baked here.
export interface AutoConfig {
  strategy: AutoStrategy;
  url: string;
  interval: number; // seconds between mihomo re-tests
  tolerance: number; // ms hysteresis before switching (url-test only)
  switchOnTimeout: boolean; // proactively re-test + switch (mihomo lazy: false)
}
export const AUTO_DEFAULTS: AutoConfig = {
  strategy: DEFAULT_AUTO_STRATEGY,
  url: DEFAULT_AUTO_TEST_URL,
  interval: DEFAULT_AUTO_TEST_INTERVAL,
  tolerance: DEFAULT_AUTO_TOLERANCE,
  switchOnTimeout: DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
};

const RESERVED_GROUP_NAMES = ["AUTO", "PROXY", "DIRECT", "REJECT", "GLOBAL"];

export function buildConfig(
  proxies: ProxyConfig[],
  auto: AutoConfig = AUTO_DEFAULTS,
  secret: string = env.MIHOMO_SECRET,
): string {
  const entries = groupProxies(proxies);
  const usedGroupNames = new Set<string>(RESERVED_GROUP_NAMES);
  const topLevelNames: string[] = [];
  const flat: ProxyConfig[] = [];
  const subGroups: Record<string, unknown>[] = [];

  for (const e of entries) {
    if (e.kind === "single") {
      topLevelNames.push(e.proxy.name);
      flat.push(e.proxy);
      continue;
    }
    let gname = e.base;
    if (usedGroupNames.has(gname)) {
      let n = 2;
      while (usedGroupNames.has(`${e.base}-${n}`)) n++;
      gname = `${e.base}-${n}`;
    }
    usedGroupNames.add(gname);
    const memberNames = e.members.map((_, i) => `${gname} #${i + 1}`);
    for (const [i, m] of e.members.entries()) {
      flat.push({ ...m, name: memberNames[i] as string });
    }
    subGroups.push({
      name: gname,
      type: "url-test",
      url: auto.url,
      interval: auto.interval,
      tolerance: auto.tolerance,
      lazy: !auto.switchOnTimeout,
      proxies: memberNames,
    });
    topLevelNames.push(gname);
  }

  const unique = dedupeNames(flat);
  const autoGroup: Record<string, unknown> = {
    name: "AUTO",
    type: auto.strategy,
    url: auto.url,
    interval: auto.interval,
    lazy: !auto.switchOnTimeout,
    proxies: topLevelNames.length ? topLevelNames : ["DIRECT"],
  };
  if (auto.strategy === "url-test") autoGroup.tolerance = auto.tolerance;
  if (auto.strategy === "load-balance") autoGroup.strategy = "round-robin";

  const cfg = {
    "mixed-port": 7890,
    "allow-lan": true,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "0.0.0.0:9090",
    secret,
    proxies: unique,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: ["AUTO", ...topLevelNames, "DIRECT"] },
      autoGroup,
      ...subGroups,
    ],
    rules: [topLevelNames.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
