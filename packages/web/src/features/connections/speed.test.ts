import type { ConnectionItem } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { deriveSpeeds, formatConnectionRatePair } from "./speed";

const conn = (id: string, up: number, down: number): ConnectionItem => ({
  id,
  source: "192.168.1.9",
  host: "youtube.com",
  destIp: "142.250.1.1",
  port: "443",
  network: "tcp",
  node: "nl-ams-01",
  up,
  down,
  start: "2026-07-06T20:00:00Z",
});

describe("deriveSpeeds", () => {
  it("computes bytes/s from the delta over the interval", () => {
    const prev = new Map([["c1", { up: 100, down: 1000 }]]);
    const rates = deriveSpeeds(prev, [conn("c1", 200, 3000)], 1000); // +100 up, +2000 down / 1s
    expect(rates.get("c1")).toEqual({ up: 100, down: 2000 });
  });

  it("scales by the elapsed time (500ms → doubles the per-second rate)", () => {
    const prev = new Map([["c1", { up: 0, down: 0 }]]);
    const rates = deriveSpeeds(prev, [conn("c1", 50, 100)], 500);
    expect(rates.get("c1")).toEqual({ up: 100, down: 200 });
  });

  it("yields 0 for a connection unseen in the previous snapshot", () => {
    expect(deriveSpeeds(new Map(), [conn("new", 500, 500)], 1000).get("new")).toEqual({
      up: 0,
      down: 0,
    });
  });

  it("clamps a counter reset (smaller current total) to 0 instead of a negative rate", () => {
    const prev = new Map([["c1", { up: 900, down: 900 }]]);
    expect(deriveSpeeds(prev, [conn("c1", 10, 10)], 1000).get("c1")).toEqual({ up: 0, down: 0 });
  });

  it("returns an empty map for a non-positive interval", () => {
    expect(deriveSpeeds(new Map([["c1", { up: 0, down: 0 }]]), [conn("c1", 5, 5)], 0).size).toBe(0);
  });
});

describe("formatConnectionRatePair", () => {
  it("uses one shared unit chosen from the larger direction", () => {
    expect(formatConnectionRatePair({ down: 333, up: 304 })).toEqual({
      down: "333",
      up: "304",
      unit: "Б/с",
    });
    expect(formatConnectionRatePair({ down: 512, up: 1_024 })).toEqual({
      down: "0.50",
      up: "1.00",
      unit: "КБ/с",
    });
    expect(formatConnectionRatePair({ down: 1_048_576, up: 1 })).toEqual({
      down: "1.00",
      up: "<0.01",
      unit: "МБ/с",
    });
  });

  it.each([
    {
      rate: { down: 1_023, up: 1 },
      expected: { down: "1023", up: "1", unit: "Б/с" },
    },
    {
      rate: { down: 1_024, up: 1 },
      expected: { down: "1.00", up: "<0.01", unit: "КБ/с" },
    },
    {
      rate: { down: 1_048_575, up: 1 },
      expected: { down: "1024", up: "<0.01", unit: "КБ/с" },
    },
    {
      rate: { down: 1_048_576, up: 1 },
      expected: { down: "1.00", up: "<0.01", unit: "МБ/с" },
    },
  ] as const)(
    "switches units exactly at binary thresholds: $rate.down Б/с",
    ({ rate, expected }) => {
      expect(formatConnectionRatePair(rate)).toEqual(expected);
    },
  );

  it("keeps positive sub-byte rates visible and zero compact", () => {
    expect(formatConnectionRatePair({ down: 0.5, up: 0 })).toEqual({
      down: "<1",
      up: "0",
      unit: "Б/с",
    });
    expect(formatConnectionRatePair({ down: 0, up: 0 })).toEqual({
      down: "0",
      up: "0",
      unit: "Б/с",
    });
  });

  it("sheds precision at rounding boundaries without growing the numeric slot", () => {
    expect(formatConnectionRatePair({ down: 10_234, up: 0 }).down).toBe("9.99");
    expect(formatConnectionRatePair({ down: 10_235, up: 0 }).down).toBe("10.0");
    expect(formatConnectionRatePair({ down: 102_348, up: 0 }).down).toBe("99.9");
    expect(formatConnectionRatePair({ down: 102_349, up: 0 }).down).toBe("100");
    expect(formatConnectionRatePair({ down: 10 * 1_048_576, up: 0 })).toEqual({
      down: "10.0",
      up: "0.00",
      unit: "МБ/с",
    });
  });
});
