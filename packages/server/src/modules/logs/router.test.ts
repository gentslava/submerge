import type { LogStreamMessage } from "@submerge/shared";
import { isTrackedEnvelope } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { LOG_STREAM_EVENT, LogHub } from "./hub.js";
import { makeLogsRouter } from "./router.js";

function unwrap(value: unknown): unknown {
  return isTrackedEnvelope(value) ? value[1] : value;
}

function makeCaller(hub: LogHub, authed = true) {
  const appRouter = router({ logs: makeLogsRouter(hub) });
  return createCallerFactory(appRouter)({
    authed,
    authRequired: true,
    req: {} as never,
    res: {} as never,
  });
}

describe("logs router", () => {
  it("streams snapshot, append, and the global clear marker with cursor ids", async () => {
    const hub = new LogHub();
    const caller = makeCaller(hub);
    const iterable = await caller.logs.stream();

    const snapshot = await iterable.next();
    expect(unwrap(snapshot.value)).toEqual(hub.snapshot());

    const appendNext = iterable.next();
    const event = hub.push({ source: "mihomo", level: "info", message: "connected" });
    expect(unwrap((await appendNext).value)).toEqual({ type: "append", cursor: 1, event });

    const clearNext = iterable.next();
    await expect(caller.logs.clear()).resolves.toEqual({ ok: true });
    expect(unwrap((await clearNext).value)).toEqual({ type: "clear", cursor: 2 });

    await iterable.return?.();
  });

  it("cleans up the hub listener when a subscription ends", async () => {
    const hub = new LogHub();
    const iterable = await makeCaller(hub).logs.stream();
    await iterable.next();
    expect(hub.emitter.listenerCount(LOG_STREAM_EVENT)).toBe(1);

    await iterable.return?.();
    expect(hub.emitter.listenerCount(LOG_STREAM_EVENT)).toBe(0);
  });

  it("protects both procedures", async () => {
    const hub = new LogHub();
    const caller = makeCaller(hub, false);
    await expect(caller.logs.stream()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.logs.clear()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("uses the message cursor as the tracked event id", async () => {
    const hub = new LogHub();
    const iterable = await makeCaller(hub).logs.stream();
    const first = await iterable.next();
    expect(isTrackedEnvelope(first.value)).toBe(true);
    if (isTrackedEnvelope(first.value)) {
      const message = first.value[1] as LogStreamMessage;
      expect(first.value[0]).toBe(String(message.cursor));
    }
    await iterable.return?.();
  });
});
