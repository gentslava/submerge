import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import {
  finalizeDomainRuleCommit,
  listUnfinishedDomainRuleOperations,
  prepareDomainRuleOperation,
} from "./apply-journal.js";
import {
  type DomainRuleApplyOperationDependencies,
  executeDomainRuleOperation,
} from "./apply-operation.js";
import { createProductionDomainRuleApplyOperationDependencies } from "./apply-operation-production.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const PARENT_SHA = "1".repeat(40);
const COMMIT_SHA = "2".repeat(40);
const CONTENT_SHA = "a".repeat(64);
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const operation = {
  id: "manual-add-1",
  action: "manual-add",
} as Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

function setup() {
  const preflightPrepared = vi.fn(async () => undefined);
  const controller = {
    readCapability: vi.fn(
      () =>
        ({
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
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
  };
  const adapters = {
    prepareRepositoryDirectories: vi.fn(() => ({
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
    })),
    attestOperation: vi.fn(async () => ({
      state: "parent" as const,
      head: "1".repeat(40),
      contentSha256: "b".repeat(64),
    })),
    commitPrepared: vi.fn(async () => ({
      changed: true,
      head: "2".repeat(40),
      parent: "1".repeat(40),
      contentSha256: "a".repeat(64),
    })),
    materializeCommitted: vi.fn(async () => undefined),
  };
  const dependencies = createProductionDomainRuleApplyOperationDependencies(
    {
      controller,
      databasePath: "/data/submerge.db",
      mihomoConfigPath: "/mihomo/config.yaml",
      preflightPrepared,
    },
    adapters,
  );
  return { adapters, controller, dependencies, preflightPrepared };
}

describe("createProductionDomainRuleApplyOperationDependencies", () => {
  it("requires a live apply capability before the mutable preflight", async () => {
    const { controller, dependencies, preflightPrepared } = setup();
    vi.mocked(controller.readCapability).mockReturnValueOnce({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });

    await expect(dependencies.preflightPrepared(operation)).rejects.toThrow(
      "domain-rule apply capability unavailable",
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
          repository: "local",
          branch: "main",
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

  it("passes exact repository paths and journal identity to local adapters", async () => {
    const { adapters, dependencies, preflightPrepared } = setup();
    const signal = new AbortController().signal;

    await dependencies.preflightPrepared(operation, signal);
    await dependencies.attestOperation({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      committedContentSha256: "a".repeat(64),
      signal,
    });
    await dependencies.commitPrepared({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      upsertRules: ["+.service.example"],
      deleteRules: [],
      signal,
    });
    await dependencies.materializeCommitted({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      commitSha: "2".repeat(40),
      committedContentSha256: "a".repeat(64),
      signal,
    });

    expect(preflightPrepared).toHaveBeenCalledWith(operation, signal);
    expect(adapters.prepareRepositoryDirectories).toHaveBeenCalledWith("/data");
    expect(adapters.attestOperation).toHaveBeenCalledWith({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      committedContentSha256: "a".repeat(64),
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
      signal,
    });
    expect(adapters.commitPrepared).toHaveBeenCalledWith({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      upsertRules: ["+.service.example"],
      deleteRules: [],
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
      signal,
    });
    expect(adapters.materializeCommitted).toHaveBeenCalledWith({
      operationId: "manual-add-1",
      expectedParent: "1".repeat(40),
      commitSha: "2".repeat(40),
      committedContentSha256: "a".repeat(64),
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
      mihomoConfigPath: "/mihomo/config.yaml",
      signal,
    });
  });

  it("reports success only after reload and the apply capability proof", async () => {
    const { controller, dependencies } = setup();

    await expect(
      dependencies.activateCommitted({
        attempt: 1,
        commitSha: "2".repeat(40),
        operation,
      }),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(controller.activateCommittedRules).toHaveBeenCalledOnce();
    expect(controller.readCapability).toHaveBeenCalledTimes(2);
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
        commitSha: "2".repeat(40),
        operation,
      }),
    ).resolves.toEqual({ outcome: "failed", errorCategory });
  });

  it("contains unexpected activation infrastructure errors but preserves shutdown", async () => {
    const { controller, dependencies } = setup();
    vi.mocked(controller.activateCommittedRules).mockRejectedValueOnce(
      new Error("reload exploded"),
    );

    await expect(
      dependencies.activateCommitted({ attempt: 1, commitSha: "2".repeat(40), operation }),
    ).resolves.toEqual({ outcome: "failed", errorCategory: "infrastructure-failure" });

    const abort = new AbortController();
    abort.abort();
    await expect(
      dependencies.activateCommitted(
        { attempt: 2, commitSha: "2".repeat(40), operation },
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
    finalizeDomainRuleCommit(
      db,
      {
        operationId: "manual-add-1",
        commitSha: COMMIT_SHA,
        committedContentSha256: CONTENT_SHA,
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
        databasePath: "/data/submerge.db",
        mihomoConfigPath: "/mihomo/config.yaml",
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
    expect(adapters.prepareRepositoryDirectories).not.toHaveBeenCalled();
    expect(adapters.materializeCommitted).not.toHaveBeenCalled();
    expect(controller.activateCommittedRules).not.toHaveBeenCalled();
  });
});
