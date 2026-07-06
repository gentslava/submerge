import type { ConnectionItem } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { deriveSpeeds, toMbps } from "./speed";

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

describe("toMbps", () => {
  it("formats bytes/s as fixed МБ/с with two decimals", () => {
    expect(toMbps(1_048_576)).toBe("1.00");
    expect(toMbps(5_557_452)).toBe("5.30");
    expect(toMbps(0)).toBe("0.00");
  });
});
