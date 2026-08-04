import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import {
  domainAutomaticBudgets,
  domainAutomaticConsents,
  domainRuleOperations,
  domainRuleOwnership,
  settings,
} from "../../db/schema.js";
import {
  beginDomainRuleActivation,
  buildDomainAutomaticConsentRevision,
  completeDomainRuleActivation,
  finalizeDomainRuleCommit,
  prepareDomainRuleOperation,
} from "./apply-journal.js";
import {
  type DomainRuleApplyOperationDependencies,
  DomainRuleOperationReconciliationError,
  executeDomainRuleOperation,
} from "./apply-operation.js";
import { DomainRuleMaterializationError } from "./materialization.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const PARENT_SHA = "1".repeat(40);
const COMMIT_SHA = "2".repeat(40);
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
      expectedParentCommit: PARENT_SHA,
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
  return prepareDomainRuleOperation(
    db,
    {
      id,
      idempotencyKey: id,
      action: "automatic-add",
      candidateFqdn: "api.service.example",
      expectedParentCommit: PARENT_SHA,
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
    preflightPrepared: vi.fn(async () => {
      events.push("preflight");
    }),
    attestOperation: vi.fn(async () => {
      events.push("attest");
      return { state: "parent", head: PARENT_SHA, contentSha256: "b".repeat(64) };
    }),
    commitPrepared: vi.fn(async () => {
      events.push("commit");
      return {
        changed: true,
        head: COMMIT_SHA,
        parent: PARENT_SHA,
        contentSha256: CONTENT_SHA,
      };
    }),
    materializeCommitted: vi.fn(async () => {
      events.push("materialize");
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
  it("commits, finalizes, materializes, activates, and completes one prepared operation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const events: string[] = [];
    const dependencies = successfulDependencies(events);

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toEqual({
      operationId: "manual-add-1",
      phase: "completed",
      commitSha: COMMIT_SHA,
      activationAttempt: 1,
    });

    expect(events).toEqual(["attest", "preflight", "commit", "materialize", "activate"]);
    expect(dependencies.commitPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "manual-add-1",
        expectedParent: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        upsertRules: ["+.service.example"],
        deleteRules: [],
      }),
    );
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "completed",
      commitSha: COMMIT_SHA,
      activationStatus: "succeeded",
      activationAttemptCount: 1,
    });
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({
      rule: "+.service.example",
      ownership: "manual",
      operationId: "manual-add-1",
      commitSha: COMMIT_SHA,
    });
  });

  it("recovers a commit whose Git CAS completed before SQLite finalization", async () => {
    const db = migratedDb();
    prepareManual(db);
    const events: string[] = [];
    const dependencies = successfulDependencies(events);
    vi.mocked(dependencies.attestOperation).mockImplementation(async () => {
      events.push("attest");
      return {
        state: "committed",
        head: COMMIT_SHA,
        parent: PARENT_SHA,
        contentSha256: CONTENT_SHA,
      };
    });

    await executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW });

    expect(events).toEqual(["attest", "materialize", "activate"]);
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "completed",
      commitSha: COMMIT_SHA,
      committedContentSha256: CONTENT_SHA,
    });
  });

  it("rechecks automatic consent after preflight and before Git", async () => {
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
    ).rejects.toThrow("automatic domain-rule consent unavailable or stale");

    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "automatic-add-1")).toMatchObject({ phase: "prepared", commitSha: null });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 1,
      consumedSlots: 0,
    });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
  });

  it("consumes the automatic reservation only after a successful local commit", async () => {
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

  it("rejects a fresh commit that aliases its prepared parent", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockResolvedValue({
      changed: true,
      head: PARENT_SHA,
      parent: PARENT_SHA,
      contentSha256: CONTENT_SHA,
    });

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule committed result does not match prepared intent");
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", commitSha: null });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.materializeCommitted).not.toHaveBeenCalled();
  });

  it("rejects a fresh publisher result that did not create a child commit", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockResolvedValue({
      changed: false,
      head: COMMIT_SHA,
      parent: PARENT_SHA,
      contentSha256: CONTENT_SHA,
    });

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule committed result does not match prepared intent");
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", commitSha: null });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.materializeCommitted).not.toHaveBeenCalled();
  });

  it("rejects malformed attestation discriminants before preflight or Git", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockResolvedValue({
      state: "bogus",
      head: PARENT_SHA,
      contentSha256: "b".repeat(64),
    } as never);

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule attestation returned an invalid result");
    expect(dependencies.preflightPrepared).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(row(db, "manual-add-1")).toMatchObject({ phase: "prepared", commitSha: null });
  });

  it("resumes a committed operation without repeating preflight, attestation, or commit", async () => {
    const db = migratedDb();
    prepareManual(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "manual-add-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    const events: string[] = [];
    const dependencies = successfulDependencies(events);

    await executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW });

    expect(events).toEqual(["materialize", "activate"]);
    expect(dependencies.preflightPrepared).not.toHaveBeenCalled();
    expect(dependencies.attestOperation).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });

  it("fails closed when a committed journal row no longer matches its prepared digest", async () => {
    const db = migratedDb();
    prepareManual(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "manual-add-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    db.update(domainRuleOperations)
      .set({ committedContentSha256: "b".repeat(64) })
      .where(eq(domainRuleOperations.id, "manual-add-1"))
      .run();
    const dependencies = successfulDependencies();

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule committed content does not match prepared intent");
    expect(dependencies.materializeCommitted).not.toHaveBeenCalled();
    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
  });

  it("rejects a stored parent SHA in both committed and completed recovery", async () => {
    for (const targetPhase of ["committed", "completed"] as const) {
      const db = migratedDb();
      prepareManual(db);
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "manual-add-1",
          commitSha: COMMIT_SHA,
          committedContentSha256: CONTENT_SHA,
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
        .set({ commitSha: PARENT_SHA })
        .where(eq(domainRuleOperations.id, "manual-add-1"))
        .run();
      const dependencies = successfulDependencies();

      await expect(
        executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
      ).rejects.toThrow("domain-rule commit must be a child of the prepared parent");
      expect(dependencies.materializeCommitted).not.toHaveBeenCalled();
      expect(dependencies.activateCommitted).not.toHaveBeenCalled();
    }
  });

  it("persists a materialization failure as a retryable partial attempt", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.materializeCommitted).mockRejectedValue(new Error("disk unavailable"));

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).resolves.toEqual({
      operationId: "manual-add-1",
      phase: "partial",
      commitSha: COMMIT_SHA,
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
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "manual-add-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
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
    vi.mocked(shutdownDependencies.materializeCommitted).mockImplementation(async () => {
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
      commitSha: null,
      activationAttemptCount: 0,
    });
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

  it("durably fences later mutations when Git attestation requires reconciliation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockRejectedValue(
      new DomainRuleOperationReconciliationError("unexpected local Git state"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("unexpected local Git state");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      completedAt: NOW,
    });
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
    expect(() => prepareManual(db, "later-operation")).toThrow(
      "domain-rule reconciliation required",
    );
  });

  it("recognizes the production publisher Git-state error as reconciliation", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.attestOperation).mockRejectedValue(
      new Error("unexpected local Git state"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("unexpected local Git state");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      completedAt: NOW,
    });
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });

  it("durably fences an ambiguous commit result before SQLite finalization", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.commitPrepared).mockRejectedValue(
      new DomainRuleOperationReconciliationError("local Git ref update was ambiguous"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("local Git ref update was ambiguous");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      commitSha: null,
      completedAt: NOW,
    });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
    expect(dependencies.materializeCommitted).not.toHaveBeenCalled();
    expect(() => prepareManual(db, "later-operation")).toThrow(
      "domain-rule reconciliation required",
    );
  });

  it("turns a materializer reconciliation error into a durable global fence", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.materializeCommitted).mockRejectedValue(
      new DomainRuleOperationReconciliationError("committed Git history changed"),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("committed Git history changed");
    expect(row(db, "manual-add-1")).toMatchObject({
      phase: "reconciliation-required",
      activationStatus: "failed",
      activationErrorCategory: "infrastructure-failure",
      completedAt: NOW,
    });
    expect(dependencies.activateCommitted).not.toHaveBeenCalled();
  });

  it("recognizes the production materializer reconciliation error", async () => {
    const db = migratedDb();
    prepareManual(db);
    const dependencies = successfulDependencies();
    vi.mocked(dependencies.materializeCommitted).mockRejectedValue(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "active domain-rule materialization does not match the expected commit parent",
      ),
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("active domain-rule materialization does not match");
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
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "rollback-target",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
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
        rollbackTargetCommit: COMMIT_SHA,
        expectedParentCommit: "3".repeat(40),
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
    expect(row(db, "rollback-1")).toMatchObject({ phase: "prepared", commitSha: null });
    expect(dependencies.attestOperation).not.toHaveBeenCalled();
    expect(dependencies.commitPrepared).not.toHaveBeenCalled();
  });
});
