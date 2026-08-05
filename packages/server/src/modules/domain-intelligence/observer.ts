import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { MihomoConnection, MihomoLogFrame } from "../../clients/mihomo.js";

export type ObservationTransport = "tcp" | "udp";
export type ObservationSource = "mihomo-log" | "connection-snapshot";

export interface DomainObservation {
  fqdn: string;
  observedAt: number;
  transport: ObservationTransport;
  source: ObservationSource;
  fingerprint: string;
}

export const OBSERVATION_RECONCILIATION_WINDOW_MS = 30_000;
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "lan",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
] as const;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const URL_HOST_DELIMITERS = new Set(["/", "\\", "?", "#", "%", "@", ":"]);
const ROUTING_MESSAGE =
  /^\[(TCP|UDP)\]\s+\S+\s+(?:-->|→)\s+([^\s:]+):(\d+)\s+(?:match\b|doesn't match\b|via\b).*$/u;

function hasSuffix(fqdn: string, suffix: string): boolean {
  return fqdn === suffix || fqdn.endsWith(`.${suffix}`);
}

function hasForbiddenHostSyntax(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || URL_HOST_DELIMITERS.has(character)) return true;
  }
  return false;
}

export function normalizeObservedFqdn(value: string): string | null {
  const trimmed = value.trim();
  const withoutTrailingDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (
    !withoutTrailingDot ||
    hasForbiddenHostSyntax(withoutTrailingDot) ||
    isIP(withoutTrailingDot) !== 0
  ) {
    return null;
  }

  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return null;
  if (isIP(ascii) !== 0 || INTERNAL_SUFFIXES.some((suffix) => hasSuffix(ascii, suffix)))
    return null;

  const labels = ascii.split(".");
  if (
    labels.some((label) => label.length === 0 || label.length > 63 || !DOMAIN_LABEL.test(label))
  ) {
    return null;
  }
  return ascii;
}

function normalizeTransport(value: unknown): ObservationTransport | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return normalized === "tcp" || normalized === "udp" ? normalized : null;
}

export function fingerprintObservation(
  fqdn: string,
  transport: ObservationTransport,
  observedAt: number,
): string {
  if (!isEpochMillis(observedAt)) throw new RangeError("invalid observation timestamp");
  const bucket = Math.floor(observedAt / OBSERVATION_RECONCILIATION_WINDOW_MS);
  return createHash("sha256").update(`${fqdn}\0${transport}\0${bucket}`).digest("hex");
}

function isEpochMillis(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function makeObservation(
  fqdn: string,
  transport: ObservationTransport,
  observedAt: number,
  source: ObservationSource,
): DomainObservation {
  return {
    fqdn,
    observedAt,
    transport,
    source,
    fingerprint: fingerprintObservation(fqdn, transport, observedAt),
  };
}

export function canReconcileObservations(
  left: DomainObservation,
  right: DomainObservation,
): boolean {
  return (
    left.source !== right.source &&
    left.fqdn === right.fqdn &&
    left.transport === right.transport &&
    Math.abs(left.observedAt - right.observedAt) <= OBSERVATION_RECONCILIATION_WINDOW_MS
  );
}

export function observationFromLogFrame(
  frame: MihomoLogFrame,
  observedAt: number = Date.now(),
): DomainObservation | null {
  if (frame.level !== "info" || !isEpochMillis(observedAt)) return null;
  const match = ROUTING_MESSAGE.exec(frame.message);
  if (!match) return null;
  const messageTransport = normalizeTransport(match[1]);
  const fieldTransport =
    frame.fields.network === undefined
      ? messageTransport
      : normalizeTransport(frame.fields.network);
  if (!messageTransport || !fieldTransport || fieldTransport !== messageTransport) return null;

  const rawHost =
    frame.fields.host === undefined
      ? (match[2] ?? "")
      : typeof frame.fields.host === "string"
        ? frame.fields.host
        : "";
  const fqdn = normalizeObservedFqdn(rawHost);
  const port = Number.parseInt(match[3] ?? "", 10);
  if (!fqdn || port < 1 || port > 65_535) return null;
  return makeObservation(fqdn, messageTransport, observedAt, "mihomo-log");
}

export function observationFromConnection(
  connection: MihomoConnection,
  snapshotAt: number = Date.now(),
): DomainObservation | null {
  if (!isEpochMillis(snapshotAt)) return null;
  const fqdn = normalizeObservedFqdn(connection.metadata.host);
  const transport = normalizeTransport(connection.metadata.network);
  if (!fqdn || !transport) return null;

  const parsedStart = Date.parse(connection.start);
  const observedAt =
    isEpochMillis(parsedStart) && parsedStart <= snapshotAt ? parsedStart : snapshotAt;
  return makeObservation(fqdn, transport, observedAt, "connection-snapshot");
}
