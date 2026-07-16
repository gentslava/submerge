import type {
  DiagnosticCheckStatus,
  DiagnosticRouteResult,
  DiagnosticServiceResult,
  DiagnosticState,
} from "@submerge/shared";
import type { ProxiesResponse } from "../../clients/mihomo.js";

export function resolveActiveLeaf(
  proxies: ProxiesResponse["proxies"],
  groupName: string,
): string | null {
  const visited = new Set<string>();
  let current = groupName;
  while (!visited.has(current)) {
    visited.add(current);
    const proxy = proxies[current];
    if (!proxy) return null;
    if (!proxy.all) return current;
    if (!proxy.now) return null;
    current = proxy.now;
  }
  return null;
}

export function safeTargetHost(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return "контрольный URL";
    }
    return url.hostname;
  } catch {
    return "контрольный URL";
  }
}

export interface DiagnosticStateInput {
  mihomoStatus: DiagnosticCheckStatus;
  realNodeCount: number;
  externalIpStatus: DiagnosticCheckStatus;
  routes: readonly DiagnosticRouteResult[];
  services: readonly DiagnosticServiceResult[];
  remainingRequiredStatuses: readonly DiagnosticCheckStatus[];
}

export function deriveDiagnosticState(input: DiagnosticStateInput): DiagnosticState {
  if (input.mihomoStatus === "failed") return "mihomo-down";
  if (input.realNodeCount === 0) return "no-nodes";

  const outbound = [input.externalIpStatus, ...input.routes, ...input.services].map((entry) =>
    typeof entry === "string" ? entry : entry.status,
  );
  const attemptedOutbound = outbound.filter((status) => status !== "skipped");
  if (attemptedOutbound.length > 0 && attemptedOutbound.every((status) => status === "failed")) {
    return "no-internet";
  }

  const allOtherRequired = [
    ...input.routes.map((route) => route.status),
    ...input.services.map((service) => service.status),
    ...input.remainingRequiredStatuses,
  ];
  if (input.externalIpStatus === "failed" && allOtherRequired.every((status) => status === "ok")) {
    return "external-ip-unavailable";
  }

  if (input.externalIpStatus !== "ok" || allOtherRequired.some((status) => status !== "ok")) {
    return "partial";
  }
  return "ready";
}
