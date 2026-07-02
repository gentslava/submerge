// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import {
  type ChannelPolicy,
  DEFAULT_SPEED_POLICY,
  type Proxy as ProxyConfig,
  PSEUDO_NODE_NAMES,
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

// A collapsed group may not shadow any built-in policy or routing group name.
const RESERVED_GROUP_NAMES = PSEUDO_NODE_NAMES;

// The mihomo tuning a `speed` policy contributes to url-test groups (AUTO + any
// collapsed same-name subgroup). Non-speed policies make AUTO a plain `select`
// that the server controller pins, so they contribute nothing here.
interface UrlTestTuning {
  url: string;
  interval: number;
  tolerance: number;
  lazy: boolean;
}
function urlTestTuning(policy: ChannelPolicy): UrlTestTuning {
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

export function buildConfig(
  proxies: ProxyConfig[],
  policy: ChannelPolicy = DEFAULT_SPEED_POLICY,
  secret: string = env.MIHOMO_SECRET,
): string {
  const entries = groupProxies(proxies);
  const usedGroupNames = new Set<string>(RESERVED_GROUP_NAMES);
  const topLevelNames: string[] = [];
  const flat: ProxyConfig[] = [];
  const subGroups: Record<string, unknown>[] = [];
  const tuning = urlTestTuning(policy);

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
      url: tuning.url,
      interval: tuning.interval,
      tolerance: tuning.tolerance,
      lazy: tuning.lazy,
      proxies: memberNames,
    });
    topLevelNames.push(gname);
  }

  const unique = dedupeNames(flat);
  const members = topLevelNames.length ? topLevelNames : ["DIRECT"];
  const autoGroup: Record<string, unknown> =
    policy.kind === "speed"
      ? {
          name: "AUTO",
          type: "url-test",
          url: tuning.url,
          interval: tuning.interval,
          tolerance: tuning.tolerance,
          lazy: tuning.lazy,
          proxies: members,
        }
      : {
          // sticky / manual: a dumb selector the server controller pins (Phase 2).
          name: "AUTO",
          type: "select",
          proxies: members,
        };

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
