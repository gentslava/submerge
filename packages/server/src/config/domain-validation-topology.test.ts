import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";

interface ComposeService {
  environment?: Record<string, string>;
  expose?: string[];
  ports?: string[];
}

interface ComposeDocument {
  services: Record<string, ComposeService>;
}

function compose(relativePath: string): ComposeDocument {
  const path = fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
  return yaml.load(readFileSync(path, "utf8")) as ComposeDocument;
}

describe("domain validation topology", () => {
  it("keeps the production listener on the private Compose network", () => {
    const config = compose("docker-compose.yml");
    const mihomo = config.services.mihomo;
    const submerge = config.services.submerge;

    expect(mihomo?.expose).toContain("7891");
    expect(mihomo?.ports?.some((mapping) => mapping.includes(":7891"))).toBe(false);
    expect(submerge?.environment).toMatchObject({
      DOMAIN_VALIDATION_TOPOLOGY: "compose",
      DOMAIN_VALIDATION_PROXY_ENDPOINT: "http://mihomo:7891",
    });
  });

  it("publishes the development listener to loopback only", () => {
    const config = compose("docker-compose.dev.yml");
    expect(config.services.mihomo?.ports).toContain("127.0.0.1:7891:7891");

    const devEnvPath = fileURLToPath(new URL("../../../../config/dev.env", import.meta.url));
    const devEnv = readFileSync(devEnvPath, "utf8");
    expect(devEnv).toContain("DOMAIN_VALIDATION_TOPOLOGY=host\n");
    expect(devEnv).toContain("DOMAIN_VALIDATION_PROXY_ENDPOINT=http://127.0.0.1:7891\n");
  });

  it("keeps domain-rule mutation disabled in deployment defaults", () => {
    const config = compose("docker-compose.yml");
    const reportOnlyInterpolation = ["$", "{DOMAIN_RULES_MODE:-report}"].join("");
    expect(config.services.submerge?.environment).toMatchObject({
      DOMAIN_RULES_MODE: reportOnlyInterpolation,
    });

    const examplePath = fileURLToPath(new URL("../../../../.env.example", import.meta.url));
    expect(readFileSync(examplePath, "utf8")).toContain("DOMAIN_RULES_MODE=report\n");
  });
});
