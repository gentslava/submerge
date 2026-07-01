import { describe, expect, it } from "vitest";
import { formatInterval, formatRelative } from "./duration";

describe("formatInterval", () => {
  it("renders sub-2-minute values in seconds", () => {
    expect(formatInterval(30)).toBe("30 с");
  });

  it("renders whole minutes of 2+ minutes in minutes", () => {
    expect(formatInterval(300)).toBe("5 мин");
  });

  it("keeps non-whole-minute values in seconds even past 2 minutes", () => {
    expect(formatInterval(150)).toBe("150 с");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-07-01T12:00:00.000Z").getTime();

  it("renders 'только что' for timestamps under a minute old", () => {
    expect(formatRelative(now - 30_000, now)).toBe("только что");
  });

  it("renders minutes ago", () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 мин назад");
  });

  it("renders hours ago", () => {
    expect(formatRelative(now - 2 * 60 * 60_000, now)).toBe("2 ч назад");
  });

  it("renders days ago", () => {
    expect(formatRelative(now - 3 * 24 * 60 * 60_000, now)).toBe("3 дн назад");
  });

  it("defaults `now` to the current time when omitted", () => {
    const recent = Date.now() - 10_000;
    expect(formatRelative(recent)).toBe("только что");
  });
});
