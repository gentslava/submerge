import type { DomainIntelligenceDeploymentCapability } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { DomainRuleDeploymentProvisioner, DomainRuleProvisioningError } from "./provisioning.js";
import { DomainRuleStoreError } from "./rule-store.js";

function dependencies() {
  return {
    provisionStore: vi.fn(async (_signal?: AbortSignal) => undefined),
    forceApplyAndVerifyManagedProvider: vi.fn(async (_input: { signal?: AbortSignal }) => ({
      providerRuleCount: 0,
    })),
  };
}

const readyCapability: DomainIntelligenceDeploymentCapability = {
  mode: "apply",
  apply: {
    available: true,
    store: "local-file",
    path: "custom.txt",
    providerName: "submerge-custom",
    providerPath: "./domain-rules/custom.txt",
  },
};

describe("DomainRuleDeploymentProvisioner", () => {
  it("keeps report mode strictly non-mutating", async () => {
    const deps = dependencies();
    const provisioner = new DomainRuleDeploymentProvisioner("report", deps);

    await expect(provisioner.reconcile()).resolves.toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
    expect(provisioner.readCapability()).toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(deps.forceApplyAndVerifyManagedProvider).not.toHaveBeenCalled();
  });

  it("mints readiness only after store and one serialized force-apply activation proof", async () => {
    const order: string[] = [];
    const deps = dependencies();
    deps.provisionStore.mockImplementationOnce(async () => {
      order.push("store");
    });
    deps.forceApplyAndVerifyManagedProvider.mockImplementationOnce(async () => {
      order.push("activation");
      return { providerRuleCount: 0 };
    });
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile()).resolves.toEqual(readyCapability);
    expect(order).toEqual(["store", "activation"]);
    expect(provisioner.readCapability()).toEqual(readyCapability);
  });

  it("keeps readiness unavailable while the final activation proof is pending", async () => {
    let finishActivation: (() => void) | undefined;
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishActivation = resolve;
      }).then(() => ({ providerRuleCount: 0 })),
    );
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    const reconciliation = provisioner.reconcile();
    await vi.waitFor(() => expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledOnce());
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });

    finishActivation?.();
    await expect(reconciliation).resolves.toEqual(readyCapability);
  });

  it("reports an unavailable target only after safe store provisioning", async () => {
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider.mockRejectedValueOnce(
      new DomainRuleProvisioningError("target-channel-unavailable"),
    );
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile()).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "target-channel-unavailable" },
    });
    expect(deps.provisionStore).toHaveBeenCalledOnce();
    expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledOnce();
  });

  it("fails closed when force-apply or activation verification fails", async () => {
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider.mockRejectedValueOnce(new Error("reload detail"));
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile()).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("rejects a malformed activation proof without minting readiness", async () => {
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider.mockResolvedValueOnce({ providerRuleCount: -1 });
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile()).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it.each([
    [
      "typed local-store failure",
      new DomainRuleStoreError("local-store-unsafe", "filesystem detail"),
      "local-store-unsafe",
    ],
    [
      "typed provisioning failure",
      new DomainRuleProvisioningError("local-store-reconciliation-required"),
      "local-store-reconciliation-required",
    ],
    ["unknown store failure", new Error("internal detail"), "local-store-unavailable"],
  ] as const)("maps %s to a safe capability", async (_label, error, reason) => {
    const deps = dependencies();
    deps.provisionStore.mockRejectedValueOnce(error);
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile()).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason },
    });
    expect(deps.forceApplyAndVerifyManagedProvider).not.toHaveBeenCalled();
  });

  it("revokes an earlier readiness before retrying", async () => {
    let finishProvisioning: (() => void) | undefined;
    const deps = dependencies();
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);
    await expect(provisioner.reconcile()).resolves.toEqual(readyCapability);
    deps.provisionStore.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishProvisioning = resolve;
      }),
    );

    const retry = provisioner.reconcile();
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
    finishProvisioning?.();
    await expect(retry).resolves.toEqual(readyCapability);
  });

  it("preserves cancellation and never starts a later provisioning stage", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const deps = dependencies();
    deps.provisionStore.mockImplementationOnce(async () => {
      controller.abort(reason);
    });
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    await expect(provisioner.reconcile(controller.signal)).rejects.toBe(reason);
    expect(deps.forceApplyAndVerifyManagedProvider).not.toHaveBeenCalled();
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });

  it("never lets an older reconciliation overwrite a newer failure", async () => {
    let finishFirstStore: (() => void) | undefined;
    const deps = dependencies();
    deps.provisionStore
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishFirstStore = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);
    deps.forceApplyAndVerifyManagedProvider.mockRejectedValueOnce(new Error("reload failed"));
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    const older = provisioner.reconcile();
    await vi.waitFor(() => expect(deps.provisionStore).toHaveBeenCalledOnce());
    const newer = provisioner.reconcile();
    finishFirstStore?.();

    await expect(older).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
    await expect(newer).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
    expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledOnce();
  });

  it("fences an older activation proof after a newer reconciliation starts", async () => {
    let finishOlderActivation: (() => void) | undefined;
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishOlderActivation = resolve;
        }).then(() => ({ providerRuleCount: 0 })),
      )
      .mockRejectedValueOnce(new Error("newer reload failed"));
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    const older = provisioner.reconcile();
    await vi.waitFor(() => expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledOnce());
    const newer = provisioner.reconcile();
    finishOlderActivation?.();

    await expect(older).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
    await expect(newer).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
    expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledTimes(2);
  });

  it("revokes readiness and fences an in-flight reconciliation", async () => {
    let finishActivation: (() => void) | undefined;
    const deps = dependencies();
    deps.forceApplyAndVerifyManagedProvider.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishActivation = resolve;
      }).then(() => ({ providerRuleCount: 0 })),
    );
    const provisioner = new DomainRuleDeploymentProvisioner("apply", deps);

    const pending = provisioner.reconcile();
    await vi.waitFor(() => expect(deps.forceApplyAndVerifyManagedProvider).toHaveBeenCalledOnce());
    provisioner.revoke("provider-inactive");
    finishActivation?.();

    await expect(pending).resolves.toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("never changes report-only capability when revocation is requested", () => {
    const provisioner = new DomainRuleDeploymentProvisioner("report", dependencies());

    provisioner.revoke("provider-inactive");

    expect(provisioner.readCapability()).toEqual({
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    });
  });

  it("restores readiness only from a fresh valid activation proof", () => {
    const provisioner = new DomainRuleDeploymentProvisioner("apply", dependencies());
    provisioner.revoke("provider-inactive");

    provisioner.publishActivationProof(provisioner.captureCapabilityEpoch(), {
      providerRuleCount: 0,
    });

    expect(provisioner.readCapability()).toMatchObject({
      mode: "apply",
      apply: { available: true },
    });

    provisioner.publishActivationProof(provisioner.captureCapabilityEpoch(), {
      providerRuleCount: -1,
    });
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "provider-inactive" },
    });
  });

  it("ignores activation proofs issued before a newer capability transition", () => {
    const provisioner = new DomainRuleDeploymentProvisioner("apply", dependencies());
    const staleEpoch = provisioner.captureCapabilityEpoch();
    provisioner.revoke("local-store-unavailable");

    expect(provisioner.publishActivationProof(staleEpoch, { providerRuleCount: 1 })).toBe(false);
    expect(provisioner.readCapability()).toEqual({
      mode: "apply",
      apply: { available: false, reason: "local-store-unavailable" },
    });
  });

  it("reserves a unique capability epoch for every requested config transition", () => {
    const provisioner = new DomainRuleDeploymentProvisioner("apply", dependencies());

    const first = provisioner.reserveCapabilityEpoch();
    const second = provisioner.reserveCapabilityEpoch();

    expect(second).toBeGreaterThan(first);
    expect(provisioner.publishActivationProof(first, { providerRuleCount: 1 })).toBe(false);
    expect(provisioner.publishActivationProof(second, { providerRuleCount: 1 })).toBe(true);
  });
});
