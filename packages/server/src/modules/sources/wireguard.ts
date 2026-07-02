// AmneziaWG / WireGuard .conf (INI) → mihomo `wireguard` proxy (+ amnezia-wg-option).
// mihomo has no separate amneziawg type: AmneziaWG = wireguard + the obfuscation block.
import { inflateSync } from "node:zlib";
import type { Proxy as ProxyConfig } from "@submerge/shared";

// Parse a WireGuard INI into { section(lower) → { key(lower) → rawValue } }. Comments
// (#, ;) are skipped here; the #_Name comment is read separately from the raw text.
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
    out[section] ??= {};
    const bucket = out[section] as Record<string, string>;
    const key = s.slice(0, eq).trim().toLowerCase();
    bucket[key] = s.slice(eq + 1).trim();
  }
  return out;
}

// AmneziaWG obfuscation params mihomo accepts. Numeric vs string (i*/j* are
// junk-packet DSL strings, not numbers — Number() would give NaN).
const AWG_NUM_KEYS = [
  "jc",
  "jmin",
  "jmax",
  "s1",
  "s2",
  "s3",
  "s4",
  "h1",
  "h2",
  "h3",
  "h4",
  "itime",
] as const;
const AWG_STR_KEYS = ["i1", "i2", "i3", "i4", "i5", "j1", "j2", "j3"] as const;

export function parseWireguardConf(text: string): ProxyConfig {
  const ini = iniSections(text);
  const iface = ini.interface;
  const peer = ini.peer;
  if (!iface?.privatekey || !peer?.endpoint) throw new Error("not a WireGuard .conf");

  const [host, portRaw] = splitEndpoint(peer.endpoint);
  const list = (v?: string) =>
    v
      ? v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const nameComment = text.match(/^\s*#\s*_?Name\s*=\s*(.+)$/im)?.[1]?.trim();

  const awg: Record<string, number | string> = {};
  for (const k of AWG_NUM_KEYS) {
    const n = Number(iface[k]);
    if (iface[k] != null && iface[k] !== "" && Number.isFinite(n)) awg[k] = n;
  }
  for (const k of AWG_STR_KEYS) {
    if (iface[k]) awg[k] = iface[k] as string;
  }
  const hasAwg = Object.keys(awg).length > 0;

  const p: Record<string, unknown> = {
    name: nameComment || `${hasAwg ? "AmneziaWG" : "WireGuard"} ${host}`,
    type: "wireguard",
    server: host,
    port: Number(portRaw) || 51820,
    "private-key": iface.privatekey,
    "public-key": peer.publickey,
    udp: true,
  };
  // Address may be v4, v6, or dual-stack ("10.8.2.2/32, fd00::2/128"); map each.
  if (iface.address) {
    for (const a of iface.address
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      const addr = (a.split("/")[0] as string).trim();
      if (addr.includes(":")) p.ipv6 ??= addr;
      else p.ip ??= addr;
    }
  }
  if (peer.presharedkey) p["pre-shared-key"] = peer.presharedkey;
  const allowed = list(peer.allowedips);
  if (allowed) p["allowed-ips"] = allowed;
  const dns = list(iface.dns);
  if (dns) p.dns = dns;
  if (iface.mtu) p.mtu = Number(iface.mtu);
  if (peer.persistentkeepalive) p["persistent-keepalive"] = Number(peer.persistentkeepalive);

  if (hasAwg) p["amnezia-wg-option"] = awg;
  return p as ProxyConfig;
}

// vpn:// → JSON. base64url (padded) → 4-byte big-endian length prefix (Qt qCompress)
// → zlib inflate → JSON.
export function decodeAmneziaVpnLink(uri: string): Record<string, unknown> {
  const b64 = uri.trim().replace(/^vpn:\/\//i, "");
  const buf = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64url");
  const json = inflateSync(buf.subarray(4)).toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

// Deep-search the decoded JSON for the first embedded WireGuard .conf string.
function findEmbeddedConf(obj: unknown): string | null {
  if (typeof obj === "string")
    return /\[Interface\]/.test(obj) && /PrivateKey/i.test(obj) ? obj : null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findEmbeddedConf(v);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) {
      const r = findEmbeddedConf(v);
      if (r) return r;
    }
  }
  return null;
}

// Amnezia vpn:// → mihomo wireguard proxy. config_version 1 (self-hosted) embeds a
// WireGuard .conf we reuse; config_version 2 (hosted Free/Premium) carries only an
// api_key + gateway pointer — unsupported until the Phase B2 API spike.
export function parseAmneziaVpnLink(uri: string): ProxyConfig {
  const cfg = decodeAmneziaVpnLink(uri);
  if (cfg.config_version === 2 || cfg.api_config) {
    throw new Error(
      "hosted Amnezia (Free/Premium) config needs the gateway API — not yet supported (planned in Phase B2)",
    );
  }
  const conf = findEmbeddedConf(cfg);
  if (!conf) throw new Error("could not find a WireGuard config inside the vpn:// blob");
  const proxy = parseWireguardConf(conf) as Record<string, unknown>;
  // Prefer the container's display name when the .conf had none (parser defaulted it).
  const name = typeof cfg.name === "string" ? cfg.name.trim() : "";
  if (name && /^(AmneziaWG|WireGuard) /.test(proxy.name as string)) proxy.name = name;
  return proxy as ProxyConfig;
}

// "194.41.113.64:443" / "[2001:db8::1]:443" / "host.example:443" → [host, port].
function splitEndpoint(ep: string): [string, string] {
  const v6 = ep.match(/^\[(.+)\]:(\d+)$/);
  if (v6) return [v6[1] as string, v6[2] as string];
  const i = ep.lastIndexOf(":");
  return i < 0 ? [ep, ""] : [ep.slice(0, i), ep.slice(i + 1)];
}
