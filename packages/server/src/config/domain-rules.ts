import {
  type DomainIntelligenceDeploymentCapability,
  domainIntelligenceDeploymentCapabilitySchema,
} from "@submerge/shared";
import type { DomainRuleDeploymentProvisioner } from "../modules/domain-intelligence/provisioning.js";
import { type Env, env } from "./env.js";

export function deriveDomainRulesDeploymentCapability(
  mode: Env["DOMAIN_RULES_MODE"],
): DomainIntelligenceDeploymentCapability {
  return domainIntelligenceDeploymentCapabilitySchema.parse(
    mode === "report"
      ? {
          mode,
          apply: { available: false, reason: "deployment-report-only" },
        }
      : {
          mode,
          apply: { available: false, reason: "local-store-unavailable" },
        },
  );
}

let domainRulesDeploymentCapabilitySource: DomainRuleDeploymentProvisioner | null = null;

export function readDomainRulesDeploymentCapability(): DomainIntelligenceDeploymentCapability {
  return domainIntelligenceDeploymentCapabilitySchema.parse(
    domainRulesDeploymentCapabilitySource?.readCapability() ??
      deriveDomainRulesDeploymentCapability(env.DOMAIN_RULES_MODE),
  );
}

export function registerDomainRulesDeploymentCapabilitySource(
  source: DomainRuleDeploymentProvisioner,
): () => void {
  if (domainRulesDeploymentCapabilitySource !== null) {
    throw new Error("domain-rule deployment capability source is already registered");
  }
  const parsed = domainIntelligenceDeploymentCapabilitySchema.parse(source.readCapability());
  if (parsed.mode !== env.DOMAIN_RULES_MODE) {
    throw new Error("domain-rule deployment capability mode mismatch");
  }
  domainRulesDeploymentCapabilitySource = source;
  return () => {
    if (domainRulesDeploymentCapabilitySource === source) {
      domainRulesDeploymentCapabilitySource = null;
    }
  };
}
