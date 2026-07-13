import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("parseEnv", () => {
  it("returns defaults for an empty environment", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.DB_PATH).toBe(resolve(serverRoot, "data/submerge.db"));
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
  it("parses PORT from a string", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });
  it("overrides the listen host", () => {
    expect(parseEnv({ HOST: "127.0.0.1" }).HOST).toBe("127.0.0.1");
  });
  it("throws on an invalid PORT", () => {
    expect(() => parseEnv({ PORT: "abc" })).toThrow();
  });
  it("provides mihomo config + hwid file defaults", () => {
    const env = parseEnv({});
    expect(env.MIHOMO_CONFIG_PATH).toBe("/mihomo/config.yaml");
    expect(env.MIHOMO_CONFIG_TARGET).toBe("/root/.config/mihomo/config.yaml");
    expect(env.HWID_FILE).toBe("/mihomo/hwid.txt");
  });
  it("overrides config path from the environment", () => {
    expect(parseEnv({ MIHOMO_CONFIG_PATH: "/tmp/c.yaml" }).MIHOMO_CONFIG_PATH).toBe("/tmp/c.yaml");
  });
});
