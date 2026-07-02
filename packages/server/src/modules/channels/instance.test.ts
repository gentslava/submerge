import { describe, expect, it, vi } from "vitest";

// instance.ts binds the controller to the real db/client at import — stub both.
vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../clients/mihomo.js", () => ({ getDelay: vi.fn(), selectProxy: vi.fn() }));
vi.mock("./service.js", () => ({
  DEFAULT_CHANNEL_ID: "default",
  readDefaultChannel: vi.fn(),
  setChannelLastReason: vi.fn(),
}));

import { getDelay } from "../../clients/mihomo.js";
import { probeDelay } from "./instance.js";

const mockedGetDelay = vi.mocked(getDelay);

describe("probeDelay", () => {
  it("returns the measured delay and forwards name + url", async () => {
    mockedGetDelay.mockResolvedValueOnce({ delay: 123 });
    await expect(probeDelay("NL-1", "https://probe/check")).resolves.toBe(123);
    expect(mockedGetDelay).toHaveBeenCalledWith("NL-1", "https://probe/check");
  });

  it("maps a timeout (delay <= 0) to null", async () => {
    mockedGetDelay.mockResolvedValueOnce({ delay: 0 });
    await expect(probeDelay("NL-1", "u")).resolves.toBeNull();
    mockedGetDelay.mockResolvedValueOnce({ delay: -1 });
    await expect(probeDelay("NL-1", "u")).resolves.toBeNull();
  });

  it("maps an unreachable node (getDelay throws) to null instead of rethrowing", async () => {
    mockedGetDelay.mockRejectedValueOnce(new Error("HTTP 503"));
    await expect(probeDelay("NL-1", "u")).resolves.toBeNull();
  });
});
