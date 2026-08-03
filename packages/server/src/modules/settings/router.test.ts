import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMihomoSecret } from "../../clients/mihomo.js";
import { operationalLog } from "../../log.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { domainIntelligenceRuntimeCoordinator } from "../logs/singleton.js";
import { applyConfig } from "../nodes/service.js";
import { settingsRouter } from "./router.js";
import { setSetting } from "./service.js";

vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../clients/mihomo.js", () => ({ setMihomoSecret: vi.fn() }));
vi.mock("../../log.js", () => ({
  log: { warn: vi.fn() },
  operationalLog: vi.fn(),
}));
vi.mock("../nodes/service.js", () => ({ applyConfig: vi.fn() }));
vi.mock("../logs/singleton.js", () => ({
  domainIntelligenceRuntimeCoordinator: { reconcile: vi.fn(), runConfigApply: vi.fn() },
}));
vi.mock("./service.js", () => ({
  getSettingsView: vi.fn(() => ({})),
  isInternalSettingKey: vi.fn((key: string) => key.startsWith("internal.")),
  setSetting: vi.fn(),
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
  vi.mocked(domainIntelligenceRuntimeCoordinator.reconcile).mockReset();
  vi.mocked(domainIntelligenceRuntimeCoordinator.runConfigApply).mockReset();
  vi.mocked(domainIntelligenceRuntimeCoordinator.runConfigApply).mockImplementation((apply) =>
    apply(),
  );
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
    expect(setMihomoSecret).not.toHaveBeenCalled();
  });

  it("reports a config write failure after secret rotation without exposing the secret", async () => {
    const err = new Error("read-only mount");
    vi.mocked(applyConfig).mockRejectedValueOnce(err);

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "new-secret-must-not-be-logged" }),
    ).resolves.toEqual({ ok: true, applied: false });

    expect(setSetting).toHaveBeenCalledWith({}, "mihomoSecret", "new-secret-must-not-be-logged");
    expect(setMihomoSecret).toHaveBeenCalledWith("new-secret-must-not-be-logged");
    expect(operationalLog).toHaveBeenCalledWith("secret-rotation-write-failed", {}, err);
    expect(JSON.stringify(vi.mocked(operationalLog).mock.calls)).not.toContain(
      "new-secret-must-not-be-logged",
    );
  });

  it("updates the API credential after reload and before the runtime resumes", async () => {
    const events: string[] = [];
    vi.mocked(applyConfig).mockImplementationOnce(async () => {
      events.push("reload");
      return { nodes: 1, applied: true, activationVerified: true };
    });
    vi.mocked(setMihomoSecret).mockImplementationOnce(() => {
      events.push("credential");
    });
    vi.mocked(domainIntelligenceRuntimeCoordinator.runConfigApply).mockImplementationOnce(
      async (apply) => {
        events.push("suspend");
        const result = await apply();
        events.push("runtime-resume");
        return result;
      },
    );

    await expect(
      caller.settings.set({ key: "mihomoSecret", value: "rotated-secret" }),
    ).resolves.toEqual({ ok: true, applied: true });

    expect(events).toEqual(["suspend", "reload", "credential", "runtime-resume"]);
    expect(applyConfig).toHaveBeenCalledWith(
      {},
      undefined,
      undefined,
      expect.objectContaining({ skipRuntimeReconciliation: true }),
    );
  });

  it("routes a manual config reload through domain-intelligence reconciliation", async () => {
    vi.mocked(domainIntelligenceRuntimeCoordinator.reconcile).mockResolvedValueOnce({
      applied: false,
    } as never);

    await expect(caller.settings.reload()).resolves.toEqual({ ok: true, applied: false });

    expect(domainIntelligenceRuntimeCoordinator.reconcile).toHaveBeenCalledTimes(1);
    expect(applyConfig).not.toHaveBeenCalled();
  });
});
