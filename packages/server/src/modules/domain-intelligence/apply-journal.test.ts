import { fileURLToPath } from "node:url";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceReportSettings,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
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
import {
  abortPreparedDomainRuleOperation,
  assertPreparedAutomaticOperationAuthorized,
  beginDomainRuleActivation,
  buildDomainAutomaticConsentRevision,
  completeDomainRuleActivation,
  finalizeDomainRuleCommit,
  listUnfinishedDomainRuleOperations,
  prepareDomainRuleOperation,
} from "./apply-journal.js";
import { claimDomainValidationRun, listDomainCandidateReport } from "./service.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const PARENT_SHA = "1".repeat(40);
const COMMIT_SHA = "2".repeat(40);
const CONTENT_SHA = "a".repeat(64);
const DAY_START = Date.parse("2026-08-05T00:00:00.000Z");

function automaticSettings(maximumAutomaticRulesPerDay = 3): DomainIntelligenceReportSettings {
  return {
    ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    enabled: true,
    automationMode: "review",
    defaultRuleScope: "site",
    maximumAutomaticRulesPerDay,
  };
}

function insertConfirmedCandidate(db: Db, fqdn: string, site: string, proposedRule: string): void {
  db.insert(domainCandidates)
    .values({
      fqdn,
      registrableSite: site,
      selectedScope: "site",
      proposedRule,
      exclusionReason: null,
      status: "confirmed",
      reviewState: "active",
      firstSeenAt: DAY_START - 86_400_000,
      lastSeenAt: DAY_START,
      nextValidationAt: DAY_START,
      lastValidationAt: DAY_START,
      failureStreak: 0,
      leaseId: null,
      leaseUntil: null,
      leaseGeneration: 0,
      updatedAt: DAY_START,
    })
    .run();
  db.insert(domainDecisions)
    .values({
      id: `confirmed-${fqdn.replaceAll(".", "-")}`,
      fqdn,
      evaluatedAt: DAY_START,
      status: "confirmed",
      confidence: "high",
      reasons: [],
      windowStart: DAY_START - 86_400_000,
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
      proposedRule,
    })
    .run();
}

function migratedDb(maximumAutomaticRulesPerDay = 3): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  const automatic = automaticSettings(maximumAutomaticRulesPerDay);
  db.insert(settings)
    .values({
      key: "domainIntelligence",
      value: JSON.stringify(automatic),
    })
    .run();
  db.insert(domainAutomaticConsents)
    .values({
      id: "consent-1",
      revision: buildDomainAutomaticConsentRevision(automatic),
      enabledAt: DAY_START,
      revokedAt: null,
    })
    .run();
  insertConfirmedCandidate(db, "api.service.example", "service.example", "+.service.example");
  return db;
}

function prepareAutomatic(
  db: Db,
  id = "auto-2026-08-05-1",
  now = DAY_START + 100,
  fqdn = "api.service.example",
  proposedRule = "+.service.example",
) {
  return prepareDomainRuleOperation(
    db,
    {
      id,
      idempotencyKey: id,
      action: "automatic-add",
      candidateFqdn: fqdn,
      expectedParentCommit: PARENT_SHA,
      intendedContentSha256: CONTENT_SHA,
      proposedRule,
      ownershipDelta: {
        upserts: [{ rule: proposedRule, ownership: "automatic" }],
        deletes: [],
      },
    },
    { clock: () => now },
  );
}

describe("domain-rule apply journal", () => {
  it("durably prepares one automatic operation and reserves its UTC budget idempotently", () => {
    const db = migratedDb();

    expect(prepareAutomatic(db)).toMatchObject({
      created: true,
      phase: "prepared",
      activationStatus: "not-started",
      activationAttemptCount: 0,
      lastActivationAttemptAt: null,
      activationErrorCategory: null,
      automaticConsentId: "consent-1",
      automaticConsentRevision: buildDomainAutomaticConsentRevision(automaticSettings()),
    });
    expect(prepareAutomatic(db)).toMatchObject({ created: false, phase: "prepared" });
    expect(prepareAutomatic(db, "auto-2026-08-05-1", DAY_START + 86_400_100)).toMatchObject({
      created: false,
      phase: "prepared",
      automaticBudgetDay: "2026-08-05",
    });

    expect(db.select().from(domainRuleOperations).all()).toHaveLength(1);
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      day: "2026-08-05",
      reservedSlots: 1,
      consumedSlots: 0,
    });
  });

  it("rejects an idempotency-key replay whose immutable intent changed", () => {
    const db = migratedDb();
    prepareAutomatic(db);

    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "different-operation-id",
        idempotencyKey: "auto-2026-08-05-1",
        action: "automatic-add",
        candidateFqdn: "other.service.example",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "+.service.example",
        ownershipDelta: {
          upserts: [{ rule: "+.service.example", ownership: "automatic" }],
          deletes: [],
        },
      }),
    ).toThrow("domain-rule idempotency conflict");
  });

  it("does not let manual actions create automatic ownership or delete and upsert together", () => {
    const db = migratedDb();

    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "manual-add-invalid",
        idempotencyKey: "manual-add-invalid",
        action: "manual-add",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "+.service.example",
        ownershipDelta: {
          upserts: [{ rule: "+.service.example", ownership: "automatic" }],
          deletes: [],
        },
      }),
    ).toThrow("invalid manual ownership delta");
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "manual-delete-invalid",
        idempotencyKey: "manual-delete-invalid",
        action: "manual-delete",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: ["+.service.example"],
        },
      }),
    ).toThrow("invalid manual delete ownership delta");
    expect(db.select().from(domainRuleOperations).all()).toEqual([]);
  });

  it("binds every automatic operation to exactly one candidate, rule, and budget slot", () => {
    const db = migratedDb();

    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "auto-multiple-invalid",
        idempotencyKey: "auto-multiple-invalid",
        action: "automatic-add",
        candidateFqdn: "api.service.example",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "+.service.example",
        ownershipDelta: {
          upserts: [
            { rule: "+.service.example", ownership: "automatic" },
            { rule: "+.other.example", ownership: "automatic" },
          ],
          deletes: [],
        },
      }),
    ).toThrow("invalid automatic ownership delta");
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "auto-unrelated-invalid",
        idempotencyKey: "auto-unrelated-invalid",
        action: "automatic-add",
        candidateFqdn: "api.service.example",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "+.other.example",
        ownershipDelta: {
          upserts: [{ rule: "+.other.example", ownership: "automatic" }],
          deletes: [],
        },
      }),
    ).toThrow("proposed rule does not cover candidate");
    expect(db.select().from(domainAutomaticBudgets).all()).toEqual([]);
  });

  it("enforces the persisted automatic UTC-day ceiling across operations", () => {
    const db = migratedDb(1);
    prepareAutomatic(db);
    insertConfirmedCandidate(db, "api.other.example", "other.example", "+.other.example");

    expect(() =>
      prepareAutomatic(
        db,
        "auto-2026-08-05-2",
        DAY_START + 100,
        "api.other.example",
        "+.other.example",
      ),
    ).toThrow("automatic domain-rule daily budget exhausted");
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 1,
      consumedSlots: 0,
    });
  });

  it("fails closed when the persisted automatic budget setting is unavailable", () => {
    const db = migratedDb();
    db.delete(settings).where(eq(settings.key, "domainIntelligence")).run();

    expect(() => prepareAutomatic(db)).toThrow("automatic domain-rule settings unavailable");
    expect(db.select().from(domainRuleOperations).all()).toEqual([]);
    expect(db.select().from(domainAutomaticBudgets).all()).toEqual([]);
  });

  it("requires current, separately audited automatic consent before reserving budget", () => {
    const missingConsentDb = migratedDb();
    missingConsentDb.delete(domainAutomaticConsents).run();

    expect(() => prepareAutomatic(missingConsentDb)).toThrow(
      "automatic domain-rule consent unavailable or stale",
    );
    expect(missingConsentDb.select().from(domainAutomaticBudgets).all()).toEqual([]);

    const staleConsentDb = migratedDb();
    const changed = automaticSettings(2);
    staleConsentDb
      .update(settings)
      .set({ value: JSON.stringify(changed) })
      .where(eq(settings.key, "domainIntelligence"))
      .run();

    expect(() => prepareAutomatic(staleConsentDb)).toThrow(
      "automatic domain-rule consent unavailable or stale",
    );
    expect(staleConsentDb.select().from(domainAutomaticBudgets).all()).toEqual([]);
  });

  it("rechecks consent before Git but finalizes an already-created commit from durable intent", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    db.update(domainAutomaticConsents)
      .set({ revokedAt: DAY_START + 150 })
      .where(eq(domainAutomaticConsents.id, "consent-1"))
      .run();

    expect(() => assertPreparedAutomaticOperationAuthorized(db, "auto-2026-08-05-1")).toThrow(
      "automatic domain-rule consent unavailable or stale",
    );
    expect(
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-2026-08-05-1",
          commitSha: COMMIT_SHA,
          committedContentSha256: CONTENT_SHA,
        },
        { clock: () => DAY_START + 200 },
      ),
    ).toMatchObject({ changed: true, phase: "committed" });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 1,
    });
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({
      rule: "+.service.example",
      operationId: "auto-2026-08-05-1",
    });
  });

  it("rejects disabled and partial settings before automatic reservation", () => {
    for (const stored of [
      DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      { maximumAutomaticRulesPerDay: 3 },
    ]) {
      const db = migratedDb();
      db.update(settings)
        .set({ value: JSON.stringify(stored) })
        .where(eq(settings.key, "domainIntelligence"))
        .run();
      expect(() => prepareAutomatic(db)).toThrow("automatic domain-rule settings unavailable");
      expect(db.select().from(domainAutomaticBudgets).all()).toEqual([]);
    }
  });

  it("requires an attested rollback target in immutable journal intent", () => {
    const db = migratedDb();
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "rollback-invalid",
        idempotencyKey: "rollback-invalid",
        action: "rollback",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
      }),
    ).toThrow("rollback target does not match action");

    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "rollback-unattested",
        idempotencyKey: "rollback-unattested",
        action: "rollback",
        rollbackTargetCommit: "0".repeat(40),
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
      }),
    ).toThrow("domain-rule rollback target is not attested");

    prepareDomainRuleOperation(db, {
      id: "manual-target",
      idempotencyKey: "manual-target",
      action: "manual-add",
      expectedParentCommit: PARENT_SHA,
      intendedContentSha256: "c".repeat(64),
      proposedRule: "api.target.example",
      ownershipDelta: {
        upserts: [{ rule: "api.target.example", ownership: "manual" }],
        deletes: [],
      },
    });
    finalizeDomainRuleCommit(db, {
      operationId: "manual-target",
      commitSha: COMMIT_SHA,
      committedContentSha256: "c".repeat(64),
    });

    expect(
      prepareDomainRuleOperation(db, {
        id: "rollback-valid",
        idempotencyKey: "rollback-valid",
        action: "rollback",
        rollbackTargetCommit: COMMIT_SHA,
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
      }),
    ).toMatchObject({ rollbackTargetCommit: COMMIT_SHA, phase: "prepared" });
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "rollback-valid",
        idempotencyKey: "rollback-valid",
        action: "rollback",
        rollbackTargetCommit: "9".repeat(40),
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
      }),
    ).toThrow("domain-rule idempotency conflict");
  });

  it("finalizes commit, ownership, and budget exactly once", () => {
    const db = migratedDb();
    prepareAutomatic(db);

    expect(
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-2026-08-05-1",
          commitSha: COMMIT_SHA,
          committedContentSha256: CONTENT_SHA,
        },
        { clock: () => DAY_START + 200 },
      ),
    ).toMatchObject({ changed: true, phase: "committed" });
    expect(
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-2026-08-05-1",
          commitSha: COMMIT_SHA,
          committedContentSha256: CONTENT_SHA,
        },
        { clock: () => DAY_START + 300 },
      ),
    ).toMatchObject({ changed: false, phase: "committed" });

    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 1,
    });
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({
      rule: "+.service.example",
      ownership: "automatic",
      operationId: "auto-2026-08-05-1",
      commitSha: COMMIT_SHA,
    });
    expect(
      db
        .select()
        .from(domainCandidates)
        .where(eq(domainCandidates.fqdn, "api.service.example"))
        .get(),
    ).toMatchObject({ status: "blocked", reviewState: "active" });
    expect(
      db
        .select()
        .from(domainDecisions)
        .where(eq(domainDecisions.fqdn, "api.service.example"))
        .orderBy(domainDecisions.evaluatedAt)
        .all()
        .at(-1),
    ).toMatchObject({
      status: "blocked",
      confidence: "none",
      reasons: ["already-covered"],
      windowStart: null,
      proposedRule: "+.service.example",
    });
    expect(
      listDomainCandidateReport(db, { view: "exclusions", limit: 50 }, null).items,
    ).toContainEqual(
      expect.objectContaining({
        fqdn: "api.service.example",
        exclusionReason: "already-covered",
        evidenceAvailable: true,
        evidenceIntegrityIssue: null,
        decision: expect.objectContaining({
          status: "blocked",
          reasons: ["already-covered"],
          windowStart: null,
        }),
      }),
    );

    db.update(domainRuleOwnership)
      .set({ ownership: "manual", updatedAt: DAY_START + 400 })
      .where(eq(domainRuleOwnership.rule, "+.service.example"))
      .run();
    expect(prepareAutomatic(db)).toMatchObject({
      created: false,
      phase: "committed",
      commitSha: COMMIT_SHA,
    });
  });

  it("fences candidate validation while a durable apply operation is unfinished", async () => {
    const db = migratedDb();
    prepareAutomatic(db);

    expect(
      claimDomainValidationRun(db, {
        runId: "validation-while-apply",
        fqdn: "api.service.example",
        leaseId: "validation-lease",
        now: DAY_START + 200,
        leaseUntil: DAY_START + 60_200,
        rateWindowMs: 60_000,
        maximumStarts: 20,
      }),
    ).toEqual({ status: "unavailable" });

    await abortPreparedDomainRuleOperation(db, "auto-2026-08-05-1", {
      clock: () => DAY_START + 300,
      assertPreCommitState: async () => undefined,
    });
    expect(
      claimDomainValidationRun(db, {
        runId: "validation-after-abort",
        fqdn: "api.service.example",
        leaseId: "validation-lease-after-abort",
        now: DAY_START + 400,
        leaseUntil: DAY_START + 60_400,
        rateWindowMs: 60_000,
        maximumStarts: 20,
      }),
    ).toMatchObject({ status: "claimed" });
  });

  it("rejects a candidate-bound operation when validation already owns the candidate", () => {
    const db = migratedDb();
    expect(
      claimDomainValidationRun(db, {
        runId: "validation-first",
        fqdn: "api.service.example",
        leaseId: "validation-first-lease",
        now: DAY_START + 100,
        leaseUntil: DAY_START + 60_100,
        rateWindowMs: 60_000,
        maximumStarts: 20,
      }),
    ).toMatchObject({ status: "claimed" });

    expect(() => prepareAutomatic(db)).toThrow("candidate apply authorization unavailable");
    expect(db.select().from(domainRuleOperations).all()).toEqual([]);
  });

  it("rejects the prepared parent as an operation commit without consuming durable intent", () => {
    const db = migratedDb();
    prepareAutomatic(db);

    expect(() =>
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-2026-08-05-1",
          commitSha: PARENT_SHA,
          committedContentSha256: CONTENT_SHA,
        },
        { clock: () => DAY_START + 200 },
      ),
    ).toThrow("domain-rule commit must be a child of the prepared parent");
    expect(
      db
        .select()
        .from(domainRuleOperations)
        .where(eq(domainRuleOperations.id, "auto-2026-08-05-1"))
        .get(),
    ).toMatchObject({ phase: "prepared", commitSha: null });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 1,
      consumedSlots: 0,
    });
    expect(db.select().from(domainRuleOwnership).all()).toEqual([]);
  });

  it("atomically transfers manual ownership and deletes removed ownership", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );

    prepareDomainRuleOperation(
      db,
      {
        id: "manual-edit-1",
        idempotencyKey: "manual-edit-1",
        action: "manual-edit",
        expectedParentCommit: COMMIT_SHA,
        intendedContentSha256: "b".repeat(64),
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: ["+.service.example"],
        },
      },
      { clock: () => DAY_START + 300 },
    );
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "manual-edit-1",
        commitSha: "3".repeat(40),
        committedContentSha256: "b".repeat(64),
      },
      { clock: () => DAY_START + 400 },
    );

    expect(db.select().from(domainRuleOwnership).all()).toEqual([
      expect.objectContaining({
        rule: "api.service.example",
        ownership: "manual",
        operationId: "manual-edit-1",
      }),
    ]);
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 0,
      consumedSlots: 1,
    });
  });

  it("reports the stored post-commit phase on an idempotent finalize retry", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );
    db.update(domainRuleOperations)
      .set({
        phase: "partial",
        activationStatus: "failed",
        activationAttemptCount: 1,
        lastActivationAttemptAt: DAY_START + 300,
        activationErrorCategory: "route-proof-failure",
        updatedAt: DAY_START + 300,
      })
      .where(eq(domainRuleOperations.id, "auto-2026-08-05-1"))
      .run();

    expect(
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-2026-08-05-1",
          commitSha: COMMIT_SHA,
          committedContentSha256: CONTENT_SHA,
        },
        { clock: () => DAY_START + 400 },
      ),
    ).toEqual({ changed: false, phase: "partial" });
  });

  it("records activation success exactly once after a committed mutation", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );

    expect(
      beginDomainRuleActivation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 300,
      }),
    ).toEqual({ changed: true, phase: "activating", attempt: 1 });
    expect(
      beginDomainRuleActivation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 350,
      }),
    ).toEqual({ changed: false, phase: "activating", attempt: 1 });
    expect(
      completeDomainRuleActivation(
        db,
        { operationId: "auto-2026-08-05-1", attempt: 1, outcome: "succeeded" },
        { clock: () => DAY_START + 400 },
      ),
    ).toEqual({ changed: true, phase: "completed", attempt: 1 });
    expect(
      completeDomainRuleActivation(
        db,
        { operationId: "auto-2026-08-05-1", attempt: 1, outcome: "succeeded" },
        { clock: () => DAY_START + 450 },
      ),
    ).toEqual({ changed: false, phase: "completed", attempt: 1 });

    expect(
      db
        .select()
        .from(domainRuleOperations)
        .where(eq(domainRuleOperations.id, "auto-2026-08-05-1"))
        .get(),
    ).toMatchObject({
      phase: "completed",
      activationStatus: "succeeded",
      activationAttemptCount: 1,
      lastActivationAttemptAt: DAY_START + 300,
      activationErrorCategory: null,
      completedAt: DAY_START + 400,
    });
    expect(listUnfinishedDomainRuleOperations(db)).toEqual([]);
  });

  it("persists a failed activation and increments the attempt on retry", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );
    beginDomainRuleActivation(db, "auto-2026-08-05-1", {
      clock: () => DAY_START + 300,
    });

    expect(
      completeDomainRuleActivation(
        db,
        {
          operationId: "auto-2026-08-05-1",
          attempt: 1,
          outcome: "failed",
          errorCategory: "route-proof-failure",
        },
        { clock: () => DAY_START + 400 },
      ),
    ).toEqual({ changed: true, phase: "partial", attempt: 1 });
    expect(
      completeDomainRuleActivation(
        db,
        {
          operationId: "auto-2026-08-05-1",
          attempt: 1,
          outcome: "failed",
          errorCategory: "route-proof-failure",
        },
        { clock: () => DAY_START + 450 },
      ),
    ).toEqual({ changed: false, phase: "partial", attempt: 1 });
    expect(
      beginDomainRuleActivation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 500,
      }),
    ).toEqual({ changed: true, phase: "activating", attempt: 2 });
    expect(
      completeDomainRuleActivation(
        db,
        { operationId: "auto-2026-08-05-1", attempt: 2, outcome: "succeeded" },
        { clock: () => DAY_START + 600 },
      ),
    ).toEqual({ changed: true, phase: "completed", attempt: 2 });
  });

  it("rejects activation transitions before commit and mismatched terminal retries", () => {
    const db = migratedDb();
    prepareAutomatic(db);

    expect(() => beginDomainRuleActivation(db, "auto-2026-08-05-1")).toThrow(
      "domain-rule operation cannot begin activation",
    );
    expect(() =>
      completeDomainRuleActivation(db, {
        operationId: "auto-2026-08-05-1",
        attempt: 1,
        outcome: "failed",
        errorCategory: "config-reload-failure",
      }),
    ).toThrow("domain-rule operation cannot complete activation");

    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );
    beginDomainRuleActivation(db, "auto-2026-08-05-1", {
      clock: () => DAY_START + 300,
    });
    completeDomainRuleActivation(
      db,
      { operationId: "auto-2026-08-05-1", attempt: 1, outcome: "succeeded" },
      { clock: () => DAY_START + 400 },
    );

    expect(() =>
      completeDomainRuleActivation(db, {
        operationId: "auto-2026-08-05-1",
        attempt: 1,
        outcome: "failed",
        errorCategory: "config-reload-failure",
      }),
    ).toThrow("domain-rule activation result conflicts with stored terminal state");
  });

  it("rejects a stale completion after a newer activation attempt starts", () => {
    const db = migratedDb();
    prepareAutomatic(db);
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "auto-2026-08-05-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
      },
      { clock: () => DAY_START + 200 },
    );
    beginDomainRuleActivation(db, "auto-2026-08-05-1", {
      clock: () => DAY_START + 300,
    });
    completeDomainRuleActivation(
      db,
      {
        operationId: "auto-2026-08-05-1",
        attempt: 1,
        outcome: "failed",
        errorCategory: "config-reload-failure",
      },
      { clock: () => DAY_START + 400 },
    );
    beginDomainRuleActivation(db, "auto-2026-08-05-1", {
      clock: () => DAY_START + 500,
    });

    expect(() =>
      completeDomainRuleActivation(
        db,
        { operationId: "auto-2026-08-05-1", attempt: 1, outcome: "succeeded" },
        { clock: () => DAY_START + 600 },
      ),
    ).toThrow("domain-rule activation attempt is stale");
    expect(
      db
        .select()
        .from(domainRuleOperations)
        .where(eq(domainRuleOperations.id, "auto-2026-08-05-1"))
        .get(),
    ).toMatchObject({
      phase: "activating",
      activationStatus: "in-progress",
      activationAttemptCount: 2,
      lastActivationAttemptAt: DAY_START + 500,
    });
  });

  it("vetoes automatic replacement of manual ownership before reservation and at finalize", () => {
    const db = migratedDb();
    prepareDomainRuleOperation(db, {
      id: "manual-add-1",
      idempotencyKey: "manual-add-1",
      action: "manual-add",
      expectedParentCommit: PARENT_SHA,
      intendedContentSha256: CONTENT_SHA,
      proposedRule: "+.service.example",
      ownershipDelta: {
        upserts: [{ rule: "+.service.example", ownership: "manual" }],
        deletes: [],
      },
    });
    finalizeDomainRuleCommit(db, {
      operationId: "manual-add-1",
      commitSha: COMMIT_SHA,
      committedContentSha256: CONTENT_SHA,
    });
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "auto-conflict-1",
        idempotencyKey: "auto-conflict-1",
        action: "automatic-add",
        candidateFqdn: "api.service.example",
        expectedParentCommit: COMMIT_SHA,
        intendedContentSha256: "b".repeat(64),
        proposedRule: "+.service.example",
        ownershipDelta: {
          upserts: [{ rule: "+.service.example", ownership: "automatic" }],
          deletes: [],
        },
      }),
    ).toThrow("automatic domain rule cannot replace manual ownership");
    expect(db.select().from(domainAutomaticBudgets).all()).toEqual([]);

    // Defense in depth for a corrupted or raced recovery state: finalization
    // repeats the ownership veto even though normal preparation rejects it.
    db.insert(domainAutomaticBudgets)
      .values({
        day: "2026-08-05",
        reservedSlots: 1,
        consumedSlots: 0,
        updatedAt: DAY_START + 300,
      })
      .run();
    db.insert(domainRuleOperations)
      .values({
        id: "auto-conflict-1",
        idempotencyKey: "auto-conflict-1",
        action: "automatic-add",
        phase: "prepared",
        candidateFqdn: "api.service.example",
        expectedParentCommit: COMMIT_SHA,
        intendedContentSha256: "b".repeat(64),
        proposedRule: "+.service.example",
        ownershipDelta: {
          upserts: [{ rule: "+.service.example", ownership: "automatic" }],
          deletes: [],
        },
        automaticConsentId: "consent-1",
        automaticConsentRevision: buildDomainAutomaticConsentRevision(automaticSettings()),
        automaticBudgetDay: "2026-08-05",
        automaticBudgetSlots: 1,
        commitSha: null,
        committedContentSha256: null,
        createdAt: DAY_START + 300,
        updatedAt: DAY_START + 300,
        completedAt: null,
      })
      .run();

    expect(() =>
      finalizeDomainRuleCommit(
        db,
        {
          operationId: "auto-conflict-1",
          commitSha: "3".repeat(40),
          committedContentSha256: "b".repeat(64),
        },
        { clock: () => DAY_START + 400 },
      ),
    ).toThrow("automatic domain rule cannot replace manual ownership");
    expect(db.select().from(domainRuleOwnership).get()).toMatchObject({
      rule: "+.service.example",
      ownership: "manual",
      operationId: "manual-add-1",
    });
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 1,
      consumedSlots: 0,
    });
  });

  it("releases only an attested pre-commit reservation and exposes unfinished recovery work", async () => {
    const db = migratedDb();
    prepareAutomatic(db);
    insertConfirmedCandidate(db, "api.other.example", "other.example", "+.other.example");
    prepareAutomatic(
      db,
      "auto-2026-08-05-2",
      DAY_START + 100,
      "api.other.example",
      "+.other.example",
    );

    await expect(
      abortPreparedDomainRuleOperation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 150,
        assertPreCommitState: async () => {
          throw new Error("local Git HEAD moved");
        },
      }),
    ).rejects.toThrow("local Git HEAD moved");
    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 2,
      consumedSlots: 0,
    });

    await expect(
      abortPreparedDomainRuleOperation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 200,
        assertPreCommitState: async (intent) => {
          expect(intent).toEqual({
            operationId: "auto-2026-08-05-1",
            expectedParentCommit: PARENT_SHA,
            intendedContentSha256: CONTENT_SHA,
          });
        },
      }),
    ).resolves.toBe(true);
    await expect(
      abortPreparedDomainRuleOperation(db, "auto-2026-08-05-1", {
        clock: () => DAY_START + 300,
        assertPreCommitState: async () => {
          throw new Error("must not attest a terminal operation");
        },
      }),
    ).resolves.toBe(false);

    expect(db.select().from(domainAutomaticBudgets).get()).toMatchObject({
      reservedSlots: 1,
      consumedSlots: 0,
    });
    expect(
      db
        .select({ phase: domainRuleOperations.phase })
        .from(domainRuleOperations)
        .where(eq(domainRuleOperations.id, "auto-2026-08-05-1"))
        .get(),
    ).toEqual({ phase: "aborted" });
    expect(listUnfinishedDomainRuleOperations(db).map((row) => row.id)).toEqual([
      "auto-2026-08-05-2",
    ]);
    db.update(domainRuleOperations)
      .set({
        phase: "reconciliation-required",
        updatedAt: DAY_START + 400,
        completedAt: DAY_START + 400,
      })
      .where(eq(domainRuleOperations.id, "auto-2026-08-05-2"))
      .run();
    expect(listUnfinishedDomainRuleOperations(db).map((row) => row.id)).toEqual([
      "auto-2026-08-05-2",
    ]);
    expect(() =>
      prepareDomainRuleOperation(db, {
        id: "manual-blocked-by-reconciliation",
        idempotencyKey: "manual-blocked-by-reconciliation",
        action: "manual-add",
        expectedParentCommit: PARENT_SHA,
        intendedContentSha256: CONTENT_SHA,
        proposedRule: "manual.service.example",
        ownershipDelta: {
          upserts: [{ rule: "manual.service.example", ownership: "manual" }],
          deletes: [],
        },
      }),
    ).toThrow("domain-rule reconciliation required");
  });
});
