import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDomainRulesDeploymentCapability } from "./domain-rules.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("domain-rules deployment capability", () => {
  it("keeps the default deployment completely report-only", () => {
    expect(deriveDomainRulesDeploymentCapability("report")).toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
  });

  it("does not mistake the apply deployment switch for repository readiness", () => {
    expect(deriveDomainRulesDeploymentCapability("apply")).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });

  it("carries the process deployment mode into the default protected read model", async () => {
    vi.stubEnv("DB_PATH", ":memory:");
    vi.stubEnv("DOMAIN_RULES_MODE", "apply");
    vi.resetModules();

    const [{ createDb }, { getDomainIntelligenceSettingsView }] = await Promise.all([
      import("../db/client.js"),
      import("../modules/domain-intelligence/service.js"),
    ]);
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });

    expect(getDomainIntelligenceSettingsView(db).deployment).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });
});
