import { PROBE_GROUP, SPEED_TEST_HOST } from "@submerge/shared";
import {
  type ActiveRulesResponse,
  getRuleProviders,
  getRules,
  type RuleProvidersResponse,
} from "../../clients/mihomo.js";
import { MANAGED_DOMAIN_RULE_PROVIDER_NAME } from "../nodes/multiConfig.js";

export class DomainRuleActivationError extends Error {
  override readonly name = "DomainRuleActivationError";
  readonly reason = "provider-inactive" as const;

  constructor() {
    super("managed domain-rule provider activation could not be proven");
  }
}

export interface ManagedDomainRuleActivationInput {
  signal?: AbortSignal | undefined;
  targetGroupName: string;
}

export interface ManagedDomainRuleActivationDeps {
  readRuleProviders: (signal?: AbortSignal) => Promise<RuleProvidersResponse>;
  readRules: (signal?: AbortSignal) => Promise<ActiveRulesResponse>;
}

export interface ManagedDomainRuleActivationProof {
  providerRuleCount: number;
}

const productionDeps: ManagedDomainRuleActivationDeps = {
  readRuleProviders: getRuleProviders,
  readRules: getRules,
};

function normalizedKind(value: string): string {
  return value.replace(/[-_\s]/gu, "").toLowerCase();
}

function isExpectedProbeRule(rule: ActiveRulesResponse["rules"][number] | undefined): boolean {
  return Boolean(
    rule &&
      rule.index === 0 &&
      normalizedKind(rule.type) === "domain" &&
      rule.payload === SPEED_TEST_HOST &&
      rule.proxy === PROBE_GROUP &&
      !rule.extra.disabled,
  );
}

export async function verifyManagedDomainRuleActivation(
  input: ManagedDomainRuleActivationInput,
  deps: ManagedDomainRuleActivationDeps = productionDeps,
): Promise<ManagedDomainRuleActivationProof> {
  try {
    input.signal?.throwIfAborted();
    const [providersResult, rulesResult] = await Promise.allSettled([
      deps.readRuleProviders(input.signal),
      deps.readRules(input.signal),
    ]);
    input.signal?.throwIfAborted();
    if (providersResult.status === "rejected") throw providersResult.reason;
    if (rulesResult.status === "rejected") throw rulesResult.reason;
    const providers = providersResult.value;
    const rules = rulesResult.value;
    const provider = providers.providers[MANAGED_DOMAIN_RULE_PROVIDER_NAME];
    if (
      !provider ||
      normalizedKind(provider.behavior) !== "domain" ||
      normalizedKind(provider.format) !== "text" ||
      provider.name !== MANAGED_DOMAIN_RULE_PROVIDER_NAME ||
      normalizedKind(provider.type) !== "rule" ||
      normalizedKind(provider.vehicleType) !== "file"
    ) {
      throw new DomainRuleActivationError();
    }
    const managedRoutes = rules.rules.filter(
      (rule) =>
        normalizedKind(rule.type) === "ruleset" &&
        rule.payload === MANAGED_DOMAIN_RULE_PROVIDER_NAME,
    );
    const probeRule = rules.rules[0];
    const managedRoute = managedRoutes[0];
    if (
      !isExpectedProbeRule(probeRule) ||
      managedRoutes.length !== 1 ||
      !managedRoute ||
      rules.rules[1] !== managedRoute ||
      managedRoute.index !== 1 ||
      managedRoute.extra.disabled ||
      managedRoute.proxy !== input.targetGroupName
    ) {
      throw new DomainRuleActivationError();
    }
    return { providerRuleCount: provider.ruleCount };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof DomainRuleActivationError) throw error;
    throw new DomainRuleActivationError();
  }
}
