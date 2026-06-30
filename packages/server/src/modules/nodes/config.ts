// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import type { Proxy as ProxyConfig } from "@submerge/shared";
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

// AUTO (url-test) group tuning — editable via Settings; defaults baked here.
export interface AutoConfig {
  url: string;
  interval: number; // seconds between mihomo re-tests
  tolerance: number; // ms hysteresis before switching nodes
}
export const AUTO_DEFAULTS: AutoConfig = {
  url: "https://www.gstatic.com/generate_204",
  interval: 300,
  tolerance: 50,
};

export function buildConfig(proxies: ProxyConfig[], auto: AutoConfig = AUTO_DEFAULTS): string {
  const unique = dedupeNames(proxies);
  const names = unique.map((p) => p.name);
  const cfg = {
    "mixed-port": 7890,
    "allow-lan": true,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "0.0.0.0:9090",
    secret: env.MIHOMO_SECRET,
    proxies: unique,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: ["AUTO", ...names, "DIRECT"] },
      {
        name: "AUTO",
        type: "url-test",
        url: auto.url,
        interval: auto.interval,
        tolerance: auto.tolerance,
        proxies: names.length ? names : ["DIRECT"],
      },
    ],
    rules: [names.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
