import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { getSetting } from "../settings/service.js";
import { DomainRuleOperationDeferredError } from "./apply-errors.js";
import {
  finalizeDomainRuleWrite,
  listUnfinishedDomainRuleOperations,
  prepareDomainRuleOperation,
} from "./apply-journal.js";
import {
  type DomainRuleApplyOperationDependencies,
  executeDomainRuleOperation,
} from "./apply-operation.js";
import { createProductionDomainRuleApplyOperationDependencies } from "./apply-operation-production.js";
import { DomainRuleStoreError } from "./rule-store.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const SOURCE_REVISION = "1".repeat(40);
const RESULT_REVISION = "2".repeat(40);
const CONTENT_SHA = "a".repeat(64);
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const operation = {
  id: "manual-add-1",
  action: "manual-add",
} as Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

function setup() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  const preflightPrepared = vi.fn(async () => undefined);
  const controller = {
    readCapability: vi.fn(
      () =>
        ({
          mode: "apply",
          apply: {
            available: true,
            store: "local-file",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        }) as const,
    ),
    activateCommittedRules: vi.fn(async () => ({
      nodes: 2,
      applied: true,
      activationVerified: true,
    })),
    invalidateManagedProviderActivation: vi.fn(),
  };
  const adapters = {
    attestOperation: vi.fn(async () => ({
      state: "expected" as const,
      revision: "1".repeat(40),
      contentSha256: "b".repeat(64),
    })),
    commitPrepared: vi.fn(async () => ({
      changed: true,
      revision: "2".repeat(40),
      previousRevision: "1".repeat(40),
      contentSha256: "a".repeat(64),
    })),
    attestWritten: vi.fn(async () => ({
      baselineCreated: false,
      content: "",
      contentSha256: "a".repeat(64),
      revision: "2".repeat(40),
      ruleCount: 2,
    })),
  };
  const dependencies = createProductionDomainRuleApplyOperationDependencies(
    {
      controller,
      db,
      preflightPrepared,
    },
    adapters,
  );
  return { adapters, controller, db, dependencies, preflightPrepared };
}

describe("createProductionDomainRuleApplyOperationDependencies", () => {
  it("requires a live apply capability before the mutable preflight", async () => {
    const { controller, dependencies, preflightPrepared } = setup();
    vi.mocked(controller.readCapability).mockReturnValueOnce({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });

    await expect(dependencies.preflightPrepared(operation)).rejects.toBeInstanceOf(
      DomainRuleOperationDeferredError,
    );
    expect(preflightPrepared).not.toHaveBeenCalled();
  });

  it("rechecks apply readiness after the mutable preflight", async () => {
    const { controller, dependencies, preflightPrepared } = setup();
    vi.mocked(controller.readCapability)
      .mockReturnValueOnce({
        mode: "apply",
        apply: {
          available: true,
          store: "local-file",
          path: "custom.txt",
          providerName: "submerge-custom",
          providerPath: "./domain-rules/custom.txt",
        },
      })
      .mockReturnValueOnce({
        mode: "apply",
        apply: { available: false, reason: "provider-inactive" },
      });

    await expect(dependencies.preflightPrepared(operation)).rejects.toThrow(
      "domain-rule apply capability unavailable",
    );
    expect(preflightPrepared).toHaveBeenCalledOnce();
    expect(controller.readCapability).toHaveBeenCalledTimes(2);
  });

  it("passes the canonical file path and journal identity to local adapters", async () => {
    const { adapters, controller, db, dependencies, preflightPrepared } = setup();
    const signal = new AbortController().signal;

    await dependencies.preflightPrepared(operation, signal);
    await dependencies.attestOperation({
      operationId: "manual-add-1",
      expectedSourceRevision: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      signal,
    });
    await dependencies.commitPrepared({
      operationId: "manual-add-1",
      expectedSourceRevision: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      upsertRules: ["+.service.example"],
      deleteRules: [],
      signal,
    });
    await dependencies.attestWritten({
      operationId: "manual-add-1",
      revision: "2".repeat(40),
      contentSha256: "a".repeat(64),
      signal,
    });

    expect(preflightPrepared).toHaveBeenCalledWith(operation, signal);
    expect(adapters.attestOperation).toHaveBeenCalledWith({
      operationId: "manual-add-1",
      expectedSourceRevision: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      ruleDirectoryPath: "/domain-rules",
      signal,
    });
    expect(adapters.commitPrepared).toHaveBeenCalledWith({
      operationId: "manual-add-1",
      expectedSourceRevision: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      upsertRules: ["+.service.example"],
      deleteRules: [],
      ruleDirectoryPath: "/domain-rules",
      signal,
    });
    expect(controller.invalidateManagedProviderActivation).toHaveBeenCalledOnce();
    expect(adapters.attestWritten).toHaveBeenCalledWith({
      contentSha256: "a".repeat(64),
      ruleDirectoryPath: "/domain-rules",
      revision: "2".repeat(40),
      signal,
    });
    expect(getSetting(db, "internal.domainRuleStore.v1")).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("revokes provider readiness when written-file attestation fails", async () => {
    const { adapters, controller, dependencies } = setup();
    vi.mocked(adapters.attestWritten).mockRejectedValueOnce(
      new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule source changed",
      ),
    );

    await expect(
      dependencies.attestWritten({
        operationId: "manual-add-1",
        revision: RESULT_REVISION,
        contentSha256: CONTENT_SHA,
      }),
    ).rejects.toThrow("local domain-rule source changed");

    expect(controller.invalidateManagedProviderActivation).toHaveBeenCalledOnce();
  });

  it("reports success only after reload and the apply capability proof", async () => {
    const { controller, dependencies } = setup();

    await expect(
      dependencies.activateCommitted({
        attempt: 1,
        operation,
        revision: "2".repeat(40),
      }),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(controller.activateCommittedRules).toHaveBeenCalledWith(2);
    expect(controller.readCapability).toHaveBeenCalledTimes(2);
  });

  it("revokes a stale proof when activation-time file attestation fails", async () => {
    const { adapters, controller, dependencies } = setup();
    vi.mocked(adapters.attestWritten).mockRejectedValueOnce(
      new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule source changed before reload",
      ),
    );

    await expect(
      dependencies.activateCommitted({
        attempt: 1,
        operation,
        revision: RESULT_REVISION,
      }),
    ).resolves.toEqual({ outcome: "failed", errorCategory: "infrastructure-failure" });

    expect(controller.invalidateManagedProviderActivation).toHaveBeenCalledOnce();
    expect(controller.activateCommittedRules).not.toHaveBeenCalled();
  });

  it.each([
    [
      { nodes: 2, applied: false, activationVerified: false },
      { mode: "apply", apply: { available: false, reason: "provider-inactive" } },
      "config-reload-failure",
    ],
    [
      { nodes: 2, applied: true, activationVerified: true },
      { mode: "apply", apply: { available: false, reason: "provider-inactive" } },
      "provider-proof-failure",
    ],
    [
      { nodes: 2, applied: true, activationVerified: true },
      { mode: "apply", apply: { available: false, reason: "target-channel-unavailable" } },
      "route-proof-failure",
    ],
  ] as const)("maps failed activation to %s", async (applyResult, capability, errorCategory) => {
    const { controller, dependencies } = setup();
    vi.mocked(controller.activateCommittedRules).mockResolvedValueOnce(applyResult);
    vi.mocked(controller.readCapability).mockReturnValue(capability);

    await expect(
      dependencies.activateCommitted({
        attempt: 1,
        operation,
        revision: "2".repeat(40),
      }),
    ).resolves.toEqual({ outcome: "failed", errorCategory });
  });

  it("contains unexpected activation infrastructure errors but preserves shutdown", async () => {
    const { controller, dependencies } = setup();
    vi.mocked(controller.activateCommittedRules).mockRejectedValueOnce(
      new Error("reload exploded"),
    );

    await expect(
      dependencies.activateCommitted({ attempt: 1, revision: "2".repeat(40), operation }),
    ).resolves.toEqual({ outcome: "failed", errorCategory: "infrastructure-failure" });

    const abort = new AbortController();
    abort.abort();
    await expect(
      dependencies.activateCommitted(
        { attempt: 2, revision: "2".repeat(40), operation },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not mutate a committed operation when deployment switches to report mode", async () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder });
    prepareDomainRuleOperation(
      db,
      {
        id: "manual-add-1",
        idempotencyKey: "manual-add-1",
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
    finalizeDomainRuleWrite(
      db,
      {
        operationId: "manual-add-1",
        resultingRevision: RESULT_REVISION,
        resultingContentSha256: CONTENT_SHA,
      },
      { clock: () => NOW - 500 },
    );
    const { adapters, controller } = setup();
    vi.mocked(controller.readCapability).mockReturnValue({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
    const dependencies = createProductionDomainRuleApplyOperationDependencies(
      {
        controller,
        preflightPrepared: vi.fn(async () => undefined),
      },
      adapters,
    );

    await expect(
      executeDomainRuleOperation(db, "manual-add-1", dependencies, { clock: () => NOW }),
    ).rejects.toThrow("domain-rule apply deployment mode unavailable");
    expect(listUnfinishedDomainRuleOperations(db)).toMatchObject([
      { id: "manual-add-1", phase: "committed", activationStatus: "not-started" },
    ]);
    expect(adapters.attestWritten).not.toHaveBeenCalled();
    expect(controller.activateCommittedRules).not.toHaveBeenCalled();
  });
});
