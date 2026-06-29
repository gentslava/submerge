import type { Proxy as ProxyConfig, SourceKind } from "@submerge/shared";
import { decodeHapp } from "../../clients/happDecoder.js";
import { detectKind, extractSubUrl, parseProxiesFromText, parseVless } from "./parse.js";

export interface IngestResult {
  kind: SourceKind;
  label: string;
  proxies: ProxyConfig[];
}

const FETCH_TIMEOUT_MS = 30_000; // subscription fetch

// Fetch an https subscription and parse its body into proxies.
// X-Hwid is sent only when useHwid is set (ADR-0002): device-bound providers
// need it, but sending it elsewhere can burn device-slot limits.
export async function fetchSubscription(
  url: string,
  useHwid = false,
  hwid = "",
): Promise<ProxyConfig[]> {
  const headers: Record<string, string> = { "User-Agent": "clash.meta" };
  if (useHwid && hwid) {
    headers["X-Hwid"] = hwid;
    headers["X-Device-Os"] = "Android";
  }
  const res = await fetch(url.trim(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`subscription returned HTTP ${res.status}`);
  const proxies = parseProxiesFromText(await res.text());
  if (!proxies.length)
    throw new Error("subscription had no nodes (clash-yaml / v2ray-json / base64)");
  return proxies;
}

// happ:// → happ-decoder → sub-url/body → proxies.
export async function ingestHapp(
  link: string,
  useHwid = false,
  hwid = "",
): Promise<{ via: string; proxies: ProxyConfig[] }> {
  const decoded = await decodeHapp(link, useHwid);
  let proxies = decoded.body ? parseProxiesFromText(decoded.body) : [];
  if (!proxies.length && decoded.url) {
    try {
      proxies = await fetchSubscription(decoded.url, useHwid, hwid);
    } catch {
      /* fall through to the diagnostic below */
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
  return { via: decoded.url || "happ", proxies };
}

// Dispatch on detected kind and return a normalized ingest result (no DB writes).
export async function ingestSource(
  value: string,
  useHwid = false,
  hwid = "",
): Promise<IngestResult> {
  const kind = detectKind(value);
  if (kind === "vless") {
    const proxy = parseVless(value);
    return { kind, label: proxy.name, proxies: [proxy] };
  }
  if (kind === "sub") {
    const url = extractSubUrl(value);
    const proxies = url ? await fetchSubscription(url, useHwid, hwid) : parseProxiesFromText(value);
    if (!proxies.length) throw new Error("subscription had no nodes");
    return { kind, label: url ?? "inline subscription", proxies };
  }
  // happ
  const { via, proxies } = await ingestHapp(value, useHwid, hwid);
  return { kind, label: `happ → ${via}`, proxies };
}
