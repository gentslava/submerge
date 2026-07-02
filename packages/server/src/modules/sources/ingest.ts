import type { Proxy as ProxyConfig, SourceKind, SubscriptionMeta } from "@submerge/shared";
import { decodeHapp } from "../../clients/happDecoder.js";
import { detectKind, extractSubUrl, parseProxiesFromText, parseSingleLink } from "./parse.js";
import { parseAmneziaVpnLink, parseWireguardConf } from "./wireguard.js";

export interface IngestResult {
  kind: SourceKind;
  label: string;
  proxies: ProxyConfig[];
  meta: SubscriptionMeta | null;
  skipped: string[];
}

// Source kinds that are a single-node link (the kind IS the protocol) — routed
// through parseSingleLink. Only vless is wired today; the rest throw until their slice.
const SINGLE_LINK_KINDS = new Set<SourceKind>([
  "vless",
  "hysteria2",
  "vmess",
  "trojan",
  "ss",
  "tuic",
]);

// Subscription headers carry the name (`label`) plus the metadata kept in `meta`.
interface SubInfo {
  title: string | null;
  used: number | null;
  total: number | null;
  expire: number | null;
  updateHours: number | null;
}
const EMPTY_INFO: SubInfo = {
  title: null,
  used: null,
  total: null,
  expire: null,
  updateHours: null,
};

// Split the title off the SubInfo; null when the provider sent no usable metadata.
function toMeta(info: SubInfo): SubscriptionMeta | null {
  const { used, total, expire, updateHours } = info;
  if (used == null && total == null && expire == null && updateHours == null) return null;
  return { used, total, expire, updateHours };
}

// Human title from `profile-title` ("base64:…" or raw), else the content-disposition
// filename (with the .yaml/.txt/.json extension stripped).
function parseTitle(headers: Headers): string | null {
  const raw = headers.get("profile-title")?.trim();
  if (raw) {
    const b64 = /^base64:(.*)$/i.exec(raw);
    if (b64?.[1]) {
      try {
        const decoded = Buffer.from(b64[1], "base64").toString("utf8").trim();
        if (decoded) return decoded;
      } catch {
        /* not valid base64 — fall through */
      }
    } else {
      return raw;
    }
  }
  const cd = headers.get("content-disposition");
  if (cd) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star?.[1]) {
      try {
        const name = decodeURIComponent(star[1]).trim();
        if (name) return name;
      } catch {
        /* malformed — fall through */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    if (plain?.[1]) return plain[1].trim().replace(/\.(ya?ml|txt|json)$/i, "") || null;
  }
  return null;
}

// Parse subscription metadata from the provider's response headers (Clash/sub standard).
export function parseSubInfo(headers: Headers): SubInfo {
  const info: SubInfo = { ...EMPTY_INFO, title: parseTitle(headers) };

  // subscription-userinfo: "upload=N; download=N; total=N; expire=N"
  const userinfo = headers.get("subscription-userinfo");
  if (userinfo) {
    const f: Record<string, number> = {};
    for (const part of userinfo.split(";")) {
      const [k, v] = part.split("=");
      if (k && v !== undefined) f[k.trim()] = Number(v.trim());
    }
    const up = Number.isFinite(f.upload) ? (f.upload as number) : 0;
    const down = Number.isFinite(f.download) ? (f.download as number) : 0;
    if (up > 0 || down > 0) info.used = up + down;
    if (Number.isFinite(f.total) && (f.total as number) > 0) info.total = f.total as number;
    if (Number.isFinite(f.expire) && (f.expire as number) > 0) info.expire = f.expire as number;
  }

  // profile-update-interval: refresh interval in hours.
  const interval = Number(headers.get("profile-update-interval"));
  if (Number.isFinite(interval) && interval > 0) info.updateHours = interval;

  return info;
}

const FETCH_TIMEOUT_MS = 30_000; // subscription fetch

// Fetch an https subscription, parse its body into proxies, and read its metadata headers.
// X-Hwid is sent only when useHwid is set (ADR-0002): device-bound providers need it, but
// sending it elsewhere can burn device-slot limits.
export async function fetchSubscription(
  url: string,
  useHwid = false,
  hwid = "",
): Promise<{ proxies: ProxyConfig[]; info: SubInfo; skipped: string[] }> {
  const headers: Record<string, string> = { "User-Agent": "clash.meta" };
  if (useHwid && hwid) {
    headers["X-Hwid"] = hwid;
    headers["X-Device-Os"] = "Android";
  }
  const res = await fetch(url.trim(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`subscription returned HTTP ${res.status}`);
  const info = parseSubInfo(res.headers);
  const { proxies, skipped } = parseProxiesFromText(await res.text());
  if (!proxies.length)
    throw new Error("subscription had no nodes (clash-yaml / v2ray-json / base64)");
  return { proxies, info, skipped };
}

// happ:// → happ-decoder → sub-url/body → proxies. Proxies prefer the decoder's inline
// body (reliable); the metadata only comes with the sub-url fetch's headers (best-effort).
export async function ingestHapp(
  link: string,
  useHwid = false,
  hwid = "",
): Promise<{ via: string; proxies: ProxyConfig[]; info: SubInfo; skipped: string[] }> {
  const decoded = await decodeHapp(link, useHwid);
  const parsed = decoded.body
    ? parseProxiesFromText(decoded.body)
    : { proxies: [] as ProxyConfig[], skipped: [] as string[] };
  let proxies = parsed.proxies;
  let skipped = parsed.skipped;
  let info = EMPTY_INFO;
  if (decoded.url) {
    try {
      const fetched = await fetchSubscription(decoded.url, useHwid, hwid);
      if (!proxies.length) {
        proxies = fetched.proxies;
        skipped = fetched.skipped; // proxies came from the fetch → report its skipped list
      }
      info = fetched.info;
    } catch {
      /* fetch failed — keep the body's proxies (if any); no metadata */
    }
  }
  if (!proxies.length) {
    const looksDecoded =
      decoded.body &&
      (decoded.body.includes('"outbounds"') ||
        decoded.body.includes("proxies:") ||
        decoded.body.includes("://"));
    if (looksDecoded)
      throw new Error(
        `happ decoded (${decoded.url || "—"}) but has no active nodes — the subscription is likely expired`,
      );
    throw new Error(
      `happ decoded (${decoded.url || "—"}) but the subscription format was not recognized`,
    );
  }
  return { via: decoded.url || "happ", proxies, info, skipped };
}

// Dispatch on detected kind and return a normalized ingest result (no DB writes).
export async function ingestSource(
  value: string,
  useHwid = false,
  hwid = "",
): Promise<IngestResult> {
  const kind = detectKind(value);
  if (SINGLE_LINK_KINDS.has(kind)) {
    const proxy = parseSingleLink(value);
    return { kind, label: proxy.name, proxies: [proxy], meta: null, skipped: [] };
  }
  if (kind === "wireguard" || kind === "amneziawg") {
    const proxy = /^vpn:\/\//i.test(value.trim())
      ? parseAmneziaVpnLink(value)
      : parseWireguardConf(value);
    return { kind, label: proxy.name, proxies: [proxy], meta: null, skipped: [] };
  }
  if (kind === "sub") {
    const url = extractSubUrl(value);
    if (url) {
      const { proxies, info, skipped } = await fetchSubscription(url, useHwid, hwid);
      return { kind, label: info.title || url, proxies, meta: toMeta(info), skipped };
    }
    const { proxies, skipped } = parseProxiesFromText(value);
    if (!proxies.length) throw new Error("subscription had no nodes");
    return { kind, label: "inline subscription", proxies, meta: null, skipped };
  }
  // happ
  const { via, proxies, info, skipped } = await ingestHapp(value, useHwid, hwid);
  return { kind, label: info.title || `happ → ${via}`, proxies, meta: toMeta(info), skipped };
}
