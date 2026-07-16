import { afterEach, describe, expect, it, vi } from "vitest";
import { log, operationalLog, setUiEventSink } from "./log.js";

afterEach(() => {
  setUiEventSink(() => {});
  vi.restoreAllMocks();
});

describe("operationalLog", () => {
  it("sends raw errors to pino but only the curated draft to the UI sink", () => {
    const stdout = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const sink = vi.fn();
    const err = Object.assign(new Error("reload exploded"), {
      secret: "raw-error-secret",
      authorization: "Bearer raw-error-token",
    });
    setUiEventSink(sink);

    operationalLog(
      "config-reload-failed",
      { secret: "field-secret", nested: { token: "nested-token" } },
      err,
    );

    expect(stdout).toHaveBeenCalledWith(
      { err },
      "config written but mihomo reload failed — applies on next reload",
    );
    expect(sink).toHaveBeenCalledTimes(1);
    const uiDraft = sink.mock.calls[0]?.[0];
    expect(uiDraft).toMatchObject({ source: "submerge", level: "warning" });
    const serialized = JSON.stringify(uiDraft);
    expect(serialized).not.toContain("reload exploded");
    expect(serialized).not.toContain("raw-error-secret");
    expect(serialized).not.toContain("raw-error-token");
    expect(serialized).not.toContain("field-secret");
    expect(serialized).not.toContain("nested-token");
  });

  it("uses the registry level and safe scalar fields for both sinks", () => {
    const stdout = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const sink = vi.fn();
    setUiEventSink(sink);

    operationalLog("server-listening", {
      host: "127.0.0.1",
      port: 3000,
      password: "must-not-leak",
    });

    expect(stdout).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 3000 },
      "submerge server listening",
    );
    expect(sink).toHaveBeenCalledWith({
      source: "submerge",
      level: "info",
      message: "Сервер submerge запущен",
      fields: { host: "127.0.0.1", port: 3000 },
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("must-not-leak");
  });
});
