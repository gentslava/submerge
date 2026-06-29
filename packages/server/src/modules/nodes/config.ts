// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import type { Proxy as ProxyConfig } from "@submerge/shared";
import * as yaml from "js-yaml";
import { env } from "../../config/env.js";

// Ensure unique proxy names (mihomo requires it). Deterministic suffix so the
// generated config is stable across reloads and testable (PoC used Math.random).
export function dedupeNames(proxies: ProxyConfig[]): ProxyConfig[] {
  const seen = new Map<string, number>();
  return proxies.map((p) => {
    const count = seen.get(p.name) ?? 0;
    seen.set(p.name, count + 1);
    return count === 0 ? p : { ...p, name: `${p.name}-${count + 1}` };
  });
}

export function buildConfig(proxies: ProxyConfig[]): string {
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
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 50,
        proxies: names.length ? names : ["DIRECT"],
      },
    ],
    rules: [names.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
