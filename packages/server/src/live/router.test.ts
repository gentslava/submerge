import { isTrackedEnvelope } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { createCallerFactory, router } from "../trpc/trpc.js";
import { LiveHub } from "./hub.js";
import { makeLiveRouter } from "./router.js";

// Via the in-process caller, tracked() values arrive as the raw envelope
// [id, data, trackedSymbol] (the {id,data} shape only appears in the SSE
// client transport). Pull the data slot off the envelope.
function unwrap(v: unknown): unknown {
  return isTrackedEnvelope(v) ? v[1] : v;
}

describe("live router", () => {
  it("replays the hub snapshot to a new subscriber", async () => {
    const hub = new LiveHub({
      fetchView: async () => ({ now: "NL-1", all: [] }),
      streamTraffic: async function* () {},
      getInterval: () => 1000,
    });
    await hub.pollOnce(); // seed lastView + health(true)
    const snapshot = hub.snapshot();

    const appRouter = router({ live: makeLiveRouter(hub) });
    const caller = createCallerFactory(appRouter)({ authed: true });
    const iterable = await caller.live.stream();

    const seen: unknown[] = [];
    for await (const v of iterable) {
      seen.push(unwrap(v));
      // The snapshot is replayed synchronously; break once the batch is drained
      // so the generator's blocking `on(emitter, …)` loop never runs (no hang).
      if (seen.length >= snapshot.length) break;
    }
    expect(seen).toEqual(snapshot);
  });
});
