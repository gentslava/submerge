import { fileURLToPath } from "node:url";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceDeploymentCapability,
} from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { domainCandidates, domainRuleOperations, settings } from "../../db/schema.js";
import {
  DomainRuleOperationDeferredError,
  DomainRuleWorkerNotAcceptingError,
} from "./apply-errors.js";
import { applyConfirmedDomainCandidate } from "./candidate-apply.js";
import { claimDomainValidationRun } from "./service.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const NOW = Date.parse("2026-08-05T09:00:00.000Z");
const APPLY_READY: DomainIntelligenceDeploymentCapability = {
  mode: "apply",
  apply: {
    available: true,
    repository: "local",
    branch: "main",
    path: "custom.txt",
    providerName: "submerge-custom",
    providerPath: "./domain-rules/custom.txt",
  },
};

function setup() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  db.insert(settings)
    .values({
      key: "domainIntelligence",
      value: JSON.stringify({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        enabled: true,
        defaultRuleScope: "site",
        automationMode: "review",
      }),
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
      lastSeenAt: NOW - 1_000,
      nextValidationAt: NOW + 60_000,
      lastValidationAt: NOW - 1_000,
      failureStreak: 0,
      leaseId: null,
      leaseUntil: null,
      leaseGeneration: 0,
      updatedAt: NOW - 1_000,
    })
    .run();
  const prepareIntent = vi.fn(async () => ({
    expectedParentCommit: "a".repeat(40),
    intendedContentSha256: "b".repeat(64),
  }));
  const submit = vi.fn(async (prepare: (signal: AbortSignal) => string | Promise<string>) => {
    const operationId = await prepare(new AbortController().signal);
    return {
      operationId,
      phase: "completed" as const,
      commitSha: "c".repeat(40),
      activationAttempt: 1,
    };
  });
  return {
    db,
    prepareIntent,
    submit,
    dependencies: {
      db,
      readCapability: () => APPLY_READY,
      prepareIntent,
      submit,
      repositoryPath: "/runtime/domain-rules/repository",
      trustedParentPath: "/runtime/domain-rules",
      now: () => NOW,
    },
  };
}

describe("applyConfirmedDomainCandidate", () => {
  it("prepares and submits one candidate-bound manual operation without a budget", async () => {
    const { db, dependencies, prepareIntent, submit } = setup();

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).resolves.toEqual({
      operationId: "manual-add-review-1",
      phase: "completed",
      commitSha: "c".repeat(40),
      activationAttempt: 1,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(prepareIntent).toHaveBeenCalledWith({
      repositoryPath: "/runtime/domain-rules/repository",
      trustedParentPath: "/runtime/domain-rules",
      upsertRules: ["+.service.example"],
      deleteRules: [],
      signal: expect.any(AbortSignal),
    });
    expect(db.select().from(domainRuleOperations).get()).toMatchObject({
      id: "manual-add-review-1",
      idempotencyKey: "manual-add-review-1",
      action: "manual-add",
      candidateFqdn: "api.service.example",
      proposedRule: "+.service.example",
      automaticBudgetDay: null,
      automaticBudgetSlots: 0,
      ownershipDelta: {
        upserts: [{ rule: "+.service.example", ownership: "manual" }],
        deletes: [],
      },
    });
  });

  it.each([
    [
      "report deployment",
      { mode: "report", apply: { available: false, reason: "deployment-report-only" } },
    ],
    ["unready apply", { mode: "apply", apply: { available: false, reason: "provider-inactive" } }],
  ] as const)("fails before Git intent in %s", async (_label, capability) => {
    const { dependencies, prepareIntent } = setup();
    dependencies.readCapability = () => capability;

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).rejects.toThrow("candidate apply unavailable");
    expect(prepareIntent).not.toHaveBeenCalled();
  });

  it("fails before Git intent when current candidate authorization is stale", async () => {
    const { db, dependencies, prepareIntent } = setup();
    db.update(domainCandidates).set({ reviewState: "rejected", nextValidationAt: 0 }).run();

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).rejects.toThrow("candidate apply authorization unavailable");
    expect(prepareIntent).not.toHaveBeenCalled();
  });

  it("replays the same durable request without recalculating Git intent", async () => {
    const { db, dependencies, prepareIntent } = setup();
    const input = { fqdn: "api.service.example", operationId: "manual-add-review-1" };

    await applyConfirmedDomainCandidate(input, dependencies);
    db.update(domainCandidates)
      .set({ status: "blocked", nextValidationAt: NOW + 60_000 })
      .run();
    dependencies.readCapability = () => ({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
    await expect(applyConfirmedDomainCandidate(input, dependencies)).resolves.toMatchObject({
      operationId: "manual-add-review-1",
      phase: "completed",
    });

    expect(prepareIntent).toHaveBeenCalledTimes(1);
  });

  it("returns queued after durable preparation is deferred for recovery", async () => {
    const { db, dependencies } = setup();
    dependencies.submit = vi.fn(async (prepare) => {
      await prepare(new AbortController().signal);
      throw new DomainRuleOperationDeferredError("observer accumulating");
    });

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).resolves.toEqual({
      operationId: "manual-add-review-1",
      phase: "queued",
      commitSha: null,
      activationAttempt: 0,
    });
    expect(db.select().from(domainRuleOperations).get()).toMatchObject({
      id: "manual-add-review-1",
      phase: "prepared",
    });
  });

  it("replays a prepared operation while the worker refuses new submissions", async () => {
    const { dependencies, prepareIntent } = setup();
    const input = { fqdn: "api.service.example", operationId: "manual-add-review-1" };
    dependencies.submit = vi.fn(async (prepare) => {
      await prepare(new AbortController().signal);
      throw new DomainRuleOperationDeferredError("observer accumulating");
    });
    await expect(applyConfirmedDomainCandidate(input, dependencies)).resolves.toMatchObject({
      operationId: input.operationId,
      phase: "queued",
    });

    dependencies.submit = vi.fn(async () => {
      throw new DomainRuleWorkerNotAcceptingError("domain-rule apply worker requires recovery");
    });
    await expect(applyConfirmedDomainCandidate(input, dependencies)).resolves.toEqual({
      operationId: input.operationId,
      phase: "queued",
      commitSha: null,
      activationAttempt: 0,
    });

    expect(dependencies.submit).toHaveBeenCalledTimes(1);
    expect(prepareIntent).toHaveBeenCalledTimes(1);
  });

  it("does not hide a fatal execution error behind a durable queued result", async () => {
    const { db, dependencies } = setup();
    dependencies.submit = vi.fn(async (prepare) => {
      await prepare(new AbortController().signal);
      throw new Error("Git attestation failed");
    });

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).rejects.toThrow("Git attestation failed");
    expect(db.select().from(domainRuleOperations).get()).toMatchObject({ phase: "prepared" });
  });

  it("reports reconciliation-required instead of presenting it as queued", async () => {
    const { db, dependencies } = setup();
    const input = { fqdn: "api.service.example", operationId: "manual-add-review-1" };
    dependencies.submit = vi.fn(async (prepare) => {
      await prepare(new AbortController().signal);
      throw new DomainRuleOperationDeferredError("observer accumulating");
    });
    await applyConfirmedDomainCandidate(input, dependencies);
    db.update(domainRuleOperations)
      .set({ phase: "reconciliation-required", updatedAt: NOW, completedAt: NOW })
      .run();
    dependencies.submit = vi.fn(async () => {
      throw new DomainRuleWorkerNotAcceptingError("worker requires recovery");
    });

    await expect(applyConfirmedDomainCandidate(input, dependencies)).rejects.toThrow(
      "domain-rule operation requires reconciliation",
    );
  });

  it("replays a terminal operation without submitting it to the worker", async () => {
    const { db, dependencies } = setup();
    const input = { fqdn: "api.service.example", operationId: "manual-add-review-1" };
    dependencies.submit = vi.fn(async (prepare) => {
      await prepare(new AbortController().signal);
      throw new DomainRuleOperationDeferredError("observer accumulating");
    });
    await applyConfirmedDomainCandidate(input, dependencies);
    db.update(domainRuleOperations)
      .set({
        phase: "completed",
        commitSha: "c".repeat(40),
        committedContentSha256: "b".repeat(64),
        activationStatus: "succeeded",
        activationAttemptCount: 1,
        lastActivationAttemptAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      })
      .run();

    dependencies.submit = vi.fn(async () => {
      throw new Error("worker must not receive terminal replay");
    });
    await expect(applyConfirmedDomainCandidate(input, dependencies)).resolves.toEqual({
      operationId: input.operationId,
      phase: "completed",
      commitSha: "c".repeat(40),
      activationAttempt: 1,
    });
    expect(dependencies.submit).not.toHaveBeenCalled();
  });

  it("does not accept a mismatched durable operation after deferral", async () => {
    const { dependencies } = setup();
    await applyConfirmedDomainCandidate(
      { fqdn: "api.service.example", operationId: "manual-add-review-1" },
      dependencies,
    );
    dependencies.submit = vi.fn(async () => {
      throw new DomainRuleOperationDeferredError("observer accumulating");
    });

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "other.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).rejects.toThrow("domain-rule idempotency conflict");
  });

  it("rejects the apply journal if validation claims the candidate during Git intent", async () => {
    const { db, dependencies } = setup();
    db.update(domainCandidates).set({ nextValidationAt: NOW }).run();
    dependencies.prepareIntent = vi.fn(async () => {
      expect(
        claimDomainValidationRun(db, {
          runId: "validation-race",
          fqdn: "api.service.example",
          leaseId: "validation-race-lease",
          now: NOW,
          leaseUntil: NOW + 60_000,
          rateWindowMs: 60_000,
          maximumStarts: 20,
        }),
      ).toMatchObject({ status: "claimed" });
      return {
        expectedParentCommit: "a".repeat(40),
        intendedContentSha256: "b".repeat(64),
      };
    });

    await expect(
      applyConfirmedDomainCandidate(
        { fqdn: "api.service.example", operationId: "manual-add-review-1" },
        dependencies,
      ),
    ).rejects.toThrow("candidate apply authorization unavailable");
    expect(db.select().from(domainRuleOperations).all()).toEqual([]);
  });
});
