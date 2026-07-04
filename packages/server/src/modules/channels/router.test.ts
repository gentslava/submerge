import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { channelsRouter } from "./router.js";
import * as service from "./service.js";

// The router binds the `db` module-level singleton directly, so it's mocked away
// here (its value is never dereferenced — every function that would use it is
// itself mocked below) rather than spinning up a real sqlite file, matching the
// mocking pattern in live/singleton.test.ts.
vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("./instance.js", () => ({
  registry: { reset: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./service.js", () => ({
  createChannel: vi.fn(),
  deleteChannel: vi.fn(),
  listChannels: vi.fn(() => []),
  readDefaultChannel: vi.fn(() => ({})),
  reorderChannels: vi.fn(),
  setChannelPolicy: vi.fn(),
  updateChannel: vi.fn(),
}));
vi.mock("./pool.js", () => ({
  getPool: vi.fn(() => []),
  setPool: vi.fn(),
}));
vi.mock("../nodes/service.js", () => ({ applyConfig: vi.fn() }));

const ctx = { authed: true, authRequired: false, req: {} as never, res: {} as never };
const caller = createCallerFactory(router({ channels: channelsRouter }))(ctx);

const manualPolicy = {
  kind: "manual" as const,
  pinnedNode: "n1",
  onFailure: "hold" as const,
};

const applyConfigMock = vi.mocked(applyConfig);

beforeEach(() => {
  vi.clearAllMocks();
  applyConfigMock.mockResolvedValue({ nodes: 0, applied: true });
});

describe("channels router — engine-apply status on every config mutation", () => {
  it("create surfaces applied alongside the created channel", async () => {
    vi.mocked(service.createChannel).mockReturnValue({ id: "ch1", name: "X" } as never);
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.create({ name: "X", policy: manualPolicy });

    expect(res).toEqual({ channel: { id: "ch1", name: "X" }, applied: false });
  });

  it("update surfaces applied", async () => {
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.update({ id: "c1", name: "Renamed" });

    expect(res).toEqual({ ok: true, applied: false });
  });

  it("remove surfaces applied", async () => {
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.remove({ id: "c1" });

    expect(res).toEqual({ ok: true, applied: false });
  });

  it("reorder surfaces applied", async () => {
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.reorder({ ids: ["c1", "c2"] });

    expect(res).toEqual({ ok: true, applied: false });
  });

  it("setPool surfaces applied", async () => {
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.setPool({ id: "c1", members: [] });

    expect(res).toEqual({ ok: true, applied: false });
  });

  it("setPolicy surfaces applied (already correct — regression guard)", async () => {
    applyConfigMock.mockResolvedValueOnce({ nodes: 0, applied: false });

    const res = await caller.channels.setPolicy({ id: "c1", policy: manualPolicy });

    expect(res).toEqual({ ok: true, applied: false });
  });

  it("reports applied: true when the reload succeeds", async () => {
    const res = await caller.channels.update({ id: "c1", name: "Renamed" });
    expect(res).toEqual({ ok: true, applied: true });
  });
});

describe("channels router — domain validation at the input boundary", () => {
  it("create rejects a matcher with a comma in a domain", async () => {
    await expect(
      caller.channels.create({
        name: "X",
        policy: manualPolicy,
        matcher: { presets: [], domains: ["bad,domain"] },
      }),
    ).rejects.toThrow();
  });

  it("create accepts a matcher with a well-formed domain", async () => {
    vi.mocked(service.createChannel).mockReturnValue({ id: "ch1", name: "X" } as never);

    const res = await caller.channels.create({
      name: "X",
      policy: manualPolicy,
      matcher: { presets: [], domains: ["youtube.com"] },
    });

    expect(res.channel).toEqual({ id: "ch1", name: "X" });
  });

  it("update rejects a matcher with a space in a domain", async () => {
    await expect(
      caller.channels.update({ id: "c1", matcher: { presets: [], domains: ["bad domain"] } }),
    ).rejects.toThrow();
  });
});
