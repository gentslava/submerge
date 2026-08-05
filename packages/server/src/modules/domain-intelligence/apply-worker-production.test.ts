import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import type { DomainRuleApplyOperationDependencies } from "./apply-operation.js";
import { createProductionDomainRuleApplyWorker } from "./apply-worker-production.js";

const completed = (operationId: string) => ({
  operationId,
  phase: "completed" as const,
  contentSha256: "b".repeat(64),
  activationAttempt: 1,
});

function setup(capability: unknown) {
  const db = {} as Db;
  const operationDependencies = {} as DomainRuleApplyOperationDependencies;
  const controller = { readCapability: vi.fn(() => capability) };
  const onError = vi.fn();
  const adapters = {
    listUnfinished: vi.fn(() => [{ id: "committed-1" }]),
    executeOperation: vi.fn(async (_db, operationId: string) => completed(operationId)),
  };
  const worker = createProductionDomainRuleApplyWorker(
    { controller, db, operationDependencies, onError },
    adapters,
  );
  return { adapters, controller, db, onError, operationDependencies, worker };
}

describe("createProductionDomainRuleApplyWorker", () => {
  it.each([
    { mode: "report", apply: { available: false, reason: "deployment-report-only" } },
    { mode: "apply" },
    null,
  ])(
    "does not inspect the journal without a valid apply deployment capability",
    async (capability) => {
      const { adapters, worker } = setup(capability);

      await worker.start();

      expect(worker.health()).toEqual({ status: "disabled", accepting: false });
      expect(adapters.listUnfinished).not.toHaveBeenCalled();
      expect(adapters.executeOperation).not.toHaveBeenCalled();
      await worker.stop();
    },
  );

  it("recovers journal rows with the production executor dependencies and AbortSignal", async () => {
    const { adapters, db, operationDependencies, worker } = setup({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });

    await worker.start();

    expect(adapters.listUnfinished).toHaveBeenCalledWith(db);
    expect(adapters.executeOperation).toHaveBeenCalledWith(
      db,
      "committed-1",
      operationDependencies,
      { signal: expect.any(AbortSignal) },
    );
    expect(worker.health()).toEqual({ status: "ready", accepting: true });
    await worker.stop();
  });

  it("routes execution failures through the curated worker error boundary", async () => {
    const error = new Error("local-store-reconciliation-required");
    const { adapters, onError, worker } = setup({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
    adapters.executeOperation.mockRejectedValueOnce(error);

    await expect(worker.start()).rejects.toBe(error);

    expect(worker.health()).toEqual({ status: "failed", accepting: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, "committed-1");
    await worker.stop();
  });
});
