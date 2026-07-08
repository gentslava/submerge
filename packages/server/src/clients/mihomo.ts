// Isolated mihomo (Clash) REST API client. Every response is Zod-parsed.
import {
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_TIMEOUT_MS,
  SPEED_TEST_URL,
  type TrafficSample,
  trafficSampleSchema,
} from "@submerge/shared";
import { ProxyAgent, request } from "undici";
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
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
// mihomo keeps a per-test-URL history map keyed by the exact test URL. `history`
// (below) is the last probe by ANY URL; `extra[url].history` is the series a group
// configured with that url actually decides on. We read the delay per test URL.
const extraEntrySchema = z.object({
  alive: z.boolean().optional(),
  history: z.array(historyEntrySchema).default([]),
});
// mihomo returns far more fields; pin only what we read, pass the rest through.
const mihomoProxySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  now: z.string().optional(),
  all: z.array(z.string()).optional(),
  udp: z.boolean().optional(),
  // The manually-pinned member of a url-test/fallback group. mihomo "fixes" a
  // url-test group when a node is selected on it via the API and then stops
  // racing by latency until the pin is cleared (DELETE /proxies/{group}) or the
  // pinned node dies — see clearFixedSelection. Absent for select/leaf proxies.
  fixed: z.string().optional(),
  history: z.array(historyEntrySchema).default([]),
  // `.nullish()` (not `.optional()`): a mihomo build that serializes an absent map
  // as `null` rather than omitting it must not fail the whole /proxies parse.
  extra: z.record(z.string(), extraEntrySchema).nullish(),
});
export type MihomoProxy = z.infer<typeof mihomoProxySchema>;

const proxiesResponseSchema = z.object({ proxies: z.record(z.string(), mihomoProxySchema) });
export type ProxiesResponse = z.infer<typeof proxiesResponseSchema>;

// The delay series to read for a node under a given test URL. mihomo keeps a
// per-URL history in `extra[url]`; use it when present and non-empty, else the
// shared `history` (fallback: a fresh node, right after a reload, or a cleared
// per-URL block). Callers pass the active policy's test URL so the panel shows
// the latency the url-test group actually decides on — not the last probe by any
// URL (a different channel's youtube/t.me check writes into the shared history too).
export function historyForUrl(
  info: MihomoProxy | undefined,
  testUrl: string | undefined,
): HistoryEntry[] {
  const perUrl = testUrl ? info?.extra?.[testUrl]?.history : undefined;
  return perUrl && perUrl.length > 0 ? perUrl : (info?.history ?? []);
}

const delayResponseSchema = z.object({ delay: z.number() });
export type DelayResponse = z.infer<typeof delayResponseSchema>;

// /connections carries cumulative byte counters (plus a large connections array we
// don't read — unknown keys are stripped by the schema).
const connectionsTotalsSchema = z.object({ downloadTotal: z.number(), uploadTotal: z.number() });
export interface TrafficTotals {
  up: number;
  down: number;
}

// The connections array from /connections. mihomo returns many more fields per
// connection and per metadata block; pin only what the screen reads and let
// `looseObject` pass the rest. `upload`/`download` are cumulative byte counters;
// `chains[0]` is the actual outbound node; `metadata.process` is usually empty for
// LAN traffic proxied over SOCKS (no local process to resolve).
const connectionMetadataSchema = z.looseObject({
  network: z.string().default(""),
  host: z.string().default(""),
  destinationIP: z.string().default(""),
  destinationPort: z.string().default(""),
  sourceIP: z.string().default(""),
  process: z.string().default(""),
});
const connectionSchema = z.looseObject({
  id: z.string(),
  metadata: connectionMetadataSchema,
  upload: z.number().default(0),
  download: z.number().default(0),
  start: z.string().default(""),
  chains: z.array(z.string()).default([]),
});
export type MihomoConnection = z.infer<typeof connectionSchema>;
const connectionsResponseSchema = z.object({
  connections: z.array(connectionSchema).default([]),
});

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

// Snapshot of active connections. Reuses the /connections endpoint (getTotals reads
// the same payload's counters); callers derive per-connection speed from consecutive
// snapshots.
export async function getConnections(): Promise<MihomoConnection[]> {
  const r = await call("/connections");
  if (!r.ok) throw new Error(`mihomo /connections returned HTTP ${r.status}`);
  return connectionsResponseSchema.parse(await r.json()).connections;
}

export async function closeConnection(id: string): Promise<void> {
  const r = await call(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  // 404 = the connection already closed on its own; treat as success (idempotent kill).
  if (!r.ok && r.status !== 404) {
    throw new Error(`mihomo close connection ${id} returned HTTP ${r.status}`);
  }
}

export async function closeAllConnections(): Promise<void> {
  const r = await call("/connections", { method: "DELETE" });
  if (!r.ok) throw new Error(`mihomo close all connections returned HTTP ${r.status}`);
}

export async function selectProxy(group: string, name: string): Promise<void> {
  const r = await call(`/proxies/${encodeURIComponent(group)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`mihomo select ${group}→${name} returned HTTP ${r.status}`);
}

// Clear a url-test/fallback group's manually-pinned ("fixed") member so mihomo
// resumes automatic latency-based selection. A manual select on a url-test group
// locks it to that node; DELETE /proxies/{group} is the documented way to unlock
// it (the endpoint is a no-op / not applicable to plain `select` groups). 404 is
// treated as success — the group has nothing pinned to clear.
export async function clearFixedSelection(group: string): Promise<void> {
  const r = await call(`/proxies/${encodeURIComponent(group)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) {
    throw new Error(`mihomo clear fixed selection for ${group} returned HTTP ${r.status}`);
  }
}

export interface DownloadResult {
  mbps: number; // download throughput
  bytes: number; // bytes actually read (capped)
  ms: number; // elapsed
}

// Download a fixed-size payload THROUGH mihomo's mixed proxy port and measure
// throughput. Which node carries it is decided by the caller pinning the PROBE
// group (selectProxy) + the config's PROBE rule — this function only drives the
// transfer. Byte-capped and timeout-bounded so a fast link can't run away and a
// stall can't hang. NOTE: real quota burn — callers gate this behind a warning.
export async function measureDownload(url: string = SPEED_TEST_URL): Promise<DownloadResult> {
  const agent = new ProxyAgent(env.MIHOMO_PROXY);
  const start = performance.now();
  let bytes = 0;
  try {
    const { statusCode, body } = await request(url, {
      dispatcher: agent,
      signal: AbortSignal.timeout(SPEED_TEST_TIMEOUT_MS),
      headers: { "user-agent": "submerge-speedtest" },
    });
    if (statusCode >= 400) throw new Error(`speed test returned HTTP ${statusCode}`);
    try {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes >= SPEED_TEST_MAX_BYTES) break;
      }
    } catch (err) {
      // Timeout is the EXPECTED end for a slow link: the payload is bigger than a
      // <10 Mbps node can pull in the window, so the read aborts. As long as we got
      // some bytes, that's a real (low) throughput — report it instead of failing.
      // A zero-byte failure (connect refused/reset) is a genuine error → rethrow.
      if (bytes === 0) throw err;
    }
  } finally {
    // destroy (not close): on an early byte-cap break the body is still streaming,
    // and close() would wait on the un-drained request. destroy tears it down now.
    await agent.destroy();
  }
  const ms = performance.now() - start;
  const mbps = ms > 0 ? (bytes * 8) / 1e6 / (ms / 1000) : 0;
  return { mbps, bytes, ms };
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
