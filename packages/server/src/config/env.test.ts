import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("returns defaults for an empty environment", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe("./data/submerge.db");
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
  it("parses PORT from a string", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });
  it("throws on an invalid PORT", () => {
    expect(() => parseEnv({ PORT: "abc" })).toThrow();
  });
});
