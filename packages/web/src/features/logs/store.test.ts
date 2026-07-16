import type { LogEvent, LogStreamMessage } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  classifyLogEmpty,
  filterLogEvents,
  initialLogFilters,
  initialLogsClientState,
  logsReducer,
  resetLogFilters,
  visibleLogEvents,
} from "./store";

function event(id: number, overrides: Partial<Omit<LogEvent, "id">> = {}): LogEvent {
  return {
    id,
    time: `2026-07-16T00:00:${String(id).padStart(2, "0")}.000Z`,
    source: "mihomo",
    level: "info",
    message: `event ${id}`,
    ...overrides,
  };
}

function reduce(...messages: LogStreamMessage[]) {
  return messages.reduce(
    (state, message) => logsReducer(state, { type: "message", message }),
    initialLogsClientState,
  );
}

describe("logs client reducer", () => {
  it("applies a snapshot with explicit upstream state and newest-first rows", () => {
    const state = reduce({
      type: "snapshot",
      cursor: 2,
      upstream: "reconnecting",
      nextRetryAt: "2026-07-16T00:00:05.000Z",
      events: [event(1), event(2)],
    });

    expect(state).toMatchObject({
      connection: "reconnecting",
      nextRetryAt: "2026-07-16T00:00:05.000Z",
      cursor: 2,
    });
    expect(state.events.map(({ id }) => id)).toEqual([2, 1]);
  });

  it("updates status without replacing retained events", () => {
    const before = reduce({
      type: "snapshot",
      cursor: 1,
      upstream: "live",
      nextRetryAt: null,
      events: [event(1)],
    });
    const after = logsReducer(before, {
      type: "message",
      message: {
        type: "status",
        cursor: 2,
        upstream: "reconnecting",
        nextRetryAt: "2026-07-16T00:00:10.000Z",
      },
    });

    expect(after.events).toEqual(before.events);
    expect(after).toMatchObject({
      connection: "reconnecting",
      nextRetryAt: "2026-07-16T00:00:10.000Z",
      cursor: 2,
    });
  });

  it("appends newest first and deduplicates repeated event ids", () => {
    const snapshot = reduce({
      type: "snapshot",
      cursor: 1,
      upstream: "live",
      nextRetryAt: null,
      events: [event(1)],
    });
    const appended = logsReducer(snapshot, {
      type: "message",
      message: { type: "append", cursor: 2, event: event(2) },
    });
    const duplicate = logsReducer(appended, {
      type: "message",
      message: { type: "append", cursor: 2, event: event(2) },
    });

    expect(appended.events.map(({ id }) => id)).toEqual([2, 1]);
    expect(duplicate.events.map(({ id }) => id)).toEqual([2, 1]);
  });

  it("retains rows for upstream and browser transport reconnects", () => {
    const upstream = reduce(
      {
        type: "snapshot",
        cursor: 1,
        upstream: "live",
        nextRetryAt: null,
        events: [event(1)],
      },
      {
        type: "status",
        cursor: 2,
        upstream: "reconnecting",
        nextRetryAt: "2026-07-16T00:00:10.000Z",
      },
    );
    const transport = logsReducer(upstream, { type: "connection-lost" });
    const beforeSnapshot = logsReducer(initialLogsClientState, { type: "connection-lost" });

    expect(upstream.events).toHaveLength(1);
    expect(transport).toMatchObject({ connection: "reconnecting", nextRetryAt: null });
    expect(transport.events).toEqual(upstream.events);
    expect(beforeSnapshot.connection).toBe("connecting");
  });

  it("freezes visible rows while paused, counts unique new ids, and continues atomically", () => {
    let state = reduce({
      type: "snapshot",
      cursor: 2,
      upstream: "live",
      nextRetryAt: null,
      events: [event(1), event(2)],
    });
    state = logsReducer(state, { type: "pause" });
    state = logsReducer(state, {
      type: "message",
      message: { type: "append", cursor: 3, event: event(3) },
    });
    state = logsReducer(state, {
      type: "message",
      message: { type: "append", cursor: 3, event: event(3) },
    });
    state = logsReducer(state, {
      type: "message",
      message: { type: "append", cursor: 4, event: event(4) },
    });

    expect(state.events.map(({ id }) => id)).toEqual([4, 3, 2, 1]);
    expect(visibleLogEvents(state).map(({ id }) => id)).toEqual([2, 1]);
    expect(state).toMatchObject({ paused: true, pausedCursor: 2, unseen: 2 });

    state = logsReducer(state, { type: "continue" });
    expect(state).toMatchObject({
      paused: false,
      pausedEvents: [],
      pausedCursor: null,
      unseen: 0,
    });
    expect(visibleLogEvents(state).map(({ id }) => id)).toEqual([4, 3, 2, 1]);
  });

  it("clears live, frozen, and unseen rows while preserving pause", () => {
    let state = reduce({
      type: "snapshot",
      cursor: 1,
      upstream: "live",
      nextRetryAt: null,
      events: [event(1)],
    });
    state = logsReducer(state, { type: "pause" });
    state = logsReducer(state, {
      type: "message",
      message: { type: "append", cursor: 2, event: event(2) },
    });
    state = logsReducer(state, {
      type: "message",
      message: { type: "clear", cursor: 3 },
    });

    expect(state).toMatchObject({
      cursor: 3,
      events: [],
      paused: true,
      pausedEvents: [],
      pausedCursor: 3,
      unseen: 0,
    });
  });

  it("uses a reconnect snapshot as an authoritative deduplicated ring", () => {
    let state = reduce({
      type: "snapshot",
      cursor: 2,
      upstream: "live",
      nextRetryAt: null,
      events: [event(1), event(2)],
    });
    state = logsReducer(state, {
      type: "message",
      message: { type: "append", cursor: 3, event: event(3) },
    });
    state = logsReducer(state, {
      type: "message",
      message: {
        type: "snapshot",
        cursor: 4,
        upstream: "live",
        nextRetryAt: null,
        events: [event(2), event(3), event(3), event(4)],
      },
    });

    expect(state.events.map(({ id }) => id)).toEqual([4, 3, 2]);
  });
});

describe("log filters", () => {
  const events = [
    event(1, {
      source: "mihomo",
      level: "info",
      message: "Connected to YouTube",
      fields: { host: "youtube.com", port: 443 },
    }),
    event(2, {
      source: "submerge",
      level: "warning",
      message: "Сбой получения данных mihomo",
      fields: { scope: "TRAFFIC", cached: false },
    }),
    event(3, { source: "mihomo", level: "debug", message: "DNS cache hit" }),
  ];

  it("combines case-insensitive source, severity, message, and visible-field search", () => {
    expect(
      filterLogEvents(events, { query: "youtube.COM", source: "mihomo", level: "info" }).map(
        ({ id }) => id,
      ),
    ).toEqual([1]);
    expect(
      filterLogEvents(events, { query: "traffic", source: "submerge", level: "warning" }).map(
        ({ id }) => id,
      ),
    ).toEqual([2]);
    expect(
      filterLogEvents(events, { query: "FALSE", source: "all", level: "all" }).map(({ id }) => id),
    ).toEqual([2]);
  });

  it("keeps debug under All without adding a debug filter", () => {
    expect(filterLogEvents(events, initialLogFilters).map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(filterLogEvents(events, { ...initialLogFilters, level: "error" })).toEqual([]);
  });

  it("distinguishes a genuinely empty ring from active filters with no matches", () => {
    expect(classifyLogEmpty([], [], initialLogFilters)).toBe("empty");
    const filters = { ...initialLogFilters, query: "missing" };
    expect(classifyLogEmpty(events, filterLogEvents(events, filters), filters)).toBe(
      "filtered-empty",
    );
    expect(classifyLogEmpty(events, events, initialLogFilters)).toBeNull();
  });

  it("resets all filters", () => {
    expect(resetLogFilters()).toEqual({ query: "", source: "all", level: "all" });
  });
});
