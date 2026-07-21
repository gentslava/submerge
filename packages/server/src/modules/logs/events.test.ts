import { describe, expect, it } from "vitest";
import { makeOperationalEvent, type OperationalEventKey } from "./events.js";

const toxicFields: Record<string, unknown> = {
  host: "127.0.0.1",
  port: 3000,
  scope: "traffic",
  password: "password-value",
  secret: "secret-value",
  authorization: "Bearer token-value",
  stack: "stack-value",
  url: "https://user:credential@example.com/sub",
  err: { message: "raw-error-value", headers: { authorization: "nested-token" } },
  nested: { private: "nested-value" },
  array: ["array-value"],
};

const keys: OperationalEventKey[] = [
  "server-listening",
  "boot-config-apply-failed",
  "config-reload-failed",
  "secret-rotation-write-failed",
  "mihomo-live-failed",
  "source-refresh-failed",
  "source-refresh-scheduler-failed",
];

describe("operational event registry", () => {
  it.each(keys)("builds a fixed safe draft for %s", (key) => {
    const event = makeOperationalEvent(key, toxicFields);
    expect(event.draft.source).toBe("submerge");
    expect(event.draft.message.length).toBeGreaterThan(0);
    expect(event.stdoutMessage.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(event.draft);
    for (const forbidden of [
      "password-value",
      "secret-value",
      "token-value",
      "stack-value",
      "credential",
      "raw-error-value",
      "nested-token",
      "nested-value",
      "array-value",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("allows only host and port for the server-listening event", () => {
    expect(makeOperationalEvent("server-listening", toxicFields).draft.fields).toEqual({
      host: "127.0.0.1",
      port: 3000,
    });
  });

  it.each([
    "boot-config-apply-failed",
    "config-reload-failed",
    "secret-rotation-write-failed",
    "source-refresh-scheduler-failed",
  ])("does not expose context fields for %s", (key) => {
    expect(makeOperationalEvent(key, toxicFields).draft.fields).toBeUndefined();
  });

  it("allows only the finite mihomo live scope enum", () => {
    expect(makeOperationalEvent("mihomo-live-failed", toxicFields).draft.fields).toEqual({
      scope: "traffic",
    });
    expect(
      makeOperationalEvent("mihomo-live-failed", { scope: "secret-value" }).draft.fields,
    ).toBeUndefined();
  });

  it("allows only sanitized source refresh failure fields", () => {
    expect(
      makeOperationalEvent("source-refresh-failed", {
        ...toxicFields,
        sourceId: 7,
        kind: "sub",
        trigger: "enable",
        stage: "fetch",
        category: "http-503",
        consecutiveFailures: 2,
        nextAttemptAt: 123_000,
      }).draft.fields,
    ).toEqual({
      sourceId: 7,
      kind: "sub",
      trigger: "enable",
      stage: "fetch",
      category: "http-503",
      consecutiveFailures: 2,
      nextAttemptAt: 123_000,
    });
  });
});
