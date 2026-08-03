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
    expect(env.DOMAIN_VALIDATION_TOPOLOGY).toBe("compose");
    expect(env.DOMAIN_VALIDATION_PROXY_ENDPOINT).toBe("http://mihomo:7891");
    expect(env.DOMAIN_VALIDATION_LISTEN).toBe("0.0.0.0");
    expect(env.DOMAIN_VALIDATION_PORT).toBe(7891);
  });
  it("overrides config path from the environment", () => {
    expect(parseEnv({ MIHOMO_CONFIG_PATH: "/tmp/c.yaml" }).MIHOMO_CONFIG_PATH).toBe("/tmp/c.yaml");
  });

  it("accepts only a literal loopback validation endpoint for host development", () => {
    expect(
      parseEnv({
        DOMAIN_VALIDATION_TOPOLOGY: "host",
        DOMAIN_VALIDATION_PROXY_ENDPOINT: "http://127.0.0.1:17891",
        DOMAIN_VALIDATION_PORT: "17891",
      }).DOMAIN_VALIDATION_PROXY_ENDPOINT,
    ).toBe("http://127.0.0.1:17891");
    expect(
      parseEnv({
        DOMAIN_VALIDATION_TOPOLOGY: "host",
        DOMAIN_VALIDATION_PROXY_ENDPOINT: "http://[::1]:17891",
        DOMAIN_VALIDATION_PORT: "17891",
      }).DOMAIN_VALIDATION_PROXY_ENDPOINT,
    ).toBe("http://[::1]:17891");

    for (const endpoint of [
      "http://localhost:7891",
      "http://192.168.1.100:7891",
      "http://mihomo:7891",
    ]) {
      expect(() =>
        parseEnv({
          DOMAIN_VALIDATION_TOPOLOGY: "host",
          DOMAIN_VALIDATION_PROXY_ENDPOINT: endpoint,
        }),
      ).toThrow();
    }
  });

  it("accepts only the private mihomo authority in compose topology", () => {
    for (const endpoint of [
      "http://127.0.0.1:7891",
      "http://other-service:7891",
      "http://user:secret@mihomo:7891",
      "https://mihomo:7891",
      "http://mihomo:7891/path",
      "http://mihomo:17891",
    ]) {
      expect(() => parseEnv({ DOMAIN_VALIDATION_PROXY_ENDPOINT: endpoint })).toThrow();
    }
    for (const port of [7890, 9090]) {
      expect(() =>
        parseEnv({
          DOMAIN_VALIDATION_PROXY_ENDPOINT: `http://mihomo:${port}`,
          DOMAIN_VALIDATION_PORT: String(port),
        }),
      ).toThrow();
    }
  });
});
