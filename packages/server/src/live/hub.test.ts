import type { LiveEvent } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { LIVE_EVENT, LiveHub } from "./hub.js";

const view = { now: "NL-1", all: [{ name: "NL-1", type: "vless", delay: 9 }] };

function collect(hub: LiveHub, n: number): Promise<LiveEvent[]> {
  return new Promise((resolve) => {
    const out: LiveEvent[] = [];
    hub.emitter.on(LIVE_EVENT, (e: LiveEvent) => {
      out.push(e);
      if (out.length === n) resolve(out);
    });
  });
}

describe("LiveHub", () => {
  it("emits nodeUpdate + health(true) after a successful poll", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
    });
    const got = collect(hub, 2);
    await hub.pollOnce();
    const events = await got;
    expect(events).toContainEqual({ type: "health", mihomo: true });
    expect(events).toContainEqual({ type: "nodeUpdate", view });
    expect(hub.snapshot()).toContainEqual({ type: "nodeUpdate", view });
  });

  it("emits health(false) when the poll throws", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        throw new Error("down");
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
    });
    const got = collect(hub, 1);
    await hub.pollOnce();
    expect(await got).toEqual([{ type: "health", mihomo: false }]);
  });
});
