# AmneziaWG / WireGuard ingest — Phase B1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ingest WireGuard / AmneziaWG configs — raw `.conf` and Amnezia `vpn://` (config_version 1) — as a mihomo `wireguard` proxy (+ `amnezia-wg-option`), with `wireguard`/`amneziawg` source kinds and a `WIREGUARD · UDP · AmneziaWG` badge. (Hosted `vpn://` v2 API = later B2 spike.)

**Architecture:** Server ingest only + a badge tweak. A `.conf` INI parser (`parseWireguardConf`) is the core; the `vpn://` path decodes the Qt-qCompress blob, and for config_version 1 extracts the embedded WireGuard `.conf` string and reuses that same parser (no guessing inner JSON field names). config_version 2 throws a clear "not yet supported" until B2. No registry/DI (ADR-0004).

**Tech Stack:** Node 24, strict TS (ESM `.js` specifiers, `exactOptionalPropertyTypes`), Zod 4, Vitest, Biome. Gate before each commit: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`.

**Spec:** [docs/specs/2026-07-02-amneziawg-phaseb-design.md](../specs/2026-07-02-amneziawg-phaseb-design.md)

---

## File structure
- `packages/shared/src/schemas.ts` — `sourceKindSchema` += `wireguard`, `amneziawg`; `nodeItemSchema.security` enum += `amneziawg` (drives the variant badge).
- `packages/server/src/modules/sources/wireguard.ts` — NEW: `parseWireguardConf(text)` + `decodeAmneziaVpnLink(uri)`.
- `packages/server/src/modules/sources/parse.ts` — `detectKind` `.conf` + `vpn://` branches; export a `parseWireguardSource(value, kind)` used by ingest.
- `packages/server/src/modules/sources/ingest.ts` — route `wireguard`/`amneziawg` kinds.
- `packages/server/src/modules/nodes/service.ts` — `proxyMeta` sets `security: "amneziawg"` when a proxy carries `amnezia-wg-option`.
- `packages/web/src/features/nodes/nodeView.ts` — WireGuard→UDP transport + AmneziaWG security badge.
- `packages/web/src/features/sources/detectKind.ts` + `SourceRow.tsx` — WireGuard/AmneziaWG hint + label.

---

## Task 1: `parseWireguardConf` (.conf → mihomo wireguard)

**Files:** Create `packages/server/src/modules/sources/wireguard.ts`; Test `packages/server/src/modules/sources/wireguard.test.ts`.

- [ ] **Step 1: Failing tests** (`wireguard.test.ts`):

```ts
import type { Proxy as ProxyConfig } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { parseWireguardConf } from "./wireguard.js";

const AWG_CONF = `[Interface]
PrivateKey = QPfJjCBp1htdPan2YGZp6N4H0O/5YBsO3+XtyHrY43I=
Address = 10.8.2.2/32
DNS = 1.1.1.1, 1.0.0.1
Jc = 7
Jmin = 50
Jmax = 1000
S1 = 86
S2 = 118
H1 = 1987912497
H2 = 1060324821
H3 = 1565009321
H4 = 290779217

[Peer]
PublicKey = Euk1dzwOLFiEsOkqJThaU8KWteBezAbOAFGs9XdVZQw=
PresharedKey = AQnQf1z/atmH0hNudbMqFZyXBWMqcXOxpPT1hcpjKX8=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 194.41.113.64:443
PersistentKeepalive = 25`;

describe("parseWireguardConf", () => {
  it("maps an AmneziaWG .conf to a mihomo wireguard proxy", () => {
    const p = parseWireguardConf(AWG_CONF) as Record<string, unknown>;
    expect(p).toMatchObject({
      name: "AmneziaWG 194.41.113.64",
      type: "wireguard",
      "private-key": "QPfJjCBp1htdPan2YGZp6N4H0O/5YBsO3+XtyHrY43I=",
      ip: "10.8.2.2",
      server: "194.41.113.64",
      port: 443,
      "public-key": "Euk1dzwOLFiEsOkqJThaU8KWteBezAbOAFGs9XdVZQw=",
      "pre-shared-key": "AQnQf1z/atmH0hNudbMqFZyXBWMqcXOxpPT1hcpjKX8=",
      "persistent-keepalive": 25,
      udp: true,
    });
    expect(p.dns).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(p["allowed-ips"]).toEqual(["0.0.0.0/0", "::/0"]);
    expect(p["amnezia-wg-option"]).toEqual({
      jc: 7, jmin: 50, jmax: 1000, s1: 86, s2: 118,
      h1: 1987912497, h2: 1060324821, h3: 1565009321, h4: 290779217,
    });
  });

  it("plain WireGuard (no AWG params) → no amnezia-wg-option", () => {
    const conf = AWG_CONF.replace(/^(Jc|Jmin|Jmax|S1|S2|H1|H2|H3|H4) =.*$/gm, "").replace(/\n{2,}/g, "\n\n");
    const p = parseWireguardConf(conf) as Record<string, unknown>;
    expect(p.type).toBe("wireguard");
    expect(p["amnezia-wg-option"]).toBeUndefined();
  });

  it("uses a #_Name / # Name comment for the node name when present", () => {
    const named = AWG_CONF.replace("[Peer]", "#_Name = Berlin\n[Peer]");
    expect(parseWireguardConf(named).name).toBe("Berlin");
  });

  it("throws on a non-wireguard blob", () => {
    expect(() => parseWireguardConf("not a conf")).toThrow();
  });
});
```

- [ ] **Step 2:** Run `pnpm -F @submerge/server test -- wireguard.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/server/src/modules/sources/wireguard.ts`:

```ts
// AmneziaWG / WireGuard .conf (INI) → mihomo `wireguard` proxy (+ amnezia-wg-option).
// mihomo has no separate amneziawg type: AmneziaWG = wireguard + the obfuscation block.
import type { Proxy as ProxyConfig } from "@submerge/shared";

// Parse a WireGuard INI into { section → { key(lower) → rawValue } } plus the raw text
// (for the #_Name comment, which INI parsing drops).
function iniSections(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith(";")) continue;
    const m = s.match(/^\[(.+)\]$/);
    if (m) {
      section = (m[1] as string).toLowerCase();
      out[section] ??= {};
      continue;
    }
    const eq = s.indexOf("=");
    if (eq < 0 || !section) continue;
    const key = s.slice(0, eq).trim().toLowerCase();
    (out[section] ??= {})[key] = s.slice(eq + 1).trim();
  }
  return out;
}

const AWG_KEYS = ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4"] as const;

export function parseWireguardConf(text: string): ProxyConfig {
  const ini = iniSections(text);
  const iface = ini.interface;
  const peer = ini.peer;
  if (!iface?.privatekey || !peer?.endpoint) throw new Error("not a WireGuard .conf");

  const [host, portRaw] = splitEndpoint(peer.endpoint);
  const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const nameComment = text.match(/^\s*#\s*_?Name\s*=\s*(.+)$/im)?.[1]?.trim();
  const hasAwg = AWG_KEYS.some((k) => iface[k] != null);

  const p: Record<string, unknown> = {
    name: nameComment || `${hasAwg ? "AmneziaWG" : "WireGuard"} ${host}`,
    type: "wireguard",
    server: host,
    port: Number(portRaw) || 51820,
    "private-key": iface.privatekey,
    "public-key": peer.publickey,
    udp: true,
  };
  const ip = iface.address ? (iface.address.split(",")[0] as string).trim().split("/")[0] : undefined;
  if (ip) p.ip = ip;
  if (peer.presharedkey) p["pre-shared-key"] = peer.presharedkey;
  const allowed = list(peer.allowedips);
  if (allowed) p["allowed-ips"] = allowed;
  const dns = list(iface.dns);
  if (dns) p.dns = dns;
  if (iface.mtu) p.mtu = Number(iface.mtu);
  if (peer.persistentkeepalive) p["persistent-keepalive"] = Number(peer.persistentkeepalive);

  if (hasAwg) {
    const awg: Record<string, number> = {};
    for (const k of AWG_KEYS) if (iface[k] != null) awg[k] = Number(iface[k]);
    p["amnezia-wg-option"] = awg;
  }
  return p as ProxyConfig;
}

// "194.41.113.64:443" / "[2001:db8::1]:443" / "host.example:443" → [host, port].
function splitEndpoint(ep: string): [string, string] {
  const v6 = ep.match(/^\[(.+)\]:(\d+)$/);
  if (v6) return [v6[1] as string, v6[2] as string];
  const i = ep.lastIndexOf(":");
  return i < 0 ? [ep, ""] : [ep.slice(0, i), ep.slice(i + 1)];
}
```

- [ ] **Step 4:** Run the test → PASS. Then `./node_modules/.bin/biome ci packages/server && pnpm -F @submerge/server typecheck`.

- [ ] **Step 5: Commit**
```
git add packages/server/src/modules/sources/wireguard.ts packages/server/src/modules/sources/wireguard.test.ts
git commit -m "feat(sources): parse WireGuard/AmneziaWG .conf into a mihomo wireguard proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: kinds + detectKind + ingest routing + web hint/label

**Files:** `packages/shared/src/schemas.ts`, `parse.ts`, `ingest.ts`, `packages/web/src/features/sources/detectKind.ts`, `SourceRow.tsx`, tests `parse.test.ts`.

- [ ] **Step 1: Schema.** In `schemas.ts`, extend `sourceKindSchema` to include `"wireguard"` and `"amneziawg"` (append both literals). Extend `nodeItemSchema.security` enum to `["reality", "tls", "none", "amneziawg"]`.

- [ ] **Step 2: Failing tests** (`parse.test.ts`):
```ts
describe("detectKind wireguard", () => {
  const conf = "[Interface]\nPrivateKey = x\nJc = 7\n[Peer]\nEndpoint = h:443\n";
  it("detects an AmneziaWG .conf (has AWG params) as amneziawg", () => {
    expect(detectKind(conf)).toBe("amneziawg");
  });
  it("detects a plain WireGuard .conf as wireguard", () => {
    expect(detectKind("[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = h:443\n")).toBe("wireguard");
  });
});
```

- [ ] **Step 3: detectKind branch.** In `parse.ts` `detectKind`, before the base64 fallback, add:
```ts
  if (/^\s*\[Interface\]/m.test(v) && /(^|\n)\s*PrivateKey\s*=/i.test(v)) {
    return /^\s*(Jc|Jmin|Jmax|S1|S2|H1|H2|H3|H4)\s*=/im.test(v) ? "amneziawg" : "wireguard";
  }
```
Also handle the `vpn://` scheme: add `"vpn:"` recognition (single-link-ish) that routes to the WG decoder in ingest — but since decode is Task 3, for THIS task make `detectKind` return `"amneziawg"` for `vpn://` (Amnezia configs are AWG) and let Task 3 implement the decode. Add near the single-link detection:
```ts
  if (scheme === "vpn:") return "amneziawg";
```
(`scheme` is already computed via `schemeOf` in detectKind.)

- [ ] **Step 4: ingest routing.** In `ingest.ts`, import `parseWireguardConf` from `./wireguard.js` (and later `decodeAmneziaVpnLink`). Add a branch in `ingestSource` for the WG kinds:
```ts
  if (kind === "wireguard" || kind === "amneziawg") {
    const proxy = value.trim().startsWith("vpn://")
      ? parseAmneziaVpnLink(value) // Task 3
      : parseWireguardConf(value);
    return { kind, label: proxy.name, proxies: [proxy], meta: null, skipped: [] };
  }
```
For THIS task, `vpn://` isn't decoded yet — guard it: if it starts with `vpn://`, `throw new Error("vpn:// decoding lands in the next step")` (temporary; replaced in Task 3). The `.conf` path is fully working here.

- [ ] **Step 5: web hint + label.** In `detectKind.ts` (web), add to `KindHint`, `SINGLE_LINK_HINT`-adjacent logic, and `KIND_LABEL`: recognize a `.conf` (`/^\s*\[Interface\]/m` + `PrivateKey`) → `"amneziawg"`/`"wireguard"` by AWG params, and `vpn://` → `"amneziawg"`. Labels: `wireguard: "WireGuard"`, `amneziawg: "AmneziaWG"`. Mirror in `SourceRow.tsx` `KIND_SHORT`: `wireguard: "WireGuard"`, `amneziawg: "AmneziaWG"`.

- [ ] **Step 6:** Gates (`./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`) green. Add a web `detectKind.test.ts` case for the `.conf` → amneziawg/wireguard hint.

- [ ] **Step 7: Commit** `feat(sources): wireguard/amneziawg source kinds + .conf ingest + web labels`.

---

## Task 3: `vpn://` decode (config_version 1 → .conf; v2 → clear error)

**Files:** `wireguard.ts` (+ `decodeAmneziaVpnLink`, `parseAmneziaVpnLink`), `ingest.ts` (swap the temporary throw), tests `wireguard.test.ts`.

- [ ] **Step 1: Failing tests.** Use the real v2 fixture (must be recognized as v2 and rejected with a clear message) and a synthetic v1 (a qCompress blob whose JSON embeds a WG `.conf` string):
```ts
import { deflateSync } from "node:zlib";
function makeVpnLink(obj: unknown): string {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const body = deflateSync(json);
  const head = Buffer.alloc(4); head.writeUInt32BE(json.length, 0);
  return "vpn://" + Buffer.concat([head, body]).toString("base64url");
}

describe("decodeAmneziaVpnLink / parseAmneziaVpnLink", () => {
  it("config_version 1 with an embedded WG .conf maps to a wireguard proxy", () => {
    const conf = "[Interface]\nPrivateKey = k\nJc = 7\n[Peer]\nPublicKey = pk\nEndpoint = 1.2.3.4:443\n";
    const link = makeVpnLink({ config_version: 1, containers: [{ container: "amnezia-awg", awg: { last_config: conf } }] });
    const p = parseAmneziaVpnLink(link) as Record<string, unknown>;
    expect(p.type).toBe("wireguard");
    expect(p.server).toBe("1.2.3.4");
    expect(p["amnezia-wg-option"]).toBeDefined();
  });
  it("config_version 2 (hosted 'amnezia-free') is rejected with a clear message", () => {
    const link = makeVpnLink({ config_version: 2, api_config: { service_protocol: "awg" }, auth_data: { api_key: "x" } });
    expect(() => parseAmneziaVpnLink(link)).toThrow(/hosted|not yet|Free|API/i);
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** in `wireguard.ts`:
```ts
import { inflateSync } from "node:zlib";

// vpn:// → JSON. base64url (padded) → 4-byte big-endian length prefix (Qt qCompress)
// → zlib inflate → JSON.
export function decodeAmneziaVpnLink(uri: string): Record<string, unknown> {
  const b64 = uri.trim().replace(/^vpn:\/\//i, "");
  const buf = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64url");
  const json = inflateSync(buf.subarray(4)).toString("utf8");
  return JSON.parse(json);
}

// Find the first embedded WireGuard .conf string anywhere in the decoded JSON.
function findEmbeddedConf(obj: unknown): string | null {
  if (typeof obj === "string") return /\[Interface\]/.test(obj) && /PrivateKey/i.test(obj) ? obj : null;
  if (Array.isArray(obj)) { for (const v of obj) { const r = findEmbeddedConf(v); if (r) return r; } return null; }
  if (obj && typeof obj === "object") { for (const v of Object.values(obj)) { const r = findEmbeddedConf(v); if (r) return r; } }
  return null;
}

export function parseAmneziaVpnLink(uri: string): ProxyConfig {
  const cfg = decodeAmneziaVpnLink(uri);
  const version = cfg.config_version;
  if (version === 2 || (cfg as { api_config?: unknown }).api_config) {
    throw new Error(
      "hosted Amnezia (Free/Premium) config needs the gateway API — not yet supported (planned in Phase B2)",
    );
  }
  const conf = findEmbeddedConf(cfg);
  if (!conf) throw new Error("could not find a WireGuard config inside the vpn:// blob");
  const proxy = parseWireguardConf(conf) as Record<string, unknown>;
  // Prefer the container's display name if the .conf had none.
  const name = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : undefined;
  if (name && /^(AmneziaWG|WireGuard) /.test(proxy.name as string)) proxy.name = name;
  return proxy as ProxyConfig;
}
```

- [ ] **Step 4:** In `ingest.ts`, replace the Task-2 temporary `vpn://` throw with `parseAmneziaVpnLink(value)` (import it). Run the test → PASS.

- [ ] **Step 5:** Gates green.

- [ ] **Step 6: Commit** `feat(sources): decode Amnezia vpn:// v1 to a wireguard proxy (v2 hosted rejected)`.

> Calibration note: the exact v1 container key path (`containers[].awg.last_config`) is
> inferred; `findEmbeddedConf` deep-searches for the `[Interface]` .conf string so the
> mapping is robust to the precise key. Verify against a real v1 `vpn://` when available.

---

## Task 4: badge — WireGuard→UDP + AmneziaWG variant

**Files:** `packages/server/src/modules/nodes/service.ts` (`proxyMeta`), `packages/web/src/features/nodes/nodeView.ts`, web test.

- [ ] **Step 1: Server — surface the AmneziaWG variant.** In `service.ts` `proxyMeta`, when a stored proxy carries `amnezia-wg-option`, set `security: "amneziawg"`:
```ts
    const security = p["amnezia-wg-option"]
      ? "amneziawg"
      : p["reality-opts"]
        ? "reality"
        : p.tls === true
          ? "tls"
          : "none";
```
(`ProxyMeta.security` type widens to include `"amneziawg"` — update the interface.)

- [ ] **Step 2: Web — failing tests** (`nodeView.test.ts`), then implement:
```ts
    expect(transportBadge({ ...node("x"), type: "wireguard" })).toBe("UDP");
    expect(securityBadge({ ...node("x"), security: "amneziawg" })).toBe("AmneziaWG");
    expect(typeBadges({ ...node("x"), type: "wireguard", security: "amneziawg" })).toEqual(["WIREGUARD", "UDP", "AmneziaWG"]);
```

- [ ] **Step 3: Implement** in `nodeView.ts`:
```ts
// QUIC-family proxy types have no tcp/tls transport — their transport is QUIC.
const QUIC_TYPES = new Set(["hysteria", "hysteria2", "tuic"]);

export function transportBadge(node: NodeItem): string | null {
  if (node.network) return node.network.toUpperCase();
  if (node.type?.toLowerCase() === "wireguard") return "UDP"; // WG/AmneziaWG are UDP
  if (node.type && QUIC_TYPES.has(node.type.toLowerCase())) return "QUIC";
  if (node.security) return "TCP";
  return null;
}

export function securityBadge(node: NodeItem): string | null {
  if (node.security === "reality") return "Reality";
  if (node.security === "tls") return "TLS";
  if (node.security === "amneziawg") return "AmneziaWG";
  return null;
}
```
(`securityBadge` "none"/undefined still returns null.)

- [ ] **Step 4:** Gates green. **Step 5: Commit** `feat(web): WireGuard→UDP badge + AmneziaWG variant`.

---

## Task 5: final review + local verify

- [ ] **Step 1:** Full gates `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` green.
- [ ] **Step 2:** Dispatch an adversarial reviewer over `git diff master...HEAD` (mapper correctness, decode-blob safety on malformed input, badge).
- [ ] **Step 3:** Fix any findings.
- [ ] **Step 4:** Local e2e — rebuild the docker image, `docker compose up -d`, paste the real AmneziaWG `.conf` in the UI, confirm the node appears as `WIREGUARD · UDP · AmneziaWG` and mihomo loads it. (User verifies.)
- [ ] **Step 5:** Stop for user sign-off before push (repo deploys on push).

## Notes
- `buildConfig` writes proxies untyped → a `wireguard` proxy flows through unchanged; no config-gen change.
- Engine caveats (spec): WG unusable in `relay` (we don't use it); verify multiple WG nodes coexist (mihomo #2338) at e2e.
- B2 (hosted `vpn://` v2) is a separate later spike — this plan only rejects it with a clear message.
