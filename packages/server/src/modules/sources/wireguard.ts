// AmneziaWG / WireGuard .conf (INI) → mihomo `wireguard` proxy (+ amnezia-wg-option).
// mihomo has no separate amneziawg type: AmneziaWG = wireguard + the obfuscation block.
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

const AWG_KEYS = ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4"] as const;

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
  const ip = iface.address
    ? (iface.address.split(",")[0] as string).trim().split("/")[0]
    : undefined;
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
