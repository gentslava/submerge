import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { DomainIntelligenceRuntimeCoordinator } from "./runtime.js";

function settingsView(enabled: boolean): DomainIntelligenceSettingsView {
  return {
    configurationState: "ready",
    settings: {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled,
      defaultRuleScope: "exact",
      automationMode: enabled ? "review" : "off",
    },
    deployment: {
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("DomainIntelligenceRuntimeCoordinator", () => {
  it("serializes inverse completions and never re-enables after a newer disable", async () => {
    let current = settingsView(true);
    const firstApply = deferred<{ applied: boolean; activationVerified: boolean }>();
    const secondApply = deferred<{ applied: boolean; activationVerified: boolean }>();
    const applyCurrentConfig = vi
      .fn<() => Promise<{ applied: boolean; activationVerified: boolean }>>()
      .mockImplementationOnce(() => firstApply.promise)
      .mockImplementationOnce(() => secondApply.promise);
    const setRuntimeEnabled = vi.fn();
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => current,
      applyCurrentConfig,
      setRuntimeEnabled,
    });

    const enabling = coordinator.reconcile();
    await vi.waitFor(() => expect(applyCurrentConfig).toHaveBeenCalledTimes(1));
    current = settingsView(false);
    const disabling = coordinator.reconcile();
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
    expect(applyCurrentConfig).toHaveBeenCalledTimes(1);

    firstApply.resolve({ applied: true, activationVerified: true });
    await vi.waitFor(() => expect(applyCurrentConfig).toHaveBeenCalledTimes(2));
    secondApply.resolve({ applied: true, activationVerified: true });

    await expect(enabling).resolves.toMatchObject({ applied: false });
    await expect(disabling).resolves.toMatchObject({
      applied: true,
      view: { settings: { enabled: false } },
    });
    expect(setRuntimeEnabled).not.toHaveBeenCalledWith(true);
  });

  it("requires a fresh successful apply before enabling after a reload failure", async () => {
    const current = settingsView(true);
    const setRuntimeEnabled = vi.fn();
    const applyCurrentConfig = vi
      .fn<() => Promise<{ applied: boolean; activationVerified: boolean }>>()
      .mockResolvedValueOnce({ applied: false, activationVerified: false })
      .mockResolvedValueOnce({ applied: true, activationVerified: true });
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => current,
      applyCurrentConfig,
      setRuntimeEnabled,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: false });
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: true });
    expect(applyCurrentConfig).toHaveBeenCalledTimes(2);
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(true);
  });

  it("fails closed when config applies without a usable validation route", async () => {
    const setRuntimeEnabled = vi.fn();
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: async () => ({ applied: true, activationVerified: true }),
      canEnableRuntime: () => false,
      setRuntimeEnabled,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: false });
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
  });

  it("retries a failed boot reconciliation when mihomo first becomes available", async () => {
    const setRuntimeEnabled = vi.fn();
    const applyCurrentConfig = vi
      .fn<() => Promise<{ applied: boolean; activationVerified: boolean }>>()
      .mockResolvedValueOnce({ applied: false, activationVerified: false })
      .mockResolvedValueOnce({ applied: true, activationVerified: true });
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig,
      setRuntimeEnabled,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: false });
    await expect(coordinator.recoverIfNeeded()).resolves.toMatchObject({ applied: true });

    expect(applyCurrentConfig).toHaveBeenCalledTimes(2);
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(true);
  });

  it("does not run a pending recovery after shutdown", async () => {
    const pending = deferred<{ applied: boolean; activationVerified: boolean }>();
    const applyCurrentConfig = vi
      .fn<() => Promise<{ applied: boolean; activationVerified: boolean }>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ applied: true, activationVerified: true });
    const setRuntimeEnabled = vi.fn();
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig,
      setRuntimeEnabled,
    });

    const boot = coordinator.reconcile();
    await vi.waitFor(() => expect(applyCurrentConfig).toHaveBeenCalledTimes(1));
    const recovery = coordinator.recoverIfNeeded();
    const stopped = coordinator.stop();
    pending.resolve({ applied: false, activationVerified: false });

    await expect(boot).resolves.toMatchObject({ applied: false });
    await expect(recovery).resolves.toBeUndefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(applyCurrentConfig).toHaveBeenCalledTimes(1);
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
  });

  it("cannot restart the runtime when shutdown wins a delayed apply", async () => {
    const pending = deferred<{ applied: boolean; activationVerified: boolean }>();
    const setRuntimeEnabled = vi.fn();
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: () => pending.promise,
      setRuntimeEnabled,
    });

    const boot = coordinator.reconcile();
    const stopped = coordinator.stop();
    pending.resolve({ applied: true, activationVerified: true });

    await expect(boot).resolves.toMatchObject({ applied: false });
    await expect(stopped).resolves.toBeUndefined();
    expect(setRuntimeEnabled).not.toHaveBeenCalledWith(true);
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
  });

  it("awaits asynchronous runtime cancellation before shutdown completes", async () => {
    const stopped = deferred<void>();
    const setRuntimeEnabled = vi.fn((enabled: boolean) =>
      enabled ? Promise.resolve() : stopped.promise,
    );
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: async () => ({ applied: true, activationVerified: true }),
      setRuntimeEnabled,
    });

    const shutdown = coordinator.stop();
    let completed = false;
    void shutdown.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    stopped.resolve();
    await expect(shutdown).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });

  it("does not start a config mutation before asynchronous runtime cleanup completes", async () => {
    const stopped = deferred<void>();
    const apply = vi.fn(async () => ({
      applied: true,
      activationVerified: true,
      nodes: 1,
    }));
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: async () => ({ applied: true, activationVerified: true }),
      setRuntimeEnabled: (enabled) => (enabled ? undefined : stopped.promise),
    });

    const transition = coordinator.runConfigApply(apply);
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    stopped.resolve();
    await expect(transition).resolves.toMatchObject({ applied: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not start a config mutation when runtime cleanup fails closed", async () => {
    const cleanupError = new Error("domain validation executor did not finish cleanup");
    const apply = vi.fn(async () => ({
      applied: true,
      activationVerified: true,
      nodes: 1,
    }));
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: async () => ({ applied: true, activationVerified: true }),
      setRuntimeEnabled: (enabled) => (enabled ? undefined : Promise.reject(cleanupError)),
    });

    await expect(coordinator.runConfigApply(apply)).rejects.toBe(cleanupError);
    expect(apply).not.toHaveBeenCalled();
  });

  it("reconciles route-changing config applies through the same serialized runtime gate", async () => {
    let routeReady = false;
    const setRuntimeEnabled = vi.fn();
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => settingsView(true),
      applyCurrentConfig: async () => ({ applied: true, activationVerified: true }),
      canEnableRuntime: () => routeReady,
      setRuntimeEnabled,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: false });
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);

    routeReady = true;
    await expect(
      coordinator.runConfigApply(async () => ({
        applied: true,
        activationVerified: true,
        nodes: 1,
      })),
    ).resolves.toEqual({ applied: true, activationVerified: true, nodes: 1 });
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(true);

    routeReady = false;
    await expect(
      coordinator.runConfigApply(async () => ({
        applied: true,
        activationVerified: true,
        nodes: 0,
      })),
    ).resolves.toEqual({ applied: true, activationVerified: true, nodes: 0 });
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(false);
  });

  it("force-verifies activation after a failed reload before accepting an unchanged apply", async () => {
    const current = settingsView(true);
    const setRuntimeEnabled = vi.fn();
    const applyCurrentConfig = vi
      .fn<() => Promise<{ applied: boolean; activationVerified: boolean }>>()
      .mockResolvedValueOnce({ applied: false, activationVerified: false })
      .mockResolvedValueOnce({ applied: true, activationVerified: true });
    const coordinator = new DomainIntelligenceRuntimeCoordinator({
      readSettings: () => current,
      applyCurrentConfig,
      setRuntimeEnabled,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({ applied: false });
    await expect(
      coordinator.runConfigApply(async () => ({
        nodes: 1,
        applied: true,
        activationVerified: false,
      })),
    ).resolves.toMatchObject({ applied: true, activationVerified: true });

    expect(applyCurrentConfig).toHaveBeenCalledTimes(2);
    expect(setRuntimeEnabled).toHaveBeenLastCalledWith(true);
  });
});
