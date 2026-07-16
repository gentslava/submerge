import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMihomoSecret } from "../../clients/mihomo.js";
import { operationalLog } from "../../log.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
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
vi.mock("./service.js", () => ({
  getSettingsView: vi.fn(() => ({})),
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
});

describe("settings router operational events", () => {
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
});
