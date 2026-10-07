import { domainToASCII } from "node:url";
import { parse } from "tldts";
import { normalizeObservedFqdn } from "./observer.js";

export type RuleScope = "exact" | "site";

export interface DomainFilterPolicy {
  excludedTlds: readonly string[];
  neverAddDomains: readonly string[];
  neverAddSuffixes: readonly string[];
  nonWidenableSuffixes: readonly string[];
  telemetryPatterns: readonly string[];
}

export type DomainExclusionReason =
  | "excluded-tld"
  | "never-add-domain"
  | "never-add-suffix"
  | "telemetry-pattern"
  | "invalid-policy";

export type SiteUnavailableReason = "public-suffix" | "non-widenable-suffix";

export interface DomainCandidateModel {
  fqdn: string;
  registrableSite: string | null;
  publicSuffix: string | null;
  excluded: boolean;
  exclusionReason: DomainExclusionReason | null;
  eligibleScopes: RuleScope[];
  selectedScope: RuleScope | null;
  proposedRule: string | null;
  siteUnavailableReason: SiteUnavailableReason | null;
}

interface RuleTarget {
  fqdn: string;
  registrableSite: string | null;
}

interface NormalizedDomainFilterPolicy {
  excludedTlds: string[];
  neverAddDomains: string[];
  neverAddSuffixes: string[];
  nonWidenableSuffixes: string[];
  telemetryPatterns: string[];
}

const POLICY_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const TELEMETRY_LABEL = /^[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?$/u;
const FORBIDDEN_POLICY_SYNTAX = new Set(["/", "\\", "?", "#", "%", "@", ":"]);

function hasForbiddenPolicySyntax(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || FORBIDDEN_POLICY_SYNTAX.has(character)) {
      return true;
    }
  }
  return false;
}

function normalizePolicyDomain(value: string, allowSingleLabel: boolean): string | null {
  if (hasForbiddenPolicySyntax(value)) return null;
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253 || (!allowSingleLabel && !ascii.includes("."))) return null;

  const labels = ascii.split(".");
  if (
    labels.some((label) => label.length === 0 || label.length > 63 || !POLICY_LABEL.test(label))
  ) {
    return null;
  }
  return ascii;
}

function normalizePolicyValues(
  values: readonly string[],
  allowSingleLabel: boolean,
): string[] | null {
  const normalized = new Set<string>();
  for (const value of values) {
    const domain = normalizePolicyDomain(value, allowSingleLabel);
    if (!domain) return null;
    normalized.add(domain);
  }
  return [...normalized];
}

function normalizeTelemetryPatterns(patterns: readonly string[]): string[] | null {
  const normalized = new Set<string>();
  for (const rawPattern of patterns) {
    if (hasForbiddenPolicySyntax(rawPattern) || rawPattern.length > 253) return null;
    const pattern = rawPattern.toLowerCase();
    const labels = pattern.split(".");
    if (
      labels.some(
        (label) => label.length === 0 || label.length > 63 || !TELEMETRY_LABEL.test(label),
      )
    ) {
      return null;
    }
    normalized.add(pattern);
  }
  return [...normalized];
}

function normalizePolicy(policy: DomainFilterPolicy): NormalizedDomainFilterPolicy | null {
  const excludedTlds = normalizePolicyValues(policy.excludedTlds, true);
  const neverAddDomains = normalizePolicyValues(policy.neverAddDomains, false);
  const neverAddSuffixes = normalizePolicyValues(policy.neverAddSuffixes, false);
  const nonWidenableSuffixes = normalizePolicyValues(policy.nonWidenableSuffixes, false);
  const telemetryPatterns = normalizeTelemetryPatterns(policy.telemetryPatterns);
  if (
    !excludedTlds ||
    excludedTlds.some((tld) => tld.includes(".")) ||
    !neverAddDomains ||
    !neverAddSuffixes ||
    !nonWidenableSuffixes ||
    !telemetryPatterns
  ) {
    return null;
  }
  return {
    excludedTlds,
    neverAddDomains,
    neverAddSuffixes,
    nonWidenableSuffixes,
    telemetryPatterns,
  };
}

function hasDomainSuffix(fqdn: string, suffix: string): boolean {
  return fqdn === suffix || fqdn.endsWith(`.${suffix}`);
}

function matchesTelemetryPattern(fqdn: string, pattern: string): boolean {
  const patternLabels = pattern.split(".");
  const domainLabels = fqdn.split(".");
  if (patternLabels.length > domainLabels.length) return false;
  const lastOffset = domainLabels.length - patternLabels.length;

  for (let offset = 0; offset <= lastOffset; offset += 1) {
    const matches = patternLabels.every((patternLabel, index) => {
      const domainLabel = domainLabels[offset + index];
      if (domainLabel === undefined) return false;
      const expression = new RegExp(
        `^${patternLabel
          .split("*")
          .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
          .join(".*")}$`,
        "u",
      );
      return expression.test(domainLabel);
    });
    if (matches) return true;
  }
  return false;
}

function exclusionReason(
  fqdn: string,
  policy: NormalizedDomainFilterPolicy,
): DomainExclusionReason | null {
  const tld = fqdn.slice(fqdn.lastIndexOf(".") + 1);
  if (policy.excludedTlds.includes(tld)) return "excluded-tld";

  if (policy.neverAddDomains.includes(fqdn)) return "never-add-domain";

  if (policy.neverAddSuffixes.some((suffix) => hasDomainSuffix(fqdn, suffix))) {
    return "never-add-suffix";
  }

  if (policy.telemetryPatterns.some((pattern) => matchesTelemetryPattern(fqdn, pattern))) {
    return "telemetry-pattern";
  }
  return null;
}

export function serializeDomainRule(target: RuleTarget, scope: RuleScope): string {
  const fqdn = normalizeObservedFqdn(target.fqdn);
  if (!fqdn || fqdn !== target.fqdn) throw new Error("invalid rule hostname");
  if (scope === "exact") return fqdn;
  if (!target.registrableSite) throw new Error("site scope requires a registrable site");
  const registrableSite = normalizeObservedFqdn(target.registrableSite);
  if (!registrableSite || registrableSite !== target.registrableSite) {
    throw new Error("invalid registrable site");
  }
  const expectedSite = parse(fqdn, {
    allowPrivateDomains: true,
    extractHostname: false,
  }).domain;
  if (registrableSite !== expectedSite) throw new Error("registrable site does not match hostname");
  return `+.${registrableSite}`;
}

export function deriveDomainCandidate(
  observedFqdn: string,
  policy: DomainFilterPolicy,
  preferredScope: RuleScope,
): DomainCandidateModel | null {
  const fqdn = normalizeObservedFqdn(observedFqdn);
  if (!fqdn) return null;

  const parsed = parse(fqdn, {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  const registrableSite = parsed.domain;
  const publicSuffix = parsed.publicSuffix;
  const normalizedPolicy = normalizePolicy(policy);
  if (!normalizedPolicy) {
    return {
      fqdn,
      registrableSite,
      publicSuffix,
      excluded: true,
      exclusionReason: "invalid-policy",
      eligibleScopes: [],
      selectedScope: null,
      proposedRule: null,
      siteUnavailableReason: registrableSite ? null : "public-suffix",
    };
  }
  const reason = exclusionReason(fqdn, normalizedPolicy);
  if (reason) {
    return {
      fqdn,
      registrableSite,
      publicSuffix,
      excluded: true,
      exclusionReason: reason,
      eligibleScopes: [],
      selectedScope: null,
      proposedRule: null,
      siteUnavailableReason: registrableSite ? null : "public-suffix",
    };
  }

  const protectedBoundary = normalizedPolicy.nonWidenableSuffixes.some((suffix) =>
    hasDomainSuffix(fqdn, suffix),
  );
  const siteUnavailableReason: SiteUnavailableReason | null = !registrableSite
    ? "public-suffix"
    : protectedBoundary
      ? "non-widenable-suffix"
      : null;
  const eligibleScopes: RuleScope[] = siteUnavailableReason ? ["exact"] : ["exact", "site"];
  const selectedScope = preferredScope === "site" && !siteUnavailableReason ? "site" : "exact";

  return {
    fqdn,
    registrableSite,
    publicSuffix,
    excluded: false,
    exclusionReason: null,
    eligibleScopes,
    selectedScope,
    proposedRule: serializeDomainRule({ fqdn, registrableSite }, selectedScope),
    siteUnavailableReason,
  };
}
