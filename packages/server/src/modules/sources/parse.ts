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
  if (v.startsWith("vless://")) return "vless";
  if (/^happ:\/\/crypt/i.test(v)) return "happ"; // encrypted happ → decoder
  if (/^(vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//i.test(v))
    throw new Error(
      "single nodes are only supported for vless:// (use a subscription for the rest)",
    );
  if (extractSubUrl(v)) return "sub"; // url or client deep-link (incy/clash/sing-box/happ-add/…)
  if (/^happ:\/\//i.test(v)) return "happ"; // happ:// without an embedded url → decoder
  try {
    const d = Buffer.from(v.replace(/\s+/g, ""), "base64").toString("utf8");
    if (d.includes("://")) return "sub"; // base64 subscription content pasted directly
  } catch {
    /* base64 decode never throws in Node; the :// check above filters non-subscription input */
  }
  throw new Error(
    "could not detect kind: expected vless:// , happ:// , a subscription URL, or a client deep-link",
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

// ── v2ray/xray JSON outbound → mihomo proxy (best-effort, Happ format) ──
// biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
function v2rayOutboundToMihomo(ob: any, remark?: string): ProxyConfig | null {
  if (ob?.protocol !== "vless") return null; // freedom/blackhole/direct skipped
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

// ── sing-box outbound → mihomo proxy (type/server/server_port) ──────
// biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
function singBoxOutboundToMihomo(ob: any): ProxyConfig | null {
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

// ── Parse subscription body text into mihomo proxies ────────────────
export function parseProxiesFromText(text: string): ProxyConfig[] {
  // 1) clash/mihomo yaml
  // JSON parses as YAML but lacks .proxies, so it falls through to the JSON branch
  try {
    const doc = yaml.load(text) as { proxies?: unknown[] } | undefined;
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length)
      return doc.proxies as ProxyConfig[];
  } catch {
    /* not yaml */
  }

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
        }
      if (out.length) return out;
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
    if (!s.startsWith("vless://")) continue;
    try {
      out.push(parseVless(s));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
