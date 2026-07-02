// Isolated mihomo (Clash) REST API client. Every response is Zod-parsed.
import { type TrafficSample, trafficSampleSchema } from "@submerge/shared";
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 5000;
const TEST_URL = "https://www.gstatic.com/generate_204";

// The mihomo API secret can be set/rotated from Settings; the live value lives here
// (init from env, overridden at boot from the DB, updated after a rotation reload).
let mihomoSecret = env.MIHOMO_SECRET;
export function setMihomoSecret(secret: string): void {
  mihomoSecret = secret;
}

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
export type ProxiesResponse = z.infer<typeof proxiesResponseSchema>;

const delayResponseSchema = z.object({ delay: z.number() });
export type DelayResponse = z.infer<typeof delayResponseSchema>;

// /connections carries cumulative byte counters (plus a large connections array we
// don't read — unknown keys are stripped by the schema).
const connectionsTotalsSchema = z.object({ downloadTotal: z.number(), uploadTotal: z.number() });
export interface TrafficTotals {
  up: number;
  down: number;
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.MIHOMO_API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${mihomoSecret}` },
  });
}

export async function getProxies(): Promise<ProxiesResponse> {
  const r = await call("/proxies");
  if (!r.ok) throw new Error(`mihomo /proxies returned HTTP ${r.status}`);
  return proxiesResponseSchema.parse(await r.json());
}

// `url` defaults to the built-in probe endpoint; callers pass the AUTO group's
// configured test URL so the chart/ping measure the same target AUTO selects on.
export async function getDelay(name: string, url: string = TEST_URL): Promise<DelayResponse> {
  const q = `timeout=3000&url=${encodeURIComponent(url)}`;
  const r = await call(`/proxies/${encodeURIComponent(name)}/delay?${q}`);
  if (!r.ok) throw new Error(`mihomo delay for "${name}" returned HTTP ${r.status}`);
  return delayResponseSchema.parse(await r.json());
}

// Cumulative bytes received/sent since mihomo started (downloadTotal/uploadTotal).
export async function getTotals(): Promise<TrafficTotals> {
  const r = await call("/connections");
  if (!r.ok) throw new Error(`mihomo /connections returned HTTP ${r.status}`);
  const { downloadTotal, uploadTotal } = connectionsTotalsSchema.parse(await r.json());
  return { up: uploadTotal, down: downloadTotal };
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

// A malformed/partial frame must not kill the long-lived stream — skip it. But a
// long RUN of unparseable frames means the schema drifted (e.g. a mihomo update
// renamed fields): the stream would otherwise stay open yielding nothing forever,
// invisible to the hub's error path — so surface that loudly.
const MAX_UNPARSEABLE_RUN = 30;

function parseTrafficLine(line: string): TrafficSample | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = trafficSampleSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// Stream mihomo /traffic as parsed NDJSON samples until `signal` aborts or the
// upstream closes. Caller owns the lifecycle (re-open on error). NOTE: uses
// fetch directly (NOT call()) because /traffic is long-lived — no 5 s timeout.
export async function* streamTraffic(signal: AbortSignal): AsyncGenerator<TrafficSample> {
  const r = await fetch(`${env.MIHOMO_API}/traffic`, {
    signal,
    headers: { Authorization: `Bearer ${mihomoSecret}` },
  });
  if (!r.ok || !r.body) throw new Error(`mihomo /traffic returned HTTP ${r.status}`);
  const stream = r.body.pipeThrough(new TextDecoderStream());
  let buf = "";
  let badRun = 0;
  for await (const chunk of stream) {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const sample = parseTrafficLine(line);
        if (sample) {
          badRun = 0;
          yield sample;
        } else if (++badRun >= MAX_UNPARSEABLE_RUN) {
          throw new Error(
            `mihomo /traffic: ${badRun} consecutive unparseable frames — schema drift?`,
          );
        }
      }
      nl = buf.indexOf("\n");
    }
  }
}
