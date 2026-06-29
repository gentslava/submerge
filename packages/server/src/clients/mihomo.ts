// Isolated mihomo (Clash) REST API client. Every response is Zod-parsed.
import { type TrafficSample, trafficSampleSchema } from "@submerge/shared";
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 5000;
const TEST_URL = "https://www.gstatic.com/generate_204";

const historyEntrySchema = z.object({ time: z.string(), delay: z.number() });
// mihomo returns far more fields; pin only what we read, pass the rest through.
const mihomoProxySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  now: z.string().optional(),
  all: z.array(z.string()).optional(),
  udp: z.boolean().optional(),
  history: z.array(historyEntrySchema).default([]),
});
export type MihomoProxy = z.infer<typeof mihomoProxySchema>;

const proxiesResponseSchema = z.object({ proxies: z.record(z.string(), mihomoProxySchema) });

const connectionsSchema = z.object({
  downloadTotal: z.number(),
  uploadTotal: z.number(),
  connections: z.array(z.unknown()).default([]),
});
export type ProxiesResponse = z.infer<typeof proxiesResponseSchema>;

const delayResponseSchema = z.object({ delay: z.number() });
export type DelayResponse = z.infer<typeof delayResponseSchema>;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.MIHOMO_API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${env.MIHOMO_SECRET}` },
  });
}

export async function getProxies(): Promise<ProxiesResponse> {
  const r = await call("/proxies");
  if (!r.ok) throw new Error(`mihomo /proxies returned HTTP ${r.status}`);
  return proxiesResponseSchema.parse(await r.json());
}

export async function getDelay(name: string): Promise<DelayResponse> {
  const q = `timeout=3000&url=${encodeURIComponent(TEST_URL)}`;
  const r = await call(`/proxies/${encodeURIComponent(name)}/delay?${q}`);
  if (!r.ok) throw new Error(`mihomo delay for "${name}" returned HTTP ${r.status}`);
  return delayResponseSchema.parse(await r.json());
}

export async function selectProxy(group: string, name: string): Promise<void> {
  const r = await call(`/proxies/${encodeURIComponent(group)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`mihomo select ${group}→${name} returned HTTP ${r.status}`);
}

export async function reloadConfig(targetPath: string): Promise<void> {
  const r = await call("/configs?force=true", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: targetPath }),
  });
  if (!r.ok) throw new Error(`mihomo reload returned HTTP ${r.status}`);
}

export interface ConnectionsSnapshot {
  downloadTotal: number;
  uploadTotal: number;
  count: number;
}

// Stream mihomo /traffic as parsed NDJSON samples until `signal` aborts or the
// upstream closes. Caller owns the lifecycle (re-open on error). NOTE: uses
// fetch directly (NOT call()) because /traffic is long-lived — no 5 s timeout.
export async function* streamTraffic(signal: AbortSignal): AsyncGenerator<TrafficSample> {
  const r = await fetch(`${env.MIHOMO_API}/traffic`, {
    signal,
    headers: { Authorization: `Bearer ${env.MIHOMO_SECRET}` },
  });
  if (!r.ok || !r.body) throw new Error(`mihomo /traffic returned HTTP ${r.status}`);
  const stream = r.body.pipeThrough(new TextDecoderStream());
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield trafficSampleSchema.parse(JSON.parse(line));
      nl = buf.indexOf("\n");
    }
  }
}

export async function getConnections(): Promise<ConnectionsSnapshot> {
  const r = await call("/connections");
  if (!r.ok) throw new Error(`mihomo /connections returned HTTP ${r.status}`);
  const { downloadTotal, uploadTotal, connections } = connectionsSchema.parse(await r.json());
  return { downloadTotal, uploadTotal, count: connections.length };
}
