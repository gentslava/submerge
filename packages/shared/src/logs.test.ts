import { describe, expect, it } from "vitest";
import { logEventSchema, logStreamMessageSchema } from "./logs.js";

const event = {
  id: 1,
  time: "2026-07-16T00:00:00.000Z",
  source: "mihomo",
  level: "info",
  message: "proxy connection opened",
  fields: { network: "tcp", port: 443, cached: false },
} as const;

describe("logEventSchema", () => {
  it("accepts only the safe scalar event contract", () => {
    expect(logEventSchema.parse(event)).toEqual(event);
    expect(
      logEventSchema.safeParse({ ...event, fields: { nested: { secret: "value" } } }).success,
    ).toBe(false);
  });

  it.each([
    ["non-positive id", { ...event, id: 0 }],
    ["invalid receipt time", { ...event, time: "today" }],
    ["unknown source", { ...event, source: "server" }],
    ["unknown level", { ...event, level: "fatal" }],
    ["empty message", { ...event, message: "" }],
  ])("rejects %s", (_name, value) => {
    expect(logEventSchema.safeParse(value).success).toBe(false);
  });
});

describe("logStreamMessageSchema", () => {
  it("accepts a chronological snapshot with explicit upstream state", () => {
    const snapshot = {
      type: "snapshot",
      cursor: 1,
      upstream: "live",
      nextRetryAt: null,
      events: [event],
    } as const;
    expect(logStreamMessageSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    ["connecting with retry time", "connecting", "2026-07-16T00:00:01.000Z"],
    ["live with retry time", "live", "2026-07-16T00:00:01.000Z"],
    ["reconnecting without retry time", "reconnecting", null],
  ] as const)("rejects inconsistent snapshot state: %s", (_name, upstream, nextRetryAt) => {
    expect(
      logStreamMessageSchema.safeParse({
        type: "snapshot",
        cursor: 0,
        upstream,
        nextRetryAt,
        events: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["connecting with retry time", "connecting", "2026-07-16T00:00:01.000Z"],
    ["live with retry time", "live", "2026-07-16T00:00:01.000Z"],
    ["reconnecting without retry time", "reconnecting", null],
  ] as const)("rejects inconsistent status state: %s", (_name, upstream, nextRetryAt) => {
    expect(
      logStreamMessageSchema.safeParse({
        type: "status",
        cursor: 2,
        upstream,
        nextRetryAt,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid cursors and unknown stream message shapes", () => {
    expect(logStreamMessageSchema.safeParse({ type: "clear", cursor: 0 }).success).toBe(false);
    expect(
      logStreamMessageSchema.safeParse({ type: "replace", cursor: 2, events: [] }).success,
    ).toBe(false);
  });
});
