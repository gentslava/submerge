import {
  type DomainIntelligenceDeploymentCapability,
  domainIntelligenceDeploymentCapabilitySchema,
} from "@submerge/shared";
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

export const domainRulesDeploymentCapability = deriveDomainRulesDeploymentCapability(
  env.DOMAIN_RULES_MODE,
);
