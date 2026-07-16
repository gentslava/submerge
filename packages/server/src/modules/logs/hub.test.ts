import type { LogStreamMessage } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { LOG_STREAM_EVENT, type LogDraft, LogHub } from "./hub.js";

const mihomoDraft: LogDraft = {
  source: "mihomo",
  level: "info",
  message: "proxy connection opened",
  fields: { network: "tcp", port: 443 },
};

describe("LogHub ring", () => {
  it("uses receipt time and one monotonic sequence across events and control messages", () => {
    let now = new Date("2026-07-16T00:00:00.000Z");
    const hub = new LogHub({ now: () => now });

    const first = hub.push(mihomoDraft);
    now = new Date("2026-07-16T00:00:01.000Z");
    const status = hub.setUpstream("live", null);
    const second = hub.push({ source: "submerge", level: "warning", message: "reload failed" });
    const cleared = hub.clear();
    const third = hub.push(mihomoDraft);

    expect(first).toMatchObject({ id: 1, time: "2026-07-16T00:00:00.000Z" });
    expect(status).toMatchObject({ type: "status", cursor: 2 });
    expect(second.id).toBe(3);
    expect(cleared).toEqual({ type: "clear", cursor: 4 });
    expect(third.id).toBe(5);
    expect(hub.snapshot()).toMatchObject({ cursor: 5, events: [third] });
  });

  it("retains only the newest 500 events in chronological order", () => {
    const hub = new LogHub();
    for (let id = 1; id <= 501; id += 1) {
      hub.push({ ...mihomoDraft, message: `event ${id}` });
    }

    const snapshot = hub.snapshot();
    expect(snapshot.events).toHaveLength(500);
    expect(snapshot.events[0]).toMatchObject({ id: 2, message: "event 2" });
    expect(snapshot.events.at(-1)).toMatchObject({ id: 501, message: "event 501" });
    expect(snapshot.cursor).toBe(501);
  });

  it("snapshots the current upstream and retry metadata", () => {
    const hub = new LogHub();
    expect(hub.snapshot()).toMatchObject({
      cursor: 0,
      upstream: "connecting",
      nextRetryAt: null,
      events: [],
    });

    const retryAt = "2026-07-16T00:00:05.000Z";
    hub.push(mihomoDraft);
    hub.setUpstream("reconnecting", retryAt);
    expect(hub.snapshot()).toMatchObject({
      cursor: 2,
      upstream: "reconnecting",
      nextRetryAt: retryAt,
      events: [{ id: 1 }],
    });
  });

  it("does not emit duplicate statuses and broadcasts changed status and clear markers", () => {
    const hub = new LogHub();
    const messages: LogStreamMessage[] = [];
    hub.emitter.on(LOG_STREAM_EVENT, (message: LogStreamMessage) => messages.push(message));

    expect(hub.setUpstream("connecting", null)).toBeNull();
    expect(hub.setUpstream("live", null)).toMatchObject({ type: "status", cursor: 1 });
    expect(hub.setUpstream("live", null)).toBeNull();
    expect(hub.clear()).toEqual({ type: "clear", cursor: 2 });
    expect(messages).toEqual([
      { type: "status", cursor: 1, upstream: "live", nextRetryAt: null },
      { type: "clear", cursor: 2 },
    ]);
  });
});

describe("LogHub messages", () => {
  it("fans the same append, status, and clear messages to multiple subscribers", async () => {
    const hub = new LogHub();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = hub.messages(firstAbort.signal);
    const second = hub.messages(secondAbort.signal);

    expect((await first.next()).value).toMatchObject({ type: "snapshot", cursor: 0 });
    expect((await second.next()).value).toMatchObject({ type: "snapshot", cursor: 0 });
    const firstNext = first.next();
    const secondNext = second.next();
    const event = hub.push(mihomoDraft);
    const status = hub.setUpstream("live", null);
    const clear = hub.clear();

    expect((await firstNext).value).toEqual({ type: "append", cursor: 1, event });
    expect((await secondNext).value).toEqual({ type: "append", cursor: 1, event });
    expect((await first.next()).value).toEqual(status);
    expect((await second.next()).value).toEqual(status);
    expect((await first.next()).value).toEqual(clear);
    expect((await second.next()).value).toEqual(clear);
    firstAbort.abort();
    secondAbort.abort();
    expect((await first.next()).done).toBe(true);
    expect((await second.next()).done).toBe(true);
  });

  it("queues an append produced during the snapshot-to-live hand-off", async () => {
    const hub = new LogHub();
    const abort = new AbortController();
    const originalSnapshot = hub.snapshot.bind(hub);
    let handoffEvent: ReturnType<LogHub["push"]> | undefined;
    vi.spyOn(hub, "snapshot").mockImplementationOnce(() => {
      const snapshot = originalSnapshot();
      handoffEvent = hub.push(mihomoDraft);
      return snapshot;
    });

    const messages = hub.messages(abort.signal);
    expect((await messages.next()).value).toMatchObject({ type: "snapshot", cursor: 0 });
    expect((await messages.next()).value).toEqual({
      type: "append",
      cursor: 1,
      event: handoffEvent,
    });
    abort.abort();
    expect((await messages.next()).done).toBe(true);
  });

  it("completes cleanly for an already-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    const messages = new LogHub().messages(abort.signal);
    expect(await messages.next()).toEqual({ done: true, value: undefined });
  });
});
