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

export function buildConfig(
  proxies: ProxyConfig[],
  auto: AutoConfig = AUTO_DEFAULTS,
  secret: string = env.MIHOMO_SECRET,
): string {
  const unique = dedupeNames(proxies);
  const names = unique.map((p) => p.name);
  // The AUTO group's shape depends on its strategy (mihomo group type).
  const autoGroup: Record<string, unknown> = {
    name: "AUTO",
    type: auto.strategy,
    url: auto.url,
    interval: auto.interval,
    lazy: !auto.switchOnTimeout,
    proxies: names.length ? names : ["DIRECT"],
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
      { name: "PROXY", type: "select", proxies: ["AUTO", ...names, "DIRECT"] },
      autoGroup,
    ],
    rules: [names.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
