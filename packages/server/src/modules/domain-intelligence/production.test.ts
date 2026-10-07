import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { domainCandidates } from "../../db/schema.js";
import { type DomainObservation, fingerprintObservation } from "./observer.js";
import { persistObservationAndQueueCandidate } from "./production.js";
import { setDomainIntelligenceReportSettings } from "./service.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

function observation(fqdn: string, observedAt: number): DomainObservation {
  return {
    fqdn,
    observedAt,
    transport: "tcp",
    source: "mihomo-log",
    fingerprint: fingerprintObservation(fqdn, "tcp", observedAt),
  };
}

describe("production domain observation pipeline", () => {
  it("persists while disabled but does not create or wake validation candidates", () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });
    const wake = vi.fn();

    persistObservationAndQueueCandidate(
      db,
      observation("api.service.example", 10_000),
      wake,
      () => 10_000,
    );

    expect(db.select().from(domainCandidates).all()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("derives and wakes an exact candidate from the fully validated enabled settings", () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });
    setDomainIntelligenceReportSettings(db, {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      automationMode: "review",
      defaultRuleScope: "exact",
    });
    const wake = vi.fn();

    for (const observedAt of [20_000, 60_000, 100_000]) {
      persistObservationAndQueueCandidate(
        db,
        observation("api.service.example", observedAt),
        wake,
        () => observedAt,
      );
    }

    expect(db.select().from(domainCandidates).all()).toEqual([
      expect.objectContaining({
        fqdn: "api.service.example",
        selectedScope: "exact",
        proposedRule: "api.service.example",
        status: "queued",
      }),
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("keeps never-add observations out of the active candidate queue", () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });
    setDomainIntelligenceReportSettings(db, {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      automationMode: "review",
      defaultRuleScope: "site",
      neverAddSuffixes: ["telemetry.example"],
    });
    const wake = vi.fn();

    persistObservationAndQueueCandidate(
      db,
      observation("metrics.telemetry.example", 30_000),
      wake,
      () => 30_000,
    );

    expect(db.select().from(domainCandidates).all()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});
