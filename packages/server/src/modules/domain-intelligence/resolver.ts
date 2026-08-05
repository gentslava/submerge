import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { normalizeObservedFqdn } from "./observer.js";

const DNS_RESPONSE_MAX_BYTES = 65_536;
const MAX_EXTERNAL_RESOLVERS = 4;
const DEFAULT_RESOLVER_TIMEOUT_MS = 5_000;
const MAX_RESOLVER_TIMEOUT_MS = 30_000;

const dnsJsonSchema = z.object({
  Status: z.number().int().nonnegative(),
  Answer: z
    .array(
      z.object({
        type: z.number().int(),
        data: z.string(),
      }),
    )
    .optional()
    .default([]),
});

type DnsQueryType = "A" | "AAAA";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResolverOutcome {
  resolverId: string;
  status: "resolved" | "negative" | "failed" | "unsafe";
  publicAddressCount: number;
  rejectedAnswerCount: number;
}

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
  resolverIds: string[];
}

export interface PublicResolutionResult {
  status: "resolved" | "quorum-failed";
  quorumRequired: number;
  quorumReached: number;
  addresses: ResolvedPublicAddress[];
  outcomes: ResolverOutcome[];
}

export interface PublicResolutionOptions {
  quorum: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

const NON_GLOBAL_IPV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_GLOBAL_IPV4.addSubnet(address, prefix, "ipv4");
}

const NON_GLOBAL_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  NON_GLOBAL_IPV6.addSubnet(address, prefix, "ipv6");
}

const GLOBAL_IPV6_EXCEPTIONS = new BlockList();
for (const [address, prefix] of [
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
] as const) {
  GLOBAL_IPV6_EXCEPTIONS.addSubnet(address, prefix, "ipv6");
}
const GLOBAL_IPV6_EXACT = new Set(["2001:1::1", "2001:1::2", "2001:1::3"]);

function canonicalIpAddress(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

export function isPublicIpAddress(address: string): boolean {
  const canonical = canonicalIpAddress(address);
  if (!canonical) return false;
  const version = isIP(canonical);
  if (version === 4) {
    if (canonical === "192.0.0.9" || canonical === "192.0.0.10") {
      return true;
    }
    return !NON_GLOBAL_IPV4.check(canonical, "ipv4");
  }
  if (version !== 6 || (canonical[0] !== "2" && canonical[0] !== "3")) return false;
  if (GLOBAL_IPV6_EXACT.has(canonical) || GLOBAL_IPV6_EXCEPTIONS.check(canonical, "ipv6")) {
    return true;
  }
  return !NON_GLOBAL_IPV6.check(canonical, "ipv6");
}

export function canonicalPublicIpAddress(address: string): string | null {
  const canonical = canonicalIpAddress(address);
  return canonical && isPublicIpAddress(canonical) ? canonical : null;
}

interface QueryResult {
  status: "answered" | "negative" | "failed";
  publicAddresses: string[];
  rejectedAnswerCount: number;
}

function normalizedResolverUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(hostname) !== 0) {
      if (!isPublicIpAddress(hostname)) return null;
    } else {
      const normalizedHostname = normalizeObservedFqdn(hostname);
      if (!normalizedHostname) return null;
      url.hostname = normalizedHostname;
    }
    return url;
  } catch {
    return null;
  }
}

async function readDnsJson(response: Response): Promise<z.infer<typeof dnsJsonSchema> | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > DNS_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > DNS_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return dnsJsonSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

async function queryResolver(
  endpoint: URL,
  fqdn: string,
  type: DnsQueryType,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<QueryResult> {
  const url = new URL(endpoint);
  url.searchParams.set("name", fqdn);
  url.searchParams.set("type", type);

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/dns-json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: "failed", publicAddresses: [], rejectedAnswerCount: 0 };
    }
    const body = await readDnsJson(response);
    if (!body) return { status: "failed", publicAddresses: [], rejectedAnswerCount: 0 };
    if (body.Status !== 0) {
      return {
        status: body.Status === 3 ? "negative" : "failed",
        publicAddresses: [],
        rejectedAnswerCount: 0,
      };
    }

    const expectedType = type === "A" ? 1 : 28;
    const publicAddresses = new Set<string>();
    let rejectedAnswerCount = 0;
    for (const answer of body.Answer) {
      if (answer.type !== expectedType) continue;
      const family = isIP(answer.data);
      if (family !== (type === "A" ? 4 : 6) || !isPublicIpAddress(answer.data)) {
        rejectedAnswerCount += 1;
        continue;
      }
      const canonical = canonicalIpAddress(answer.data);
      if (!canonical) {
        rejectedAnswerCount += 1;
        continue;
      }
      publicAddresses.add(canonical);
    }
    return {
      status: publicAddresses.size > 0 ? "answered" : "negative",
      publicAddresses: [...publicAddresses],
      rejectedAnswerCount,
    };
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    return { status: "failed", publicAddresses: [], rejectedAnswerCount: 0 };
  }
}

async function resolveOne(
  endpoint: URL,
  resolverId: string,
  fqdn: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<{ outcome: ResolverOutcome; addresses: string[] }> {
  const [ipv4, ipv6] = await Promise.all([
    queryResolver(endpoint, fqdn, "A", fetchImpl, signal, callerSignal),
    queryResolver(endpoint, fqdn, "AAAA", fetchImpl, signal, callerSignal),
  ]);
  const addresses = [...new Set([...ipv4.publicAddresses, ...ipv6.publicAddresses])];
  const rejectedAnswerCount = ipv4.rejectedAnswerCount + ipv6.rejectedAnswerCount;
  const status: ResolverOutcome["status"] =
    addresses.length > 0
      ? "resolved"
      : rejectedAnswerCount > 0
        ? "unsafe"
        : ipv4.status === "failed" || ipv6.status === "failed"
          ? "failed"
          : "negative";
  return {
    addresses,
    outcome: {
      resolverId,
      status,
      publicAddressCount: addresses.length,
      rejectedAnswerCount,
    },
  };
}

export async function resolvePublicAddresses(
  observedFqdn: string,
  resolverUrls: readonly string[],
  options: PublicResolutionOptions,
): Promise<PublicResolutionResult> {
  const fqdn = normalizeObservedFqdn(observedFqdn);
  if (!fqdn) throw new TypeError("invalid resolver hostname");

  const endpoints = new Map<string, URL>();
  for (const raw of resolverUrls) {
    const url = normalizedResolverUrl(raw);
    // Quorum means independent network authorities, not multiple resources or
    // spellings of the same DoH server.
    if (url && !endpoints.has(url.origin)) endpoints.set(url.origin, url);
  }
  if (endpoints.size > MAX_EXTERNAL_RESOLVERS) {
    throw new RangeError("too many external resolvers");
  }
  if (!Number.isInteger(options.quorum) || options.quorum < 1 || options.quorum > endpoints.size) {
    throw new RangeError("resolver quorum exceeds valid unique resolvers");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RESOLVER_TIMEOUT_MS) {
    throw new RangeError("invalid resolver timeout");
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = await Promise.all(
    [...endpoints.values()].map((endpoint, index) =>
      resolveOne(endpoint, `resolver-${index + 1}`, fqdn, fetchImpl, signal, options.signal),
    ),
  );
  const outcomes = resolved.map((item) => item.outcome);
  const quorumReached = outcomes.filter((outcome) => outcome.status === "resolved").length;
  if (quorumReached < options.quorum) {
    return {
      status: "quorum-failed",
      quorumRequired: options.quorum,
      quorumReached,
      addresses: [],
      outcomes,
    };
  }

  const addressSources = new Map<string, string[]>();
  for (const item of resolved) {
    for (const address of item.addresses) {
      const sources = addressSources.get(address) ?? [];
      sources.push(item.outcome.resolverId);
      addressSources.set(address, sources);
    }
  }
  const addresses = [...addressSources]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([address, resolverIds]): ResolvedPublicAddress => ({
        address,
        family: isIP(address) as 4 | 6,
        resolverIds,
      }),
    );
  return {
    status: "resolved",
    quorumRequired: options.quorum,
    quorumReached,
    addresses,
    outcomes,
  };
}
