import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDomainRulesDeploymentCapability } from "./domain-rules.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("domain-rules deployment capability", () => {
  it("keeps the default deployment completely report-only", () => {
    expect(deriveDomainRulesDeploymentCapability("report")).toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
  });

  it("does not mistake the apply deployment switch for local-file readiness", () => {
    expect(deriveDomainRulesDeploymentCapability("apply")).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });

  it("rejects a capability source for a different deployment mode", async () => {
    vi.stubEnv("DOMAIN_RULES_MODE", "report");
    vi.resetModules();
    const [{ registerDomainRulesDeploymentCapabilitySource }, { DomainRuleDeploymentProvisioner }] =
      await Promise.all([
        import("./domain-rules.js"),
        import("../modules/domain-intelligence/provisioning.js"),
      ]);
    const provisioner = new DomainRuleDeploymentProvisioner("apply", {
      provisionStore: async () => undefined,
      forceApplyAndVerifyManagedProvider: async () => ({ providerRuleCount: 0 }),
    });

    expect(() => registerDomainRulesDeploymentCapabilitySource(provisioner)).toThrow(
      "domain-rule deployment capability mode mismatch",
    );
  });

  it("carries the process deployment mode into the default protected read model", async () => {
    vi.stubEnv("DB_PATH", ":memory:");
    vi.stubEnv("DOMAIN_RULES_MODE", "apply");
    vi.resetModules();

    const [
      { createDb },
      { getDomainIntelligenceSettingsView },
      { registerDomainRulesDeploymentCapabilitySource },
      { DomainRuleDeploymentProvisioner },
    ] = await Promise.all([
      import("../db/client.js"),
      import("../modules/domain-intelligence/service.js"),
      import("./domain-rules.js"),
      import("../modules/domain-intelligence/provisioning.js"),
    ]);
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });
    const provisioner = new DomainRuleDeploymentProvisioner("apply", {
      provisionStore: async () => undefined,
      forceApplyAndVerifyManagedProvider: async () => ({ providerRuleCount: 0 }),
    });
    registerDomainRulesDeploymentCapabilitySource(provisioner);

    expect(getDomainIntelligenceSettingsView(db).deployment).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });

    await provisioner.reconcile();
    expect(getDomainIntelligenceSettingsView(db).deployment).toMatchObject({
      mode: "apply",
      apply: { available: true, providerName: "submerge-custom" },
    });
  });
});
