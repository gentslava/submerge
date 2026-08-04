import { describe, expect, it, vi } from "vitest";
import type { ApplyResult } from "../nodes/service.js";
import {
  DomainRuleDeploymentController,
  type DomainRuleDeploymentControllerDeps,
} from "./deployment-controller.js";
import { DomainRuleDeploymentLifecycle } from "./deployment-lifecycle.js";

const applied: ApplyResult = { nodes: 1, applied: true, activationVerified: true };
const pending: ApplyResult = { nodes: 1, applied: false, activationVerified: false };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("DomainRuleDeploymentLifecycle", () => {
  it("retries a failed apply deployment on first availability even when runtime settings are off", async () => {
    const boot = deferred<ApplyResult>();
    let attempt = 0;
    let available = false;
    const controller = {
      readCapability: vi.fn(() =>
        available
          ? ({ mode: "apply", apply: { available: true } } as const)
          : ({
              mode: "apply",
              apply: { available: false, reason: "provider-inactive" },
            } as const),
      ),
      reconcile: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return boot.promise;
        available = true;
        return applied;
      }),
    };
    const lifecycle = new DomainRuleDeploymentLifecycle(controller);

    const bootReconciliation = lifecycle.reconcile();
    const firstAvailability = lifecycle.recoverIfNeeded();
    boot.resolve(pending);
    await expect(bootReconciliation).resolves.toEqual(pending);

    await expect(firstAvailability).resolves.toEqual(applied);
    expect(controller.reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a successful boot deployment on first availability", async () => {
    const controller = {
      readCapability: vi.fn(() => ({ mode: "report", apply: { available: false } }) as never),
      reconcile: vi.fn(async () => applied),
    };
    const lifecycle = new DomainRuleDeploymentLifecycle(controller);

    await lifecycle.reconcile();

    await expect(lifecycle.recoverIfNeeded()).resolves.toBeUndefined();
    expect(controller.reconcile).toHaveBeenCalledOnce();
  });

  it("aborts and drains pending store provisioning before shutdown resolves", async () => {
    const provisioningStarted = deferred();
    const releaseCleanup = deferred();
    const cleanupFinished = vi.fn();
    const deps: DomainRuleDeploymentControllerDeps = {
      applyConfigDirect: vi.fn(async () => applied),
      provisionStore: vi.fn(async (signal) => {
        provisioningStarted.resolve();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
        await releaseCleanup.promise;
        cleanupFinished();
      }),
      resolveTargetGroupName: vi.fn(() => "AUTO"),
      runConfigApply: vi.fn(async (apply) => apply()),
      verifyActivation: vi.fn(async () => ({ providerRuleCount: 0 })),
    };
    const controller = new DomainRuleDeploymentController("apply", deps);
    const lifecycle = new DomainRuleDeploymentLifecycle(controller);
    const reconciliation = lifecycle.reconcile();
    await provisioningStarted.promise;

    let shutdownResolved = false;
    const shutdown = lifecycle.stop().then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);
    expect(cleanupFinished).not.toHaveBeenCalled();

    releaseCleanup.resolve();
    await shutdown;

    expect(cleanupFinished).toHaveBeenCalledOnce();
    await expect(reconciliation).rejects.toMatchObject({ name: "AbortError" });
  });
});
