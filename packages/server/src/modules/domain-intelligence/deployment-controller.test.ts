import { describe, expect, it, vi } from "vitest";
import type { ApplyResult } from "../nodes/service.js";
import {
  DomainRuleDeploymentController,
  type DomainRuleDeploymentControllerDeps,
} from "./deployment-controller.js";
import { DomainRuleProvisioningError } from "./provisioning.js";

const applied: ApplyResult = { nodes: 2, applied: true, activationVerified: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function dependencies(): DomainRuleDeploymentControllerDeps {
  return {
    provisionStore: vi.fn(async (_signal?: AbortSignal) => undefined),
    resolveTargetGroupName: vi.fn(() => "AUTO" as string | null),
    runConfigApply: vi.fn(async (apply) => apply()),
    applyConfigDirect: vi.fn(
      async (_input: { force: true; managedDomainRules?: { targetGroupName: string } }) => applied,
    ),
    verifyActivation: vi.fn(async (_input: { signal?: AbortSignal; targetGroupName: string }) => ({
      providerRuleCount: 0,
    })),
  };
}

describe("DomainRuleDeploymentController", () => {
  it("keeps report mode free of store/provider provisioning while still applying base config", async () => {
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("report", deps);

    await expect(controller.reconcile()).resolves.toEqual(applied);
    expect(controller.readCapability()).toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(deps.applyConfigDirect).toHaveBeenCalledWith({ force: true });
    expect(deps.verifyActivation).not.toHaveBeenCalled();
  });

  it("propagates report-mode cancellation during coordinator finalization", async () => {
    const finishCoordinator = deferred<void>();
    const deps = dependencies();
    vi.mocked(deps.runConfigApply).mockImplementationOnce(async (apply) => {
      const result = await apply();
      await finishCoordinator.promise;
      return result;
    });
    const controller = new DomainRuleDeploymentController("report", deps);
    const abort = new AbortController();

    const pending = controller.reconcile(abort.signal);
    await vi.waitFor(() => expect(deps.applyConfigDirect).toHaveBeenCalledOnce());
    abort.abort();
    finishCoordinator.resolve();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("mints readiness after one serialized store, force-apply, and live proof", async () => {
    const events: string[] = [];
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockImplementationOnce(async () => {
      events.push("store");
    });
    vi.mocked(deps.runConfigApply).mockImplementationOnce(async (apply) => {
      events.push("coordinator-enter");
      const result = await apply();
      events.push("coordinator-exit");
      return result;
    });
    vi.mocked(deps.applyConfigDirect).mockImplementationOnce(async (input) => {
      events.push(`reload:${input.managedDomainRules?.targetGroupName ?? "none"}`);
      return applied;
    });
    vi.mocked(deps.verifyActivation).mockImplementationOnce(async () => {
      events.push("proof");
      return { providerRuleCount: 3 };
    });
    const controller = new DomainRuleDeploymentController("apply", deps);

    await expect(controller.reconcile()).resolves.toEqual(applied);
    expect(events).toEqual([
      "store",
      "coordinator-enter",
      "reload:AUTO",
      "proof",
      "coordinator-exit",
    ]);
    expect(controller.readCapability()).toMatchObject({
      mode: "apply",
      apply: { available: true, providerName: "submerge-custom" },
    });
  });

  it("keeps the base config and reporting path alive when local store provisioning fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(
      new DomainRuleProvisioningError("local-store-unsafe"),
    );
    const controller = new DomainRuleDeploymentController("apply", deps);

    await expect(controller.reconcile()).resolves.toEqual(applied);
    expect(deps.runConfigApply).toHaveBeenCalledOnce();
    expect(deps.applyConfigDirect).toHaveBeenCalledWith({ force: true });
    expect(deps.verifyActivation).not.toHaveBeenCalled();
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unsafe" },
    });
  });

  it("keeps the managed provider in a fallback after provisioning is fenced", async () => {
    const deps = dependencies();
    let controller!: DomainRuleDeploymentController;
    vi.mocked(deps.provisionStore).mockImplementationOnce(async () => {
      await controller.coordinateConfigApply(async (managedDomainRules) => {
        expect(managedDomainRules).toBeUndefined();
        return applied;
      });
    });
    controller = new DomainRuleDeploymentController("apply", deps);

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(deps.applyConfigDirect).toHaveBeenCalledWith({
      force: true,
      managedDomainRules: { targetGroupName: "AUTO" },
    });
    expect(deps.verifyActivation).toHaveBeenCalledOnce();
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });

  it("applies base config but reports an unavailable target when no usable group exists", async () => {
    const deps = dependencies();
    vi.mocked(deps.resolveTargetGroupName).mockReturnValueOnce(null);
    const controller = new DomainRuleDeploymentController("apply", deps);

    await expect(controller.reconcile()).resolves.toEqual(applied);
    expect(deps.applyConfigDirect).toHaveBeenCalledWith({ force: true });
    expect(deps.verifyActivation).not.toHaveBeenCalled();
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "target-channel-unavailable" },
    });
  });

  it("fails closed when the forced reload cannot prove activation", async () => {
    const deps = dependencies();
    vi.mocked(deps.applyConfigDirect).mockResolvedValueOnce({
      nodes: 2,
      applied: false,
      activationVerified: false,
    });
    const controller = new DomainRuleDeploymentController("apply", deps);

    await expect(controller.reconcile()).resolves.toMatchObject({ applied: false });
    expect(deps.verifyActivation).not.toHaveBeenCalled();
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("injects and verifies the provider inside every later serialized config apply", async () => {
    const events: string[] = [];
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.clearAllMocks();
    vi.mocked(deps.runConfigApply).mockImplementationOnce(async (apply) => {
      events.push("coordinator-enter");
      const result = await apply();
      events.push("coordinator-exit");
      return result;
    });
    vi.mocked(deps.verifyActivation).mockImplementationOnce(async () => {
      events.push("proof");
      return { providerRuleCount: 2 };
    });
    const apply = vi.fn(async (managed?: { targetGroupName: string }) => {
      events.push(`reload:${managed?.targetGroupName ?? "none"}`);
      return applied;
    });

    await expect(controller.coordinateConfigApply(apply)).resolves.toEqual(applied);
    expect(events).toEqual(["coordinator-enter", "reload:AUTO", "proof", "coordinator-exit"]);
    expect(apply).toHaveBeenCalledWith({ targetGroupName: "AUTO" });
  });

  it("revokes existing readiness when a later config apply loses activation", async () => {
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();

    await controller.coordinateConfigApply(async () => ({
      nodes: 2,
      applied: false,
      activationVerified: false,
    }));

    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("keeps readiness when an unchanged config still has a live managed provider", async () => {
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.clearAllMocks();

    const noOp = { nodes: 2, applied: true, activationVerified: false };
    await expect(controller.coordinateConfigApply(async () => noOp)).resolves.toEqual(noOp);

    expect(deps.verifyActivation).toHaveBeenCalledOnce();
    expect(controller.readCapability()).toMatchObject({
      mode: "apply",
      apply: { available: true },
    });
  });

  it("does not let an older config proof overwrite a newer failed reconciliation", async () => {
    const staleProof = deferred<{ providerRuleCount: number }>();
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.clearAllMocks();
    vi.mocked(deps.verifyActivation).mockReturnValueOnce(staleProof.promise);

    const older = controller.coordinateConfigApply(async () => applied);
    await vi.waitFor(() => expect(deps.verifyActivation).toHaveBeenCalledOnce());
    vi.mocked(deps.applyConfigDirect).mockResolvedValueOnce({
      nodes: 2,
      applied: false,
      activationVerified: false,
    });
    const newer = controller.reconcile();

    await expect(newer).resolves.toMatchObject({ applied: false });
    staleProof.resolve({ providerRuleCount: 1 });
    await expect(older).resolves.toEqual(applied);
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("lets the newer queued config failure supersede an older successful proof", async () => {
    const firstProof = deferred<{ providerRuleCount: number }>();
    const deps = dependencies();
    let tail: Promise<void> = Promise.resolve();
    vi.mocked(deps.runConfigApply).mockImplementation((apply) => {
      const operation = tail.then(apply, apply);
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    });
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.mocked(deps.verifyActivation).mockReturnValueOnce(firstProof.promise);

    const older = controller.coordinateConfigApply(async () => applied);
    await vi.waitFor(() => expect(deps.verifyActivation).toHaveBeenCalledTimes(2));
    const newer = controller.coordinateConfigApply(async () => ({
      nodes: 2,
      applied: false,
      activationVerified: false,
    }));
    firstProof.resolve({ providerRuleCount: 1 });

    await expect(older).resolves.toEqual(applied);
    await expect(newer).resolves.toMatchObject({ applied: false });
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("keeps nested forced recovery in the epoch of its older config request", async () => {
    const staleProof = deferred<{ providerRuleCount: number }>();
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.clearAllMocks();
    vi.mocked(deps.resolveTargetGroupName).mockReturnValueOnce("AUTO").mockReturnValueOnce(null);
    vi.mocked(deps.verifyActivation).mockReturnValueOnce(staleProof.promise);
    vi.mocked(deps.runConfigApply).mockImplementationOnce(async (apply) => {
      const result = await apply();
      return result.applied && !result.activationVerified
        ? controller.applyCurrentConfig()
        : result;
    });

    const older = controller.coordinateConfigApply(async () => ({
      nodes: 2,
      applied: true,
      activationVerified: false,
    }));
    await vi.waitFor(() => expect(deps.verifyActivation).toHaveBeenCalledOnce());
    const newer = controller.reconcile();
    await expect(newer).resolves.toEqual(applied);
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "target-channel-unavailable" },
    });

    staleProof.resolve({ providerRuleCount: 1 });
    await expect(older).resolves.toEqual(applied);
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "target-channel-unavailable" },
    });
  });

  it("restores readiness after the next successful forced apply and live proof", async () => {
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    await controller.coordinateConfigApply(async () => ({
      nodes: 2,
      applied: false,
      activationVerified: false,
    }));
    expect(controller.readCapability().apply.available).toBe(false);

    await expect(controller.applyCurrentConfig()).resolves.toEqual(applied);

    expect(controller.readCapability()).toMatchObject({
      mode: "apply",
      apply: { available: true },
    });
  });

  it("propagates cancellation that arrives during a base-config fallback", async () => {
    const pendingApply = deferred<ApplyResult>();
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(
      new DomainRuleProvisioningError("local-store-unsafe"),
    );
    vi.mocked(deps.applyConfigDirect).mockReturnValueOnce(pendingApply.promise);
    const controller = new DomainRuleDeploymentController("apply", deps);
    const abort = new AbortController();

    const pending = controller.reconcile(abort.signal);
    await vi.waitFor(() => expect(deps.applyConfigDirect).toHaveBeenCalledOnce());
    abort.abort();
    pendingApply.resolve(applied);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unsafe" },
    });
  });

  it("propagates fallback cancellation during coordinator finalization", async () => {
    const finishCoordinator = deferred<void>();
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(
      new DomainRuleProvisioningError("local-store-unavailable"),
    );
    vi.mocked(deps.runConfigApply).mockImplementationOnce(async (apply) => {
      const result = await apply();
      await finishCoordinator.promise;
      return result;
    });
    const controller = new DomainRuleDeploymentController("apply", deps);
    const abort = new AbortController();

    const pending = controller.reconcile(abort.signal);
    await vi.waitFor(() => expect(deps.applyConfigDirect).toHaveBeenCalledOnce());
    abort.abort();
    finishCoordinator.resolve();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fences an older activation as soon as a newer reconciliation is requested", async () => {
    const firstProof = deferred<{ providerRuleCount: number }>();
    const deps = dependencies();
    vi.mocked(deps.verifyActivation).mockReturnValueOnce(firstProof.promise);
    const controller = new DomainRuleDeploymentController("apply", deps);

    const first = controller.reconcile();
    await vi.waitFor(() => expect(deps.verifyActivation).toHaveBeenCalledOnce());
    const second = controller.reconcile();
    firstProof.resolve({ providerRuleCount: 1 });

    await expect(first).resolves.toEqual({
      nodes: 0,
      applied: false,
      activationVerified: false,
    });
    await expect(second).resolves.toEqual(applied);
    expect(controller.readCapability()).toMatchObject({
      mode: "apply",
      apply: { available: true },
    });
  });

  it("fences an older base fallback when reconciliation is requested again", async () => {
    const firstApply = deferred<ApplyResult>();
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(
      new DomainRuleProvisioningError("local-store-unavailable"),
    );
    vi.mocked(deps.applyConfigDirect).mockReturnValueOnce(firstApply.promise);
    const controller = new DomainRuleDeploymentController("apply", deps);

    const first = controller.reconcile();
    await vi.waitFor(() => expect(deps.applyConfigDirect).toHaveBeenCalledOnce());
    const second = controller.reconcile();
    firstApply.resolve(applied);

    await expect(first).resolves.toEqual({
      nodes: 0,
      applied: false,
      activationVerified: false,
    });
    await expect(second).resolves.toEqual(applied);
  });

  it("reapplies through the current runtime transition without nesting the coordinator", async () => {
    const deps = dependencies();
    const controller = new DomainRuleDeploymentController("apply", deps);
    await controller.reconcile();
    vi.clearAllMocks();

    await expect(controller.applyCurrentConfig()).resolves.toEqual(applied);

    expect(deps.runConfigApply).not.toHaveBeenCalled();
    expect(deps.applyConfigDirect).toHaveBeenCalledWith({
      force: true,
      managedDomainRules: { targetGroupName: "AUTO" },
    });
    expect(deps.verifyActivation).toHaveBeenCalledOnce();
  });
});
