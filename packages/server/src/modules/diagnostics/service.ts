import {
  channelGroupName,
  type DiagnosticErrorCode,
  type DiagnosticRouteResult,
  type DiagnosticServiceResult,
  type DiagnosticsResult,
  diagnosticsResultSchema,
  type ProxyChannel,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { sql } from "drizzle-orm";
import type {
  ExternalIpTrace,
  MihomoRuntimeConfig,
  MihomoVersion,
  ProxiesResponse,
} from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import { SUBMERGE_VERSION } from "../../version.js";
import { resolveMatcherDomains } from "../channels/presets.js";
import { listChannels, policyProbe } from "../channels/service.js";
import { getSetting } from "../settings/service.js";
import { deriveDiagnosticState, resolveActiveLeaf, safeTargetHost } from "./model.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const OPERATION_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 15_000;
const MAX_CONCURRENCY = 6;

type ComponentResult = DiagnosticsResult["components"][number];
type ExternalIpResult = DiagnosticsResult["externalIp"];
type RuntimeConfigResult = DiagnosticsResult["config"];

interface ServiceProbe {
  id: DiagnosticServiceResult["id"];
  label: string;
  url: string;
  accepts(status: number): boolean;
}

export const SERVICE_PROBES: readonly ServiceProbe[] = [
  {
    id: "google",
    label: "Google",
    url: "https://www.google.com/generate_204",
    accepts: (status) => status === 204,
  },
  {
    id: "youtube",
    label: "YouTube",
    url: "https://www.youtube.com/generate_204",
    accepts: (status) => status === 204,
  },
  {
    id: "telegram",
    label: "Telegram",
    url: "https://telegram.org/favicon.ico",
    accepts: (status) => status >= 200 && status <= 399,
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    accepts: (status) => status === 200,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com/favicon.ico",
    accepts: (status) => status >= 200 && status <= 499,
  },
  {
    id: "steam",
    label: "Steam",
    url: "https://store.steampowered.com/favicon.ico",
    accepts: (status) => status >= 200 && status <= 399,
  },
] as const;

export interface DiagnosticsServiceDeps {
  db: Db;
  getVersion(signal?: AbortSignal): Promise<MihomoVersion>;
  healthHapp(signal?: AbortSignal): Promise<{ ok: true }>;
  getProxies(signal?: AbortSignal): Promise<ProxiesResponse>;
  getRuntimeConfig(signal?: AbortSignal): Promise<MihomoRuntimeConfig>;
  getExternalIpTrace(signal?: AbortSignal): Promise<ExternalIpTrace>;
  getDelay(
    name: string,
    url?: string,
    options?: { timeoutMs?: number; expected?: "200-399"; signal?: AbortSignal },
  ): Promise<{ delay: number }>;
  probeThroughProxy(url: string, signal?: AbortSignal): Promise<{ status: number }>;
  now?: () => number;
  monotonicNow?: () => number;
  proxyEndpointFallback: string;
  checkDb?: () => Promise<void>;
  runChecks?: () => Promise<DiagnosticsResult>;
}

interface ClassifiedError {
  code: DiagnosticErrorCode;
  detail: string;
}

function classifyError(error: unknown): ClassifiedError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "TimeoutError" || message.includes("timeout") || message.includes("time out")) {
    return { code: "timeout", detail: "Превышено время ожидания" };
  }
  if (
    message.includes("invalid") ||
    message.includes("unexpected") ||
    message.includes("parse") ||
    message.includes("trace")
  ) {
    return { code: "invalid-response", detail: "Некорректный ответ" };
  }
  if (message.includes("http")) return { code: "http-error", detail: "HTTP-ошибка" };
  if (
    name === "AbortError" ||
    message.includes("unreachable") ||
    message.includes("fetch") ||
    message.includes("dns") ||
    message.includes("getaddrinfo") ||
    message.includes("enotfound") ||
    message.includes("tls") ||
    message.includes("connect")
  ) {
    return { code: "unreachable", detail: "Сервис недоступен" };
  }
  return { code: "unknown", detail: "Проверка не выполнена" };
}

function skippedError(
  code: Extract<
    DiagnosticErrorCode,
    "dependency-unavailable" | "no-active-node" | "no-proxy-nodes"
  >,
): ClassifiedError {
  if (code === "dependency-unavailable") {
    return { code, detail: "mihomo недоступен" };
  }
  if (code === "no-active-node") {
    return { code, detail: "Активный узел не определён" };
  }
  return { code, detail: "Прокси-узлы отсутствуют" };
}

function operationSignal(overallSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([overallSignal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
}

function monotonicNow(deps: DiagnosticsServiceDeps): number {
  return deps.monotonicNow ? deps.monotonicNow() : performance.now();
}

async function raceSignal<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function timed<T>(
  deps: DiagnosticsServiceDeps,
  overallSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const started = monotonicNow(deps);
  const signal = operationSignal(overallSignal);
  if (signal.aborted) throw signal.reason;
  const value = await raceSignal(
    signal,
    Promise.resolve().then(() => work(signal)),
  );
  return {
    value,
    durationMs: Math.max(0, monotonicNow(deps) - started),
  };
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) await worker(item, index);
    }
  });
  await Promise.all(runners);
}

function realNodeCount(proxies: ProxiesResponse["proxies"]): number {
  return Object.values(proxies).filter(
    (proxy) => !proxy.all && !PSEUDO_NODE_SET.has(proxy.name) && !proxy.name.startsWith("ch-"),
  ).length;
}

function externalRouteAttribution(
  allChannels: ReturnType<typeof listChannels>,
  proxies: ProxiesResponse["proxies"],
): { route: string; node: string | null } {
  const host = "www.cloudflare.com";
  let uncertain = false;
  const enabled = allChannels.filter((channel) => channel.enabled);
  for (const channel of enabled) {
    if (channel.isDefault) continue;
    const deterministicMatch =
      channel.matcher.keywords.some((keyword) => host.includes(keyword.toLowerCase())) ||
      resolveMatcherDomains(channel.matcher).some((domain) => {
        const normalized = domain.toLowerCase();
        return host === normalized || host.endsWith(`.${normalized}`);
      });
    if (deterministicMatch) {
      if (uncertain) return { route: "через mihomo · текущие правила", node: null };
      if (channel.target === "direct") return { route: channel.name, node: "DIRECT" };
      return {
        route: channel.name,
        node: resolveActiveLeaf(proxies, channelGroupName(channel)),
      };
    }
    if (
      channel.matcher.ruleProviders.length > 0 ||
      channel.matcher.geosite.length > 0 ||
      channel.matcher.geoip.length > 0 ||
      channel.matcher.cidrs.length > 0
    ) {
      uncertain = true;
    }
  }
  if (uncertain) return { route: "через mihomo · текущие правила", node: null };
  const defaultChannel = enabled.find(
    (channel): channel is ProxyChannel => channel.target === "proxy" && channel.isDefault,
  );
  return defaultChannel
    ? {
        route: defaultChannel.name,
        node: resolveActiveLeaf(proxies, channelGroupName(defaultChannel)),
      }
    : { route: "через mihomo · текущие правила", node: null };
}

async function checkComponent(
  deps: DiagnosticsServiceDeps,
  overallSignal: AbortSignal,
  id: ComponentResult["id"],
  version: string | null,
  work: (signal: AbortSignal) => Promise<string | null>,
): Promise<ComponentResult> {
  try {
    const result = await timed(deps, overallSignal, work);
    return {
      id,
      status: "ok",
      durationMs: result.durationMs,
      version: result.value ?? version,
      detail:
        id === "submerge"
          ? "SQLite доступна"
          : id === "mihomo"
            ? "Контроллер доступен"
            : "Доступен",
      errorCode: null,
    };
  } catch (error) {
    const failure = classifyError(error);
    return {
      id,
      status: "failed",
      durationMs: null,
      version,
      detail: failure.detail,
      errorCode: failure.code,
    };
  }
}

function skippedServices(): DiagnosticServiceResult[] {
  const error = skippedError("dependency-unavailable");
  return SERVICE_PROBES.map((probe) => ({
    id: probe.id,
    label: probe.label,
    status: "skipped",
    durationMs: null,
    httpStatus: null,
    detail: error.detail,
    errorCode: error.code,
  }));
}

function skippedExternal(code: "dependency-unavailable" | "no-proxy-nodes"): ExternalIpResult {
  const error = skippedError(code);
  return {
    status: "skipped",
    ip: null,
    country: null,
    colo: null,
    durationMs: null,
    route: null,
    node: null,
    detail: error.detail,
    errorCode: error.code,
  };
}

function skippedConfig(proxyEndpoint: string): RuntimeConfigResult {
  const error = skippedError("dependency-unavailable");
  return {
    status: "skipped",
    proxyEndpoint,
    mode: null,
    dns: null,
    ipv6: null,
    tun: null,
    errorCode: error.code,
  };
}

function summary(
  routes: readonly DiagnosticRouteResult[],
  services: readonly DiagnosticServiceResult[],
) {
  const attemptedRoutes = routes.filter((entry) => entry.status !== "skipped");
  const attemptedServices = services.filter((entry) => entry.status !== "skipped");
  const workingRoutes = attemptedRoutes.filter((entry) => entry.status === "ok").length;
  const workingServices = attemptedServices.filter((entry) => entry.status === "ok").length;
  return `${workingRoutes} из ${attemptedRoutes.length} маршрутов · ${workingServices} из ${attemptedServices.length} сервисов`;
}

function safeProxyEndpoint(deps: DiagnosticsServiceDeps): string {
  try {
    return getSetting(deps.db, "proxyEndpoint") || deps.proxyEndpointFallback || "—";
  } catch {
    return deps.proxyEndpointFallback || "—";
  }
}

async function executeDiagnostics(deps: DiagnosticsServiceDeps): Promise<DiagnosticsResult> {
  const now = deps.now ?? Date.now;
  const startedEpoch = now();
  const startedMono = monotonicNow(deps);
  const overallSignal = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  const proxyEndpoint = safeProxyEndpoint(deps);
  const checkDb = deps.checkDb ?? (async () => void deps.db.run(sql`select 1`));

  const [submerge, mihomoInitial, happ] = await Promise.all([
    checkComponent(deps, overallSignal, "submerge", SUBMERGE_VERSION, async (signal) => {
      await raceSignal(signal, Promise.resolve().then(checkDb));
      return SUBMERGE_VERSION;
    }),
    checkComponent(deps, overallSignal, "mihomo", null, async (signal) => {
      const result = await deps.getVersion(signal);
      return result.version;
    }),
    checkComponent(deps, overallSignal, "happ-decoder", null, async (signal) => {
      await deps.healthHapp(signal);
      return null;
    }),
  ]);
  let mihomo = mihomoInitial;
  let routes: DiagnosticRouteResult[] = [];
  let services: DiagnosticServiceResult[] = skippedServices();
  let externalIp = skippedExternal("dependency-unavailable");
  let config = skippedConfig(proxyEndpoint);
  let nodes = 0;

  if (mihomo.status === "ok") {
    let proxyView: ProxiesResponse;
    try {
      proxyView = (await timed(deps, overallSignal, (signal) => deps.getProxies(signal))).value;
    } catch (error) {
      const failure = classifyError(error);
      mihomo = {
        ...mihomo,
        status: "failed",
        detail: failure.detail,
        errorCode: failure.code,
      };
      proxyView = { proxies: {} };
    }

    if (mihomo.status === "ok") {
      nodes = realNodeCount(proxyView.proxies);
      const allChannels = listChannels(deps.db);
      const proxyChannels = allChannels.filter(
        (channel): channel is ProxyChannel => channel.target === "proxy" && channel.enabled,
      );
      routes = proxyChannels.map((channel) => {
        const target = policyProbe(channel.policy);
        const activeLeaf = resolveActiveLeaf(proxyView.proxies, channelGroupName(channel));
        if (!activeLeaf) {
          const error = skippedError("no-active-node");
          return {
            channelId: channel.id,
            channelName: channel.name,
            targetHost: safeTargetHost(target.url),
            node: null,
            status: "skipped",
            durationMs: null,
            detail: error.detail,
            errorCode: error.code,
          };
        }
        if (nodes === 0 && !channel.isDefault) {
          const error = skippedError("no-proxy-nodes");
          return {
            channelId: channel.id,
            channelName: channel.name,
            targetHost: safeTargetHost(target.url),
            node: activeLeaf,
            status: "skipped",
            durationMs: null,
            detail: error.detail,
            errorCode: error.code,
          };
        }
        return {
          channelId: channel.id,
          channelName: channel.name,
          targetHost: safeTargetHost(target.url),
          node: activeLeaf,
          status: "ok",
          durationMs: null,
          detail: activeLeaf === "DIRECT" ? "Прямой маршрут" : "Маршрут доступен",
          errorCode: null,
        };
      });
      services = SERVICE_PROBES.map((probe) => ({
        id: probe.id,
        label: probe.label,
        status: "failed",
        durationMs: null,
        httpStatus: null,
        detail: "Проверка не выполнена",
        errorCode: "unknown",
      }));
      externalIp =
        nodes === 0
          ? skippedExternal("no-proxy-nodes")
          : {
              status: "failed",
              ip: null,
              country: null,
              colo: null,
              durationMs: null,
              route: null,
              node: null,
              detail: "Проверка не выполнена",
              errorCode: "unknown",
            };
      config = {
        status: "failed",
        proxyEndpoint,
        mode: null,
        dns: null,
        ipv6: null,
        tun: null,
        errorCode: "unknown",
      };

      const jobs: Array<() => Promise<void>> = [];
      jobs.push(async () => {
        try {
          const result = await timed(deps, overallSignal, (signal) =>
            deps.getRuntimeConfig(signal),
          );
          config = {
            status: "ok",
            proxyEndpoint,
            ...result.value,
            errorCode: null,
          };
        } catch (error) {
          config = {
            ...config,
            status: "failed",
            errorCode: classifyError(error).code,
          };
        }
      });
      if (nodes > 0) {
        jobs.push(async () => {
          try {
            const result = await timed(deps, overallSignal, (signal) =>
              deps.getExternalIpTrace(signal),
            );
            const attribution = externalRouteAttribution(allChannels, proxyView.proxies);
            externalIp = {
              status: "ok",
              ...result.value,
              durationMs: result.durationMs,
              ...attribution,
              detail: "Внешний IP определён",
              errorCode: null,
            };
          } catch (error) {
            const failure = classifyError(error);
            externalIp = {
              ...externalIp,
              status: "failed",
              detail: failure.detail,
              errorCode: failure.code,
            };
          }
        });
      }
      for (const [index, channel] of proxyChannels.entries()) {
        const row = routes[index];
        if (!row || row.status === "skipped" || !row.node || row.node === "DIRECT") continue;
        jobs.push(async () => {
          try {
            const probe = policyProbe(channel.policy);
            const result = await timed(deps, overallSignal, (signal) =>
              deps.getDelay(row.node as string, probe.url, {
                timeoutMs: OPERATION_TIMEOUT_MS,
                expected: "200-399",
                signal,
              }),
            );
            routes[index] = {
              ...row,
              status: "ok",
              durationMs: result.value.delay,
              detail: "Маршрут доступен",
              errorCode: null,
            };
          } catch (error) {
            const failure = classifyError(error);
            routes[index] = {
              ...row,
              status: "failed",
              durationMs: null,
              detail: failure.detail,
              errorCode: failure.code,
            };
          }
        });
      }
      for (const [index, probe] of SERVICE_PROBES.entries()) {
        jobs.push(async () => {
          try {
            const result = await timed(deps, overallSignal, (signal) =>
              deps.probeThroughProxy(probe.url, signal),
            );
            const ok = probe.accepts(result.value.status);
            services[index] = {
              id: probe.id,
              label: probe.label,
              status: ok ? "ok" : "failed",
              durationMs: result.durationMs,
              httpStatus: result.value.status,
              detail: ok ? "Доступен" : `HTTP ${result.value.status}`,
              errorCode: ok ? null : "http-error",
            };
          } catch (error) {
            const failure = classifyError(error);
            services[index] = {
              id: probe.id,
              label: probe.label,
              status: "failed",
              durationMs: null,
              httpStatus: null,
              detail: failure.detail,
              errorCode: failure.code,
            };
          }
        });
      }
      await mapLimit(jobs, MAX_CONCURRENCY, (job) => job());
    }
  }

  const components = [submerge, mihomo, happ];
  const state = deriveDiagnosticState({
    mihomoStatus: mihomo.status,
    realNodeCount: nodes,
    externalIpStatus: externalIp.status,
    routes,
    services,
    remainingRequiredStatuses: [submerge.status, happ.status, config.status],
  });
  const completedEpoch = now();
  return diagnosticsResultSchema.parse({
    startedAt: new Date(startedEpoch).toISOString(),
    completedAt: new Date(completedEpoch).toISOString(),
    durationMs: Math.max(0, monotonicNow(deps) - startedMono),
    state,
    summary: summary(routes, services),
    components,
    externalIp,
    routes,
    services,
    config,
  });
}

function fatalResult(deps: DiagnosticsServiceDeps): DiagnosticsResult {
  const timestamp = new Date((deps.now ?? Date.now)()).toISOString();
  const proxyEndpoint = safeProxyEndpoint(deps);
  const unavailable = skippedError("dependency-unavailable");
  return diagnosticsResultSchema.parse({
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    state: "partial",
    summary: "Проверка завершилась с ошибкой",
    components: [
      {
        id: "submerge",
        status: "failed",
        durationMs: null,
        version: SUBMERGE_VERSION,
        detail: "Проверка не выполнена",
        errorCode: "unknown",
      },
      {
        id: "mihomo",
        status: "skipped",
        durationMs: null,
        version: null,
        detail: unavailable.detail,
        errorCode: unavailable.code,
      },
      {
        id: "happ-decoder",
        status: "skipped",
        durationMs: null,
        version: null,
        detail: "Проверка не выполнена",
        errorCode: "unknown",
      },
    ],
    externalIp: skippedExternal("dependency-unavailable"),
    routes: [],
    services: skippedServices(),
    config: skippedConfig(proxyEndpoint),
  });
}

export class DiagnosticsService {
  private readonly deps: DiagnosticsServiceDeps;
  private result: DiagnosticsResult | null = null;
  private completedAt: number | null = null;
  private inFlight: Promise<DiagnosticsResult> | null = null;

  constructor(deps: DiagnosticsServiceDeps) {
    this.deps = deps;
  }

  async run(input: { force?: boolean } = {}): Promise<DiagnosticsResult> {
    if (this.inFlight) return this.inFlight;
    if (
      !input.force &&
      this.result &&
      this.completedAt !== null &&
      (this.deps.now ?? Date.now)() - this.completedAt < CACHE_TTL_MS
    ) {
      return this.result;
    }

    const pending = Promise.resolve()
      .then(() => this.deps.runChecks?.() ?? executeDiagnostics(this.deps))
      .then((result) => diagnosticsResultSchema.parse(result))
      .catch(() => fatalResult(this.deps));
    this.inFlight = pending;
    try {
      const result = await pending;
      this.result = result;
      this.completedAt = (this.deps.now ?? Date.now)();
      return result;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }
}
