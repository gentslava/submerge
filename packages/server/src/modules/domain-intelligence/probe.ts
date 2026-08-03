import type { ClientRequest, IncomingMessage } from "node:http";
import { request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { normalizeObservedFqdn } from "./observer.js";
import {
  isPublicIpAddress,
  type PublicResolutionOptions,
  type PublicResolutionResult,
  resolvePublicAddresses,
} from "./resolver.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
const MAX_TOTAL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_LOCATION_BYTES = 4_096;
const MAX_RESPONSE_HEADER_BYTES = 16_384;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESET_CODES = new Set(["ECONNRESET", "EPIPE"]);

export type ProbeCategory =
  | "http_response"
  | "dns_failure"
  | "unsafe_address"
  | "ipv6_unavailable"
  | "unsafe_redirect"
  | "redirect_limit"
  | "connect_timeout"
  | "tls_timeout"
  | "tls_handshake_reset"
  | "connection_reset_before_http"
  | "tls_error"
  | "network_error"
  | "total_timeout"
  | "infrastructure_error";

export interface PinnedHopRequest {
  target: URL;
  address: string;
  family: 4 | 6;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
}

interface PinnedHopTiming {
  connectDurationMs: number | null;
  tlsDurationMs: number | null;
  totalDurationMs: number;
}

export type PinnedHopResult =
  | (PinnedHopTiming & {
      kind: "response";
      statusCode: number;
      location: string | null;
      locationRejected: boolean;
    })
  | (PinnedHopTiming & {
      kind: "failure";
      category: Exclude<
        ProbeCategory,
        | "http_response"
        | "dns_failure"
        | "ipv6_unavailable"
        | "unsafe_redirect"
        | "redirect_limit"
        | "infrastructure_error"
      >;
    });

type PinnedFailureCategory = Extract<PinnedHopResult, { kind: "failure" }>["category"];

export type PinnedRequestFactory = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

type ResolveImpl = (
  observedFqdn: string,
  resolverUrls: readonly string[],
  options: PublicResolutionOptions,
) => Promise<PublicResolutionResult>;

type RequestPinnedImpl = (request: PinnedHopRequest) => Promise<PinnedHopResult>;

export interface DirectProbeOptions {
  resolverUrls: readonly string[];
  resolverQuorum: number;
  resolverTimeoutMs?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  addressSelectionIndex?: number;
  ipv6EgressVerified?: boolean;
  signal?: AbortSignal;
  resolveImpl?: ResolveImpl;
  requestPinnedImpl?: RequestPinnedImpl;
  nowImpl?: () => number;
}

export interface DirectProbeResult {
  direction: "direct";
  category: ProbeCategory;
  transportSuccess: boolean;
  httpStatus: number | null;
  resolvedAddress: string | null;
  connectDurationMs: number | null;
  tlsDurationMs: number | null;
  totalDurationMs: number;
  redirectCount: number;
  finalOrigin: string | null;
}

type ConnectionPhase = "connecting" | "tls" | "awaiting-http";

function safeDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function classifyNetworkError(error: unknown, phase: ConnectionPhase): PinnedFailureCategory {
  const code = errorCode(error);
  if (phase === "tls") return code && RESET_CODES.has(code) ? "tls_handshake_reset" : "tls_error";
  if (phase === "awaiting-http" && code && RESET_CODES.has(code)) {
    return "connection_reset_before_http";
  }
  return "network_error";
}

function normalizeHttpsTarget(value: URL): URL | null {
  const target = new URL(value);
  if (target.protocol !== "https:" || target.username || target.password) return null;
  const hostname = normalizeObservedFqdn(target.hostname);
  if (!hostname) return null;
  target.hostname = hostname;
  target.hash = "";
  return target;
}

function pinnedLookup(expectedHostname: string, address: string, family: 4 | 6): LookupFunction {
  return (hostname, options, callback) => {
    if (normalizeObservedFqdn(hostname) !== expectedHostname) {
      const error = Object.assign(new Error("pinned lookup hostname mismatch"), {
        code: "EACCES",
      });
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function abortedReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function requestPinnedHttps(
  input: PinnedHopRequest,
  requestImpl: PinnedRequestFactory = nodeHttpsRequest,
): Promise<PinnedHopResult> {
  const startedAt = performance.now();
  const target = normalizeHttpsTarget(input.target);
  if (!target || !isPublicIpAddress(input.address) || isIP(input.address) !== input.family) {
    return {
      kind: "failure",
      category: "unsafe_address",
      connectDurationMs: null,
      tlsDurationMs: null,
      totalDurationMs: safeDuration(performance.now() - startedAt),
    };
  }
  if (input.signal?.aborted) throw abortedReason(input.signal);

  return await new Promise<PinnedHopResult>((resolve, reject) => {
    let settled = false;
    let phase: ConnectionPhase = "connecting";
    let connectedAt: number | null = null;
    let connectDurationMs: number | null = null;
    let tlsDurationMs: number | null = null;
    let request: ClientRequest | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (totalTimer) clearTimeout(totalTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const timing = (): PinnedHopTiming => ({
      connectDurationMs,
      tlsDurationMs,
      totalDurationMs: safeDuration(performance.now() - startedAt),
    });
    const finish = (result: PinnedHopResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (category: PinnedFailureCategory) => {
      finish({ kind: "failure", category, ...timing() });
    };
    const onAbort = () => {
      if (settled || !input.signal) return;
      settled = true;
      cleanup();
      request?.destroy();
      reject(abortedReason(input.signal));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    if (settled) return;

    try {
      request = requestImpl(
        {
          protocol: "https:",
          hostname: target.hostname,
          port: target.port || 443,
          servername: target.hostname,
          method: "GET",
          path: `${target.pathname}${target.search}`,
          headers: {
            Host: target.host,
            Accept: "*/*",
            Connection: "close",
          },
          setHost: false,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
          lookup: pinnedLookup(target.hostname, input.address, input.family),
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          const statusCode = response.statusCode;
          const rawLocation = response.headers.location;
          const location =
            typeof rawLocation === "string" && Buffer.byteLength(rawLocation) <= MAX_LOCATION_BYTES
              ? rawLocation
              : null;
          const locationRejected = rawLocation !== undefined && location === null;
          if (
            !Number.isInteger(statusCode) ||
            !statusCode ||
            statusCode < 100 ||
            statusCode > 599
          ) {
            fail("network_error");
            response.destroy();
            return;
          }
          finish({ kind: "response", statusCode, location, locationRejected, ...timing() });
          response.destroy();
        },
      );
      if (settled) {
        request.destroy();
        return;
      }
      request.once("socket", (socket) => {
        socket.once("connect", () => {
          if (settled) return;
          connectedAt = performance.now();
          connectDurationMs = safeDuration(connectedAt - startedAt);
          phase = "tls";
        });
        socket.once("secureConnect", () => {
          if (settled) return;
          const securedAt = performance.now();
          connectDurationMs ??= safeDuration(securedAt - startedAt);
          tlsDurationMs = safeDuration(securedAt - (connectedAt ?? startedAt));
          phase = "awaiting-http";
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
        });
      });
      request.once("error", (error) => {
        if (!settled) fail(classifyNetworkError(error, phase));
      });
      if (input.signal?.aborted) onAbort();
      if (settled) return;

      connectTimer = setTimeout(() => {
        if (settled) return;
        fail(phase === "connecting" ? "connect_timeout" : "tls_timeout");
        request?.destroy();
      }, input.connectTimeoutMs);
      connectTimer.unref();
      totalTimer = setTimeout(() => {
        if (settled) return;
        fail("total_timeout");
        request?.destroy();
      }, input.totalTimeoutMs);
      totalTimer.unref();
      request.end();
    } catch (error) {
      if (input.signal?.aborted) {
        onAbort();
      } else {
        fail(classifyNetworkError(error, phase));
      }
    }
  });
}

function validateOptions(options: DirectProbeOptions): {
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
  addressSelectionIndex: number;
} {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const addressSelectionIndex = options.addressSelectionIndex ?? 0;
  if (
    !Number.isInteger(connectTimeoutMs) ||
    connectTimeoutMs < 1 ||
    connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS
  ) {
    throw new RangeError("invalid DIRECT connect timeout");
  }
  if (
    !Number.isInteger(totalTimeoutMs) ||
    totalTimeoutMs < connectTimeoutMs ||
    totalTimeoutMs > MAX_TOTAL_TIMEOUT_MS
  ) {
    throw new RangeError("invalid DIRECT total timeout");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new RangeError("invalid DIRECT redirect limit");
  }
  if (!Number.isSafeInteger(addressSelectionIndex) || addressSelectionIndex < 0) {
    throw new RangeError("invalid DIRECT address selection index");
  }
  return { connectTimeoutMs, totalTimeoutMs, maxRedirects, addressSelectionIndex };
}

export async function probeDirectHttps(
  observedFqdn: string,
  options: DirectProbeOptions,
): Promise<DirectProbeResult> {
  const fqdn = normalizeObservedFqdn(observedFqdn);
  if (!fqdn) throw new TypeError("invalid DIRECT probe hostname");
  const { connectTimeoutMs, totalTimeoutMs, maxRedirects, addressSelectionIndex } =
    validateOptions(options);
  const resolveImpl = options.resolveImpl ?? resolvePublicAddresses;
  const requestPinnedImpl = options.requestPinnedImpl ?? requestPinnedHttps;
  const now = options.nowImpl ?? performance.now.bind(performance);
  const startedAt = now();
  if (options.signal?.aborted) throw abortedReason(options.signal);
  const deadlineSignal = AbortSignal.timeout(totalTimeoutMs);
  const attemptSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;
  let target = new URL(`https://${fqdn}/`);
  let redirectCount = 0;
  let connectDurationMs = 0;
  let tlsDurationMs = 0;
  let hasConnectDuration = false;
  let hasTlsDuration = false;

  const result = (
    category: ProbeCategory,
    input: {
      transportSuccess?: boolean;
      httpStatus?: number | null;
      resolvedAddress?: string | null;
      finalOrigin?: string | null;
    } = {},
  ): DirectProbeResult => ({
    direction: "direct",
    category,
    transportSuccess: input.transportSuccess ?? false,
    httpStatus: input.httpStatus ?? null,
    resolvedAddress: input.resolvedAddress ?? null,
    connectDurationMs: hasConnectDuration ? connectDurationMs : null,
    tlsDurationMs: hasTlsDuration ? tlsDurationMs : null,
    totalDurationMs: safeDuration(now() - startedAt),
    redirectCount,
    finalOrigin: input.finalOrigin ?? target.origin,
  });

  while (true) {
    let resolution: PublicResolutionResult;
    try {
      resolution = await resolveImpl(target.hostname, options.resolverUrls, {
        quorum: options.resolverQuorum,
        ...(options.resolverTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.resolverTimeoutMs }),
        signal: attemptSignal,
      });
    } catch {
      if (options.signal?.aborted) throw abortedReason(options.signal);
      if (deadlineSignal.aborted) return result("total_timeout", { finalOrigin: target.origin });
      return result("infrastructure_error", { finalOrigin: target.origin });
    }
    if (resolution.outcomes.some((outcome) => outcome.rejectedAnswerCount > 0)) {
      return result("unsafe_address", { finalOrigin: target.origin });
    }
    if (resolution.status !== "resolved") {
      return result("dns_failure", { finalOrigin: target.origin });
    }
    const validatedAddresses = resolution.addresses.filter(
      (address) => isPublicIpAddress(address.address) && isIP(address.address) === address.family,
    );
    if (
      validatedAddresses.length !== resolution.addresses.length ||
      validatedAddresses.length === 0
    ) {
      return result("unsafe_address", { finalOrigin: target.origin });
    }
    const usableAddresses = options.ipv6EgressVerified
      ? validatedAddresses
      : validatedAddresses.filter((address) => address.family === 4);
    if (usableAddresses.length === 0) {
      return result("ipv6_unavailable", { finalOrigin: target.origin });
    }
    const selected = usableAddresses[addressSelectionIndex % usableAddresses.length];
    if (!selected) return result("infrastructure_error", { finalOrigin: target.origin });

    let hop: PinnedHopResult;
    try {
      hop = await requestPinnedImpl({
        target: new URL(target),
        address: selected.address,
        family: selected.family,
        connectTimeoutMs,
        totalTimeoutMs,
        signal: attemptSignal,
      });
    } catch {
      if (options.signal?.aborted) throw abortedReason(options.signal);
      if (deadlineSignal.aborted) {
        return result("total_timeout", {
          resolvedAddress: selected.address,
          finalOrigin: target.origin,
        });
      }
      return result("infrastructure_error", {
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }
    if (hop.connectDurationMs !== null) {
      connectDurationMs += hop.connectDurationMs;
      hasConnectDuration = true;
    }
    if (hop.tlsDurationMs !== null) {
      tlsDurationMs += hop.tlsDurationMs;
      hasTlsDuration = true;
    }
    if (hop.kind === "failure") {
      return result(hop.category, {
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }

    if (REDIRECT_STATUSES.has(hop.statusCode) && hop.locationRejected) {
      return result("unsafe_redirect", {
        httpStatus: hop.statusCode,
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }
    if (!REDIRECT_STATUSES.has(hop.statusCode) || !hop.location) {
      return result("http_response", {
        transportSuccess: true,
        httpStatus: hop.statusCode,
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }
    if (redirectCount >= maxRedirects) {
      return result("redirect_limit", {
        httpStatus: hop.statusCode,
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }

    let redirected: URL;
    try {
      const parsed = new URL(hop.location, target);
      const normalized = normalizeHttpsTarget(parsed);
      if (!normalized) {
        return result("unsafe_redirect", {
          httpStatus: hop.statusCode,
          resolvedAddress: selected.address,
          finalOrigin: target.origin,
        });
      }
      redirected = normalized;
    } catch {
      return result("unsafe_redirect", {
        httpStatus: hop.statusCode,
        resolvedAddress: selected.address,
        finalOrigin: target.origin,
      });
    }
    target = redirected;
    redirectCount += 1;
  }
}
