import { describe, expect, it } from "vitest";
import { db } from "./client.js";

describe("test database isolation", () => {
  it("opens the imported singleton in memory instead of a shared runtime file", () => {
    expect(db.$client.name).toBe(":memory:");
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("memory");
  });
});
