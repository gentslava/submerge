import { isIP } from "node:net";
import { isValidKeyword, ruleProviderFormat } from "@submerge/shared";
import * as yaml from "js-yaml";
import { type ChannelConfigInput, ruleProviderName } from "../nodes/multiConfig.js";
import { normalizeObservedFqdn } from "./observer.js";

export type CoverageRuleKind = "exact" | "suffix" | "keyword";
export type CoverageSourceKind = "inline" | "custom" | "notblocked" | "third-party";

export interface ActiveDomainRule {
  kind: CoverageRuleKind;
  value: string;
  sourceId: string;
}

export interface ActiveRuleProvider {
  sourceId: string;
  sourceKind: Exclude<CoverageSourceKind, "inline">;
  behavior: "domain" | "ipcidr" | "classical";
  format: "text" | "yaml" | "mrs" | "unknown";
  content: string | null;
}

export interface ProviderMaterialization {
  content: string | null;
  sourceKind: Exclude<CoverageSourceKind, "inline">;
}

export interface OpaqueDomainMatcher {
  sourceId: string;
  kind: "geosite";
  value: string;
}

export interface DomainCoverageModel {
  rules: readonly ActiveDomainRule[];
  providers: readonly ActiveRuleProvider[];
  opaqueMatchers: readonly OpaqueDomainMatcher[];
}

export interface CoverageMatch {
  kind: CoverageRuleKind;
  rule: string;
  sourceKind: CoverageSourceKind;
  sourceId: string;
}

export interface CoverageResult {
  status: "covered" | "uncovered" | "incomplete";
  match: CoverageMatch | null;
  incompleteSourceIds: string[];
}

export const MAX_PROVIDER_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_ENTRIES = 50_000;
export const MAX_PROVIDER_LINE_LENGTH = 4_096;

export function coverageModelFromActiveChannels(
  channels: readonly ChannelConfigInput[],
  materializedProviders: ReadonlyMap<string, ProviderMaterialization>,
): DomainCoverageModel {
  const hasExitNode = channels.some(
    (channel) => channel.target === "proxy" && channel.proxies.length > 0,
  );
  if (!hasExitNode) return { rules: [], providers: [], opaqueMatchers: [] };

  const rules: ActiveDomainRule[] = [];
  const providers = new Map<string, ActiveRuleProvider>();
  const opaqueMatchers: OpaqueDomainMatcher[] = [];

  for (const channel of channels) {
    if (channel.isDefault) continue;
    const sourceId = `channel:${channel.id}`;
    for (const value of channel.keywords ?? []) rules.push({ kind: "keyword", value, sourceId });
    for (const value of channel.domains) rules.push({ kind: "suffix", value, sourceId });
    for (const ref of channel.ruleProviders ?? []) {
      const providerId = ruleProviderName(ref);
      if (providers.has(providerId)) continue;
      const materialized = materializedProviders.get(providerId);
      providers.set(providerId, {
        sourceId: providerId,
        sourceKind: materialized?.sourceKind ?? "third-party",
        behavior: ref.behavior,
        format: ruleProviderFormat(ref.url),
        content: materialized?.content ?? null,
      });
    }
    for (const value of channel.geosite ?? []) {
      opaqueMatchers.push({ kind: "geosite", value, sourceId });
    }
  }

  return { rules, providers: [...providers.values()], opaqueMatchers };
}

function hasDomainSuffix(fqdn: string, suffix: string): boolean {
  return fqdn === suffix || fqdn.endsWith(`.${suffix}`);
}

function normalizeRule(rule: ActiveDomainRule): ActiveDomainRule | null {
  if (rule.kind === "keyword") {
    const value = rule.value.trim().toLowerCase();
    return isValidKeyword(value) ? { ...rule, value } : null;
  }
  const value = normalizeObservedFqdn(rule.value);
  return value ? { ...rule, value } : null;
}

function matchRule(
  fqdn: string,
  rule: ActiveDomainRule,
  sourceKind: CoverageSourceKind,
): CoverageMatch | null {
  const matches =
    rule.kind === "exact"
      ? rule.value === fqdn
      : rule.kind === "suffix"
        ? hasDomainSuffix(fqdn, rule.value)
        : fqdn.includes(rule.value);
  if (!matches) return null;

  return {
    kind: rule.kind,
    rule: rule.value,
    sourceKind,
    sourceId: rule.sourceId,
  };
}

function boundedLines(content: string): string[] | null {
  if (Buffer.byteLength(content, "utf8") > MAX_PROVIDER_CONTENT_BYTES) return null;
  const lines = content.split(/\r?\n/gu);
  if (
    lines.length > MAX_PROVIDER_ENTRIES + 2 ||
    lines.some((line) => line.length > MAX_PROVIDER_LINE_LENGTH)
  ) {
    return null;
  }
  return lines;
}

function textEntries(content: string): string[] | null {
  const lines = boundedLines(content);
  if (!lines) return null;
  const entries = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return entries.length <= MAX_PROVIDER_ENTRIES ? entries : null;
}

function domainProviderRule(entry: string, sourceId: string): ActiveDomainRule {
  return entry.startsWith("+.")
    ? { kind: "suffix", value: entry.slice(2), sourceId }
    : { kind: "exact", value: entry, sourceId };
}

function yamlEntries(content: string): string[] | null {
  const lines = boundedLines(content);
  if (!lines || lines.some((line) => line.includes("\t"))) return null;

  const entries: string[] = [];
  let sawPayload = false;
  let explicitEmpty = false;
  let finished = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || (!sawPayload && trimmed === "---")) continue;
    if (trimmed === "...") {
      finished = true;
      continue;
    }
    if (finished) return null;
    if (!sawPayload) {
      if (/^payload:\s*(?:#.*)?$/u.test(trimmed)) {
        sawPayload = true;
        continue;
      }
      if (/^payload:\s*\[\s*\]\s*(?:#.*)?$/u.test(trimmed)) {
        sawPayload = true;
        explicitEmpty = true;
        continue;
      }
      return null;
    }
    if (explicitEmpty) return null;

    const match = /^\s+-\s+(.+)$/u.exec(line);
    if (!match?.[1]) return null;
    try {
      const scalar: unknown = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA });
      if (typeof scalar !== "string" || !scalar.trim()) return null;
      entries.push(scalar.trim());
      if (entries.length > MAX_PROVIDER_ENTRIES) return null;
    } catch {
      return null;
    }
  }
  return sawPayload && (explicitEmpty || entries.length > 0) ? entries : null;
}

function providerEntries(provider: ActiveRuleProvider): string[] | null {
  if (provider.content === null || provider.format === "mrs" || provider.format === "unknown") {
    return null;
  }
  if (provider.format === "text") return textEntries(provider.content);
  return yamlEntries(provider.content);
}

type ClassicalEntry =
  | { status: "rule"; rule: ActiveDomainRule }
  | { status: "irrelevant" }
  | { status: "incomplete" };

const TARGET_IP_RULES = new Set(["GEOIP", "IP-ASN", "IP-CIDR", "IP-CIDR6", "IP-SUFFIX"]);
const SOURCE_IP_RULES = new Set(["SRC-GEOIP", "SRC-IP-ASN", "SRC-IP-CIDR", "SRC-IP-SUFFIX"]);
const IP_NETWORK_RULES = new Set([
  "IP-CIDR",
  "IP-CIDR6",
  "IP-SUFFIX",
  "SRC-IP-CIDR",
  "SRC-IP-SUFFIX",
]);
const PORT_RULES = new Set(["DST-PORT", "IN-PORT", "SRC-PORT"]);

function validIpNetwork(value: string): boolean {
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return false;
  const address = value.slice(0, slash);
  const prefix = Number(value.slice(slash + 1));
  const version = isIP(address);
  return (
    Number.isInteger(prefix) &&
    ((version === 4 && prefix >= 0 && prefix <= 32) ||
      (version === 6 && prefix >= 0 && prefix <= 128))
  );
}

function validAsn(value: string): boolean {
  if (!/^\d{1,10}$/u.test(value)) return false;
  const asn = Number(value);
  return Number.isSafeInteger(asn) && asn > 0 && asn <= 4_294_967_295;
}

function validGeoCode(value: string): boolean {
  return /^(?:[A-Za-z]{2}|LAN|PRIVATE)$/u.test(value);
}

function validPortExpression(value: string): boolean {
  if (!value) return false;
  return value.split(/[/,]/u).every((part) => {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/u.exec(part.trim());
    if (!match?.[1]) return false;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    return start >= 1 && start <= 65_535 && end >= start && end <= 65_535;
  });
}

function validIpRule(kind: string, value: string, rest: readonly string[]): boolean {
  const options = rest.map((option) => option.trim().toLowerCase());
  if (options.some((option) => option !== "no-resolve" && option !== "src")) return false;
  if (SOURCE_IP_RULES.has(kind) && options.length > 0) return false;
  if (IP_NETWORK_RULES.has(kind)) return validIpNetwork(value);
  if (kind.endsWith("ASN")) return validAsn(value);
  return validGeoCode(value);
}

function classicalProviderRule(entry: string, sourceId: string): ClassicalEntry {
  const [rawKind, rawValue, ...rest] = entry.split(",");
  if (rawKind === undefined || rawValue === undefined) return { status: "incomplete" };
  const kind = rawKind.trim().toUpperCase();
  const value = rawValue.trim();
  if (kind === "DOMAIN" && rest.length === 0) {
    return { status: "rule", rule: { kind: "exact", value, sourceId } };
  }
  if (kind === "DOMAIN-SUFFIX" && rest.length === 0) {
    return { status: "rule", rule: { kind: "suffix", value, sourceId } };
  }
  if (kind === "DOMAIN-KEYWORD" && rest.length === 0) {
    return { status: "rule", rule: { kind: "keyword", value, sourceId } };
  }
  if (TARGET_IP_RULES.has(kind) || SOURCE_IP_RULES.has(kind)) {
    return validIpRule(kind, value, rest) ? { status: "irrelevant" } : { status: "incomplete" };
  }
  if (PORT_RULES.has(kind)) {
    return validPortExpression([value, ...rest].join(","))
      ? { status: "irrelevant" }
      : { status: "incomplete" };
  }
  return { status: "incomplete" };
}

type ParsedProvider = { status: "complete"; rules: ActiveDomainRule[] } | { status: "incomplete" };

function parseProvider(provider: ActiveRuleProvider): ParsedProvider {
  const entries = providerEntries(provider);
  if (!entries) return { status: "incomplete" };

  const rules: ActiveDomainRule[] = [];
  for (const entry of entries) {
    let rule: ActiveDomainRule;
    if (provider.behavior === "domain") {
      rule = domainProviderRule(entry, provider.sourceId);
    } else {
      const parsed = classicalProviderRule(entry, provider.sourceId);
      if (parsed.status === "incomplete") return { status: "incomplete" };
      if (parsed.status === "irrelevant") continue;
      rule = parsed.rule;
    }
    const normalizedRule = normalizeRule(rule);
    if (!normalizedRule) return { status: "incomplete" };
    rules.push(normalizedRule);
  }
  return { status: "complete", rules };
}

export function evaluateDomainCoverage(
  observedFqdn: string,
  model: DomainCoverageModel,
): CoverageResult {
  const fqdn = normalizeObservedFqdn(observedFqdn);
  if (!fqdn) {
    return { status: "incomplete", match: null, incompleteSourceIds: ["observed-fqdn"] };
  }

  const incompleteSourceIds = new Set<string>();

  for (const rule of model.rules) {
    const normalizedRule = normalizeRule(rule);
    if (!normalizedRule) {
      incompleteSourceIds.add(rule.sourceId);
      continue;
    }
    const match = matchRule(fqdn, normalizedRule, "inline");
    if (match) {
      return { status: "covered", match, incompleteSourceIds: [] };
    }
  }

  for (const provider of model.providers) {
    if (provider.behavior === "ipcidr") continue;
    const parsed = parseProvider(provider);
    if (parsed.status === "incomplete") {
      incompleteSourceIds.add(provider.sourceId);
      continue;
    }
    for (const rule of parsed.rules) {
      const match = matchRule(fqdn, rule, provider.sourceKind);
      if (match) return { status: "covered", match, incompleteSourceIds: [] };
    }
  }

  for (const matcher of model.opaqueMatchers) incompleteSourceIds.add(matcher.sourceId);
  if (incompleteSourceIds.size > 0) {
    return {
      status: "incomplete",
      match: null,
      incompleteSourceIds: [...incompleteSourceIds],
    };
  }
  return { status: "uncovered", match: null, incompleteSourceIds: [] };
}
