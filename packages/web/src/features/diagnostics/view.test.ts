import { describe, expect, it } from "vitest";
import {
  diagnosticStateCopy,
  diagnosticStatusVisual,
  formatDiagnosticDuration,
  passCount,
  safeDiagnosticTitle,
} from "./view";

describe("formatDiagnosticDuration", () => {
  it.each([
    [null, "—"],
    [0, "<1 мс"],
    [0.9, "<1 мс"],
    [83.6, "84 мс"],
  ] as const)("formats %s", (value, expected) => {
    expect(formatDiagnosticDuration(value)).toBe(expected);
  });
});

describe("passCount", () => {
  it("excludes skipped rows from both pass and attempted totals", () => {
    expect(passCount([{ status: "ok" }, { status: "failed" }, { status: "skipped" }])).toEqual({
      passed: 1,
      attempted: 2,
    });
  });
});

describe("safeDiagnosticTitle", () => {
  it("keeps complete safe values and uses a dash for absent values", () => {
    expect(safeDiagnosticTitle("very-long-safe-channel-name")).toBe("very-long-safe-channel-name");
    expect(safeDiagnosticTitle(null)).toBe("—");
    expect(safeDiagnosticTitle("  ")).toBe("—");
  });
});

describe("diagnosticStatusVisual", () => {
  it("maps status to semantic classes and keeps slow success successful", () => {
    expect(diagnosticStatusVisual("ok", 48)).toMatchObject({
      label: "Работает",
      dotClass: "bg-online",
      textClass: "text-online",
    });
    expect(diagnosticStatusVisual("ok", 800)).toMatchObject({
      label: "Работает медленно",
      dotClass: "bg-slow",
      textClass: "text-slow",
    });
    expect(diagnosticStatusVisual("failed", null)).toMatchObject({
      label: "Ошибка",
      dotClass: "bg-timeout",
    });
    expect(diagnosticStatusVisual("skipped", null)).toMatchObject({
      label: "Пропущено",
      dotClass: "bg-idle",
    });
  });
});

describe("diagnosticStateCopy", () => {
  it.each([
    ["running", "Проверка выполняется"],
    ["mihomo-down", "mihomo недоступен"],
    ["no-nodes", "Нет прокси-узлов"],
    ["no-internet", "Нет выхода в интернет"],
    ["external-ip-unavailable", "Внешний IP не определён"],
    ["partial", "Есть замечания"],
    ["ready", "Все проверки пройдены"],
  ] as const)("provides Russian copy for %s", (state, title) => {
    const copy = diagnosticStateCopy(state);
    expect(copy.title).toBe(title);
    expect(copy.detail.length).toBeGreaterThan(10);
    expect(copy.badge.length).toBeGreaterThan(2);
  });
});
