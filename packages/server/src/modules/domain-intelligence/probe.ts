import {
  type ClientRequest,
  type RequestOptions as HttpRequestOptions,
  type IncomingMessage,
  request as nodeHttpRequest,
} from "node:http";
import { Agent as HttpsAgent, request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { type ConnectionOptions, connect as nodeTlsConnect, type TLSSocket } from "node:tls";
import { ProxyAgent, errors as undiciErrors, fetch as undiciFetch } from "undici";
import { env } from "../../config/env.js";
import { DOMAIN_VALIDATION_USERNAME } from "../nodes/multiConfig.js";
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
  | "proxy_auth_failure"
  | "route_proof_failure"
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
        "http_response" | "dns_failure" | "ipv6_unavailable" | "unsafe_redirect" | "redirect_limit"
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

export interface ValidationProxyAuth {
  endpoint: string;
  username: string;
  password: string;
}

export interface ProxyRouteProofDestination {
  address: string;
  port: number;
  signal?: AbortSignal;
}

export type ProxyRouteProof = (destination: ProxyRouteProofDestination) => Promise<void>;

export interface ProxyPinnedHopRequest extends PinnedHopRequest {
  proxy: ValidationProxyAuth;
  proveRoute: ProxyRouteProof;
}

export type ProxyConnectRequestFactory = (options: HttpRequestOptions) => ClientRequest;
export type TlsConnectFactory = (options: ConnectionOptions) => TLSSocket;

export interface ProxyTransportDependencies {
  connectRequest?: ProxyConnectRequestFactory;
  tlsConnect?: TlsConnectFactory;
  httpsRequest?: PinnedRequestFactory;
  nowImpl?: () => number;
}

type RequestProxyPinnedImpl = (request: ProxyPinnedHopRequest) => Promise<PinnedHopResult>;

export interface ProxyResolverResource {
  fetchImpl: NonNullable<PublicResolutionOptions["fetchImpl"]>;
  failureCategory?(): Extract<ProbeCategory, "proxy_auth_failure"> | null;
  close(): Promise<void>;
}

export type ProxyResolverFactory = (proxy: ValidationProxyAuth) => ProxyResolverResource;

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
  availableAddressCount: number;
  connectDurationMs: number | null;
  tlsDurationMs: number | null;
  totalDurationMs: number;
  redirectCount: number;
  finalOrigin: string | null;
}

export interface ProxyProbeOptions extends Omit<DirectProbeOptions, "requestPinnedImpl"> {
  proxy: ValidationProxyAuth;
  prepareRouteProof(signal?: AbortSignal): Promise<ProxyRouteProof>;
  requestPinnedImpl?: RequestProxyPinnedImpl;
  proxyResolverFactory?: ProxyResolverFactory;
}

export interface ProxyProbeResult extends Omit<DirectProbeResult, "direction"> {
  direction: "proxy";
}

type ConnectionPhase = "connecting" | "route-proof" | "tls" | "awaiting-http";

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

function normalizedProxyAuth(proxy: ValidationProxyAuth): ValidationProxyAuth {
  let endpoint: URL;
  try {
    endpoint = new URL(proxy.endpoint);
  } catch {
    throw new TypeError("invalid validation proxy configuration");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.hostname ||
    !endpoint.port ||
    endpoint.toString() !== new URL(env.DOMAIN_VALIDATION_PROXY_ENDPOINT).toString() ||
    proxy.username !== DOMAIN_VALIDATION_USERNAME ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(proxy.password)
  ) {
    throw new TypeError("invalid validation proxy configuration");
  }
  return { endpoint: endpoint.toString(), username: proxy.username, password: proxy.password };
}

function proxyAuthorization(proxy: ValidationProxyAuth): string {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString("base64")}`;
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

export async function requestPinnedProxyHttps(
  input: ProxyPinnedHopRequest,
  dependencies: ProxyTransportDependencies = {},
): Promise<PinnedHopResult> {
  const now = dependencies.nowImpl ?? performance.now.bind(performance);
  const startedAt = now();
  const target = normalizeHttpsTarget(input.target);
  if (!target || !isPublicIpAddress(input.address) || isIP(input.address) !== input.family) {
    return {
      kind: "failure",
      category: "unsafe_address",
      connectDurationMs: null,
      tlsDurationMs: null,
      totalDurationMs: safeDuration(now() - startedAt),
    };
  }
  const proxy = normalizedProxyAuth(input.proxy);
  if (input.signal?.aborted) throw abortedReason(input.signal);
  const connectRequest = dependencies.connectRequest ?? nodeHttpRequest;
  const tlsConnect = dependencies.tlsConnect ?? nodeTlsConnect;
  const httpsRequestFactory = dependencies.httpsRequest ?? nodeHttpsRequest;
  const targetPort = target.port ? Number(target.port) : 443;
  const pinnedAuthority =
    input.family === 6 ? `[${input.address}]:${targetPort}` : `${input.address}:${targetPort}`;

  return await new Promise<PinnedHopResult>((resolve, reject) => {
    let settled = false;
    let phase: ConnectionPhase = "connecting";
    let connectedAt: number | null = null;
    let tlsStartedAt: number | null = null;
    let connectDurationMs: number | null = null;
    let tlsDurationMs: number | null = null;
    let proxyRequest: ClientRequest | null = null;
    let targetRequest: ClientRequest | null = null;
    let tunnelSocket: { destroy(error?: Error): void } | null = null;
    let secureSocket: TLSSocket | null = null;
    let tunnelAgent: HttpsAgent | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;
    const routeProofController = new AbortController();

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (!routeProofController.signal.aborted) {
        routeProofController.abort(new DOMException("route proof stopped", "AbortError"));
      }
      input.signal?.removeEventListener("abort", onAbort);
    };
    const timing = (): PinnedHopTiming => ({
      connectDurationMs,
      tlsDurationMs,
      totalDurationMs: safeDuration(now() - startedAt),
    });
    const finish = (result: PinnedHopResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const closeTransport = () => {
      targetRequest?.destroy();
      tunnelAgent?.destroy();
      secureSocket?.destroy();
      tunnelSocket?.destroy();
      proxyRequest?.destroy();
    };
    const fail = (category: PinnedFailureCategory) => {
      if (settled) return;
      finish({ kind: "failure", category, ...timing() });
      closeTransport();
    };
    const onAbort = () => {
      if (settled || !input.signal) return;
      settled = true;
      cleanup();
      closeTransport();
      reject(abortedReason(input.signal));
    };

    const startHttpsRequest = () => {
      if (settled || !secureSocket) return;
      phase = "awaiting-http";
      try {
        const pinnedSocket = secureSocket;
        tunnelAgent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
        tunnelAgent.createConnection = () => pinnedSocket;
        targetRequest = httpsRequestFactory(
          {
            protocol: "https:",
            hostname: target.hostname,
            port: targetPort,
            servername: target.hostname,
            method: "GET",
            path: `${target.pathname}${target.search}`,
            headers: {
              Host: target.host,
              Accept: "*/*",
              Connection: "close",
            },
            setHost: false,
            rejectUnauthorized: true,
            maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
            agent: tunnelAgent,
          },
          (response) => {
            if (settled) {
              response.destroy();
              return;
            }
            const statusCode = response.statusCode;
            const rawLocation = response.headers.location;
            const location =
              typeof rawLocation === "string" &&
              Buffer.byteLength(rawLocation) <= MAX_LOCATION_BYTES
                ? rawLocation
                : null;
            const locationRejected = rawLocation !== undefined && location === null;
            if (
              !Number.isInteger(statusCode) ||
              !statusCode ||
              statusCode < 100 ||
              statusCode > 599
            ) {
              response.destroy();
              fail("network_error");
              return;
            }
            finish({ kind: "response", statusCode, location, locationRejected, ...timing() });
            response.destroy();
            closeTransport();
          },
        );
        if (settled) {
          targetRequest.destroy();
          return;
        }
        targetRequest.once("error", (error) => {
          if (!settled) fail(classifyNetworkError(error, phase));
        });
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        targetRequest.end();
      } catch (error) {
        fail(classifyNetworkError(error, phase));
      }
    };

    const startTls = () => {
      if (settled || !tunnelSocket) return;
      phase = "tls";
      tlsStartedAt = now();
      try {
        secureSocket = tlsConnect({
          socket: tunnelSocket as ConnectionOptions["socket"],
          servername: target.hostname,
          rejectUnauthorized: true,
        });
        if (settled) {
          secureSocket.destroy();
          return;
        }
        secureSocket.once("secureConnect", () => {
          if (settled) return;
          const securedAt = now();
          tlsDurationMs = safeDuration(securedAt - (tlsStartedAt ?? securedAt));
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          startHttpsRequest();
        });
        secureSocket.once("error", (error) => {
          if (!settled) fail(classifyNetworkError(error, phase));
        });
      } catch (error) {
        fail(classifyNetworkError(error, phase));
      }
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    if (settled) return;

    try {
      const endpoint = new URL(proxy.endpoint);
      const endpointHostname = endpoint.hostname.startsWith("[")
        ? endpoint.hostname.slice(1, -1)
        : endpoint.hostname;
      proxyRequest = connectRequest({
        protocol: "http:",
        hostname: endpointHostname,
        port: Number(endpoint.port),
        method: "CONNECT",
        path: pinnedAuthority,
        headers: {
          Host: pinnedAuthority,
          "Proxy-Authorization": proxyAuthorization(proxy),
        },
        agent: false,
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      });
      if (settled) {
        proxyRequest.destroy();
        return;
      }
      proxyRequest.once("connect", (response, socket, head) => {
        if (settled) {
          socket.destroy();
          return;
        }
        tunnelSocket = socket;
        if (response.statusCode !== 200 || head.length > 0) {
          fail(
            response.statusCode === 403 || response.statusCode === 407
              ? "proxy_auth_failure"
              : "network_error",
          );
          return;
        }
        connectedAt = now();
        connectDurationMs = safeDuration(connectedAt - startedAt);
        phase = "route-proof";
        const proofSignal = input.signal
          ? AbortSignal.any([input.signal, routeProofController.signal])
          : routeProofController.signal;
        void input
          .proveRoute({
            address: input.address,
            port: targetPort,
            signal: proofSignal,
          })
          .then(startTls)
          .catch(() => {
            if (input.signal?.aborted) onAbort();
            else if (!settled) fail("route_proof_failure");
          });
      });
      proxyRequest.once("error", (error) => {
        if (!settled) fail(classifyNetworkError(error, phase));
      });
      if (input.signal?.aborted) onAbort();
      if (settled) return;

      connectTimer = setTimeout(() => {
        if (settled) return;
        const category =
          phase === "connecting"
            ? "connect_timeout"
            : phase === "route-proof"
              ? "route_proof_failure"
              : "tls_timeout";
        fail(category);
      }, input.connectTimeoutMs);
      connectTimer.unref();
      totalTimer = setTimeout(() => {
        if (!settled) fail("total_timeout");
      }, input.totalTimeoutMs);
      totalTimer.unref();
      proxyRequest.end();
    } catch (error) {
      if (input.signal?.aborted) onAbort();
      else fail(classifyNetworkError(error, phase));
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
    throw new RangeError("invalid HTTPS connect timeout");
  }
  if (
    !Number.isInteger(totalTimeoutMs) ||
    totalTimeoutMs < connectTimeoutMs ||
    totalTimeoutMs > MAX_TOTAL_TIMEOUT_MS
  ) {
    throw new RangeError("invalid HTTPS total timeout");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new RangeError("invalid HTTPS redirect limit");
  }
  if (!Number.isSafeInteger(addressSelectionIndex) || addressSelectionIndex < 0) {
    throw new RangeError("invalid HTTPS address selection index");
  }
  return { connectTimeoutMs, totalTimeoutMs, maxRedirects, addressSelectionIndex };
}

interface ProbeExecutionOptions extends Omit<DirectProbeOptions, "requestPinnedImpl"> {
  direction: "direct" | "proxy";
  requestPinnedImpl: RequestPinnedImpl;
  resolverFetchImpl?: NonNullable<PublicResolutionOptions["fetchImpl"]>;
  resolverFailureCategory?: () => Extract<ProbeCategory, "proxy_auth_failure"> | null;
}

async function probeHttps(
  observedFqdn: string,
  options: ProbeExecutionOptions,
): Promise<DirectProbeResult | ProxyProbeResult> {
  const fqdn = normalizeObservedFqdn(observedFqdn);
  if (!fqdn) throw new TypeError("invalid HTTPS probe hostname");
  const { connectTimeoutMs, totalTimeoutMs, maxRedirects, addressSelectionIndex } =
    validateOptions(options);
  const resolveImpl = options.resolveImpl ?? resolvePublicAddresses;
  const requestPinnedImpl = options.requestPinnedImpl;
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
  let availableAddressCount = 0;

  const result = (
    category: ProbeCategory,
    input: {
      transportSuccess?: boolean;
      httpStatus?: number | null;
      resolvedAddress?: string | null;
      finalOrigin?: string | null;
    } = {},
  ): DirectProbeResult | ProxyProbeResult => ({
    direction: options.direction,
    category,
    transportSuccess: input.transportSuccess ?? false,
    httpStatus: input.httpStatus ?? null,
    resolvedAddress: input.resolvedAddress ?? null,
    availableAddressCount,
    connectDurationMs: hasConnectDuration ? connectDurationMs : null,
    tlsDurationMs: hasTlsDuration ? tlsDurationMs : null,
    totalDurationMs: safeDuration(now() - startedAt),
    redirectCount,
    finalOrigin: input.finalOrigin ?? target.origin,
  });

  while (true) {
    availableAddressCount = 0;
    let resolution: PublicResolutionResult;
    try {
      resolution = await resolveImpl(target.hostname, options.resolverUrls, {
        quorum: options.resolverQuorum,
        ...(options.resolverTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.resolverTimeoutMs }),
        ...(options.resolverFetchImpl === undefined
          ? {}
          : { fetchImpl: options.resolverFetchImpl }),
        signal: attemptSignal,
      });
    } catch {
      if (options.signal?.aborted) throw abortedReason(options.signal);
      if (deadlineSignal.aborted) return result("total_timeout", { finalOrigin: target.origin });
      const resolverFailure = options.resolverFailureCategory?.();
      if (resolverFailure) return result(resolverFailure, { finalOrigin: target.origin });
      return result("infrastructure_error", { finalOrigin: target.origin });
    }
    const resolverFailure = options.resolverFailureCategory?.();
    if (resolverFailure) return result(resolverFailure, { finalOrigin: target.origin });
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
    availableAddressCount = usableAddresses.length;
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

export async function probeDirectHttps(
  observedFqdn: string,
  options: DirectProbeOptions,
): Promise<DirectProbeResult> {
  return (await probeHttps(observedFqdn, {
    ...options,
    direction: "direct",
    requestPinnedImpl: options.requestPinnedImpl ?? requestPinnedHttps,
  })) as DirectProbeResult;
}

export function buildValidationProxyAgentOptions(
  proxy: ValidationProxyAuth,
): ConstructorParameters<typeof ProxyAgent>[0] {
  const normalized = normalizedProxyAuth(proxy);
  return {
    uri: normalized.endpoint,
    token: proxyAuthorization(normalized),
    proxyTunnel: true,
  };
}

interface ValidationProxyDispatcher {
  destroy(): Promise<void>;
}

type ValidationProxyRequestInit = Omit<RequestInit, "dispatcher"> & {
  dispatcher: ValidationProxyDispatcher;
};

interface ProxyResolverDependencies {
  createDispatcher?: (
    options: ConstructorParameters<typeof ProxyAgent>[0],
  ) => ValidationProxyDispatcher;
  fetchImpl?: (
    input: string | URL | Request,
    init: ValidationProxyRequestInit,
  ) => Promise<Response>;
}

function isProxyAuthenticationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (
      current instanceof undiciErrors.RequestAbortedError &&
      /^Proxy response \((?:403|407)\) !== 200 when HTTP Tunneling$/u.test(current.message)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export function createProxyResolver(
  proxy: ValidationProxyAuth,
  dependencies: ProxyResolverDependencies = {},
): ProxyResolverResource {
  const createDispatcher = dependencies.createDispatcher ?? ((options) => new ProxyAgent(options));
  const dispatcher = createDispatcher(buildValidationProxyAgentOptions(proxy));
  const fetchImpl =
    dependencies.fetchImpl ??
    (async (input: string | URL | Request, init: ValidationProxyRequestInit) =>
      (await undiciFetch(input as URL, init as never)) as unknown as Response);
  let failureCategory: Extract<ProbeCategory, "proxy_auth_failure"> | null = null;
  return {
    fetchImpl: async (input, init) => {
      try {
        return await fetchImpl(input, { ...init, dispatcher });
      } catch (error) {
        if (isProxyAuthenticationError(error)) failureCategory = "proxy_auth_failure";
        throw error;
      }
    },
    failureCategory: () => failureCategory,
    close: () => dispatcher.destroy(),
  };
}

export async function probeProxyHttps(
  observedFqdn: string,
  options: ProxyProbeOptions,
): Promise<ProxyProbeResult> {
  const proxy = normalizedProxyAuth(options.proxy);
  const resolver = (options.proxyResolverFactory ?? createProxyResolver)(proxy);
  const requestPinnedImpl = options.requestPinnedImpl ?? requestPinnedProxyHttps;
  try {
    return (await probeHttps(observedFqdn, {
      ...options,
      direction: "proxy",
      resolverFetchImpl: resolver.fetchImpl,
      ...(resolver.failureCategory ? { resolverFailureCategory: resolver.failureCategory } : {}),
      requestPinnedImpl: async (request) => {
        const proveRoute = await options.prepareRouteProof(request.signal);
        return await requestPinnedImpl({ ...request, proxy, proveRoute });
      },
    })) as ProxyProbeResult;
  } finally {
    await resolver.close();
  }
}
