import { beforeEach, describe, expect, it, vi } from "vitest";
import { operationalLog } from "../../log.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { reconcileDomainRuleDeployment } from "../logs/singleton.js";
import { applyConfig } from "../nodes/service.js";
import { settingsRouter } from "./router.js";
import {
  beginMihomoSecretRotation,
  getMihomoSecretRotationPersistenceState,
  rollbackMihomoSecretRotation,
} from "./secret-rotation.js";
import { setSetting } from "./service.js";

vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../log.js", () => ({
  log: { warn: vi.fn() },
  operationalLog: vi.fn(),
}));
vi.mock("../nodes/service.js", () => ({ applyConfig: vi.fn() }));
vi.mock("../logs/singleton.js", () => ({
  reconcileDomainRuleDeployment: vi.fn(),
}));
vi.mock("./service.js", () => ({
  getSettingsView: vi.fn(() => ({})),
  isInternalSettingKey: vi.fn((key: string) => key.startsWith("internal.")),
  setSetting: vi.fn(),
}));
const pendingRotation = {
  id: "00000000-0000-4000-8000-000000000001",
  nextEffective: "fallback-secret",
  nextStored: "",
  previousEffective: "old-secret",
  version: 2,
} as const;
vi.mock("./secret-rotation.js", () => ({
  beginMihomoSecretRotation: vi.fn((_db, next: string) => ({
    created: true,
    rotation: {
      ...pendingRotation,
      nextEffective: next || pendingRotation.nextEffective,
      nextStored: next,
    },
  })),
  getMihomoSecretRotationPersistenceState: vi.fn(() => "absent"),
  rollbackMihomoSecretRotation: vi.fn(),
}));

const caller = createCallerFactory(router({ settings: settingsRouter }))({
  authed: true,
  authRequired: false,
  req: {} as never,
  res: {} as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applyConfig).mockReset();
  vi.mocked(reconcileDomainRuleDeployment).mockReset();
  vi.mocked(getMihomoSecretRotationPersistenceState).mockReset();
  vi.mocked(getMihomoSecretRotationPersistenceState).mockReturnValue("absent");
});

describe("settings router operational events", () => {
  it("does not allow API callers to overwrite internal secrets", async () => {
    await expect(
      caller.settings.set({
        key: "internal.domainValidationProxyPassword",
        value: "attacker-selected",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not allow raw domain-intelligence JSON outside its strict router", async () => {
    const value = JSON.stringify({ enabled: true, customTargetChannelId: "media" });

    await expect(caller.settings.set({ key: "domainIntelligence", value })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(setSetting).not.toHaveBeenCalled();
    expect(applyConfig).not.toHaveBeenCalled();
    expect(beginMihomoSecretRotation).not.toHaveBeenCalled();
  });

  it("reports a config write failure after secret rotation without exposing the secret", async () => {
    const err = new Error("read-only mount");
    vi.mocked(applyConfig).mockRejectedValueOnce(err);

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "new-secret-must-not-be-logged" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Не удалось сохранить секрет mihomo",
    });

    expect(setSetting).not.toHaveBeenCalled();
    // The coordinator rejected before invoking the raw apply callback, so the
    // running engine still uses the old credential and the client must keep it.
    expect(beginMihomoSecretRotation).not.toHaveBeenCalled();
    expect(operationalLog).toHaveBeenCalledWith("secret-rotation-write-failed", {}, err);
    expect(JSON.stringify(vi.mocked(operationalLog).mock.calls)).not.toContain(
      "new-secret-must-not-be-logged",
    );
  });

  it("updates the API credential after reload and before the runtime resumes", async () => {
    const events: string[] = [];
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      opts?.stageConfigMutation?.();
      events.push("reload");
      return { nodes: 1, applied: true, activationVerified: true };
    });
    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "rotated-secret" }),
    ).resolves.toEqual({ ok: true, applied: true });

    expect(events).toEqual(["reload"]);
    expect(applyConfig).toHaveBeenCalledWith(
      {},
      undefined,
      undefined,
      expect.objectContaining({
        stageConfigMutation: expect.any(Function),
      }),
    );
    expect(beginMihomoSecretRotation).toHaveBeenCalledWith({}, "rotated-secret");
  });

  it("updates the client credential after a reload attempt that leaves activation pending", async () => {
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      opts?.stageConfigMutation?.();
      return { nodes: 1, applied: false, activationVerified: false };
    });

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "pending-secret" }),
    ).resolves.toEqual({ ok: true, applied: false });

    expect(beginMihomoSecretRotation).toHaveBeenCalledWith({}, "pending-secret");
    expect(rollbackMihomoSecretRotation).not.toHaveBeenCalled();
  });

  it("restores the persisted secret when a staged rotation fails before reload", async () => {
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      const rollback = opts?.stageConfigMutation?.();
      rollback?.();
      throw new Error("config write failed");
    });

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "new-secret" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(beginMihomoSecretRotation).toHaveBeenCalledWith({}, "new-secret");
    expect(rollbackMihomoSecretRotation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        created: true,
        rotation: expect.objectContaining({ nextStored: "new-secret" }),
      }),
    );
  });

  it("reports a durable resumed rotation as saved but pending activation", async () => {
    vi.mocked(getMihomoSecretRotationPersistenceState).mockReturnValue("pending");
    vi.mocked(beginMihomoSecretRotation).mockReturnValueOnce({
      created: false,
      rotation: {
        ...pendingRotation,
        nextEffective: "pending-secret",
        nextStored: "pending-secret",
      },
    });
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      opts?.stageConfigMutation?.();
      throw new Error("mihomo unavailable");
    });

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "pending-secret" }),
    ).resolves.toEqual({ ok: true, applied: false });
  });

  it("reports a resumed rotation finalized before a later failure as applied", async () => {
    vi.mocked(getMihomoSecretRotationPersistenceState).mockReturnValue("committed");
    vi.mocked(beginMihomoSecretRotation).mockReturnValueOnce({
      created: false,
      rotation: {
        ...pendingRotation,
        nextEffective: "pending-secret",
        nextStored: "pending-secret",
      },
    });
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      opts?.stageConfigMutation?.();
      throw new Error("provider proof failed after secret confirmation");
    });

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "pending-secret" }),
    ).resolves.toEqual({ ok: true, applied: true });
  });

  it("stages an empty value as a journaled reset instead of changing the client directly", async () => {
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _config, _target, opts) => {
      opts?.stageConfigMutation?.();
      return { nodes: 1, applied: true, activationVerified: true };
    });

    await expect(caller.settings.set({ key: "mihomoSecret", value: "" })).resolves.toEqual({
      ok: true,
      applied: true,
    });

    expect(beginMihomoSecretRotation).toHaveBeenCalledWith({}, "");
  });

  it("routes a manual config reload through full deployment reconciliation", async () => {
    vi.mocked(reconcileDomainRuleDeployment).mockResolvedValueOnce({ applied: false } as never);

    await expect(caller.settings.reload()).resolves.toEqual({ ok: true, applied: false });

    expect(reconcileDomainRuleDeployment).toHaveBeenCalledTimes(1);
    expect(applyConfig).not.toHaveBeenCalled();
  });
});
