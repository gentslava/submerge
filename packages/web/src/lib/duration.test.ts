import { describe, expect, it } from "vitest";
import { formatElapsed, formatInterval, formatRelative } from "./duration";

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

describe("formatElapsed", () => {
  const now = new Date("2026-07-06T12:00:00.000Z").getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("renders M:SS under an hour", () => {
    expect(formatElapsed(ago(72_000), now)).toBe("1:12");
    expect(formatElapsed(ago(5_000), now)).toBe("0:05");
  });

  it("renders H:MM:SS past an hour", () => {
    expect(formatElapsed(ago(3_720_000), now)).toBe("1:02:00");
  });

  it("returns — for an unparseable timestamp", () => {
    expect(formatElapsed("not-a-date", now)).toBe("—");
  });
});
