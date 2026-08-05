import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import {
  domainAutomaticBudgets,
  domainAutomaticConsents,
  domainCandidates,
  domainDecisions,
  domainRuleOperations,
  domainRuleOwnership,
  settings,
} from "../../db/schema.js";
import { DomainRulePreparedVetoError } from "./apply-errors.js";
import {
  beginDomainRuleActivation,
  buildDomainAutomaticConsentRevision,
  completeDomainRuleActivation,
  finalizeDomainRuleWrite,
  prepareDomainRuleOperation,
} from "./apply-journal.js";
import {
  type DomainRuleApplyOperationDependencies,
  DomainRuleOperationReconciliationError,
  executeDomainRuleOperation,
} from "./apply-operation.js";
import { DomainRuleStoreError } from "./rule-store.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const SOURCE_REVISION = "1".repeat(40);
const RESULT_REVISION = "2".repeat(40);
const CONTENT_SHA = "a".repeat(64);
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function migratedDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  return db;
}

function prepareManual(db: Db, id = "manual-add-1") {
  return prepareDomainRuleOperation(
    db,
    {
      id,
      idempotencyKey: id,
      action: "manual-add",
      expectedSourceRevision: SOURCE_REVISION,
      intendedContentSha256: CONTENT_SHA,
      proposedRule: "+.service.example",
      ownershipDelta: {
        upserts: [{ rule: "+.service.example", ownership: "manual" }],
        deletes: [],
      },
    },
    { clock: () => NOW - 1_000 },
  );
}

function prepareAutomatic(db: Db, id = "automatic-add-1") {
  const automatic = {
    ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    enabled: true,
    automationMode: "review" as const,
    defaultRuleScope: "site" as const,
  };
  db.insert(settings)
    .values({ key: "domainIntelligence", value: JSON.stringify(automatic) })
    .run();
  db.insert(domainAutomaticConsents)
    .values({
      id: "consent-1",
      revision: buildDomainAutomaticConsentRevision(automatic),
      enabledAt: NOW - 2_000,
      revokedAt: null,
    })
    .run();
  db.insert(domainCandidates)
    .values({
      fqdn: "api.service.example",
      registrableSite: "service.example",
      selectedScope: "site",
      proposedRule: "+.service.example",
      exclusionReason: null,
      status: "confirmed",
      reviewState: "active",
      firstSeenAt: NOW - 86_400_000,
      lastSeenAt: NOW - 2_000,
      nextValidationAt: NOW,
      lastValidationAt: NOW - 2_000,
      failureStreak: 0,
      leaseId: null,
      leaseUntil: null,
      leaseGeneration: 0,
      updatedAt: NOW - 2_000,
    })
    .run();
  db.insert(domainDecisions)
    .values({
      id: "confirmed-api-service-example",
      fqdn: "api.service.example",
      evaluatedAt: NOW - 2_000,
      status: "confirmed",
      confidence: "high",
      reasons: [],
      windowStart: NOW - 86_400_000,
      evidence: {
        directQualifyingFailures: 3,
        directSpacedFailures: 3,
        directAddressDiversityRequired: false,
        directAddressDiversitySatisfied: true,
        proxyHttpSuccesses: 2,
        proxyTransportFailures: 0,
        proxyUncertainFailures: 0,
      },
      selectedScope: "site",
      proposedRule: "+.service.example",
    })
    .run();
  return prepareDomainRuleOperation(
    db,
    {
      id,
      idempotencyKey: id,
      action: "automatic-add",
      candidateFqdn: "api.service.example",
      expectedSourceRevision: SOURCE_REVISION,
      intendedContentSha256: CONTENT_SHA,
      proposedRule: "+.service.example",
      ownershipDelta: {
        upserts: [{ rule: "+.service.example", ownership: "automatic" }],
        deletes: [],
      },
    },
    { clock: () => NOW - 1_000 },
  );
}

function successfulDependencies(events: string[] = []): DomainRuleApplyOperationDependencies {
  return {
    assertExecutionAllowed: vi.fn(async () => {
      events.push("allowed");
    }),
    preflightPrepared: vi.fn(async () => {
      events.push("preflight");
    }),
    attestOperation: vi.fn(async () => {
      events.push("attest");
      return { state: "expected", revision: SOURCE_REVISION, contentSha256: "b".repeat(64) };
    }),
    commitPrepared: vi.fn(async () => {
      events.push("write");
      return {
        changed: true,
        revision: RESULT_REVISION,
        previousRevision: SOURCE_REVISION,
        contentSha256: CONTENT_SHA,
      };
    }),
    attestWritten: vi.fn(async () => {
      events.push("attest-written");
    }),
    activateCommitted: vi.fn(async () => {
      events.push("activate");
      return { outcome: "succeeded" };
    }),
  };
}

function row(db: Db, operationId: string) {
  return db
    .select()
    .from(domainRuleOperations)
    .where(eq(domainRuleOperations.id, operationId))
    .get();
}

describe("executeDomainRuleOperation", () => {
  it("writes, finalizes, attests, activates, and completes one prepared operation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const events: string[] = [];
    const dependencies = successfulDependencies(events);

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toEqual({
      operationId: "manual-add-1",
      phase: "completed",
      contentSha256: CONTENT_SHA,
      activationAttempt: 1,
    });

    expect(events).toEqual([
      "allowed",
      "attest",
      "preflight",
      "write",
      "attest-written",
      "activate",
      "attest-written",
    ]);
    expect(dependencies.commitPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "manual-add-1",
        expectedSourceRevision: SOURCE_REVISION,
        intendedContentSha256: CONTENT_SHA,
        upsertRules: ["+.service.example"],
        deleteRules: [],
      }),
    );
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "completed",
      resultingRevision: RESULT_REVISION,
      activationStatus: "succeeded",
      activationAttemptCount: 1,
    });
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({
      rule: "+.service.example",
      ownership: "manual",
      operationId: "manual-add-1",
      resultingRevision: RESULT_REVISION,
    });
  });

  it("recovers a file write that completed before SQLite finalization", async () => {
    const db = migratedDb();
    prepareManual(db);
    const events: string[] = [];
    const dependencies = successfulDependencies(events);
    vi.mocked(dependencies.attestOperation).mockImplementation(async () => {
      events.push("attest");
      return {
        state: "written",
        revision: RESULT_REVISION,
        previousRevision: SOURCE_REVISION,
        contentSha256: CONTENT_SHA,
      };
    });

    await executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW });

    expect(events).toEqual(["allowed", "attest", "attest-written", "activate", "attest-written"]);
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "completed",
      resultingRevision: RESULT_REVISION,
      resultingContentSha256: CONTENT_SHA,
    });
  });

  it("rechecks automatic consent after preflight and before the local write", async () => {
    const db = migratedDb();
    prepareAutomatic(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.preflightPrepared).mockImplementation(async () => {
      db.update(domainAutomaticConsents)
        .set({ revokedAt: NOW })
        .where(eq(domainAutomaticConsents.id, "consent-1"))
        .run();
    });

    await expect(
      executeDomainRuleOperation(db, "automatic-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toMatchObject({ phase: "aborted" });

    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "automatic-add-1")).toMatchObject({ phase: "aborted", resultingRevision: null });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 0,
    });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
  });

  it("consumes the automatic reservation only after a successful local write", async () => {
    const db = migratedDb();
    prepareAutomatic(db);

    await executeDomainRuleOperation(db, "automatic-add-1", successfulDependencies(), {
      clock: () => NOW,
    });

    expect(row(db, "automatic-add-1")).toMatchObject({ phase: "completed" });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 1,
    });
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({ ownership: "automatic" });
  });

  it("removes a committed candidate from the active queue across partial activation retry", async () => {
    const db = migratedDb();
    prepareAutomatic(db);
    const firstDependencies = successfulDependencies();
    vi.mocked(firstDependencies.attestWritten).mockRejectedValue(new Error("disk unavailable"));

    await expect(
      executeDomainRuleOperation(db, "automatic-add-1", firstDependencies, { clock: () => NOW }),
    ).resolves.toMatchObject({ phase: "partial" });
    expect(
      db
        .select()
        .from(domainCandidates)
        .where(eq(domainCandidates.fqdn, "api.service.example"))
        .get(),
    ).toMatchObject({ status: "blocked", nextValidationAt: 8_640_000_000_000_000 });

    await expect(
      executeDomainRuleOperation(db, "automatic-add-1", successfulDependencies(), {
        clock: () => NOW + 1_000,
      }),
    ).resolves.toMatchObject({ phase: "completed" });
    expect(
      db
        .select()
        .from(domainDecisions)
        .where(eq(domainDecisions.fqdn, "api.service.example"))
        .all(),
    ).toHaveLength(2);
  });

  it("rejects a fresh write that aliases its prepared parent", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockResolvedValue({
      changed: true,
      revision: SOURCE_REVISION,
      previousRevision: SOURCE_REVISION,
      contentSha256: CONTENT_SHA,
    });

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule written result does not match prepared intent");
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", resultingRevision: null });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.attestWritten).not.toHaveBeenCalled();
  });

  it("rejects a fresh rule-store result that did not advance the source revision", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockResolvedValue({
      changed: false,
      revision: RESULT_REVISION,
      previousRevision: SOURCE_REVISION,
      contentSha256: CONTENT_SHA,
    });

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule written result does not match prepared intent");
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", resultingRevision: null });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.attestWritten).not.toHaveBeenCalled();
  });

  it("rejects malformed attestation discriminants before preflight or file write", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockResolvedValue({
      state: "bogus",
      revision: SOURCE_REVISION,
      contentSha256: "b".repeat(64),
    } as never);

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule attestation returned an invalid result");
    expect(dependencies.preflightPrepared).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", resultingRevision: null });
  });

  it("resumes a committed operation without repeating preflight, attestation, or write", async () => {
    const db = migratedDb();
    prepareManual(db);
    finalizeDomainRuleWrite(
      db,
      {
        operationId: "manual-add-1",
        resultingRevision: RESULT_REVISION,
        resultingContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    const events: string[] = [];
    const dependencies = successfulDependencies(events);

    await executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW });

    expect(events).toEqual(["allowed", "attest-written", "activate", "attest-written"]);
    expect(dependencies.preflightPrepared).not.toHaveBeenCalled();
    expect(dependencies.attestOperation).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });

  it("fails closed when a committed journal row no longer matches its prepared digest", async () => {
    const db = migratedDb();
    prepareManual(db);
    finalizeDomainRuleWrite(
      db,
      {
        operationId: "manual-add-1",
        resultingRevision: RESULT_REVISION,
        resultingContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    db.update(domainRuleOperations)
      .set({ resultingContentSha256: "b".repeat(64) })
      .where(eq(domainRuleOperations.id, "manual-add-1"))
      .run();
    const dependencies = successfulDependencies();

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule written content does not match prepared intent");
    expect(dependencies.attestWritten).not.toHaveBeenCalled();
    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
  });

  it("requires the written digest to remain stable through activation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestWritten)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        new DomainRuleStoreError(
          "local-store-reconciliation-required",
          "local domain-rule source changed",
        ),
      );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("local domain-rule source changed");
    expect(dependencies.activateCommitted).toHaveBeenCalledOnce();
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      activationStatus: "failed",
      activationErrorCategory: "infrastructure-failure",
    });
  });

  it("rejects the source revision as the result revision during recovery", async () => {
    for (const targetPhase of ["committed", "completed"] as const) {
      const db = migratedDb();
      prepareManual(db);
      finalizeDomainRuleWrite(
        db,
        {
          operationId: "manual-add-1",
          resultingRevision: RESULT_REVISION,
          resultingContentSha256: CONTENT_SHA,
        },
        { clock: () => NOW - 500 },
      );
      if (targetPhase === "completed") {
        const activation = beginDomainRuleActivation(db, "manual-add-1", {
          clock: () => NOW - 400,
        });
        completeDomainRuleActivation(
          db,
          { operationId: "manual-add-1", attempt: activation.attempt, outcome: "succeeded" },
          { clock: () => NOW - 300 },
        );
      }
      db.update(domainRuleOperations)
        .set({ resultingRevision: SOURCE_REVISION })
        .where(eq(domainRuleOperations.id, "manual-add-1"))
        .run();
      const dependencies = successfulDependencies();

      await expect(
        executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
      ).rejects.toThrow("domain-rule write must advance the prepared revision");
      expect(dependencies.attestWritten).not.toHaveBeenCalled();
      expect(dependencies.activateCommitted).not.toHaveBeenCalled();
    }
  });

  it("persists a materialization failure as a retryable partial attempt", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestWritten).mockRejectedValue(new Error("disk unavailable"));

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toEqual({
      operationId: "manual-add-1",
      phase: "partial",
      contentSha256: CONTENT_SHA,
      activationAttempt: 1,
      errorCategory: "materialization-failure",
    });

    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "partial",
      activationStatus: "failed",
      activationAttemptCount: 1,
      activationErrorCategory: "materialization-failure",
    });
  });

  it("persists typed activation failure and advances the attempt on retry", async () => {
    const db = migratedDb();
    prepareManual(db);
    const firstDependencies = successfulDependencies();
    vi.mocked(firstDependencies.activateCommitted).mockResolvedValue({
      outcome: "failed",
      errorCategory: "provider-proof-failure",
    });

    await executeDomainRuleOperation(db, "manual-add-1", firstDependencies, {
      clock: () => NOW,
    });
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "partial",
      activationAttemptCount: 1,
      activationErrorCategory: "provider-proof-failure",
    });

    const retryDependencies = successfulDependencies();
    await expect(
      executeDomainRuleOperation(db, "manual-add-1", retryDependencies, {
        clock: () => NOW + 1,
      }),
    ).resolves.toMatchObject({ phase: "completed", activationAttempt: 2 });
  });

  it("resumes the same in-progress attempt after a process restart", async () => {
    const db = migratedDb();
    prepareManual(db);
    finalizeDomainRuleWrite(
      db,
      {
        operationId: "manual-add-1",
        resultingRevision: RESULT_REVISION,
        resultingContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    beginDomainRuleActivation(db, "manual-add-1", { clock: () => NOW - 250 });
    const dependencies = successfulDependencies();

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toMatchObject({ phase: "completed", activationAttempt: 1 });
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "completed",
      activationAttemptCount: 1,
    });
  });

  it("turns thrown or malformed activation results into a durable infrastructure failure", async () => {
    const thrownDb = migratedDb();
    prepareManual(thrownDb, "thrown-op");
    const thrownDependencies = successfulDependencies();
    vi.mocked(thrownDependencies.activateCommitted).mockRejectedValue(new Error("reload crashed"));

    await expect(
      executeDomainRuleOperation(thrownDb, "thrown-op", thrownDependencies, {
        clock: () => NOW,
      }),
    ).resolves.toMatchObject({ phase: "partial", errorCategory: "infrastructure-failure" });

    const malformedDb = migratedDb();
    prepareManual(malformedDb, "malformed-op");
    const malformedDependencies = successfulDependencies();
    vi.mocked(malformedDependencies.activateCommitted).mockResolvedValue({
      outcome: "failed",
      errorCategory: "not-a-real-category",
    } as never);

    await expect(
      executeDomainRuleOperation(malformedDb, "malformed-op", malformedDependencies, {
        clock: () => NOW,
      }),
    ).resolves.toMatchObject({ phase: "partial", errorCategory: "infrastructure-failure" });
    expect(row(malformedDb, "malformed-op")).toMatchObject({
      phase: "partial",
      activationErrorCategory: "infrastructure-failure",
    });

    const contradictoryDb = migratedDb();
    prepareManual(contradictoryDb, "contradictory-op");
    const contradictoryDependencies = successfulDependencies();
    vi.mocked(contradictoryDependencies.activateCommitted).mockResolvedValue({
      outcome: "succeeded",
      errorCategory: "provider-proof-failure",
    } as never);

    await expect(
      executeDomainRuleOperation(contradictoryDb, "contradictory-op", contradictoryDependencies, {
        clock: () => NOW,
      }),
    ).resolves.toMatchObject({ phase: "partial", errorCategory: "infrastructure-failure" });
  });

  it("records shutdown after activation starts and leaves prepared failures untouched", async () => {
    const shutdownDb = migratedDb();
    prepareManual(shutdownDb, "shutdown-op");
    const controller = new AbortController();
    const shutdownDependencies = successfulDependencies();
    vi.mocked(shutdownDependencies.attestWritten).mockImplementation(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });

    await expect(
      executeDomainRuleOperation(shutdownDb, "shutdown-op", shutdownDependencies, {
        clock: () => NOW,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ phase: "partial", errorCategory: "shutdown" });
    expect(row(shutdownDb, "shutdown-op")).toMatchObject({
      phase: "partial",
      activationErrorCategory: "shutdown",
    });

    const preparedDb = migratedDb();
    prepareManual(preparedDb, "preflight-op");
    const preparedDependencies = successfulDependencies();
    vi.mocked(preparedDependencies.preflightPrepared).mockRejectedValue(
      new Error("policy changed"),
    );
    await expect(
      executeDomainRuleOperation(preparedDb, "preflight-op", preparedDependencies, {
        clock: () => NOW,
      }),
    ).rejects.toThrow("policy changed");
    expect(row(preparedDb, "preflight-op")).toMatchObject({
      phase: "prepared",
      resultingRevision: null,
      activationAttemptCount: 0,
    });
  });

  it("attests and aborts an automatic operation after an ordinary pre-write veto", async () => {
    const db = migratedDb();
    prepareAutomatic(db, "automatic-veto");
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.preflightPrepared).mockRejectedValue(
      new DomainRulePreparedVetoError("candidate evidence changed"),
    );

    await expect(
      executeDomainRuleOperation(db, "automatic-veto", dependencies, { clock: () => NOW }),
    ).resolves.toEqual({
      operationId: "automatic-veto",
      phase: "aborted",
      contentSha256: null,
      activationAttempt: 0,
    });

    expect(dependencies.attestOperation).toHaveBeenCalledTimes(2);
    expect(row(db, "automatic-veto")).toMatchObject({ phase: "aborted", resultingRevision: null });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 0,
    });
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });

  it("fails closed on reconciliation-required operations and missing dependencies", async () => {
    const db = migratedDb();
    prepareManual(db);
    db.update(domainRuleOperations)
      .set({
        phase: "reconciliation-required",
        completedAt: NOW - 500,
        updatedAt: NOW - 500,
      })
      .where(eq(domainRuleOperations.id, "manual-add-1"))
      .run();
    const dependencies = successfulDependencies();

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule reconciliation required");
    await expect(
      executeDomainRuleOperation(db, "missing", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule operation not found");
    await expect(
      executeDomainRuleOperation(db, "manual-add-1", {
        ...dependencies,
        activateCommitted: undefined,
      } as never),
    ).rejects.toThrow("domain-rule apply dependencies unavailable");
  });

  it("durably fences later mutations when file attestation requires reconciliation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockRejectedValue(
      new DomainRuleOperationReconciliationError("unexpected local rule-file state"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("unexpected local rule-file state");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      completedAt: NOW,
    });
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(() => prepareManual(db, "later-operation")).toThrow(
      "domain-rule reconciliation required",
    );
  });

  it("recognizes the production rule-store error as reconciliation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockRejectedValue(
      new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule source changed",
      ),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("local domain-rule source changed");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      completedAt: NOW,
    });
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });

  it("durably fences an ambiguous file write before SQLite finalization", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockRejectedValue(
      new DomainRuleOperationReconciliationError("local file replacement was ambiguous"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("local file replacement was ambiguous");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      resultingRevision: null,
      completedAt: NOW,
    });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.attestWritten).not.toHaveBeenCalled();
    expect(() => prepareManual(db, "later-operation")).toThrow(
      "domain-rule reconciliation required",
    );
  });

  it("turns a written-file attestation error into a durable global fence", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestWritten).mockRejectedValue(
      new DomainRuleOperationReconciliationError("written rule file changed"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("written rule file changed");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      activationStatus: "failed",
      activationErrorCategory: "infrastructure-failure",
      completedAt: NOW,
    });
    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
  });

  it("recognizes the production rule-store reconciliation error", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestWritten).mockRejectedValue(
      new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "active domain-rule file does not match the expected revision",
      ),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("active domain-rule file does not match");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      activationStatus: "failed",
      activationErrorCategory: "infrastructure-failure",
      completedAt: NOW,
    });
    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
  });

  it("fails closed for a prepared rollback until its attested revert path exists", async () => {
    const db = migratedDb();
    prepareManual(db, "rollback-target");
    finalizeDomainRuleWrite(
      db,
      {
        operationId: "rollback-target",
        resultingRevision: RESULT_REVISION,
        resultingContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 750 },
    );
    const targetAttempt = beginDomainRuleActivation(db, "rollback-target", {
      clock: () => NOW - 500,
    });
    completeDomainRuleActivation(
      db,
      { operationId: "rollback-target", attempt: targetAttempt.attempt, outcome: "succeeded" },
      { clock: () => NOW - 250 },
    );
    prepareDomainRuleOperation(
      db,
      {
        id: "rollback-1",
        idempotencyKey: "rollback-1",
        action: "rollback",
        rollbackTargetRevision: RESULT_REVISION,
        expectedSourceRevision: "3".repeat(40),
        intendedContentSha256: "b".repeat(64),
        ownershipDelta: {
          upserts: [{ rule: "+.service.example", ownership: "manual" }],
          deletes: [],
        },
      },
      { clock: () => NOW - 100 },
    );
    const dependencies = successfulDependencies();

    await expect(
      executeDomainRuleOperation(db, "rollback-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule rollback execution unavailable");
    expect(row(db, "rollback-1")).toMatchObject({ phase: "prepared", resultingRevision: null });
    expect(dependencies.attestOperation).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });
});
