// Ingest layer: parse node sources (ported from combine/parse.js).
//  - vless:// (ws+tls / tcp+reality / grpc / xhttp / http)
//  - subscriptions: clash/mihomo yaml | base64 list | v2ray/xray JSON | sing-box JSON
//  - happ:// is handled separately via the happ-decoder client (see ingest.ts)
import type { Proxy as ProxyConfig } from "@submerge/shared";
import { type SourceKind, sourceKindSchema } from "@submerge/shared";
import * as yaml from "js-yaml";

// ── Extract a subscription URL from a client deep-link ──────────────
// Covers scheme://action?url=<encoded> (clash/sing-box/v2rayng) and
// scheme://action/<plain-url> (incy/happ-add/streisand/hiddify).
export function extractSubUrl(value: string): string | null {
  const v = (value || "").trim();
  if (/^https?:\/\//i.test(v)) return v; // already a url
  try {
    const u = new URL(v);
    const q = u.searchParams.get("url") || u.searchParams.get("link");
    if (q && /^https?:\/\//i.test(q)) return q; // ?url=<encoded>
  } catch {
    /* not a URL */
  }
  const m = v.match(/https?:\/\/[^\s"'<>]+/i); // http(s) somewhere in the string
  if (m) {
    try {
      return decodeURIComponent(m[0]);
    } catch {
      return m[0];
    }
  }
  return null;
}

// ── Auto-detect the source kind ─────────────────────────────────────
export function detectKind(value: string): SourceKind {
  const v = (value || "").trim();
  if (!v) throw new Error("empty string");
  const scheme = schemeOf(v);
  if (scheme && SINGLE_LINK[scheme]) return SINGLE_LINK[scheme].kind; // supported single link
  if (/^happ:\/\/crypt/i.test(v)) return "happ"; // encrypted happ → decoder
  if (scheme && UNSUPPORTED_SINGLE.has(scheme))
    throw new Error(
      `single ${scheme.slice(0, -1)} links aren't supported yet — use a subscription instead`,
    );
  if (extractSubUrl(v)) return "sub"; // url or client deep-link
  if (/^happ:\/\//i.test(v)) return "happ"; // happ:// without an embedded url → decoder
  try {
    const d = Buffer.from(v.replace(/\s+/g, ""), "base64").toString("utf8");
    if (d.includes("://")) return "sub"; // base64 subscription pasted directly
  } catch {
    /* base64 decode never throws in Node; the :// check filters non-subscription input */
  }
  throw new Error(
    "could not detect kind: expected a single-node link, happ:// , a subscription URL, or a client deep-link",
  );
}

// Asserts the detected kind is a valid SourceKind via the shared schema.
export function detectKindSafe(value: string): SourceKind {
  return sourceKindSchema.parse(detectKind(value));
}

// ── vless:// → mihomo proxy ─────────────────────────────────────────
export function parseVless(uri: string): ProxyConfig {
  const u = new URL(uri.trim());
  if (u.protocol !== "vless:") throw new Error("not a vless:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443; // port 0 → 443; no VPN provider uses port 0
  const uuid = decodeURIComponent(u.username);
  if (!uuid) throw new Error("could not parse the UUID");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;

  const security = q.get("security") || "none";
  const net = q.get("type") || "tcp";
  const sni = q.get("sni") || q.get("host") || server;
  const fp = q.get("fp") || "chrome";
  const flow = q.get("flow") || "";
  const host = q.get("host") || "";
  const path = q.get("path") ? decodeURIComponent(q.get("path") as string) : "/";

  const p: Record<string, unknown> = {
    name,
    type: "vless",
    server,
    port,
    uuid,
    udp: true,
    "client-fingerprint": fp,
    network: net === "h2" ? "http" : net,
  };
  if (flow) p.flow = flow;
  if (security === "tls" || security === "reality") {
    p.tls = true;
    p.servername = sni;
    if (security === "reality")
      p["reality-opts"] = { "public-key": q.get("pbk") || "", "short-id": q.get("sid") || "" };
  }
  if (net === "ws") p["ws-opts"] = { path, headers: { Host: host || sni } };
  else if (net === "grpc")
    p["grpc-opts"] = { "grpc-service-name": q.get("serviceName") || path.replace(/^\//, "") };
  else if (net === "http" || net === "h2") p["h2-opts"] = { path, host: host ? [host] : [sni] };
  else if (net === "xhttp")
    p["xhttp-opts"] = { path, host: host || sni, mode: q.get("mode") || "auto" };
  return p as ProxyConfig;
}

// ── hysteria2:// (and hy2://) → mihomo proxy ────────────────────────
export function parseHysteria2(uri: string): ProxyConfig {
  const raw = uri.trim();
  // Port hopping "host:port,<ranges>" — URL() rejects the comma, so pull ranges out first.
  let ports: string | undefined;
  const cleaned = raw.replace(/(:\d+),([\d,-]+)/, (_m, port: string, ranges: string) => {
    ports = ranges;
    return port;
  });
  const u = new URL(cleaned);
  if (u.protocol !== "hysteria2:" && u.protocol !== "hy2:")
    throw new Error("not a hysteria2:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const password = decodeURIComponent(u.password || u.username || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const p: Record<string, unknown> = { name, type: "hysteria2", server, port, password, udp: true };
  const sni = q.get("sni");
  if (sni) p.sni = sni;
  if (q.get("insecure") === "1") p["skip-cert-verify"] = true;
  const obfs = q.get("obfs");
  if (obfs) {
    p.obfs = obfs;
    const op = q.get("obfs-password");
    if (op) p["obfs-password"] = op;
  }
  if (ports) p.ports = ports;
  return p as ProxyConfig;
}

// ── trojan:// → mihomo proxy ────────────────────────────────────────
export function parseTrojan(uri: string): ProxyConfig {
  const u = new URL(uri.trim());
  if (u.protocol !== "trojan:") throw new Error("not a trojan:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const password = decodeURIComponent(u.username || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const net = q.get("type") || "tcp";
  const p: Record<string, unknown> = {
    name,
    type: "trojan",
    server,
    port,
    password,
    udp: true,
    network: net === "h2" ? "http" : net,
  };
  const sni = q.get("sni") || q.get("host");
  if (sni) p.sni = sni;
  if (q.get("allowInsecure") === "1") p["skip-cert-verify"] = true;
  const fp = q.get("fp");
  if (fp) p["client-fingerprint"] = fp;
  if (net === "ws")
    p["ws-opts"] = {
      path: q.get("path") ? decodeURIComponent(q.get("path") as string) : "/",
      headers: { Host: q.get("host") || sni || server },
    };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": q.get("serviceName") || "" };
  return p as ProxyConfig;
}

// ── vmess:// (base64 v2rayN JSON) → mihomo proxy ────────────────────
export function parseVmess(uri: string): ProxyConfig {
  const b64 = uri.trim().replace(/^vmess:\/\//i, "");
  let conf: Record<string, unknown>;
  try {
    conf = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("could not parse the vmess:// payload");
  }
  const str = (k: string) => (conf[k] == null ? "" : String(conf[k]));
  const server = str("add");
  const port = Number(str("port")) || 443;
  const net = str("net") || "tcp";
  const p: Record<string, unknown> = {
    name: str("ps") || `${server}:${port}`,
    type: "vmess",
    server,
    port,
    uuid: str("id"),
    alterId: Number(str("aid")) || 0,
    cipher: "auto",
    udp: true,
    network: net === "h2" ? "http" : net,
  };
  if (str("tls") === "tls") {
    p.tls = true;
    p.servername = str("sni") || str("host") || server;
  }
  const host = str("host");
  const path = str("path") || "/";
  if (net === "ws") p["ws-opts"] = { path, headers: { Host: host || str("sni") || server } };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": path.replace(/^\//, "") };
  return p as ProxyConfig;
}

// ── ss:// (SIP002, with legacy fallback) → mihomo proxy ─────────────
export function parseShadowsocks(uri: string): ProxyConfig {
  const raw = uri.trim();
  const hash = raw.indexOf("#");
  const name = hash >= 0 ? decodeURIComponent(raw.slice(hash + 1)) : "";
  const body = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/^ss:\/\//i, "");
  let cipher: string;
  let password: string;
  let server: string;
  let port: number;
  const at = body.lastIndexOf("@");
  if (at >= 0) {
    const decoded = Buffer.from(body.slice(0, at), "base64url").toString("utf8");
    const c = decoded.indexOf(":");
    cipher = decoded.slice(0, c);
    password = decoded.slice(c + 1);
    const hostPort = body.slice(at + 1);
    const cp = hostPort.lastIndexOf(":");
    server = hostPort.slice(0, cp);
    port = Number(hostPort.slice(cp + 1)) || 8388;
  } else {
    const dec = Buffer.from(body, "base64").toString("utf8");
    const m = dec.match(/^(.*?):(.*)@(.*):(\d+)$/);
    if (!m) throw new Error("could not parse the ss:// payload");
    cipher = m[1] as string;
    password = m[2] as string;
    server = m[3] as string;
    port = Number(m[4]);
  }
  return {
    name: name || `${server}:${port}`,
    type: "ss",
    server,
    port,
    cipher,
    password,
    udp: true,
  } as ProxyConfig;
}

// ── tuic:// → mihomo proxy ──────────────────────────────────────────
export function parseTuic(uri: string): ProxyConfig {
  const u = new URL(uri.trim());
  if (u.protocol !== "tuic:") throw new Error("not a tuic:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const p: Record<string, unknown> = {
    name,
    type: "tuic",
    server,
    port,
    uuid: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    udp: true,
  };
  const sni = q.get("sni");
  if (sni) p.sni = sni;
  const alpn = q.get("alpn");
  if (alpn) p.alpn = alpn.split(",");
  const cc = q.get("congestion_control");
  if (cc) p["congestion-controller"] = cc;
  if (q.get("allow_insecure") === "1") p["skip-cert-verify"] = true;
  return p as ProxyConfig;
}

// Return the URL scheme with its colon ("vless:") for a scheme://… string, else null.
function schemeOf(value: string): string | null {
  const m = value.match(/^([a-z][a-z0-9.+-]*):\/\//i);
  return m ? `${(m[1] as string).toLowerCase()}:` : null;
}

// Single-node link schemes we can parse → { source kind stored, parser }. The kind
// IS the protocol (personalized). Grows one entry per protocol slice.
const SINGLE_LINK: Record<string, { kind: SourceKind; parse: (uri: string) => ProxyConfig }> = {
  "vless:": { kind: "vless", parse: parseVless },
  "hysteria2:": { kind: "hysteria2", parse: parseHysteria2 },
  "hy2:": { kind: "hysteria2", parse: parseHysteria2 },
  "trojan:": { kind: "trojan", parse: parseTrojan },
  "vmess:": { kind: "vmess", parse: parseVmess },
  "ss:": { kind: "ss", parse: parseShadowsocks },
  "tuic:": { kind: "tuic", parse: parseTuic },
};

// Single-node schemes we recognize but don't support yet (ssr never). Shrinks as
// slices move a scheme into SINGLE_LINK. Kept only for a helpful detectKind error.
const UNSUPPORTED_SINGLE = new Set(["ssr:", "hysteria:"]);

// Dispatch a single-node link to its protocol parser.
export function parseSingleLink(uri: string): ProxyConfig {
  const scheme = schemeOf(uri.trim());
  const entry = scheme ? SINGLE_LINK[scheme] : undefined;
  if (!entry) throw new Error(`unsupported single-node link: ${scheme ?? uri.slice(0, 12)}`);
  return entry.parse(uri);
}

// ── v2ray/xray JSON outbound → mihomo proxy (best-effort, Happ format) ──
// biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
function v2rayOutboundToMihomo(ob: any, remark?: string): ProxyConfig | null {
  if (ob?.protocol === "vless") {
    const vnext = ob.settings?.vnext?.[0];
    const user = vnext?.users?.[0];
    if (!vnext || !user) return null;
    const ss = ob.streamSettings || {};
    const net = ss.network || "tcp";
    const p: Record<string, unknown> = {
      name: remark || ob.tag || `${vnext.address}:${vnext.port}`,
      type: "vless",
      server: vnext.address,
      port: Number(vnext.port),
      uuid: user.id,
      udp: true,
      network: net === "h2" ? "http" : net,
    };
    if (user.flow) p.flow = user.flow;
    const sec = ss.security || "none";
    if (sec === "tls" || sec === "reality") {
      p.tls = true;
      const t = ss.tlsSettings || ss.realitySettings || {};
      p.servername = t.serverName || vnext.address;
      if (t.fingerprint) p["client-fingerprint"] = t.fingerprint;
      if (sec === "reality") {
        const r = ss.realitySettings || {};
        p["reality-opts"] = { "public-key": r.publicKey || "", "short-id": r.shortId || "" };
      }
    }
    if (net === "ws")
      p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
    else if (net === "grpc")
      p["grpc-opts"] = { "grpc-service-name": ss.grpcSettings?.serviceName || "" };
    return p as ProxyConfig;
  }
  if (ob?.protocol === "trojan") {
    const s = ob.settings?.servers?.[0];
    if (!s) return null;
    const ss = ob.streamSettings || {};
    const net = ss.network || "tcp";
    const p: Record<string, unknown> = {
      name: remark || ob.tag || `${s.address}:${s.port}`,
      type: "trojan",
      server: s.address,
      port: Number(s.port),
      password: s.password,
      udp: true,
      network: net === "h2" ? "http" : net,
    };
    const t = ss.tlsSettings || {};
    if (t.serverName) p.sni = t.serverName;
    if (t.fingerprint) p["client-fingerprint"] = t.fingerprint;
    if (net === "ws")
      p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
    return p as ProxyConfig;
  }
  if (ob?.protocol === "vmess") {
    const vnext = ob.settings?.vnext?.[0];
    const user = vnext?.users?.[0];
    if (!vnext || !user) return null;
    const ss = ob.streamSettings || {};
    const net = ss.network || "tcp";
    const p: Record<string, unknown> = {
      name: remark || ob.tag || `${vnext.address}:${vnext.port}`,
      type: "vmess",
      server: vnext.address,
      port: Number(vnext.port),
      uuid: user.id,
      alterId: user.alterId ?? 0,
      cipher: user.security || "auto",
      udp: true,
      network: net === "h2" ? "http" : net,
    };
    if ((ss.security || "none") === "tls") {
      p.tls = true;
      const t = ss.tlsSettings || {};
      p.servername = t.serverName || vnext.address;
    }
    if (net === "ws")
      p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
    return p as ProxyConfig;
  }
  return null; // freedom/blackhole/direct skipped
}

// ── sing-box outbound → mihomo proxy (type/server/server_port) ──────
// biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
function singBoxOutboundToMihomo(ob: any): ProxyConfig | null {
  if (ob?.type === "hysteria2" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "hysteria2",
      server: ob.server,
      port: Number(ob.server_port),
      password: ob.password,
      udp: true,
    };
    if (ob.obfs?.type) {
      p.obfs = ob.obfs.type;
      if (ob.obfs.password) p["obfs-password"] = ob.obfs.password;
    }
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.tls?.insecure) p["skip-cert-verify"] = true;
    return p as ProxyConfig;
  }
  if (ob?.type === "trojan" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "trojan",
      server: ob.server,
      port: Number(ob.server_port),
      password: ob.password,
      udp: true,
    };
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.tls?.insecure) p["skip-cert-verify"] = true;
    return p as ProxyConfig;
  }
  if (ob?.type === "vmess" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "vmess",
      server: ob.server,
      port: Number(ob.server_port),
      uuid: ob.uuid,
      alterId: ob.alter_id ?? 0,
      cipher: ob.security || "auto",
      udp: true,
    };
    if (ob.tls?.enabled) {
      p.tls = true;
      p.servername = ob.tls.server_name || ob.server;
    }
    return p as ProxyConfig;
  }
  if (ob?.type === "shadowsocks" && ob.server) {
    return {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "ss",
      server: ob.server,
      port: Number(ob.server_port),
      cipher: ob.method,
      password: ob.password,
      udp: true,
    } as ProxyConfig;
  }
  if (ob?.type === "tuic" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "tuic",
      server: ob.server,
      port: Number(ob.server_port),
      uuid: ob.uuid,
      password: ob.password,
      udp: true,
    };
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.congestion_control) p["congestion-controller"] = ob.congestion_control;
    return p as ProxyConfig;
  }
  if (ob?.type !== "vless" || !ob.server) return null;
  const net = ob.transport?.type || "tcp";
  const p: Record<string, unknown> = {
    name: ob.tag || `${ob.server}:${ob.server_port}`,
    type: "vless",
    server: ob.server,
    port: Number(ob.server_port),
    uuid: ob.uuid,
    udp: true,
    network: net,
  };
  if (ob.flow) p.flow = ob.flow;
  const tls = ob.tls;
  if (tls?.enabled) {
    p.tls = true;
    p.servername = tls.server_name || ob.server;
    if (tls.utls?.fingerprint) p["client-fingerprint"] = tls.utls.fingerprint;
    if (tls.reality?.enabled)
      p["reality-opts"] = {
        "public-key": tls.reality.public_key || "",
        "short-id": tls.reality.short_id || "",
      };
  }
  if (net === "ws")
    p["ws-opts"] = { path: ob.transport?.path || "/", headers: ob.transport?.headers || {} };
  else if (net === "grpc")
    p["grpc-opts"] = { "grpc-service-name": ob.transport?.service_name || "" };
  return p as ProxyConfig;
}

export interface ParsedProxies {
  proxies: ProxyConfig[];
  skipped: string[]; // deduped unsupported protocol/scheme names (e.g. ["ssr"])
}

// ── Parse subscription body text into mihomo proxies ────────────────
export function parseProxiesFromText(text: string): ParsedProxies {
  // 1) clash/mihomo yaml
  // JSON parses as YAML but lacks .proxies, so it falls through to the JSON branch
  try {
    const doc = yaml.load(text) as { proxies?: unknown[] } | undefined;
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length)
      return { proxies: doc.proxies as ProxyConfig[], skipped: [] };
  } catch {
    /* not yaml */
  }

  const skipped = new Set<string>();

  // 2) v2ray/xray JSON (array of profiles with outbounds, or {outbounds:[…]})
  try {
    const j = JSON.parse(text);
    // biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
    const profiles: any[] | null = Array.isArray(j) ? j : j.outbounds ? [j] : null;
    if (profiles) {
      const out: ProxyConfig[] = [];
      for (const prof of profiles)
        for (const ob of prof.outbounds || []) {
          const p = v2rayOutboundToMihomo(ob, prof.remarks) || singBoxOutboundToMihomo(ob);
          if (p) out.push(p);
          else {
            const t = ob?.protocol || ob?.type;
            if (t && !["freedom", "blackhole", "direct", "dns", "block"].includes(t))
              skipped.add(String(t));
          }
        }
      if (out.length || skipped.size) return { proxies: out, skipped: [...skipped] };
    }
  } catch {
    /* not json */
  }

  // 3) base64 list or plain list of links
  let decoded = text;
  try {
    const b = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
    if (b.includes("://")) decoded = b;
  } catch {
    /* base64 decode never throws in Node; the :// check above filters non-subscription input */
  }
  const out: ProxyConfig[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const s = line.trim();
    const scheme = schemeOf(s);
    if (!scheme) continue;
    if (SINGLE_LINK[scheme]) {
      try {
        out.push(SINGLE_LINK[scheme].parse(s));
      } catch {
        /* skip malformed line */
      }
    } else {
      skipped.add(scheme.slice(0, -1)); // "ssr:" → "ssr"
    }
  }
  return { proxies: out, skipped: [...skipped] };
}
