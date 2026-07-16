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
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const DIAGNOSTIC_BODY_MAX_BYTES = 8192;

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

const delayResponseSchema = z.object({ delay: z.number().nonnegative() });
export type DelayResponse = z.infer<typeof delayResponseSchema>;

const mihomoVersionSchema = z.object({ version: z.string().min(1) });
export interface MihomoVersion {
  version: string;
}

const nullableBooleanSchema = z
  .boolean()
  .nullish()
  .transform((value) => value ?? null);
const runtimeConfigResponseSchema = z
  .looseObject({
    mode: z
      .string()
      .nullish()
      .transform((value) => value ?? null),
    dns: z.looseObject({ enable: nullableBooleanSchema }).nullish(),
    ipv6: nullableBooleanSchema,
    tun: z.looseObject({ enable: nullableBooleanSchema }).nullish(),
  })
  .transform((value) => ({
    mode: value.mode,
    dns: value.dns?.enable ?? null,
    ipv6: value.ipv6,
    tun: value.tun?.enable ?? null,
  }));
export interface MihomoRuntimeConfig {
  mode: string | null;
  dns: boolean | null;
  ipv6: boolean | null;
  tun: boolean | null;
}

const ipAddressSchema = z.union([z.ipv4(), z.ipv6()]);
const externalIpTraceSchema = z.object({
  ip: ipAddressSchema,
  country: z.string().min(1).nullable(),
  colo: z.string().min(1).nullable(),
});
export interface ExternalIpTrace {
  ip: string;
  country: string | null;
  colo: string | null;
}

export interface ProxyHttpProbe {
  status: number;
}

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
  // mihomo serializes an idle connection list as `null` (Go nil slice), not `[]`.
  // Treat that as an empty snapshot; HTTP/errors still represent engine failures.
  connections: z
    .array(connectionSchema)
    .nullish()
    .transform((value) => value ?? []),
});

function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number = TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function call(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> {
  return fetch(`${env.MIHOMO_API}${path}`, {
    ...init,
    signal: boundedSignal(signal, timeoutMs),
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${mihomoSecret}` },
  });
}

export async function getVersion(signal?: AbortSignal): Promise<MihomoVersion> {
  const r = await call("/version", {}, signal);
  if (!r.ok) throw new Error(`mihomo /version returned HTTP ${r.status}`);
  return mihomoVersionSchema.parse(await r.json());
}

export async function getRuntimeConfig(signal?: AbortSignal): Promise<MihomoRuntimeConfig> {
  const r = await call("/configs", {}, signal);
  if (!r.ok) throw new Error(`mihomo /configs returned HTTP ${r.status}`);
  return runtimeConfigResponseSchema.parse(await r.json());
}

export async function getProxies(): Promise<ProxiesResponse> {
  const r = await call("/proxies");
  if (!r.ok) throw new Error(`mihomo /proxies returned HTTP ${r.status}`);
  return proxiesResponseSchema.parse(await r.json());
}

// `url` defaults to the built-in probe endpoint; callers pass the AUTO group's
// configured test URL so the chart/ping measure the same target AUTO selects on.
export interface DelayOptions {
  timeoutMs?: number;
  expected?: "200-399";
  signal?: AbortSignal;
}

export async function getDelay(
  name: string,
  url: string = TEST_URL,
  options: DelayOptions = {},
): Promise<DelayResponse> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const query = new URLSearchParams({ timeout: String(timeoutMs), url });
  if (options.expected) query.set("expected", options.expected);
  const r = await call(
    `/proxies/${encodeURIComponent(name)}/delay?${query.toString()}`,
    {},
    options.signal,
    timeoutMs,
  );
  if (!r.ok) throw new Error(`mihomo delay for "${name}" returned HTTP ${r.status}`);
  return delayResponseSchema.parse(await r.json());
}

interface ProxyBody {
  dump(options?: { limit: number; signal?: AbortSignal }): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

async function readBoundedText(body: ProxyBody, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("proxy response exceeded diagnostic body limit");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function requestThroughProxy(
  url: string,
  signal?: AbortSignal,
): Promise<{
  statusCode: number;
  body: ProxyBody;
  signal: AbortSignal;
  destroy: () => Promise<void>;
}> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("diagnostic proxy requests require HTTP(S)");
  }
  const agent = new ProxyAgent(env.MIHOMO_PROXY);
  const requestSignal = boundedSignal(signal);
  try {
    const response = await request(parsed, {
      dispatcher: agent,
      signal: requestSignal,
      headers: { "user-agent": "submerge-diagnostics" },
    });
    return {
      statusCode: response.statusCode,
      body: response.body,
      signal: requestSignal,
      destroy: () => agent.destroy(),
    };
  } catch (error) {
    await agent.destroy();
    throw error;
  }
}

function parseExternalIpTrace(raw: string): ExternalIpTrace {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return externalIpTraceSchema.parse({
    ip: fields.get("ip"),
    country: fields.get("loc") || null,
    colo: fields.get("colo") || null,
  });
}

export async function getExternalIpTrace(signal?: AbortSignal): Promise<ExternalIpTrace> {
  const response = await requestThroughProxy(TRACE_URL, signal);
  try {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump({
        limit: DIAGNOSTIC_BODY_MAX_BYTES,
        signal: response.signal,
      });
      throw new Error(`Cloudflare trace returned HTTP ${response.statusCode}`);
    }
    return parseExternalIpTrace(await readBoundedText(response.body, DIAGNOSTIC_BODY_MAX_BYTES));
  } finally {
    await response.destroy();
  }
}

export async function probeThroughProxy(
  url: string,
  signal?: AbortSignal,
): Promise<ProxyHttpProbe> {
  const response = await requestThroughProxy(url, signal);
  try {
    await response.body.dump({ limit: DIAGNOSTIC_BODY_MAX_BYTES, signal: response.signal });
    return { status: response.statusCode };
  } finally {
    await response.destroy();
  }
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

const mihomoLogLevelSchema = z.enum(["debug", "info", "warn", "warning", "error"]);
const mihomoLogFieldSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});
const mihomoLogLineSchema = z.object({
  time: z.string(),
  level: mihomoLogLevelSchema,
  message: z.string().min(1),
  fields: z.array(mihomoLogFieldSchema).default([]),
});

export interface MihomoLogFrame {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  fields: Record<string, string | number | boolean>;
}

// The current structured endpoint emits an empty list, but mihomo deliberately
// models fields as an extensible key/value list. Keep that extension boundary
// narrow: arbitrary future fields must not silently become browser-visible data.
const MIHOMO_LOG_FIELD_ALLOWLIST = new Set(["host", "network", "port", "scope", "status"]);

const SECRET_LINK_PATTERN =
  /\b(?:amneziawg|happ|hysteria2|ss|trojan|tuic|vless|vmess|vpn|wireguard):\/\/\S+/giu;
const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const AUTHORIZATION_PATTERN =
  /\b(authorization|proxy-authorization|auth)\s*[:=]\s*(?:Bearer|Basic)\s+\S+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(authorization|auth|password|passwd|secret|token|api[_-]?key|x-hwid|hwid)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

function redactLogText(value: string): string {
  return value
    .replace(SECRET_LINK_PATTERN, "[LINK REDACTED]")
    .replace(HTTP_URL_PATTERN, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}/…`;
      } catch {
        return "[URL REDACTED]";
      }
    })
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(AUTHORIZATION_PATTERN, "$1=[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(JWT_PATTERN, "[TOKEN REDACTED]");
}

function parseLogLine(line: string): MihomoLogFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = mihomoLogLineSchema.safeParse(json);
  if (!parsed.success) return null;

  const fields: Record<string, string | number | boolean> = {};
  for (const field of parsed.data.fields) {
    if (!MIHOMO_LOG_FIELD_ALLOWLIST.has(field.key)) continue;
    if (
      typeof field.value !== "string" &&
      typeof field.value !== "number" &&
      typeof field.value !== "boolean"
    ) {
      continue;
    }
    if (typeof field.value === "number" && !Number.isFinite(field.value)) continue;
    fields[field.key] =
      typeof field.value === "string" ? redactLogText(field.value).slice(0, 1024) : field.value;
  }

  return {
    level:
      parsed.data.level === "warn" || parsed.data.level === "warning"
        ? "warning"
        : parsed.data.level,
    message: redactLogText(parsed.data.message).slice(0, 16_384),
    fields,
  };
}

async function* readLogStream(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  signal: AbortSignal,
): AsyncGenerator<MihomoLogFrame> {
  const stream = body.pipeThrough(new TextDecoderStream());
  let buffer = "";
  let badRun = 0;
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const frame = parseLogLine(line);
          if (frame) {
            badRun = 0;
            yield frame;
          } else if (++badRun >= MAX_UNPARSEABLE_RUN) {
            throw new Error(
              `mihomo /logs: ${badRun} consecutive unparseable frames — schema drift?`,
            );
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}

// Open only after mihomo has accepted the request and supplied a readable body.
// Keeping the opener separate from the generator lets the hub switch to `live`
// immediately after headers, even when no log line has arrived yet.
export async function openLogStream(signal: AbortSignal): Promise<AsyncGenerator<MihomoLogFrame>> {
  const response = await fetch(`${env.MIHOMO_API}/logs?level=info&format=structured`, {
    signal,
    headers: { Authorization: `Bearer ${mihomoSecret}` },
  });
  if (!response.ok) throw new Error(`mihomo /logs returned HTTP ${response.status}`);
  if (!response.body) throw new Error("mihomo /logs returned no readable body");
  return readLogStream(response.body, signal);
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
